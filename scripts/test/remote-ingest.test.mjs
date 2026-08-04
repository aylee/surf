import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueAndWaitForRemoteIngest as enqueueAndWaitForRemoteIngestImplementation
} from "../lib/remote-ingest.mjs";
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
const legacyWorkerVersion = "69ae1d6c-4f4a-4e24-9167-2ee2a17244a8";
const workerVersionKeyHeader = "Cloudflare-Workers-Version-Key";
const silentLogger = { warn() {} };

function enqueueAndWaitForRemoteIngest(options) {
  return enqueueAndWaitForRemoteIngestImplementation({
    // Keep every pre-existing deploy-handoff test deterministic and outside
    // the hourly cron exclusion window. Individual cron tests override this.
    now: () => Date.parse(requestedAt),
    ...options
  });
}

function affinityKey(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function sequentialAffinityKeyFactory() {
  let index = 0;
  return () => affinityKey(++index);
}

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

function typedStaleVersionResponse({
  status = 409,
  responseVersion = staleWorkerVersion,
  payload = {
    error: "worker_version_mismatch",
    expectedWorkerVersion: workerVersion,
    actualWorkerVersion: responseVersion
  },
  contentType = "application/json",
  cfRay = "stale-ray"
} = {}) {
  const headers = new Headers({ "CF-Ray": cfRay });
  if (responseVersion !== null) {
    headers.set(SURF_WORKER_VERSION_HEADER, responseVersion);
  }
  if (contentType !== null) headers.set("Content-Type", contentType);
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Response(body, { status, headers });
}

function legacyPatchlessResponse({
  status = 404,
  responseVersion = legacyWorkerVersion,
  body = "404 Not Found",
  contentType = "text/plain; charset=UTF-8",
  cfRay = "legacy-ray"
} = {}) {
  const headers = new Headers({ "CF-Ray": cfRay });
  if (responseVersion !== null) {
    headers.set(SURF_WORKER_VERSION_HEADER, responseVersion);
  }
  if (contentType !== null) headers.set("Content-Type", contentType);
  return new Response(body, { status, headers });
}

function acceptedDeployResponse(overrides = {}, responseVersion = workerVersion) {
  const headers = { [SURF_WORKER_VERSION_HEADER]: responseVersion };
  return Response.json(
    {
      status: "accepted",
      ingestId: workerVersion,
      requestedAt,
      forecastGeneratedAt: requestedAt,
      region: "norcal",
      ...overrides
    },
    { status: 202, headers }
  );
}

const readinessDigest = "a".repeat(64);

function readinessRow({
  spotId = spot.id,
  interval,
  rowIngestId = ingestId,
  generatedAt = requestedAt,
  materializedAt = "2026-08-03T01:00:30.000Z",
  generationId = rowIngestId === null
    ? `sha256:${readinessDigest}`
    : `sha256:${readinessDigest}:ingest:${rowIngestId}`
}) {
  return {
    spotId,
    interval,
    generationId,
    ingestId: rowIngestId,
    generatedAt,
    materializedAt
  };
}

function missingReadinessRow(spotId, interval) {
  return {
    spotId,
    interval,
    generationId: null,
    ingestId: null,
    generatedAt: null,
    materializedAt: null
  };
}

function readinessRows(spots = [spot], options = {}) {
  return spots.flatMap(({ id: spotId }) =>
    ["3h", "1h"].map((interval) =>
      readinessRow({ spotId, interval, ...options })
    )
  );
}

function readinessResponse(
  forecastReadModels = readinessRows(),
  { responseVersion, status = 200, headers: initialHeaders } = {}
) {
  const headers = new Headers(initialHeaders);
  if (responseVersion) headers.set(SURF_WORKER_VERSION_HEADER, responseVersion);
  return Response.json({ forecastReadModels }, { status, headers });
}

function versionedReadinessResponse(spots = [spot], rowIngestId = workerVersion) {
  return readinessResponse(readinessRows(spots, { rowIngestId }), {
    responseVersion: workerVersion
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

async function successfulVersionedDeployAt(startedAt) {
  let clock = Date.parse(startedAt);
  const delays = [];
  const requests = [];
  const infoEvents = [];
  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    now: () => clock,
    sleep: async (delayMs) => {
      assert.equal(requests.length, 0, "cron deferral must precede every network request");
      delays.push(delayMs);
      clock += delayMs;
    },
    logger: {
      warn() {},
      info(message) {
        infoEvents.push(JSON.parse(message));
      }
    },
    fetcher: async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      requests.push({
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        at: clock,
        authorization: headers.get("Authorization")
      });
      if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
      if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
        return headers.has("Authorization")
          ? acceptedDeployResponse()
          : versionedUnauthorized();
      }
      if (url.pathname === "/api/forecast-readiness") {
        return readinessResponse(
          readinessRows([spot], { rowIngestId: workerVersion }),
          { responseVersion: workerVersion }
        );
      }
      return new Response("unexpected request", { status: 500 });
    }
  });
  return { result, clock, delays, requests, infoEvents };
}

test("versioned deploys defer before handoff when exact verification would overlap :17", async (t) => {
  const cases = [
    ["one millisecond before the protected window", "2026-08-04T06:04:59.999Z", 0],
    ["protected-window boundary", "2026-08-04T06:05:00.000Z", 22 * 60_000],
    ["observed failed-deploy time", "2026-08-04T06:13:19.808Z", 820_192],
    ["cron instant", "2026-08-04T06:17:00.000Z", 10 * 60_000],
    ["one millisecond before settle", "2026-08-04T06:26:59.999Z", 1],
    ["settle boundary", "2026-08-04T06:27:00.000Z", 0]
  ];

  for (const [name, startedAt, expectedDelayMs] of cases) {
    await t.test(name, async () => {
      const startedAtMs = Date.parse(startedAt);
      const { result, delays, requests, infoEvents } =
        await successfulVersionedDeployAt(startedAt);
      assert.equal(result.status, "published");
      assert.deepEqual(delays, expectedDelayMs === 0 ? [] : [expectedDelayMs]);
      assert.ok(requests.length > 0);
      assert.equal(requests[0].path, "/api/spots");
      assert.equal(requests[0].authorization, null);
      assert.equal(requests[0].at, startedAtMs + expectedDelayMs);
      assert.equal(
        requests.find((request) => request.authorization !== null)?.method,
        "PATCH"
      );
      assert.equal(infoEvents.length, expectedDelayMs === 0 ? 0 : 1);
      if (expectedDelayMs > 0) {
        assert.deepEqual(infoEvents[0], {
          event: "remote_ingest_cron_deferral",
          observedAt: new Date(startedAtMs).toISOString(),
          resumeAt: "2026-08-04T06:27:00.000Z",
          delayMs: expectedDelayMs,
          scheduledIngestMinute: 17,
          settleMs: 10 * 60_000,
          verificationTimeoutMs: 10 * 60_000,
          handoffTimeoutMs: 60_000
        });
      }
    });
  }
});

test("cron safety fails closed before networking when the wait ends early", async () => {
  let clock = Date.parse("2026-08-04T06:13:19.808Z");
  let networkRequests = 0;
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs - 1;
      },
      logger: silentLogger,
      fetcher: async () => {
        networkRequests += 1;
        return new Response("unexpected request", { status: 500 });
      }
    }),
    /cron-safety wait ended before the required settle boundary; mutation did not begin/
  );
  assert.equal(networkRequests, 0);
});

test("cron safety fails closed before networking when the wait overshoots into the next protected window", async () => {
  let clock = Date.parse("2026-08-04T06:13:19.808Z");
  let networkRequests = 0;
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs + 40 * 60_000;
      },
      logger: silentLogger,
      fetcher: async () => {
        networkRequests += 1;
        return new Response("unexpected request", { status: 500 });
      }
    }),
    /cron-safety wait did not reach a safe verification window; mutation did not begin/
  );
  assert.equal(networkRequests, 0);
});

test("cron safety rejects an unbounded verification window before networking", async () => {
  let networkRequests = 0;
  let sleeps = 0;
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      timeoutMs: 48 * 60_000,
      now: () => Date.parse("2026-08-04T06:27:00.000Z"),
      sleep: async () => {
        sleeps += 1;
      },
      fetcher: async () => {
        networkRequests += 1;
        return new Response("unexpected request", { status: 500 });
      }
    }),
    /verification window must be shorter than 3000000ms/
  );
  assert.equal(sleeps, 0);
  assert.equal(networkRequests, 0);
});

