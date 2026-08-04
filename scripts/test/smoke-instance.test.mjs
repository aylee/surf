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

test("version-pinned smoke rejects a mismatched health response", async () => {
  const fixture = versionedFixture({
    versionForPath: (url) =>
      url.pathname === "/api/health" ? otherVersionId : expectedVersionId
  });
  await assert.rejects(
    smokeForecastInstance("https://surf.example", {
      label: "version smoke",
      expectedVersionId,
      expectedWorkerName,
      fetcher: fixture.fetcher
    }),
    new RegExp(`/api/health was served by Worker version ${otherVersionId}`)
  );
});

test("version-pinned smoke rejects a mismatched catalog response", async () => {
  const fixture = versionedFixture({
    versionForPath: (url) =>
      url.pathname === "/api/spots" ? otherVersionId : expectedVersionId
  });
  await assert.rejects(
    smokeForecastInstance("https://surf.example", {
      label: "version smoke",
      expectedVersionId,
      expectedWorkerName,
      fetcher: fixture.fetcher
    }),
    new RegExp(`/api/spots was served by Worker version ${otherVersionId}`)
  );
});

test("version-pinned smoke rejects any mismatched forecast response", async () => {
  const fixture = versionedFixture({
    versionForPath: (url) =>
      url.pathname === "/api/forecast/test-break" &&
      url.searchParams.get("interval") === "1h"
        ? otherVersionId
        : expectedVersionId
  });
  await assert.rejects(
    smokeForecastInstance("https://surf.example", {
      label: "version smoke",
      expectedVersionId,
      expectedWorkerName,
      fetcher: fixture.fetcher
    }),
    new RegExp(`interval=1h was served by Worker version ${otherVersionId}`)
  );
});

test("smoke bounds a stalled fetch and aborts the request", async () => {
  let signal;
  await assert.rejects(
    smokeForecastInstance("https://surf.example", {
      label: "bounded smoke",
      fetcher: async (_input, init) => {
        signal = init.signal;
        return new Promise(() => {});
      },
      requestTimeoutMs: 5,
      timeoutMs: 20
    }),
    (error) => error?.name === "TimeoutError"
  );
  assert.equal(signal.aborted, true);
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
