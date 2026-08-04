import assert from "node:assert/strict";
import test from "node:test";
import { enqueueAndWaitForRemoteIngest } from "../lib/remote-ingest.mjs";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  SURF_EXPECTED_WORKER_VERSION_HEADER,
  SURF_WORKER_VERSION_HEADER
} from "../lib/worker-version.mjs";

const baseUrl = "https://surf.example";
const requestedAt = "2026-08-03T01:00:00.000Z";
const ingestId = "ingest-test-id";
const spot = { id: "test-break", timezone: "America/Los_Angeles" };
const workerVersion = "9fdf8329-662b-4665-bc74-9b153dc3fc40";
const workerName = "surf";
const staleWorkerVersion = "ea3a7a1e-3c43-4aca-9517-dbe1ff562746";

function versionedJson(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set(SURF_WORKER_VERSION_HEADER, workerVersion);
  return Response.json(value, { ...init, headers });
}

function versionedUnauthorized() {
  return versionedJson(
    { error: "Unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
  );
}

function versionedForecast(expectedIngestId = ingestId) {
  return new Response("{}", {
    headers: {
      [SURF_WORKER_VERSION_HEADER]: workerVersion,
      "X-Surf-Forecast-Generated-At": requestedAt,
      "X-Surf-Forecast-Materialized-At": "2026-08-03T01:00:30.000Z",
      "X-Surf-Ingest-Id": expectedIngestId
    }
  });
}

function hangingBodyResponse(init = {}) {
  return new Response(
    new ReadableStream({
      start() {
        // Intentionally never enqueue or close: the request-level deadline must
        // bound both headers and body consumption.
      }
    }),
    init
  );
}

function pendingResponse(interval) {
  return Response.json(
    {
      error: "forecast_temporarily_unavailable",
      message: "Forecast data is being refreshed. Please retry shortly.",
      retryable: true,
      spotId: spot.id,
      interval
    },
    { status: 503 }
  );
}

test("remote ingest enqueues work and waits for every interval to publish a fresh read model", async () => {
  let clock = Date.parse(requestedAt);
  const forecastRequests = new Map();
  const authorizationHeaders = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") {
      authorizationHeaders.push(new Headers(init.headers).get("Authorization"));
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt, region: "norcal" },
        { status: 202 }
      );
    }
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === `/api/forecast/${spot.id}`) {
      const interval = url.searchParams.get("interval");
      const requests = (forecastRequests.get(interval) ?? 0) + 1;
      forecastRequests.set(interval, requests);
      if (interval === "3h" && requests === 1) return pendingResponse(interval);
      const materializedAt = interval === "1h"
        ? "2026-08-03T01:00:30.000Z"
        : "2026-08-03T01:01:00.000Z";
      return new Response("{}", {
        headers: {
          "X-Surf-Forecast-Generated-At": requestedAt,
          "X-Surf-Forecast-Materialized-At": materializedAt,
          "X-Surf-Ingest-Id": ingestId
        }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    pollIntervalMs: 5,
    timeoutMs: 20
  });

  assert.deepEqual(authorizationHeaders, ["Bearer secret-token"]);
  assert.equal(result.status, "published");
  assert.equal(result.ingestId, ingestId);
  assert.equal(result.attempts, 2);
  assert.equal(result.spots, 1);
  assert.equal(result.forecastReadModels, 2);
  assert.equal(result.materializedAt, "2026-08-03T01:01:00.000Z");
  assert.deepEqual(Object.fromEntries(forecastRequests), { "3h": 2, "1h": 1 });
});

test("remote ingest polling is bounded and names unpublished read models", async () => {
  let clock = Date.parse(requestedAt);
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt, region: "norcal" },
        { status: 202 }
      );
    }
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === `/api/forecast/${spot.id}`) {
      return pendingResponse(url.searchParams.get("interval"));
    }
    return new Response("not found", { status: 404 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      pollIntervalMs: 5,
      timeoutMs: 10
    }),
    /pending: test-break:3h, test-break:1h/
  );
});