test("a clock jump after the initial guard expires before affinity or networking", async () => {
  const initialClock = Date.parse("2026-08-04T06:04:59.999Z");
  const jumpedClock = Date.parse("2026-08-04T06:16:30.000Z");
  let clockReads = 0;
  let catalogRequests = 0;
  let probePatches = 0;
  let authenticatedPatches = 0;
  let sleeps = 0;
  let affinityKeys = 0;

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      versionAffinityKeyFactory: () => {
        affinityKeys += 1;
        return affinityKey(affinityKeys);
      },
      now: () => (clockReads++ === 0 ? initialClock : jumpedClock),
      sleep: async () => {
        sleeps += 1;
      },
      logger: silentLogger,
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/spots") {
          catalogRequests += 1;
          return versionedJson({ spots: [spot] });
        }
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          if (new Headers(init.headers).has("Authorization")) {
            authenticatedPatches += 1;
            return acceptedDeployResponse();
          }
          probePatches += 1;
          return versionedUnauthorized();
        }
        return new Response("unexpected request", { status: 500 });
      }
    }),
    /remote ingest catalog handoff deadline reached.*no request-attributable Queue mutation was accepted/
  );

  assert.equal(catalogRequests, 0);
  assert.equal(probePatches, 0);
  assert.equal(authenticatedPatches, 0);
  assert.equal(sleeps, 0);
  assert.equal(affinityKeys, 0);
});

test("a final clock jump after the last handoff check fails before authenticated PATCH", async () => {
  const safeClock = Date.parse("2026-08-04T06:27:00.000Z");
  const jumpedClock = Date.parse("2026-08-04T07:16:30.000Z");
  let probeReturned = false;
  let postProbeClockReads = 0;
  let catalogRequests = 0;
  let probePatches = 0;
  let authenticatedPatches = 0;

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      now: () => {
        if (!probeReturned) return safeClock;
        postProbeClockReads += 1;
        return postProbeClockReads >= 4 ? jumpedClock : safeClock;
      },
      sleep: async () => {
        assert.fail("the client must not wait while holding an affinity session");
      },
      logger: silentLogger,
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/spots") {
          catalogRequests += 1;
          return versionedJson({ spots: [spot] });
        }
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          if (new Headers(init.headers).has("Authorization")) {
            authenticatedPatches += 1;
            return acceptedDeployResponse();
          }
          probePatches += 1;
          probeReturned = true;
          return versionedUnauthorized();
        }
        return new Response("unexpected request", { status: 500 });
      }
    }),
    /cron-safety window closed before authenticated PATCH.*mutation did not begin/
  );

  assert.equal(catalogRequests, 1);
  assert.equal(probePatches, 1);
  assert.equal(authenticatedPatches, 0);
  assert.equal(postProbeClockReads, 4);
});

test("remote ingest succeeds only after one aggregate snapshot exposes the exact lineage", async () => {
  let clock = Date.parse(requestedAt);
  let readinessRequests = 0;
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
    if (url.pathname === "/api/forecast-readiness") {
      readinessRequests += 1;
      const rows = [
        readinessRequests === 1
          ? missingReadinessRow(spot.id, "3h")
          : readinessRow({
              interval: "3h",
              materializedAt: "2026-08-03T01:01:00.000Z"
            }),
        readinessRequests === 2
          ? missingReadinessRow(spot.id, "1h")
          : readinessRow({ interval: "1h" })
      ];
      return readinessResponse(rows);
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
  assert.equal(result.attempts, 3);
  assert.equal(result.spots, 1);
  assert.equal(result.forecastReadModels, 2);
  assert.equal(result.materializedAt, "2026-08-03T01:01:00.000Z");
  assert.equal(readinessRequests, 3);
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
    if (url.pathname === "/api/forecast-readiness") {
      return readinessResponse([
        missingReadinessRow(spot.id, "3h"),
        missingReadinessRow(spot.id, "1h")
      ]);
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

test("remote ingest keeps polling a different lineage at the same generation time", async () => {
  let clock = Date.parse(requestedAt);
  let readinessRequests = 0;
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt, region: "norcal" },
        { status: 202 }
      );
    }
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/forecast-readiness") {
      readinessRequests += 1;
      return readinessResponse(
        readinessRows([spot], {
          rowIngestId: readinessRequests === 1 ? "different-ingest" : ingestId,
          materializedAt: "2026-08-03T01:05:30.000Z"
        })
      );
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
  assert.equal(readinessRequests, 2);
});

test("malformed successful readiness payloads fail closed", async (t) => {
  const cases = [
    [
      "generation identity",
      () => {
        const rows = readinessRows();
        rows[0].generationId = `sha256:${readinessDigest}:ingest:invalid lineage with spaces`;
        rows[0].ingestId = "invalid lineage with spaces";
        return readinessResponse(rows);
      },
      /generation identity is inconsistent/
    ],
    [
      "noncanonical timestamp",
      () => {
        const rows = readinessRows();
        rows[0].generatedAt = "2026-08-03T01:00:00Z";
        return readinessResponse(rows);
      },
      /timestamps are invalid/
    ],
    [
      "duplicate target",
      () => {
        const rows = readinessRows();
        return readinessResponse([rows[0], rows[0], rows[1]]);
      },
      /duplicate target test-break:3h/
    ],
    [
      "missing target",
      () => readinessResponse([readinessRows()[0]]),
      /missing targets: test-break:1h/
    ],
    [
      "extra target",
      () => readinessResponse([
        ...readinessRows(),
        readinessRow({ spotId: "unexpected-break", interval: "3h" })
      ]),
      /unexpected target unexpected-break:3h/
    ],
    [
      "partial missing metadata",
      () => {
        const rows = readinessRows();
        rows[0].generationId = null;
        return readinessResponse(rows);
      },
      /missing target test-break:3h has partial metadata/
    ],
    [
      "extra top-level field",
      () => Response.json({ forecastReadModels: readinessRows(), extra: true }),
      /expected only forecastReadModels/
    ],
    [
      "wrong content type",
      () => new Response(JSON.stringify({ forecastReadModels: readinessRows() }), {
        headers: { "Content-Type": "text/plain" }
      }),
      /content type must be application\/json/
    ]
  ];

  for (const [name, readinessResponseFactory, expectedError] of cases) {
    await t.test(name, async () => {
      let clock = Date.parse(requestedAt);
      let readinessRequests = 0;
      let sleeps = 0;
      const fetcher = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/ingest/once") {
          return Response.json(
            { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
            { status: 202 }
          );
        }
        if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
        if (url.pathname === "/api/forecast-readiness") {
          readinessRequests += 1;
          return readinessResponseFactory();
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
            sleeps += 1;
            clock += delayMs;
          },
          pollIntervalMs: 1,
          timeoutMs: 5
        }),
        expectedError
      );
      assert.equal(readinessRequests, 1);
      assert.equal(sleeps, 0);
    });
  }
});

