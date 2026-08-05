/**
 * @vitest-environment jsdom
 *
 * TEMPORARY refuter-3 probe — deleted after run.
 * Feeds the exact placeholder entry the Worker ships for a missing preferred
 * NDBC observation (sourceId "ndbc:preferred", freshnessMinutes null, status
 * "missing", declared cadence 60/60) through the App banner path and asserts
 * no notice banner renders.
 */

import { cleanup, render, screen } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("refuter-3 probe: placeholder and pre-cadence entries through the banner path", () => {
  it("null-age ndbc:preferred placeholder with declared cadence never banners", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const placeholderForecast = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === 0
          ? [{
              capability: "observed_wave",
              sourceId: "ndbc:preferred",
              sourceRunId: null,
              updatedAt: null,
              freshnessMinutes: null,
              status: "missing",
              expectedCadenceMinutes: 60,
              graceMinutes: 60
            }]
          : window.sourceFreshness
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(placeholderForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".noticeBanner")).toBeNull();
  });

  it("pre-cadence entry (no expectedCadenceMinutes) never banners", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const preCadenceForecast = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === 0
          ? [{
              capability: "observed_wave",
              sourceId: "ndbc-46237",
              sourceRunId: "obs-run",
              updatedAt: new Date(Date.now() - 500 * 60_000).toISOString(),
              freshnessMinutes: 500,
              status: "stale"
            }]
          : window.sourceFreshness
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(preCadenceForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".noticeBanner")).toBeNull();
  });
});