test("remote ingest ignores fresh read models from a different ingest", async () => {
  let clock = Date.parse(requestedAt);
  let forecastRequests = 0;
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt, region: "norcal" },
        { status: 202 }
      );
    }
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === `/api/forecast/${spot.id}`) {
      forecastRequests += 1;
      const wrongIngest = forecastRequests <= 2;
      return new Response("{}", {
        headers: {
          "X-Surf-Forecast-Generated-At": "2026-08-03T01:05:00.000Z",
          "X-Surf-Forecast-Materialized-At": "2026-08-03T01:05:30.000Z",
          "X-Surf-Ingest-Id": wrongIngest ? "different-ingest" : ingestId
        }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    pollIntervalMs: 5,
    timeoutMs: 20
  });

  assert.equal(result.status, "published");
  assert.equal(result.ingestId, ingestId);
  assert.equal(result.attempts, 2);
  assert.equal(forecastRequests, 4);
});

test("version-checked remote ingest proves the ordinary route before and after its single enqueue", async () => {
  let patchCount = 0;
  const requests = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      cache: init.cache,
      redirect: init.redirect
    });
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      patchCount += 1;
      if (!new Headers(init.headers).has("Authorization")) {
        return versionedUnauthorized();
      }
      return versionedJson(
        {
          status: "accepted",
          ingestId: workerVersion,
          requestedAt,
          forecastGeneratedAt: requestedAt,
          region: "norcal"
        },
        { status: 202 }
      );
    }
    if (url.pathname === `/api/forecast/${spot.id}`) return versionedForecast(workerVersion);
    return new Response("not found", { status: 404 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    pollIntervalMs: 5,
    timeoutMs: 20
  });

  assert.equal(patchCount, 2);
  assert.equal(result.workerVersion, workerVersion);
  assert.equal(result.ingestId, workerVersion);
  assert.equal(result.forecastReadModels, 2);
  assert.deepEqual(
    requests.map(({ path, method }) => ({ path, method })),
    [
      { path: "/api/spots", method: "GET" },
      { path: "/api/ingest/once", method: "PATCH" },
      { path: "/api/ingest/once", method: "PATCH" },
      { path: "/api/forecast/test-break?interval=3h", method: "GET" },
      { path: "/api/forecast/test-break?interval=1h", method: "GET" }
    ]
  );
  for (const request of requests) {
    assert.equal(
      request.headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER),
      null,
      `${request.path} must exercise ordinary production routing`
    );
    assert.equal(
      request.headers.get(SURF_EXPECTED_WORKER_VERSION_HEADER),
      request.method === "PATCH" ? workerVersion : null,
      `${request.path} must apply the version precondition only at the mutation boundary`
    );
  }
  const patchRequests = requests.filter(({ method }) => method === "PATCH");
  assert.deepEqual(
    patchRequests.map(({ headers }) => headers.get("Authorization")),
    [null, "Bearer secret-token"],
    "the route probe must be unauthenticated and exactly one PATCH may carry credentials"
  );
  assert.deepEqual(
    patchRequests.map(({ cache, redirect }) => ({ cache, redirect })),
    [
      { cache: "no-store", redirect: "error" },
      { cache: "no-store", redirect: "error" }
    ]
  );
});

test("deploy route probe requires exact unauthorized method-path identity before enqueue", async () => {
  for (const probeResponse of [
    versionedJson({ error: "Unauthorized" }, { status: 404 }),
    versionedJson({ error: "Unauthorized" }, { status: 401 }),
    Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": "Bearer",
          [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion,
          "CF-Ray": "stale-ray"
        }
      }
    )
  ]) {
    let authenticatedPatches = 0;
    const fetcher = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
      if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
        if (new Headers(init.headers).has("Authorization")) authenticatedPatches += 1;
        return probeResponse.clone();
      }
      return new Response("unexpected request", { status: 500 });
    };

    await assert.rejects(
      enqueueAndWaitForRemoteIngest({
        baseUrl,
        token: "secret-token",
        fetcher,
        expectedVersionId: workerVersion,
        expectedWorkerName: workerName
      }),
      /remote ingest route probe failed: PATCH \/api\/ingest\/once/
    );
    assert.equal(authenticatedPatches, 0);
  }
});