test("five ready spots then a superseding cron lineage fail instead of mixing rounds", async () => {
  const spots = [
    "obsf-north",
    "obsf-central",
    "obsf-south",
    "linda-mar",
    "stinson",
    "bolinas"
  ].map((id) => ({ id, timezone: "America/Los_Angeles" }));
  const newerIngestId = "scheduled-ingest-after-deploy";
  const newerGeneratedAt = "2026-08-03T01:17:00.000Z";
  const olderGeneratedAt = "2026-08-03T00:17:00.000Z";
  let readinessRequests = 0;
  let individualForecastRequests = 0;
  let authenticatedPatches = 0;
  let sleeps = 0;

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      logger: silentLogger,
      sleep: async () => {
        sleeps += 1;
      },
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        const headers = new Headers(init.headers);
        if (url.pathname === "/api/spots") return versionedJson({ spots });
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          if (!headers.has("Authorization")) return versionedUnauthorized();
          authenticatedPatches += 1;
          return acceptedDeployResponse();
        }
        if (url.pathname === "/api/forecast-readiness") {
          readinessRequests += 1;
          const rows = readinessRows(spots, { rowIngestId: workerVersion });
          for (const row of rows) {
            if (row.spotId === "bolinas") {
              Object.assign(
                row,
                readinessRow({
                  spotId: row.spotId,
                  interval: row.interval,
                  rowIngestId: "scheduled-ingest-before-deploy",
                  generatedAt: olderGeneratedAt,
                  materializedAt: "2026-08-03T00:17:30.000Z"
                })
              );
            }
          }
          if (readinessRequests === 2) {
            rows[0] = readinessRow({
              spotId: "obsf-north",
              interval: "3h",
              rowIngestId: newerIngestId,
              generatedAt: newerGeneratedAt,
              materializedAt: "2026-08-03T01:17:30.000Z"
            });
          }
          return readinessResponse(rows, { responseVersion: workerVersion });
        }
        if (url.pathname.startsWith("/api/forecast/")) {
          individualForecastRequests += 1;
          return new Response("unexpected individual forecast request", { status: 500 });
        }
        return new Response("unexpected request", { status: 500 });
      }
    }),
    (error) => {
      assert.match(error.message, /was superseded before complete publication/);
      assert.match(error.message, /target=obsf-north:3h/);
      assert.match(error.message, new RegExp(`queued ingest ${workerVersion}`));
      assert.match(error.message, /expectedGeneratedAt=2026-08-03T01:00:00.000Z/);
      assert.match(error.message, /observedIngestId=scheduled-ingest-after-deploy/);
      assert.match(error.message, /observedGeneratedAt=2026-08-03T01:17:00.000Z/);
      assert.match(error.message, /must not be accepted as mixed-lineage success/);
      return true;
    }
  );

  assert.equal(authenticatedPatches, 1);
  assert.equal(sleeps, 1);
  assert.equal(readinessRequests, 2);
  assert.equal(individualForecastRequests, 0);
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
    if (url.pathname === "/api/forecast-readiness") {
      return readinessResponse(
        readinessRows([spot], { rowIngestId: workerVersion }),
        { responseVersion: workerVersion }
      );
    }
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
  assert.equal(result.versionAffinitySessions, 1);
  assert.equal(result.authenticatedAttempts, 1);
  assert.equal(result.forecastReadModels, 2);
  assert.deepEqual(
    requests.map(({ path, method }) => ({ path, method })),
    [
      { path: "/api/spots", method: "GET" },
      { path: "/api/ingest/once", method: "PATCH" },
      { path: "/api/ingest/once", method: "PATCH" },
      { path: "/api/forecast-readiness", method: "GET" }
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
  const handoffRequests = requests.filter(
    ({ path, method }) => path === "/api/spots" || method === "PATCH"
  );
  const versionAffinityKeys = handoffRequests.map(({ headers }) =>
    headers.get(workerVersionKeyHeader)
  );
  assert.match(versionAffinityKeys[0], /^[0-9a-f-]{36}$/i);
  assert.equal(
    new Set(versionAffinityKeys).size,
    1,
    "catalog, probe, and authenticated mutation must share one stable rollout key"
  );
  for (const request of requests.filter(
    ({ path, method }) => path !== "/api/spots" && method !== "PATCH"
  )) {
    assert.equal(request.headers.get(workerVersionKeyHeader), null);
  }
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

test("versioned catalog rotates stale and failed affinity sessions before freezing the target key", async () => {
  let clock = Date.parse(requestedAt);
  let catalogRequests = 0;
  let authenticatedPatches = 0;
  const handoffKeys = [];
  const delays = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (url.pathname === "/api/spots") {
      catalogRequests += 1;
      handoffKeys.push(headers.get(workerVersionKeyHeader));
      if (catalogRequests === 1) {
        return Response.json(
          { spots: [spot] },
          { headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion } }
        );
      }
      if (catalogRequests === 2) throw new TypeError("catalog route changed");
      return versionedJson({ spots: [spot] });
    }
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      handoffKeys.push(headers.get(workerVersionKeyHeader));
      if (!headers.has("Authorization")) return versionedUnauthorized();
      authenticatedPatches += 1;
      return acceptedDeployResponse();
    }
    if (url.pathname === "/api/forecast-readiness") {
      return versionedReadinessResponse();
    }
    return new Response("unexpected request", { status: 500 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    }
  });

  assert.equal(result.status, "published");
  assert.equal(result.versionAffinitySessions, 3);
  assert.equal(result.authenticatedAttempts, 1);
  assert.equal(catalogRequests, 3);
  assert.equal(authenticatedPatches, 1);
  assert.deepEqual(delays, [1_000, 1_000]);
  assert.deepEqual(handoffKeys, [
    affinityKey(1),
    affinityKey(2),
    affinityKey(3),
    affinityKey(3),
    affinityKey(3)
  ]);
});

test("a stalled stale-version catalog body rotates within the shared handoff clock", async () => {
  const startedAt = Date.parse(requestedAt);
  let clock = startedAt;
  let catalogRequests = 0;
  let authenticatedPatches = 0;
  let stalledCatalogSignal;
  let clockAtAuthenticatedPatch;
  const handoffKeys = [];
  const delays = [];
  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
    requestTimeoutMs: 5,
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    },
    fetcher: async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      if (url.pathname === "/api/spots") {
        catalogRequests += 1;
        handoffKeys.push(headers.get(workerVersionKeyHeader));
        if (catalogRequests === 1) {
          stalledCatalogSignal = init.signal;
          return hangingBodyResponse({
            headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion }
          });
        }
        return versionedJson({ spots: [spot] });
      }
      if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
        handoffKeys.push(headers.get(workerVersionKeyHeader));
        if (!headers.has("Authorization")) return versionedUnauthorized();
        authenticatedPatches += 1;
        clockAtAuthenticatedPatch = clock;
        return acceptedDeployResponse();
      }
      if (url.pathname === "/api/forecast-readiness") {
        return versionedReadinessResponse();
      }
      return new Response("unexpected request", { status: 500 });
    }
  });

  assert.equal(result.status, "published");
  assert.equal(result.versionAffinitySessions, 2);
  assert.equal(result.authenticatedAttempts, 1);
  assert.equal(stalledCatalogSignal.aborted, true);
  assert.equal(catalogRequests, 2);
  assert.equal(authenticatedPatches, 1);
  assert.equal(clockAtAuthenticatedPatch, startedAt + 1_000);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(handoffKeys, [
    affinityKey(1),
    affinityKey(2),
    affinityKey(2),
    affinityKey(2)
  ]);
});

test("a stale route probe discards its target-catalog session before authentication", async () => {
  let clock = Date.parse(requestedAt);
  let catalogRequests = 0;
  let probeRequests = 0;
  let authenticatedRequests = 0;
  const handoff = [];
  const delays = [];
  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    },
    fetcher: async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      const key = headers.get(workerVersionKeyHeader);
      if (url.pathname === "/api/spots") {
        catalogRequests += 1;
        handoff.push(["catalog", key]);
        return versionedJson({ spots: [spot] });
      }
      if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
        if (!headers.has("Authorization")) {
          probeRequests += 1;
          handoff.push(["probe", key]);
          return probeRequests === 1
            ? typedStaleVersionResponse({ status: 404, payload: "stale route" })
            : versionedUnauthorized();
        }
        authenticatedRequests += 1;
        handoff.push(["auth", key]);
        return acceptedDeployResponse();
      }
      if (url.pathname === "/api/forecast-readiness") {
        return versionedReadinessResponse();
      }
      return new Response("unexpected request", { status: 500 });
    }
  });

  assert.equal(result.status, "published");
  assert.equal(result.versionAffinitySessions, 2);
  assert.equal(result.authenticatedAttempts, 1);
  assert.equal(catalogRequests, 2);
  assert.equal(probeRequests, 2);
  assert.equal(authenticatedRequests, 1);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(handoff, [
    ["catalog", affinityKey(1)],
    ["probe", affinityKey(1)],
    ["catalog", affinityKey(2)],
    ["probe", affinityKey(2)],
    ["auth", affinityKey(2)]
  ]);
});

