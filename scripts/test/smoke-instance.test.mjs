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
    const path = new URL(String(input)).pathname;
    if (path === "/api/health") return Response.json({ status: "ok" });
    if (path === "/api/spots") return Response.json({ spots: [spot] });
    if (path === "/api/forecast/test-break") {
      return Response.json({ spot, windows: forecastWindows });
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
    assert.equal(result.dataCheck, "scored forecasts present");
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