test("deploy request failures distinguish pre-mutation from ambiguous enqueue transport", async () => {
  let probePatchRequests = 0;
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          probePatchRequests += 1;
          throw new TypeError("redirect rejected");
        }
        return new Response("unexpected request", { status: 500 });
      }
    }),
    (error) => {
      assert.equal(error.name, "TransportError");
      assert.match(
        error.message,
        /remote ingest route probe request failed: PATCH \/api\/ingest\/once; mutation did not begin/
      );
      assert.equal(error.cause?.name, "TransportError");
      return true;
    }
  );
  assert.equal(probePatchRequests, 1);

  let authenticatedPatchRequests = 0;
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          if (!new Headers(init.headers).has("Authorization")) {
            return versionedUnauthorized();
          }
          authenticatedPatchRequests += 1;
          throw new TypeError("connection reset after send");
        }
        return new Response("unexpected request", { status: 500 });
      }
    }),
    (error) => {
      assert.equal(error.name, "TransportError");
      assert.match(
        error.message,
        /remote ingest enqueue request failed: PATCH \/api\/ingest\/once; mutation may have occurred; do not retry/
      );
      assert.equal(error.cause?.name, "TransportError");
      return true;
    }
  );
  assert.equal(authenticatedPatchRequests, 1);
});

test("deploy enqueue diagnostics preserve bounded text evidence without leaking the token", async () => {
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) return versionedUnauthorized();
      return new Response("upstream reflected secret-token\nwith control\u0000bytes", {
        status: 502,
        headers: {
          [SURF_WORKER_VERSION_HEADER]: workerVersion,
          "CF-Ray": "diagnostic-ray"
        }
      });
    }
    return new Response("unexpected request", { status: 500 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName
    }),
    (error) => {
      assert.match(
        error.message,
        /status=502 workerVersion=9fdf8329-662b-4665-bc74-9b153dc3fc40 cfRay=diagnostic-ray body=upstream reflected \[REDACTED\] with control bytes/
      );
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    }
  );
});

test("deploy diagnostics redact a token before the evidence boundary is truncated", async () => {
  const reflected = `${"x".repeat(495)}secret-token trailing`;
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) return versionedUnauthorized();
      return new Response(reflected, {
        status: 502,
        headers: { [SURF_WORKER_VERSION_HEADER]: workerVersion }
      });
    }
    return new Response("unexpected request", { status: 500 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName
    }),
    (error) => {
      assert.doesNotMatch(error.message, /secret|secret-token/);
      assert.match(error.message, /body=x{495}\[REDA/);
      return true;
    }
  );
});

test("a predecessor without the deploy PATCH cannot enqueue on override fallback", async () => {
  let deployPatches = 0;
  let legacyQueueSends = 0;
  let forecastRequests = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      deployPatches += 1;
      return new Response("not found", {
        status: 404,
        headers: {
          [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion,
          "CF-Ray": "predecessor-ray"
        }
      });
    }
    if (url.pathname === "/api/ingest/once" && init.method === "POST") {
      legacyQueueSends += 1;
      return new Response("unexpected legacy mutation", { status: 202 });
    }
    if (url.pathname === `/api/forecast/${spot.id}`) forecastRequests += 1;
    return new Response("not found", { status: 404 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName
    }),
    /remote ingest route probe failed: PATCH \/api\/ingest\/once status=404 workerVersion=ea3a7a1e-3c43-4aca-9517-dbe1ff562746 cfRay=predecessor-ray body=not found/
  );
  assert.equal(deployPatches, 1);
  assert.equal(legacyQueueSends, 0);
  assert.equal(forecastRequests, 0);
});

test("version-pinned remote ingest requires the Worker name and version as a fail-closed pair", async () => {
  for (const versionOptions of [
    { expectedVersionId: workerVersion },
    { expectedWorkerName: workerName }
  ]) {
    let requests = 0;
    await assert.rejects(
      enqueueAndWaitForRemoteIngest({
        baseUrl,
        token: "secret-token",
        ...versionOptions,
        fetcher: async () => {
          requests += 1;
          return new Response("unexpected request");
        }
      }),
      /Worker version ID and Worker name must be provided together/
    );
    assert.equal(requests, 0);
  }
});

test("version mismatch on the read-only preflight prevents enqueue", async () => {
  let postCount = 0;
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") postCount += 1;
    return Response.json(
      { spots: [spot] },
      { headers: { [SURF_WORKER_VERSION_HEADER]: "stale-worker-version" } }
    );
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName
    }),
    /served by Worker version stale-worker-version/
  );
  assert.equal(postCount, 0);
});