test("the exact target catalog fails fast on non-2xx or invalid schema", async (t) => {
  const invalidCatalogs = [
    versionedJson({ error: "unavailable" }, { status: 503 }),
    versionedJson({ spots: [] }),
    new Response("not-json", {
      headers: {
        "Content-Type": "application/json",
        [SURF_WORKER_VERSION_HEADER]: workerVersion
      }
    }),
    versionedJson({ spots: [spot, spot] }),
    versionedJson({ spots: [spot, { id: "" }] })
  ];

  for (const invalidCatalog of invalidCatalogs) {
    await t.test(`status ${invalidCatalog.status}`, async () => {
      let catalogRequests = 0;
      let patchRequests = 0;
      let sleeps = 0;
      await assert.rejects(
        enqueueAndWaitForRemoteIngest({
          baseUrl,
          token: "secret-token",
          expectedVersionId: workerVersion,
          expectedWorkerName: workerName,
          sleep: async () => {
            sleeps += 1;
          },
          fetcher: async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/spots") {
              catalogRequests += 1;
              return invalidCatalog.clone();
            }
            if (url.pathname === "/api/ingest/once") patchRequests += 1;
            return new Response("unexpected request", { status: 500 });
          }
        }),
        (error) => {
          assert.match(error.message, /remote ingest catalog failed: GET \/api\/spots/);
          assert.match(error.message, /expected Worker returned an invalid spot catalog/);
          assert.match(error.message, /mutation did not begin/);
          return true;
        }
      );
      assert.equal(catalogRequests, 1);
      assert.equal(patchRequests, 0);
      assert.equal(sleeps, 0);
    });
  }
});

test("target catalog HTTP and body defects never rotate to another affinity session", async (t) => {
  for (const [name, status] of [
    ["HTTP defect", 503],
    ["stalled success body", 200]
  ]) {
    await t.test(name, async () => {
      let affinitySessions = 0;
      let catalogRequests = 0;
      let patchRequests = 0;
      let sleeps = 0;
      await assert.rejects(
        enqueueAndWaitForRemoteIngest({
          baseUrl,
          token: "secret-token",
          expectedVersionId: workerVersion,
          expectedWorkerName: workerName,
          requestTimeoutMs: 5,
          versionAffinityKeyFactory: () => affinityKey(++affinitySessions),
          sleep: async () => {
            sleeps += 1;
          },
          fetcher: async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/spots") {
              catalogRequests += 1;
              return hangingBodyResponse({
                status,
                headers: { [SURF_WORKER_VERSION_HEADER]: workerVersion }
              });
            }
            if (url.pathname === "/api/ingest/once") patchRequests += 1;
            return new Response("unexpected request", { status: 500 });
          }
        }),
        (error) => {
          assert.match(error.message, /remote ingest catalog failed: GET \/api\/spots/);
          assert.match(error.message, /expected Worker returned an (invalid|unreadable) spot catalog/);
          assert.match(error.message, /mutation did not begin/);
          return true;
        }
      );
      assert.equal(affinitySessions, 1);
      assert.equal(catalogRequests, 1);
      assert.equal(patchRequests, 0);
      assert.equal(sleeps, 0);
    });
  }
});

test("typed stale-version rejection retries one fresh probe/auth pair with fixed backoff", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatches = 0;
  const patchKinds = [];
  const patchKeys = [];
  const catalogKeys = [];
  const delays = [];
  const warnings = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") {
      catalogKeys.push(new Headers(init.headers).get(workerVersionKeyHeader));
      return versionedJson({ spots: [spot] });
    }
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      const headers = new Headers(init.headers);
      const authenticated = headers.has("Authorization");
      patchKinds.push(authenticated ? "auth" : "probe");
      patchKeys.push(headers.get(workerVersionKeyHeader));
      if (!authenticated) return versionedUnauthorized();
      authenticatedPatches += 1;
      return authenticatedPatches === 1
        ? typedStaleVersionResponse()
        : acceptedDeployResponse();
    }
    if (url.pathname === "/api/forecast-readiness") {
      return versionedReadinessResponse();
    }
    return new Response("unexpected request", { status: 500 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
    logger: { warn: (message) => warnings.push(message) },
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    }
  });

  assert.equal(result.status, "published");
  assert.equal(result.versionAffinitySessions, 2);
  assert.equal(result.authenticatedAttempts, 2);
  assert.deepEqual(patchKinds, ["probe", "auth", "probe", "auth"]);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(patchKeys, [
    affinityKey(1),
    affinityKey(1),
    affinityKey(2),
    affinityKey(2)
  ]);
  assert.deepEqual(catalogKeys, [affinityKey(1), affinityKey(2)]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(warnings[0]), {
    event: "remote_ingest_safe_rejection",
    authenticatedAttempt: 1,
    kind: "typed-stale-409",
    status: 409,
    workerVersion: staleWorkerVersion,
    cfRay: "stale-ray",
    contentType: "application/json",
    body: JSON.stringify({
      error: "worker_version_mismatch",
      expectedWorkerVersion: workerVersion,
      actualWorkerVersion: staleWorkerVersion
    })
  });
  assert.doesNotMatch(warnings[0], /secret-token|Cloudflare-Workers-Version-Key/);
});

test("an explicitly named legacy PATCH-less version retries only its exact Hono 404 fingerprint", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatches = 0;
  let probePatches = 0;
  const patchKinds = [];
  const patchKeys = [];
  const delays = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      const headers = new Headers(init.headers);
      const authenticated = headers.has("Authorization");
      patchKinds.push(authenticated ? "auth" : "probe");
      patchKeys.push(headers.get(workerVersionKeyHeader));
      if (!authenticated) {
        probePatches += 1;
        if (probePatches === 2) return legacyPatchlessResponse();
        if (probePatches === 3) throw new TypeError("rollout route changed");
        return versionedUnauthorized();
      }
      authenticatedPatches += 1;
      return authenticatedPatches === 1
        ? legacyPatchlessResponse()
        : acceptedDeployResponse();
    }
    if (url.pathname === "/api/forecast-readiness") {
      return versionedReadinessResponse();
    }
    return new Response("unexpected request", { status: 500 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    fetcher,
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
    legacyPatchlessVersionId: legacyWorkerVersion,
    logger: silentLogger,
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    }
  });

  assert.equal(result.status, "published");
  assert.deepEqual(
    patchKinds,
    ["probe", "auth", "probe", "probe", "probe", "auth"]
  );
  assert.equal(authenticatedPatches, 2);
  assert.deepEqual(delays, [1_000, 1_000, 1_000]);
  assert.deepEqual(patchKeys, [
    affinityKey(1),
    affinityKey(1),
    affinityKey(2),
    affinityKey(3),
    affinityKey(4),
    affinityKey(4)
  ]);
});

test("handoff exhausts after three safe paired attempts and preserves bounded rejection evidence", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatches = 0;
  const patchKinds = [];
  const patchKeys = [];
  const delays = [];
  let forecastRequests = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      const headers = new Headers(init.headers);
      const authenticated = headers.has("Authorization");
      patchKinds.push(authenticated ? "auth" : "probe");
      patchKeys.push(headers.get(workerVersionKeyHeader));
      if (!authenticated) return versionedUnauthorized();
      authenticatedPatches += 1;
      return typedStaleVersionResponse({ cfRay: `stale-ray-${authenticatedPatches}` });
    }
    if (url.pathname.startsWith("/api/forecast/")) forecastRequests += 1;
    return new Response("unexpected request", { status: 500 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
      logger: silentLogger,
      now: () => clock,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        clock += delayMs;
      }
    }),
    (error) => {
      assert.match(error.message, /remote ingest handoff exhausted/);
      assert.match(error.message, /authenticatedAttempts=3\/3/);
      assert.match(error.message, /handoffElapsedMs=3000/);
      assert.match(error.message, /stale-ray-1/);
      assert.match(error.message, /stale-ray-2/);
      assert.match(error.message, /stale-ray-3/);
      assert.match(error.message, /contentType=application\/json/);
      assert.match(error.message, /body=\{"error":"worker_version_mismatch"/);
      assert.match(error.message, /no request-attributable Queue mutation was accepted/);
      return true;
    }
  );

  assert.equal(authenticatedPatches, 3);
  assert.deepEqual(patchKinds, ["probe", "auth", "probe", "auth", "probe", "auth"]);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.deepEqual(patchKeys, [
    affinityKey(1), affinityKey(1),
    affinityKey(2), affinityKey(2),
    affinityKey(3), affinityKey(3)
  ]);
  assert.equal(forecastRequests, 0);
});

