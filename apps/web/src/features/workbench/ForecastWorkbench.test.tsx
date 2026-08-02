/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ForecastResponseSchema, type ApiSpot, type ForecastResponse } from "@surf/contracts";
import { getSpotProfile, selectCanonicalRecommendationIds } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptForecastResponse } from "./forecast-adapter";
import { ForecastWorkbench } from "./ForecastWorkbench";

const now = new Date("2026-08-02T07:00:00.000Z");
const canonicalThreeHourAt = "2026-08-02T16:00:00.000Z";
const hourlyChallengerAt = "2026-08-02T17:00:00.000Z";
const profile = getSpotProfile("bolinas");
const spot = {
  ...profile,
  sourceMap: {
    nwsWaveGrid: {
      provider: "NOAA/NWS MTR",
      forecastGridData: "https://api.weather.gov/gridpoints/MTR/85,105",
      breakingHeightScale: 1,
      notes: "Test source"
    },
    observedWave: [{ provider: "NDBC", stationId: "46237", name: "San Francisco Bar" }],
    coopsTide: { stationId: "9414958", name: "Bolinas Lagoon" }
  }
} satisfies ApiSpot;

function fixtureForecast(): ForecastResponse {
  const fixture = buildFixtureForecast("bolinas", now);
  return ForecastResponseSchema.parse({
    ...fixture,
    interval: "3h",
    windows: fixture.windows.map((window) => ({
      ...window,
      sourceFreshness: [
        {
          capability: "forecast_wave_offshore",
          sourceId: "wave:test",
          sourceRunId: "wave-run",
          updatedAt: "2026-08-02T06:40:00.000Z",
          freshnessMinutes: 20,
          status: "fresh"
        },
        {
          capability: "observed_wave",
          sourceId: "buoy:test",
          sourceRunId: null,
          updatedAt: null,
          freshnessMinutes: null,
          status: "missing"
        }
      ]
    }))
  });
}

function canonicalThreeHourForecast(): ForecastResponse {
  const fixture = fixtureForecast();
  return ForecastResponseSchema.parse({
    ...fixture,
    interval: "3h",
    windows: fixture.windows.map((window) => ({
      ...window,
      surfaceCondition: window.forecastAt === canonicalThreeHourAt ? "clean" : "choppy",
      score: window.forecastAt === canonicalThreeHourAt ? 82 : 12,
      confidence: window.forecastAt === canonicalThreeHourAt ? 88 : 60
    }))
  });
}