test("exact Cloudflare 1102 responses are bounded pending while near-misses fail closed", async () => {
  let clock = Date.parse(requestedAt);
  let forecastRequests = 0;
  const cloudflare1102 = {
    type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/",
    status: 503,
    error_code: 1102,
    error_name: "worker_exceeded_resources",
    error_category: "worker",
    cloudflare_error: true
  };
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        { status: 202 }
      );
    }
    if (url.pathname === `/api/forecast/${spot.id}`) {
      forecastRequests += 1;
      if (forecastRequests <= 2) return Response.json(cloudflare1102, { status: 503 });
      return new Response("{}", {
        headers: {
          "X-Surf-Forecast-Generated-At": requestedAt,
          "X-Surf-Forecast-Materialized-At": "2026-08-03T01:00:30.000Z",
          "X-Surf-Ingest-Id": ingestId
        }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    pollIntervalMs: 5,
    timeoutMs: 20
  });
  assert.equal(result.attempts, 2);

  const nearMissFetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        { status: 202 }
      );
    }
    return Response.json({ ...cloudflare1102, cloudflare_error: false }, { status: 503 });
  };
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher: nearMissFetcher,
      pollIntervalMs: 5,
      timeoutMs: 20
    }),
    /invalid retryable-unavailable response/
  );
});

test("forecast polling is sequential to avoid recreating the Worker CPU burst", async () => {
  let inFlightForecasts = 0;
  let maximumInFlightForecasts = 0;
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        { status: 202 }
      );
    }
    if (url.pathname === `/api/forecast/${spot.id}`) {
      inFlightForecasts += 1;
      maximumInFlightForecasts = Math.max(maximumInFlightForecasts, inFlightForecasts);
      await new Promise((resolve) => setImmediate(resolve));
      inFlightForecasts -= 1;
      return new Response("{}", {
        headers: {
          "X-Surf-Forecast-Generated-At": requestedAt,
          "X-Surf-Forecast-Materialized-At": "2026-08-03T01:00:30.000Z",
          "X-Surf-Ingest-Id": ingestId
        }
      });
    }
    return new Response("not found", { status: 404 });
  };

  await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    pollIntervalMs: 5,
    timeoutMs: 20
  });
  assert.equal(maximumInFlightForecasts, 1);
});

test("a stalled catalog body times out before enqueue and aborts its request", async () => {
  let signal;
  let postCount = 0;
  const fetcher = (input, init = {}) => {
    const url = new URL(String(input));
    signal = init.signal;
    if (url.pathname === "/api/ingest/once") postCount += 1;
    return Promise.resolve(hangingBodyResponse());
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      requestTimeoutMs: 5
    }),
    (error) => error?.name === "TimeoutError"
  );
  assert.equal(signal.aborted, true);
  assert.equal(postCount, 0);
});

test("a stalled accepted-response body is bounded after exactly one authenticated PATCH", async () => {
  let authenticatedPatchCount = 0;
  let forecastCount = 0;
  let patchSignal;
  const fetcher = (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Promise.resolve(versionedJson({ spots: [spot] }));
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) {
        return Promise.resolve(versionedUnauthorized());
      }
      authenticatedPatchCount += 1;
      patchSignal = init.signal;
      return Promise.resolve(
        hangingBodyResponse({
          status: 202,
          headers: { [SURF_WORKER_VERSION_HEADER]: workerVersion }
        })
      );
    }
    if (url.pathname === `/api/forecast/${spot.id}`) forecastCount += 1;
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      requestTimeoutMs: 5
    }),
    (error) => {
      assert.equal(error?.name, "TimeoutError");
      assert.match(
        error.message,
        /remote ingest enqueue request failed: PATCH \/api\/ingest\/once; mutation may have occurred; do not retry/
      );
      assert.equal(error.cause?.name, "TimeoutError");
      return true;
    }
  );
  assert.equal(patchSignal.aborted, true);
  assert.equal(authenticatedPatchCount, 1);
  assert.equal(forecastCount, 0);
});