test("one handoff deadline bounds retries and refuses a backoff that cannot fit", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatches = 0;
  const delays = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) {
        return versionedUnauthorized();
      }
      authenticatedPatches += 1;
      return typedStaleVersionResponse({ cfRay: `deadline-ray-${authenticatedPatches}` });
    }
    return new Response("unexpected request", { status: 500 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      logger: silentLogger,
      handoffTimeoutMs: 2_500,
      now: () => clock,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        clock += delayMs;
      }
    }),
    (error) => {
      assert.match(error.message, /remote ingest handoff deadline reached/);
      assert.match(error.message, /authenticatedAttempts=2\/3/);
      assert.match(error.message, /handoffElapsedMs=1000/);
      assert.match(error.message, /handoffRemainingMs=1500/);
      assert.match(error.message, /handoffDeadlineMs=2500/);
      return true;
    }
  );
  assert.equal(authenticatedPatches, 2);
  assert.deepEqual(delays, [1_000]);
});

test("a later stale-catalog deadline retains prior probe and safe-auth evidence without leaking session keys", async () => {
  let clock = Date.parse(requestedAt);
  let catalogRequests = 0;
  let authenticatedPatches = 0;
  const keys = [];
  const delays = [];
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
      logger: silentLogger,
      handoffTimeoutMs: 2_500,
      now: () => clock,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        clock += delayMs;
      },
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        const headers = new Headers(init.headers);
        const key = headers.get(workerVersionKeyHeader);
        if (url.pathname === "/api/spots") {
          catalogRequests += 1;
          keys.push(key);
          if (catalogRequests === 1) return versionedJson({ spots: [spot] });
          return new Response(`stale catalog reflected ${key}`, {
            status: 503,
            headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion }
          });
        }
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          if (!headers.has("Authorization")) return versionedUnauthorized();
          authenticatedPatches += 1;
          return typedStaleVersionResponse({ cfRay: "safe-before-catalog-ray" });
        }
        return new Response("unexpected request", { status: 500 });
      }
    }),
    (error) => {
      assert.match(error.message, /authenticatedAttempts=1\/3/);
      assert.match(error.message, /sessionCount=3 catalogCount=3 probeCount=1/);
      assert.match(error.message, /latestProbe=probe=1 status=401/);
      assert.match(error.message, /safe-before-catalog-ray/);
      assert.match(error.message, /body=stale catalog reflected \[REDACTED\]/);
      for (const key of keys) assert.doesNotMatch(error.message, new RegExp(key));
      return true;
    }
  );
  assert.equal(authenticatedPatches, 1);
  assert.deepEqual(delays, [1_000, 1_000]);
});

test("persistent stale probes consume the deadline without a second authenticated attempt", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatches = 0;
  let probePatches = 0;
  const delays = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) {
        probePatches += 1;
        return probePatches === 1
          ? versionedUnauthorized()
          : legacyPatchlessResponse({ cfRay: `probe-ray-${probePatches}` });
      }
      authenticatedPatches += 1;
      return legacyPatchlessResponse({ cfRay: "safe-auth-ray" });
    }
    return new Response("unexpected request", { status: 500 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      legacyPatchlessVersionId: legacyWorkerVersion,
      logger: silentLogger,
      handoffTimeoutMs: 3_500,
      now: () => clock,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        clock += delayMs;
      }
    }),
    (error) => {
      assert.match(error.message, /remote ingest handoff deadline reached/);
      assert.match(error.message, /authenticatedAttempts=1\/3/);
      assert.match(error.message, /probeCount=4/);
      assert.match(error.message, /latestProbe=probe=4 status=404/);
      assert.match(error.message, /probe-ray-4/);
      assert.match(error.message, /safe-auth-ray/);
      return true;
    }
  );
  assert.equal(authenticatedPatches, 1);
  assert.equal(probePatches, 4);
  assert.deepEqual(delays, [1_000, 1_000, 1_000]);
});

test("stale probes can exhaust the shared deadline before any authenticated attempt", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatches = 0;
  let probePatches = 0;
  const delays = [];
  const probeKeys = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      const headers = new Headers(init.headers);
      if (headers.has("Authorization")) {
        authenticatedPatches += 1;
      } else {
        probePatches += 1;
        probeKeys.push(headers.get(workerVersionKeyHeader));
      }
      return typedStaleVersionResponse({
        status: 404,
        payload: `stale route ${headers.get(workerVersionKeyHeader)}`
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
      expectedWorkerName: workerName,
      logger: silentLogger,
      handoffTimeoutMs: 2_500,
      now: () => clock,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        clock += delayMs;
      }
    }),
    (error) => {
      assert.match(
        error.message,
        /remote ingest handoff deadline reached: authenticatedAttempts=0\/3 sessionCount=3 catalogCount=3 probeCount=3/
      );
      assert.match(error.message, /body=stale route \[REDACTED\]/);
      for (const key of probeKeys) {
        assert.doesNotMatch(error.message, new RegExp(key));
      }
      return true;
    }
  );
  assert.equal(authenticatedPatches, 0);
  assert.equal(probePatches, 3);
  assert.deepEqual(delays, [1_000, 1_000]);
});

test("affinity session count is explicitly bounded even when an injected clock does not advance", async () => {
  let probePatches = 0;
  let authenticatedPatches = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (new Headers(init.headers).has("Authorization")) authenticatedPatches += 1;
      else probePatches += 1;
      return legacyPatchlessResponse();
    }
    return new Response("unexpected request", { status: 500 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      now: () => 0,
      sleep: async () => {}
    }),
    /remote ingest affinity session budget exhausted: authenticatedAttempts=0\/3 sessionCount=60 catalogCount=60 probeCount=60/
  );
  assert.equal(probePatches, 60);
  assert.equal(authenticatedPatches, 0);
});

test("stale and legacy near-misses are terminal and never receive a second authenticated PATCH", async (t) => {
  const terminalCases = [
    ["409 missing version header", () => typedStaleVersionResponse({ responseVersion: null })],
    ["409 malformed version header", () => typedStaleVersionResponse({ responseVersion: "not-a-uuid" })],
    ["409 target version header", () => typedStaleVersionResponse({ responseVersion: workerVersion })],
    ["409 non-JSON content type", () => typedStaleVersionResponse({ contentType: "text/plain" })],
    ["409 malformed JSON", () => typedStaleVersionResponse({ payload: "{not-json" })],
    [
      "409 extra JSON field",
      () => typedStaleVersionResponse({
        payload: {
          error: "worker_version_mismatch",
          expectedWorkerVersion: workerVersion,
          actualWorkerVersion: staleWorkerVersion,
          retryable: true
        }
      })
    ],
    [
      "409 wrong error type",
      () => typedStaleVersionResponse({
        payload: {
          error: "conflict",
          expectedWorkerVersion: workerVersion,
          actualWorkerVersion: staleWorkerVersion
        }
      })
    ],
    [
      "409 expected version mismatch",
      () => typedStaleVersionResponse({
        payload: {
          error: "worker_version_mismatch",
          expectedWorkerVersion: legacyWorkerVersion,
          actualWorkerVersion: staleWorkerVersion
        }
      })
    ],
    [
      "409 body/header version mismatch",
      () => typedStaleVersionResponse({
        payload: {
          error: "worker_version_mismatch",
          expectedWorkerVersion: workerVersion,
          actualWorkerVersion: legacyWorkerVersion
        }
      })
    ],
    ["404 without explicit legacy ID", () => legacyPatchlessResponse(), undefined],
    [
      "404 wrong legacy version",
      () => legacyPatchlessResponse({ responseVersion: staleWorkerVersion }),
      legacyWorkerVersion
    ],
    [
      "404 near-miss body",
      () => legacyPatchlessResponse({ body: "404 Not Found\n" }),
      legacyWorkerVersion
    ],
    [
      "404 near-miss content type",
      () => legacyPatchlessResponse({ contentType: "text/plain; charset=utf-8" }),
      legacyWorkerVersion
    ],
    [
      "redirect response",
      () => new Response("redirect", {
        status: 302,
        headers: {
          Location: "/api/ingest/once",
          [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion
        }
      })
    ],
    [
      "untyped server failure",
      () => new Response("unavailable", {
        status: 503,
        headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion }
      })
    ],
    [
      "unexpected success",
      () => new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion
        }
      })
    ],
    [
      "empty success",
      () => new Response(null, {
        status: 204,
        headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion }
      })
    ]
  ];

  for (const [name, responseFactory, legacyPatchlessVersionId] of terminalCases) {
    await t.test(name, async () => {
      let authenticatedPatches = 0;
      let totalPatches = 0;
      let sleeps = 0;
      let forecastRequests = 0;
      const fetcher = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          totalPatches += 1;
          if (!new Headers(init.headers).has("Authorization")) {
            return versionedUnauthorized();
          }
          authenticatedPatches += 1;
          return responseFactory();
        }
        if (url.pathname.startsWith("/api/forecast/")) forecastRequests += 1;
        return new Response("unexpected request", { status: 500 });
      };

      await assert.rejects(
        enqueueAndWaitForRemoteIngest({
          baseUrl,
          token: "secret-token",
          fetcher,
          expectedVersionId: workerVersion,
          expectedWorkerName: workerName,
          ...(legacyPatchlessVersionId ? { legacyPatchlessVersionId } : {}),
          sleep: async () => {
            sleeps += 1;
          }
        }),
        (error) => {
          assert.match(
            error.message,
            /remote ingest enqueue failed: PATCH \/api\/ingest\/once/
          );
          assert.match(error.message, /mutation may have occurred; do not retry/);
          return true;
        }
      );
      assert.equal(authenticatedPatches, 1);
      assert.equal(totalPatches, 2);
      assert.equal(sleeps, 0);
      assert.equal(forecastRequests, 0);
    });
  }
});

