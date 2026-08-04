import assert from "node:assert/strict";
import test from "node:test";
import { smokeForecastInstance } from "../lib/smoke-instance.mjs";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  SURF_WORKER_VERSION_HEADER
} from "../lib/worker-version.mjs";

const spot = { id: "test-break", timezone: "America/Los_Angeles" };
const expectedVersionId = "11111111-2222-4333-8444-555555555555";
const expectedWorkerName = "surf";
const otherVersionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const workerVersionKeyHeader = "Cloudflare-Workers-Version-Key";
const windows = Array.from({ length: 5 }, (_, day) => ({
  forecastAt: new Date(Date.UTC(2026, 6, 10 + day, 16)).toISOString(),
  ratingStatus: "scored",
  waveHeightFt: 2.5
}));

function fetchFixture(forecastWindows) {
  return async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/api/health") return Response.json({ status: "ok" });
    if (path === "/api/spots") return Response.json({ spots: [spot] });
    if (path === "/api/forecast/test-break") {
      return Response.json({
        spot,
        interval: url.searchParams.get("interval") ?? "3h",
        windows: forecastWindows
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function pendingFixture(valid = true) {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/health") return Response.json({ status: "ok" });
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/forecast/test-break") {
      const interval = url.searchParams.get("interval") ?? "3h";
      return Response.json(
        valid
          ? {
              error: "forecast_temporarily_unavailable",
              message: "Forecast data is being refreshed. Please retry shortly.",
              retryable: true,
              spotId: spot.id,
              interval
            }
          : { error: "unavailable" },
        { status: 503 }
      );
    }
    return new Response("not found", { status: 404 });
  };
}

test("strict smoke verifies every spot has a five-day sourced forecast", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFixture(windows);
  try {
    const result = await smokeForecastInstance("https://surf.example/", {
      label: "test",
      requireForecastData: true
    });
    assert.equal(result.spots, 1);
    assert.equal(result.forecastReadModels, 2);
    assert.equal(result.pendingForecastReadModels, 0);
    assert.equal(result.dataCheck, "scored forecasts present");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("setup smoke accepts typed retryable read-model publication gaps", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pendingFixture();
  try {
    const result = await smokeForecastInstance("https://surf.example", {
      label: "test",
      requireForecastData: false
    });
    assert.equal(result.forecastReadModels, 0);
    assert.equal(result.pendingForecastReadModels, 2);
    assert.equal(result.dataCheck, "API structure only");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("setup smoke rejects untyped forecast failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pendingFixture(false);
  try {
    await assert.rejects(
      smokeForecastInstance("https://surf.example", {
        label: "test",
        requireForecastData: false
      }),
      /invalid setup-time unavailable response/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict smoke rejects synthesized unknown windows", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFixture(
    windows.map((window) => ({ ...window, ratingStatus: "unknown", waveHeightFt: null }))
  );
  try {
    await assert.rejects(
      smokeForecastInstance("https://surf.example", {
        label: "test",
        requireForecastData: true
      }),
      /no scored window/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function versionedFixture({ versionForPath = () => expectedVersionId } = {}) {
  const requests = [];
  return {
    requests,
    fetcher: async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({ url, headers: new Headers(init.headers) });
      const headers = {
        [SURF_WORKER_VERSION_HEADER]: versionForPath(url)
      };
      if (url.pathname === "/api/health") {
        return Response.json({ status: "ok" }, { headers });
      }
      if (url.pathname === "/api/spots") {
        return Response.json({ spots: [spot] }, { headers });
      }
      if (url.pathname === "/api/forecast/test-break") {
        return Response.json(
          {
            spot,
            interval: url.searchParams.get("interval") ?? "3h",
            windows
          },
          { headers }
        );
      }
      return new Response("not found", { status: 404, headers });
    }
  };
}

test("version-checked smoke exercises ordinary routing for health, spots, and every forecast", async () => {
  const fixture = versionedFixture();
  const result = await smokeForecastInstance("https://surf.example", {
    label: "version smoke",
    requireForecastData: true,
    expectedVersionId,
    expectedWorkerName,
    fetcher: fixture.fetcher
  });

  assert.equal(result.workerVersion, expectedVersionId);
  assert.equal(fixture.requests.length, 4);
  assert.deepEqual(
    fixture.requests.map(({ url }) => `${url.pathname}${url.search}`),
    [
      "/api/health",
      "/api/spots",
      "/api/forecast/test-break?interval=3h",
      "/api/forecast/test-break?interval=1h"
    ]
  );
  for (const request of fixture.requests) {
    assert.equal(
      request.headers.get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER),
      null
    );
    assert.equal(request.headers.get(workerVersionKeyHeader), null);
  }
});

test("version-pinned smoke requires the Worker name and version as a fail-closed pair", async () => {
  for (const versionOptions of [
    { expectedVersionId },
    { expectedWorkerName }
  ]) {
    let requests = 0;
    await assert.rejects(
      smokeForecastInstance("https://surf.example", {
        label: "version smoke",
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

test("smoke validates its injected sleep and retry interval before requesting", async () => {
  for (const invalidOptions of [
    { sleep: null },
    { roundRetryIntervalMs: 0 }
  ]) {
    let requests = 0;
    await assert.rejects(
      smokeForecastInstance("https://surf.example", {
        label: "version smoke",
        ...invalidOptions,
        fetcher: async () => {
          requests += 1;
          return new Response("unexpected request");
        }
      }),
      /requires fetch, clock, sleep, and positive request\/overall\/retry timeouts/
    );
    assert.equal(requests, 0);
  }
});

test("version-pinned smoke restarts the full round after stale health", async () => {
  let clock = 0;
  let healthResponses = 0;
  const delays = [];
  const fixture = versionedFixture({
    versionForPath: (url) => {
      if (url.pathname !== "/api/health") return expectedVersionId;
      healthResponses += 1;
      return healthResponses === 1 ? otherVersionId : expectedVersionId;
    }
  });
  const result = await smokeForecastInstance("https://surf.example", {
    label: "version smoke",
    expectedVersionId,
    expectedWorkerName,
    fetcher: fixture.fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    }
  });

  assert.equal(result.workerVersion, expectedVersionId);
  assert.equal(result.versionConvergenceRounds, 2);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(
    fixture.requests.map(({ url }) => `${url.pathname}${url.search}`),
    [
      "/api/health",
      "/api/health",
      "/api/spots",
      "/api/forecast/test-break?interval=3h",
      "/api/forecast/test-break?interval=1h"
    ]
  );
});

test("known version skew does not await a stalled response-body cancellation", async () => {
  let clock = 0;
  let healthRequests = 0;
  const delays = [];
  const fetcher = async (input) => {
    const url = new URL(String(input));
    const headers = { [SURF_WORKER_VERSION_HEADER]: expectedVersionId };
    if (url.pathname === "/api/health") {
      healthRequests += 1;
      if (healthRequests === 1) {
        return new Response(
          new ReadableStream({
            start() {},
            cancel() {
              return new Promise(() => {});
            }
          }),
          { headers: { [SURF_WORKER_VERSION_HEADER]: otherVersionId } }
        );
      }
      return Response.json({ status: "ok" }, { headers });
    }
    if (url.pathname === "/api/spots") {
      return Response.json({ spots: [spot] }, { headers });
    }
    return Response.json(
      {
        spot,
        interval: url.searchParams.get("interval") ?? "3h",
        windows
      },
      { headers }
    );
  };

  const result = await smokeForecastInstance("https://surf.example", {
    label: "version smoke",
    expectedVersionId,
    expectedWorkerName,
    fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    },
    requestTimeoutMs: 10,
    timeoutMs: 5_000
  });
  assert.equal(result.versionConvergenceRounds, 2);
  assert.equal(healthRequests, 2);
  assert.deepEqual(delays, [1_000]);
});

test("an exact-target HTTP defect fails fast without restarting", async () => {
  const requests = [];
  const delays = [];
  await assert.rejects(
    smokeForecastInstance("https://surf.example", {
      label: "version smoke",
      expectedVersionId,
      expectedWorkerName,
      sleep: async (delayMs) => delays.push(delayMs),
      fetcher: async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        const headers = { [SURF_WORKER_VERSION_HEADER]: expectedVersionId };
        if (url.pathname === "/api/health") {
          return Response.json({ status: "ok" }, { headers });
        }
        return Response.json({ error: "broken catalog" }, { status: 500, headers });
      }
    }),
    /version smoke \/api\/spots failed: 500/
  );
  assert.deepEqual(requests, ["/api/health", "/api/spots"]);
  assert.deepEqual(delays, []);
});

test("mid-forecast version skew restarts health, catalog, and every forecast", async () => {
  const spots = Array.from({ length: 6 }, (_, index) => ({
    id: `round-break-${index + 1}`,
    timezone: "America/Los_Angeles"
  }));
  let clock = 0;
  let round = 0;
  const requestCounts = new Map();
  const delays = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    if (url.pathname === "/api/health") round += 1;
    const staleMidRound =
      round === 1 &&
      url.pathname === "/api/forecast/round-break-4" &&
      url.searchParams.get("interval") === "1h";
    const headers = {
      [SURF_WORKER_VERSION_HEADER]: staleMidRound
        ? otherVersionId
        : expectedVersionId
    };
    assert.equal(
      new Headers(init.headers).get(CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER),
      null
    );
    assert.equal(new Headers(init.headers).get(workerVersionKeyHeader), null);
    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok" }, { headers });
    }
    if (url.pathname === "/api/spots") {
      return Response.json({ spots }, { headers });
    }
    const matchedSpot = spots.find(
      (candidate) => url.pathname === `/api/forecast/${candidate.id}`
    );
    if (!matchedSpot) return new Response("not found", { status: 404, headers });
    return Response.json({
      spot: matchedSpot,
      interval: url.searchParams.get("interval") ?? "3h",
      windows
    }, { headers });
  };

  const result = await smokeForecastInstance("https://surf.example", {
    label: "version smoke",
    expectedVersionId,
    expectedWorkerName,
    fetcher,
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    }
  });

  assert.equal(result.forecastReadModels, 12);
  assert.equal(result.versionConvergenceRounds, 2);
  assert.deepEqual(delays, [1_000]);
  assert.equal(requestCounts.get("/api/health"), 2);
  assert.equal(requestCounts.get("/api/spots"), 2);
  assert.equal(
    requestCounts.get("/api/forecast/round-break-1?interval=3h"),
    2,
    "an endpoint before the skew must be repeated in the clean round"
  );
  assert.equal(
    requestCounts.get("/api/forecast/round-break-4?interval=1h"),
    2
  );
  assert.equal(
    requestCounts.get("/api/forecast/round-break-6?interval=1h"),
    1,
    "an endpoint after the skew must run only in the clean round"
  );
});

test("persistent missing-version skew reaches the shared deadline with latest evidence", async () => {
  let clock = 0;
  let healthRequests = 0;
  const delays = [];
  await assert.rejects(
    smokeForecastInstance("https://surf.example", {
      label: "version smoke",
      expectedVersionId,
      expectedWorkerName,
      timeoutMs: 2_500,
      roundRetryIntervalMs: 1_000,
      now: () => clock,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        clock += delayMs;
      },
      fetcher: async () => {
        healthRequests += 1;
        return Response.json({ status: "ok" });
      }
    }),
    (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /within 2500ms after 3 round\(s\)/);
      assert.match(error.message, /path=\/api\/health/);
      assert.match(error.message, /actualWorkerVersion=missing/);
      assert.equal(error.cause?.path, "/api/health");
      assert.equal(error.cause?.actualVersionId, null);
      return true;
    }
  );
  assert.equal(healthRequests, 3);
  assert.deepEqual(delays, [1_000, 1_000, 500]);
});

test("smoke bounds a stalled fetch and aborts the request", async () => {
  let signal;
  let sleeps = 0;
  let requests = 0;
  await assert.rejects(
    smokeForecastInstance("https://surf.example", {
      label: "bounded smoke",
      expectedVersionId,
      expectedWorkerName,
      fetcher: async (_input, init) => {
        requests += 1;
        signal = init.signal;
        return new Promise(() => {});
      },
      sleep: async () => {
        sleeps += 1;
      },
      requestTimeoutMs: 5,
      timeoutMs: 20
    }),
    (error) => error?.name === "TimeoutError"
  );
  assert.equal(signal.aborted, true);
  assert.equal(requests, 1);
  assert.equal(sleeps, 0);
});

test("smoke bounds stalled response-body consumption", async () => {
  let signal;
  await assert.rejects(
    smokeForecastInstance("https://surf.example", {
      label: "bounded smoke",
      fetcher: async (_input, init) => {
        signal = init.signal;
        return new Response(
          new ReadableStream({
            start() {
              // Intentionally never emit or close.
            }
          })
        );
      },
      requestTimeoutMs: 5,
      timeoutMs: 20
    }),
    (error) => error?.name === "TimeoutError"
  );
  assert.equal(signal.aborted, true);
});

test("smoke inspects forecast read models sequentially", async () => {
  const spots = Array.from({ length: 6 }, (_, index) => ({
    id: `test-break-${index + 1}`,
    timezone: "America/Los_Angeles"
  }));
  let activeForecasts = 0;
  let maximumActiveForecasts = 0;
  let forecastRequests = 0;
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/health") return Response.json({ status: "ok" });
    if (url.pathname === "/api/spots") return Response.json({ spots });
    const matchedSpot = spots.find(
      (candidate) => url.pathname === `/api/forecast/${candidate.id}`
    );
    if (!matchedSpot) return new Response("not found", { status: 404 });
    forecastRequests += 1;
    activeForecasts += 1;
    maximumActiveForecasts = Math.max(maximumActiveForecasts, activeForecasts);
    await new Promise((resolve) => setImmediate(resolve));
    activeForecasts -= 1;
    return Response.json({
      spot: matchedSpot,
      interval: url.searchParams.get("interval") ?? "3h",
      windows
    });
  };

  const result = await smokeForecastInstance("https://surf.example", {
    label: "sequential smoke",
    fetcher,
    requestTimeoutMs: 100,
    timeoutMs: 2_000
  });
  assert.equal(result.forecastReadModels, 12);
  assert.equal(forecastRequests, 12);
  assert.equal(maximumActiveForecasts, 1);
});