test("signal-aware AbortError races normalize to bounded pending forecast state", async () => {
  let clock = Date.parse(requestedAt);
  let postCount = 0;
  let abortedForecasts = 0;
  const fetcher = (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Promise.resolve(Response.json({ spots: [spot] }));
    if (url.pathname === "/api/ingest/once") {
      postCount += 1;
      return Promise.resolve(
        Response.json(
          { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
          { status: 202 }
        )
      );
    }
    return new Promise((_, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          abortedForecasts += 1;
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true }
      );
    });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      pollIntervalMs: 5,
      timeoutMs: 5,
      requestTimeoutMs: 2
    }),
    /pending: test-break:3h, test-break:1h/
  );
  assert.equal(postCount, 1);
  assert.equal(abortedForecasts, 2);
});

test("transient forecast transport failures stay bounded and recover without reenqueuing", async () => {
  let clock = Date.parse(requestedAt);
  let postCount = 0;
  const forecastAttempts = new Map();
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/ingest/once") {
      postCount += 1;
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        { status: 202 }
      );
    }
    const interval = url.searchParams.get("interval");
    const attempts = (forecastAttempts.get(interval) ?? 0) + 1;
    forecastAttempts.set(interval, attempts);
    if (attempts === 1) {
      if (interval === "3h") throw new TypeError("fetch failed");
      throw new DOMException("independent abort", "AbortError");
    }
    return new Response("{}", {
      headers: {
        "X-Surf-Forecast-Generated-At": requestedAt,
        "X-Surf-Forecast-Materialized-At": "2026-08-03T01:00:30.000Z",
        "X-Surf-Ingest-Id": ingestId
      }
    });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      clock += delayMs;
    },
    pollIntervalMs: 5,
    timeoutMs: 20
  });

  assert.equal(result.attempts, 2);
  assert.equal(postCount, 1);
  assert.deepEqual(Object.fromEntries(forecastAttempts), { "3h": 2, "1h": 2 });
});

test("persistent forecast transport failure reaches the global deadline after one POST", async () => {
  let clock = Date.parse(requestedAt);
  let postCount = 0;
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/ingest/once") {
      postCount += 1;
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        { status: 202 }
      );
    }
    throw new TypeError("temporary connection reset");
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      pollIntervalMs: 5,
      timeoutMs: 5
    }),
    /pending: test-break:3h, test-break:1h/
  );
  assert.equal(postCount, 1);
});

test("an accepted deploy response from the wrong Worker rejects without forecast polling", async () => {
  let authenticatedPatchCount = 0;
  let forecastCount = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) {
        return versionedUnauthorized();
      }
      authenticatedPatchCount += 1;
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        {
          status: 202,
          headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion }
        }
      );
    }
    if (url.pathname === `/api/forecast/${spot.id}`) forecastCount += 1;
    return new Response("not found", { status: 404 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName
    }),
    /remote ingest enqueue failed: PATCH \/api\/ingest\/once status=202 workerVersion=ea3a7a1e-3c43-4aca-9517-dbe1ff562746/
  );
  assert.equal(authenticatedPatchCount, 1);
  assert.equal(forecastCount, 0);
});

test("wrong-version ready forecasts never satisfy publication", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatchCount = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) {
        return versionedUnauthorized();
      }
      authenticatedPatchCount += 1;
      return versionedJson(
        {
          status: "accepted",
          ingestId: workerVersion,
          requestedAt,
          forecastGeneratedAt: requestedAt
        },
        { status: 202 }
      );
    }
    return new Response("{}", {
      headers: {
        [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion,
        "X-Surf-Forecast-Generated-At": requestedAt,
        "X-Surf-Forecast-Materialized-At": "2026-08-03T01:00:30.000Z",
        "X-Surf-Ingest-Id": workerVersion
      }
    });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      pollIntervalMs: 5,
      timeoutMs: 5
    }),
    /pending: test-break:3h, test-break:1h/
  );
  assert.equal(authenticatedPatchCount, 1);
});

test("persistent exact Cloudflare 1102 reaches the global deadline without reenqueuing", async () => {
  let clock = Date.parse(requestedAt);
  let postCount = 0;
  const exact1102 = {
    type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/",
    status: 503,
    error_code: 1102,
    error_name: "worker_exceeded_resources",
    error_category: "worker",
    cloudflare_error: true
  };
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/ingest/once") {
      postCount += 1;
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        { status: 202 }
      );
    }
    return Response.json(exact1102, { status: 503 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      pollIntervalMs: 5,
      timeoutMs: 5
    }),
    /pending: test-break:3h, test-break:1h/
  );
  assert.equal(postCount, 1);
});