test("every 202 is terminal even when its body is malformed after a safe retry", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatches = 0;
  let totalRequests = 0;
  let forecastRequests = 0;
  const delays = [];
  const fetcher = async (input, init = {}) => {
    totalRequests += 1;
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) {
        return versionedUnauthorized();
      }
      authenticatedPatches += 1;
      if (authenticatedPatches === 1) return typedStaleVersionResponse();
      return new Response("not-json", {
        status: 202,
        headers: { [SURF_WORKER_VERSION_HEADER]: workerVersion }
      });
    }
    if (url.pathname.startsWith("/api/forecast/")) forecastRequests += 1;
    return new Response("request after terminal 202", { status: 500 });
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      logger: silentLogger,
      now: () => clock,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        clock += delayMs;
      }
    }),
    (error) => {
      assert.match(
        error.message,
        /remote ingest enqueue failed: PATCH \/api\/ingest\/once status=202/
      );
      assert.match(error.message, /mutation may have occurred; do not retry/);
      assert.match(
        error.message,
        /safeRejections=authenticatedAttempt=1 kind=typed-stale-409/
      );
      assert.match(error.message, /cfRay=stale-ray/);
      return true;
    }
  );
  assert.equal(authenticatedPatches, 2);
  assert.equal(
    totalRequests,
    6,
    "each safe authenticated rejection must start a fresh catalog/probe/auth session"
  );
  assert.deepEqual(delays, [1_000]);
  assert.equal(forecastRequests, 0);
});

test("legacy runtime input is validated before any request", async () => {
  for (const legacyPatchlessVersionId of ["not-a-uuid", workerVersion]) {
    let requests = 0;
    await assert.rejects(
      enqueueAndWaitForRemoteIngest({
        baseUrl,
        token: "secret-token",
        expectedVersionId: workerVersion,
        expectedWorkerName: workerName,
        legacyPatchlessVersionId,
        fetcher: async () => {
          requests += 1;
          return new Response("unexpected request");
        }
      }),
      /legacy patchless Worker version/
    );
    assert.equal(requests, 0);
  }
});

test("affinity session factory failures are terminal before authentication and never leak keys", async (t) => {
  await t.test("non-function", async () => {
    let requests = 0;
    await assert.rejects(
      enqueueAndWaitForRemoteIngest({
        baseUrl,
        token: "secret-token",
        expectedVersionId: workerVersion,
        expectedWorkerName: workerName,
        versionAffinityKeyFactory: "not-a-function",
        fetcher: async () => {
          requests += 1;
          return new Response("unexpected request");
        }
      }),
      /version affinity key factory must be a function/
    );
    assert.equal(requests, 0);
  });

  await t.test("invalid key", async () => {
    let requests = 0;
    await assert.rejects(
      enqueueAndWaitForRemoteIngest({
        baseUrl,
        token: "secret-token",
        expectedVersionId: workerVersion,
        expectedWorkerName: workerName,
        versionAffinityKeyFactory: () => "invalid-affinity-key",
        fetcher: async () => {
          requests += 1;
          return new Response("unexpected request");
        }
      }),
      (error) => {
        assert.match(error.message, /factory must return a UUID/);
        assert.doesNotMatch(error.message, /invalid-affinity-key|secret-token/);
        return true;
      }
    );
    assert.equal(requests, 0);
  });

  await t.test("reused key", async () => {
    let requests = 0;
    const reusedKey = affinityKey(1);
    await assert.rejects(
      enqueueAndWaitForRemoteIngest({
        baseUrl,
        token: "secret-token",
        expectedVersionId: workerVersion,
        expectedWorkerName: workerName,
        versionAffinityKeyFactory: () => reusedKey,
        sleep: async () => {},
        fetcher: async () => {
          requests += 1;
          return Response.json(
            { spots: [spot] },
            { headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion } }
          );
        }
      }),
      (error) => {
        assert.match(error.message, /reused a discarded session key/);
        assert.doesNotMatch(error.message, new RegExp(`${reusedKey}|secret-token`));
        return true;
      }
    );
    assert.equal(requests, 1);
  });
});

test("deploy route probe requires exact unauthorized method-path identity before enqueue", async () => {
  for (const probeResponse of [
    versionedJson({ error: "Unauthorized" }, { status: 404 }),
    versionedJson({ error: "Unauthorized" }, { status: 401 }),
    versionedJson({ status: "unexpected unauthenticated success" })
  ]) {
    let authenticatedPatches = 0;
    let totalPatches = 0;
    const fetcher = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
      if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
        totalPatches += 1;
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
      (error) => {
        assert.match(
          error.message,
          /remote ingest route probe failed: PATCH \/api\/ingest\/once/
        );
        if (probeResponse.status >= 200 && probeResponse.status < 300) {
          assert.match(error.message, /mutation may have occurred; do not retry/);
        } else {
          assert.match(error.message, /mutation did not begin/);
        }
        return true;
      }
    );
    assert.equal(authenticatedPatches, 0);
    assert.equal(totalPatches, 1);
  }
});

test("unauthenticated 2xx is terminal from headers even when its body never settles", async (t) => {
  for (const [name, responseVersion] of [
    ["target", workerVersion],
    ["stale", staleWorkerVersion],
    ["missing", null]
  ]) {
    await t.test(name, async () => {
      let affinitySessions = 0;
      let catalogRequests = 0;
      let probeRequests = 0;
      let authenticatedRequests = 0;
      let sleeps = 0;
      await assert.rejects(
        enqueueAndWaitForRemoteIngest({
          baseUrl,
          token: "secret-token",
          expectedVersionId: workerVersion,
          expectedWorkerName: workerName,
          requestTimeoutMs: 5,
          versionAffinityKeyFactory: () => affinityKey(++affinitySessions),
          sleep: async () => {
            sleeps += 1;
          },
          fetcher: async (input, init = {}) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/spots") {
              catalogRequests += 1;
              return versionedJson({ spots: [spot] });
            }
            if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
              if (new Headers(init.headers).has("Authorization")) {
                authenticatedRequests += 1;
                return acceptedDeployResponse();
              }
              probeRequests += 1;
              const headers = new Headers();
              if (responseVersion) {
                headers.set(SURF_WORKER_VERSION_HEADER, responseVersion);
              }
              return hangingBodyResponse({ status: 200, headers });
            }
            return new Response("unexpected request", { status: 500 });
          }
        }),
        (error) => {
          assert.match(
            error.message,
            /remote ingest route probe failed: PATCH \/api\/ingest\/once status=200/
          );
          assert.match(error.message, /body=<unread unauthenticated 2xx>/);
          assert.match(error.message, /mutation may have occurred; do not retry/);
          return true;
        }
      );
      assert.equal(affinitySessions, 1);
      assert.equal(catalogRequests, 1);
      assert.equal(probeRequests, 1);
      assert.equal(authenticatedRequests, 0);
      assert.equal(sleeps, 0);
    });
  }
});

