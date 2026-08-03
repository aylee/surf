import assert from "node:assert/strict";
import test from "node:test";
import { smokeForecastInstance } from "../lib/smoke-instance.mjs";

const spot = { id: "test-break", timezone: "America/Los_Angeles" };
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
