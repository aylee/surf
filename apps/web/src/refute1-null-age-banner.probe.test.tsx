/**
 * @vitest-environment jsdom
 *
 * TEMPORARY PROBE (refuter #1) — DO NOT COMMIT.
 * Feeds the App the exact placeholder entry the worker ships for a buoyless
 * spot (ndbc:preferred, null age, declared cadence 60/60) and a pre-cadence
 * entry, and reports whether the dashboard banner fires.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ForecastResponseSchema,
  type ApiSpot,
  type ForecastResponse,
  type SpotsResponse
} from "@surf/contracts";
import { getSpotProfile } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { App } from "./App";

const referenceSpot = getSpotProfile("bolinas");

const spot = {
  ...referenceSpot,
  id: "test-break",
  name: "Test Break",
  sourceMap: {
    nwsWaveGrid: {
      provider: "NOAA/NWS MTR",
      forecastGridData: "https://api.weather.gov/gridpoints/MTR/85,105",
      breakingHeightScale: 1,
      notes: "DOM-test source summary."
    },
    observedWave: [{ provider: "NDBC", stationId: "46237", name: "San Francisco Bar" }],
    coopsTide: { stationId: "9414958", name: "Bolinas Lagoon" }
  }
} satisfies ApiSpot;

const spotsResponse = {
  spots: [spot],
  sourceNote: "DOM-test catalog."
} satisfies SpotsResponse;

function fixtureForecast(forecastSpot: ApiSpot = spot): ForecastResponse {
  const fixture = buildFixtureForecast("bolinas");
  return ForecastResponseSchema.parse({
    ...fixture,
    spot: forecastSpot,
    windows: fixture.windows.map((window) => ({ ...window, spotId: forecastSpot.id }))
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

function requestPath(input: URL | RequestInfo): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.pathname : input.url;
}

function installApi(forecast: ForecastResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    })
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("probe: banner suppression invariants", () => {
  it("PROBE A: buoyless-spot placeholder (null age, cadence 60/60) must not fire the banner", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const payload = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === 0
          ? [
              {
                // Healthy wave source: fresh, well within cadence.
                capability: "forecast_wave_nearshore",
                sourceId: "cdip:mop:SF-001",
                sourceRunId: "wave-run",
                updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
                freshnessMinutes: 30,
                status: "fresh",
                expectedCadenceMinutes: 360,
                graceMinutes: 180
              },
              {
                // Exactly what worker/forecast.ts ships when no NDBC
                // observation exists for the spot's preferred station.
                capability: "observed_wave",
                sourceId: "ndbc:preferred",
                sourceRunId: null,
                updatedAt: null,
                freshnessMinutes: null,
                status: "missing",
                expectedCadenceMinutes: 60,
                graceMinutes: 60
              }
            ]
          : window.sourceFreshness
      }))
    });
    installApi(payload);

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector(".noticeBanner")).toBeNull();
    });
  });

  it("PROBE B: pre-cadence entry (no expectedCadenceMinutes) must not fire the banner", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const payload = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === 0
          ? [
              {
                // Pre-cadence read-model row: shipped status stale, huge age,
                // but no declared cadence. Client must keep shipped status
                // and never locally re-judge it into a late banner.
                capability: "observed_wave",
                sourceId: "ndbc-46237",
                sourceRunId: "obs-run",
                updatedAt: new Date(Date.now() - 500 * 60_000).toISOString(),
                freshnessMinutes: 500,
                status: "stale"
              }
            ]
          : window.sourceFreshness
      }))
    });
    installApi(payload);

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector(".noticeBanner")).toBeNull();
    });
  });
});