test("the exact 401 Bearer probe advances from headers without awaiting its body", async () => {
  let probeRequests = 0;
  let authenticatedRequests = 0;
  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    requestTimeoutMs: 5,
    versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
    fetcher: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
      if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
        if (!new Headers(init.headers).has("Authorization")) {
          probeRequests += 1;
          return hangingBodyResponse({
            status: 401,
            headers: {
              [SURF_WORKER_VERSION_HEADER]: workerVersion,
              "WWW-Authenticate": "Bearer"
            }
          });
        }
        authenticatedRequests += 1;
        return acceptedDeployResponse();
      }
      if (url.pathname === "/api/forecast-readiness") {
        return versionedReadinessResponse();
      }
      return new Response("unexpected request", { status: 500 });
    }
  });

  assert.equal(result.status, "published");
  assert.equal(result.versionAffinitySessions, 1);
  assert.equal(probeRequests, 1);
  assert.equal(authenticatedRequests, 1);
});

test("target auth-contract defects fail from headers without rotating on a stalled body", async (t) => {
  for (const [name, status, authenticate] of [
    ["401 without Bearer", 401, null],
    ["target 503", 503, "Bearer"]
  ]) {
    await t.test(name, async () => {
      let affinitySessions = 0;
      let probeRequests = 0;
      let authenticatedRequests = 0;
      let sleeps = 0;
      await assert.rejects(
        enqueueAndWaitForRemoteIngest({
          baseUrl,
          token: "secret-token",
          expectedVersionId: workerVersion,
          expectedWorkerName: workerName,
          requestTimeoutMs: 5,
          versionAffinityKeyFactory: () => affinityKey(++affinitySessions),
          sleep: async () => {
            sleeps += 1;
          },
          fetcher: async (input, init = {}) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/spots") {
              return versionedJson({ spots: [spot] });
            }
            if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
              if (new Headers(init.headers).has("Authorization")) {
                authenticatedRequests += 1;
                return acceptedDeployResponse();
              }
              probeRequests += 1;
              const headers = new Headers({
                [SURF_WORKER_VERSION_HEADER]: workerVersion
              });
              if (authenticate) headers.set("WWW-Authenticate", authenticate);
              return hangingBodyResponse({ status, headers });
            }
            return new Response("unexpected request", { status: 500 });
          }
        }),
        (error) => {
          assert.match(
            error.message,
            new RegExp(`route probe failed: PATCH /api/ingest/once status=${status}`)
          );
          assert.match(error.message, /body=<unread target auth-contract defect>/);
          assert.match(error.message, /mutation did not begin/);
          return true;
        }
      );
      assert.equal(affinitySessions, 1);
      assert.equal(probeRequests, 1);
      assert.equal(authenticatedRequests, 0);
      assert.equal(sleeps, 0);
    });
  }
});

test("a deadline crossing before auth leaves the authenticated-attempt count at zero", async () => {
  let probeReturned = false;
  let postProbeClockReads = 0;
  let authenticatedRequests = 0;
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      now: () => {
        if (!probeReturned) return 0;
        postProbeClockReads += 1;
        return postProbeClockReads >= 3 ? 60_000 : 0;
      },
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          if (new Headers(init.headers).has("Authorization")) {
            authenticatedRequests += 1;
            return acceptedDeployResponse();
          }
          probeReturned = true;
          return versionedUnauthorized();
        }
        return new Response("unexpected request", { status: 500 });
      }
    }),
    (error) => {
      assert.match(error.message, /remote ingest handoff deadline reached/);
      assert.match(error.message, /authenticatedAttempts=0\/3/);
      assert.match(error.message, /no request-attributable Queue mutation was accepted/);
      return true;
    }
  );
  assert.equal(authenticatedRequests, 0);
  assert.equal(postProbeClockReads, 3);
});

test("probe transport failures poll safely while authenticated transport remains terminal", async () => {
  let clock = Date.parse(requestedAt);
  let recoveredCatalogRequests = 0;
  let probePatchRequests = 0;
  let authenticatedPatchRequests = 0;
  const recoveredHandoff = [];
  const delays = [];
  const recovered = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    },
    fetcher: async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      const key = headers.get(workerVersionKeyHeader);
      if (url.pathname === "/api/spots") {
        recoveredCatalogRequests += 1;
        recoveredHandoff.push(["catalog", key]);
        return versionedJson({ spots: [spot] });
      }
      if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
        if (!headers.has("Authorization")) {
          probePatchRequests += 1;
          recoveredHandoff.push(["probe", key]);
          if (probePatchRequests === 1) throw new TypeError("redirect rejected");
          return versionedUnauthorized();
        }
        authenticatedPatchRequests += 1;
        recoveredHandoff.push(["auth", key]);
        return acceptedDeployResponse();
      }
      if (url.pathname === "/api/forecast-readiness") {
        return versionedReadinessResponse();
      }
      return new Response("unexpected request", { status: 500 });
    }
  });
  assert.equal(recovered.status, "published");
  assert.equal(recovered.versionAffinitySessions, 2);
  assert.equal(recoveredCatalogRequests, 2);
  assert.equal(probePatchRequests, 2);
  assert.equal(authenticatedPatchRequests, 1);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(recoveredHandoff, [
    ["catalog", affinityKey(1)],
    ["probe", affinityKey(1)],
    ["catalog", affinityKey(2)],
    ["probe", affinityKey(2)],
    ["auth", affinityKey(2)]
  ]);

  authenticatedPatchRequests = 0;
  let failureClock = Date.parse(requestedAt);
  const failureDelays = [];
  let failedAffinityKey;
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      logger: silentLogger,
      now: () => failureClock,
      sleep: async (delayMs) => {
        failureDelays.push(delayMs);
        failureClock += delayMs;
      },
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
        if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
          const headers = new Headers(init.headers);
          if (!headers.has("Authorization")) {
            return versionedUnauthorized();
          }
          authenticatedPatchRequests += 1;
          if (authenticatedPatchRequests === 1) {
            return typedStaleVersionResponse();
          }
          failedAffinityKey = headers.get(workerVersionKeyHeader);
          throw new TypeError(
            `connection reset after send secret-token ${failedAffinityKey}`
          );
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
      assert.match(
        error.message,
        /safeRejections=authenticatedAttempt=1 kind=typed-stale-409/
      );
      assert.match(error.message, /cfRay=stale-ray/);
      assert.doesNotMatch(error.message, /secret-token/);
      assert.doesNotMatch(error.message, new RegExp(failedAffinityKey));
      assert.doesNotMatch(error.cause?.message ?? "", /secret-token/);
      assert.doesNotMatch(
        error.cause?.message ?? "",
        new RegExp(failedAffinityKey)
      );
      assert.equal(error.cause?.name, "TransportError");
      return true;
    }
  );
  assert.equal(authenticatedPatchRequests, 2);
  assert.deepEqual(failureDelays, [1_000]);
});

test("a stalled probe body is aborted and polled without consuming an authenticated attempt", async () => {
  let clock = Date.parse(requestedAt);
  let probePatches = 0;
  let authenticatedPatches = 0;
  let stalledProbeSignal;
  const delays = [];
  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token: "secret-token",
    expectedVersionId: workerVersion,
    expectedWorkerName: workerName,
    requestTimeoutMs: 5,
    now: () => clock,
    sleep: async (delayMs) => {
      delays.push(delayMs);
      clock += delayMs;
    },
    fetcher: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
      if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
        if (!new Headers(init.headers).has("Authorization")) {
          probePatches += 1;
          if (probePatches === 1) {
            stalledProbeSignal = init.signal;
            return hangingBodyResponse({
              status: 404,
              headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion }
            });
          }
          return versionedUnauthorized();
        }
        authenticatedPatches += 1;
        return acceptedDeployResponse();
      }
      if (url.pathname === "/api/forecast-readiness") {
        return versionedReadinessResponse();
      }
      return new Response("unexpected request", { status: 500 });
    }
  });

  assert.equal(result.status, "published");
  assert.equal(stalledProbeSignal.aborted, true);
  assert.equal(probePatches, 2);
  assert.equal(authenticatedPatches, 1);
  assert.deepEqual(delays, [1_000]);
});