function hourlyForecastWithLocalChallenger(threeHour: ForecastResponse): ForecastResponse {
  const localDayStart = new Date("2026-08-02T07:00:00.000Z").getTime();
  const hourMs = 60 * 60 * 1000;
  const windows = Array.from({ length: 24 }, (_, localHour) => {
    const forecastAt = new Date(localDayStart + localHour * hourMs).toISOString();
    const sourceHour = Math.floor(localHour / 3) * 3;
    const validFrom = new Date(localDayStart + sourceHour * hourMs).toISOString();
    const validTo = new Date(localDayStart + (sourceHour + 3) * hourMs).toISOString();
    const source = threeHour.windows.find((window) => window.forecastAt === validFrom);
    if (!source) throw new Error(`Missing three-hour source window for ${validFrom}`);
    const isChallenger = forecastAt === hourlyChallengerAt;
    return {
      ...source,
      forecastAt,
      surfaceCondition: isChallenger ? "clean" as const : "choppy" as const,
      score: isChallenger ? 100 : 5,
      confidence: isChallenger ? 100 : 55,
      waveState: {
        semantics: "nws_fallback" as const,
        calibrationStatus: "cold_start_uncalibrated" as const,
        validFrom,
        validTo,
        sourceResolutionHours: 3,
        modeledNearshoreHeightFt: source.waveHeightFt,
        breakingSurfHeightFt: null,
        periodSec: source.peakPeriodSec,
        directionDeg: source.primaryDirectionDeg
      },
      resolution: {
        wave: {
          sourceIntervalMinutes: 180,
          displayIntervalMinutes: 60,
          method: localHour % 3 === 0 ? "exact" as const : "held" as const,
          validFrom,
          validTo
        },
        wind: {
          sourceIntervalMinutes: 60,
          displayIntervalMinutes: 60,
          method: "exact" as const,
          validFrom: forecastAt,
          validTo: new Date(new Date(forecastAt).getTime() + hourMs).toISOString()
        },
        tide: {
          sourceIntervalMinutes: 60,
          displayIntervalMinutes: 60,
          method: "exact" as const,
          validFrom: forecastAt,
          validTo: new Date(new Date(forecastAt).getTime() + hourMs).toISOString()
        }
      }
    };
  });
  return ForecastResponseSchema.parse({ ...threeHour, interval: "1h", windows });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("ForecastWorkbench", () => {
  it("keeps the canonical three-hour recommendation after switching to a locally stronger hourly row", async () => {
    const threeHour = canonicalThreeHourForecast();
    const oneHour = hourlyForecastWithLocalChallenger(threeHour);
    const adaptedHourly = adaptForecastResponse(oneHour, spot, "1h");
    const hourlyWinner = selectCanonicalRecommendationIds(
      adaptedHourly.windows.map((window) => ({
        windowId: window.forecastAt,
        forecastAt: window.forecastAt,
        isDaylight: window.isDaylight,
        ratingStatus: window.raw.ratingStatus,
        surfaceCondition: window.condition,
        score: window.raw.score,
        confidence: window.confidence
      })),
      now
    )[0];
    expect(hourlyWinner).toBe(hourlyChallengerAt);

    window.history.replaceState({}, "", "/?spot=bolinas");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.includes("interval=1h")) return jsonResponse(oneHour);
      if (url.includes("interval=3h")) return jsonResponse(threeHour);
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={threeHour} now={now} />);

    expect(await screen.findByRole("heading", { name: "9:00 AM is the clearest daylight window" })).toBeTruthy();
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("at")).toBe(canonicalThreeHourAt);
    });

    fireEvent.click(screen.getByRole("radio", { name: "One-hour resolution" }));

    expect(await screen.findByRole("table", { name: /One-hour surf-planning inputs for Bolinas/ })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId(`forecast-row-${canonicalThreeHourAt}`).classList.contains("selectedRow")).toBe(true);
      expect(screen.getByTestId(`forecast-row-${hourlyChallengerAt}`).classList.contains("selectedRow")).toBe(false);
      const params = new URLSearchParams(window.location.search);
      expect(params.get("interval")).toBe("1h");
      expect(params.get("at")).toBe(canonicalThreeHourAt);
    });
    expect(screen.getByRole("heading", { name: "9:00 AM is the clearest daylight window" })).toBeTruthy();
  });

  it("labels stale deterministic briefs, shows selected-source states, and lets a phone row collapse", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({
      status: "stale",
      fallbackReason: "Forecast inputs changed materially.",
      availableRevisions: 4,
      brief: {
        provider: "deterministic",
        headline: "Use the current deterministic read",
        setup: "The prior model brief no longer matches the public inputs.",
        revision: 4,
        generatedAt: "2026-08-02T07:05:00.000Z",
        picks: [{
          windowId: "window:1",
          label: "First-light option",
          why: "The supported score leads.",
          tradeoff: "The buoy observation is missing.",
          factRefs: ["window:1"]
        }],
        bustFactors: [],
        lesson: { topic: "Freshness", text: "Read source state per selected time.", factRefs: ["source:1"] }
      }
    })));

    const { container } = render(
      <ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />
    );

    expect(await screen.findByText("Stale · deterministic")).toBeTruthy();
    expect(screen.getByText("Forecast inputs changed materially.")).toBeTruthy();
    expect(screen.getByText("First-light option")).toBeTruthy();
    expect(screen.getByText(/Generated Aug 2/)).toBeTruthy();
    expect(screen.queryByText("AI explanation")).toBeNull();
    expect(screen.queryByText("Revision 4")).toBeNull();

    fireEvent.click(screen.getByText("Data, confidence & provenance").closest("button")!);
    expect(await screen.findByText("Fresh")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();

    let expandedTrigger: HTMLButtonElement | null = null;
    await waitFor(() => {
      expandedTrigger = container.querySelector(
        ".mobileForecastRows .uiAccordionTrigger[data-state='open']"
      );
      expect(expandedTrigger).toBeTruthy();
    });
    fireEvent.click(expandedTrigger!);
    await waitFor(() => expect(expandedTrigger?.getAttribute("data-state")).toBe("closed"));
    expect(container.querySelector(".mobileForecastRows .uiAccordionItem.selectedRow")).toBeTruthy();
  });

  it("invalidates and refetches the active hourly cache when the canonical forecast changes", async () => {
    const firstThreeHour = canonicalThreeHourForecast();
    const refreshedThreeHour = ForecastResponseSchema.parse({
      ...firstThreeHour,
      generatedAt: "2026-08-02T08:00:00.000Z"
    });
    const oneHour = hourlyForecastWithLocalChallenger(firstThreeHour);
    let hourlyRequests = 0;

    window.history.replaceState({}, "", "/?spot=bolinas");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.includes("interval=1h")) {
        hourlyRequests += 1;
        return jsonResponse(oneHour);
      }
      if (url.includes("interval=3h")) return jsonResponse(refreshedThreeHour);
      return jsonResponse({}, 503);
    }));

    const { rerender } = render(
      <ForecastWorkbench spot={spot} initialForecast={firstThreeHour} now={now} />
    );
    fireEvent.click(screen.getByRole("radio", { name: "One-hour resolution" }));
    await waitFor(() => expect(hourlyRequests).toBe(1));
    expect(await screen.findByRole("table", { name: /One-hour surf-planning inputs/ })).toBeTruthy();

    rerender(
      <ForecastWorkbench spot={spot} initialForecast={refreshedThreeHour} now={now} />
    );
    await waitFor(() => expect(hourlyRequests).toBe(2));
  });
});