test("deploy enqueue diagnostics preserve bounded text evidence without leaking the token", async () => {
  let reflectedAffinityKey;
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) return versionedUnauthorized();
      reflectedAffinityKey = new Headers(init.headers).get(workerVersionKeyHeader);
      return new Response(
        `upstream reflected secret-token ${reflectedAffinityKey}\nwith control\u0000bytes`,
        {
        status: 502,
        headers: {
          [SURF_WORKER_VERSION_HEADER]: workerVersion,
          "CF-Ray": "diagnostic-ray"
        }
        }
      );
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
        /status=502 workerVersion=9fdf8329-662b-4665-bc74-9b153dc3fc40 cfRay=diagnostic-ray body=upstream reflected \[REDACTED\] \[REDACTED\] with control bytes/
      );
      assert.doesNotMatch(error.message, /secret-token/);
      assert.doesNotMatch(error.message, new RegExp(reflectedAffinityKey));
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
  let clock = Date.parse(requestedAt);
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
      expectedWorkerName: workerName,
      handoffTimeoutMs: 2_500,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      }
    }),
    (error) => {
      assert.match(error.message, /remote ingest handoff deadline reached/);
      assert.match(error.message, /latestProbe=probe=3 status=404/);
      assert.match(error.message, /workerVersion=ea3a7a1e-3c43-4aca-9517-dbe1ff562746/);
      assert.match(error.message, /cfRay=predecessor-ray/);
      assert.match(error.message, /body=not found/);
      return true;
    }
  );
  assert.equal(deployPatches, 3);
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

test("persistent stale catalog routing reaches the shared deadline with zero PATCH requests", async () => {
  let clock = Date.parse(requestedAt);
  let catalogCount = 0;
  let patchCount = 0;
  const catalogKeys = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/ingest/once") patchCount += 1;
    if (url.pathname === "/api/spots") {
      catalogCount += 1;
      catalogKeys.push(new Headers(init.headers).get(workerVersionKeyHeader));
    }
    return Response.json(
      { spots: [spot] },
      {
        headers: {
          [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion,
          "CF-Ray": `catalog-ray-${catalogCount}`
        }
      }
    );
  };

  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher,
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
      handoffTimeoutMs: 2_500,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      }
    }),
    (error) => {
      assert.match(error.message, /remote ingest catalog handoff deadline reached/);
      assert.match(
        error.message,
        /authenticatedAttempts=0\/3 sessionCount=3 catalogCount=3/
      );
      assert.match(error.message, /handoffElapsedMs=2000/);
      assert.match(error.message, /handoffRemainingMs=500/);
      assert.match(error.message, /handoffDeadlineMs=2500/);
      assert.match(error.message, /latestCatalog=catalog=3 status=200/);
      assert.match(error.message, /catalog-ray-3/);
      assert.match(
        error.message,
        /no request-attributable Queue mutation was accepted/
      );
      return true;
    }
  );
  assert.equal(catalogCount, 3);
  assert.deepEqual(catalogKeys, [affinityKey(1), affinityKey(2), affinityKey(3)]);
  assert.equal(patchCount, 0);
});

test("catalog transport diagnostics redact every discarded affinity key", async () => {
  let clock = Date.parse(requestedAt);
  const keys = [];
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      expectedVersionId: workerVersion,
      expectedWorkerName: workerName,
      versionAffinityKeyFactory: sequentialAffinityKeyFactory(),
      handoffTimeoutMs: 2_500,
      now: () => clock,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      fetcher: async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/spots") {
          const key = new Headers(init.headers).get(workerVersionKeyHeader);
          keys.push(key);
          throw new TypeError(`catalog transport reflected ${key}`);
        }
        return new Response("unexpected request", { status: 500 });
      }
    }),
    (error) => {
      assert.match(
        error.message,
        /requestError=TransportError: forecast transport failed: catalog transport reflected \[REDACTED\]/
      );
      for (const key of keys) assert.doesNotMatch(error.message, new RegExp(key));
      return true;
    }
  );
  assert.equal(keys.length, 3);
});

test("exact Cloudflare 1102 responses are bounded pending while near-misses fail closed", async () => {
  let clock = Date.parse(requestedAt);
  let readinessRequests = 0;
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
    if (url.pathname === "/api/forecast-readiness") {
      readinessRequests += 1;
      if (readinessRequests === 1) {
        return Response.json(
          {
            error: "forecast_readiness_unavailable",
            message: "Forecast readiness is temporarily unavailable.",
            retryable: true
          },
          { status: 503 }
        );
      }
      if (readinessRequests === 2) {
        return Response.json(cloudflare1102, { status: 503 });
      }
      return readinessResponse();
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
  assert.equal(result.attempts, 3);

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
    /invalid 503 response/
  );

  const typedWrongContentTypeFetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        { status: 202 }
      );
    }
    return new Response(
      JSON.stringify({
        error: "forecast_readiness_unavailable",
        message: "Forecast readiness is temporarily unavailable.",
        retryable: true
      }),
      { status: 503, headers: { "Content-Type": "text/plain" } }
    );
  };
  await assert.rejects(
    enqueueAndWaitForRemoteIngest({
      baseUrl,
      token: "secret-token",
      fetcher: typedWrongContentTypeFetcher,
      pollIntervalMs: 5,
      timeoutMs: 20
    }),
    /invalid 503 response/
  );
});

test("publication polling uses one aggregate snapshot request per attempt", async () => {
  let readinessRequests = 0;
  let individualForecastRequests = 0;
  const fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return Response.json({ spots: [spot] });
    if (url.pathname === "/api/ingest/once") {
      return Response.json(
        { status: "accepted", ingestId, requestedAt, forecastGeneratedAt: requestedAt },
        { status: 202 }
      );
    }
    if (url.pathname === "/api/forecast-readiness") {
      readinessRequests += 1;
      return readinessResponse();
    }
    if (url.pathname.startsWith("/api/forecast/")) {
      individualForecastRequests += 1;
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
  assert.equal(readinessRequests, 1);
  assert.equal(individualForecastRequests, 0);
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
  assert.equal(abortedForecasts, 1);
});

test("transient forecast transport failures stay bounded and recover without reenqueuing", async () => {
  let clock = Date.parse(requestedAt);
  let postCount = 0;
  let readinessAttempts = 0;
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
    if (url.pathname === "/api/forecast-readiness") {
      readinessAttempts += 1;
      if (readinessAttempts === 1) throw new TypeError("fetch failed");
      return readinessResponse();
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
  assert.equal(postCount, 1);
  assert.equal(readinessAttempts, 2);
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

test("wrong-version readiness snapshots never satisfy publication", async () => {
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

test("wrong-version readiness errors stay pending until the target Worker publishes", async () => {
  let clock = Date.parse(requestedAt);
  let authenticatedPatchCount = 0;
  let readinessAttempts = 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/spots") return versionedJson({ spots: [spot] });
    if (url.pathname === "/api/ingest/once" && init.method === "PATCH") {
      if (!new Headers(init.headers).has("Authorization")) {
        return versionedUnauthorized();
      }
      authenticatedPatchCount += 1;
      return acceptedDeployResponse();
    }
    if (url.pathname === "/api/forecast-readiness") {
      readinessAttempts += 1;
      if (readinessAttempts === 1) {
        return new Response("stale route", {
          status: 404,
          headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion }
        });
      }
      if (readinessAttempts === 2) {
        return Response.json(
          { error: "not_the_target_contract" },
          {
            status: 503,
            headers: { [SURF_WORKER_VERSION_HEADER]: staleWorkerVersion }
          }
        );
      }
      return versionedReadinessResponse();
    }
    return new Response("unexpected request", { status: 500 });
  };

  const result = await enqueueAndWaitForRemoteIngest({
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
    timeoutMs: 30
  });

  assert.equal(result.status, "published");
  assert.equal(result.attempts, 3);
  assert.equal(authenticatedPatchCount, 1);
  assert.equal(readinessAttempts, 3);
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
