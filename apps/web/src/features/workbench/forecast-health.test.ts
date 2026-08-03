import { describe, expect, it } from "vitest";
import { ForecastResponseSchema } from "@surf/contracts";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import {
  ageForecastFreshness,
  parseUsableForecastResponse
} from "./forecast-health";

const generatedAt = new Date("2026-08-02T12:00:00.000Z");

function forecastWithSourceFreshness() {
  const forecast = buildFixtureForecast("bolinas", generatedAt);
  return ForecastResponseSchema.parse({
    ...forecast,
    windows: forecast.windows.map((window) => ({
      ...window,
      sourceFreshnessMinutes: 45,
      sourceFreshness: [
        {
          capability: "forecast_wave_nearshore",
          sourceId: "cdip:test",
          sourceRunId: "wave-run",
          updatedAt: "2026-08-02T11:30:00.000Z",
          freshnessMinutes: 30,
          status: "fresh"
        },
        {
          capability: "wind",
          sourceId: "nws:test",
          sourceRunId: "wind-run",
          updatedAt: "2026-08-02T11:30:00.000Z",
          freshnessMinutes: 30,
          status: "fresh"
        }
      ]
    })),
    observation: {
      stationId: "46237",
      observedAt: "2026-08-02T11:40:00.000Z",
      waveHeightFt: 5.2,
      dominantPeriodSec: 10,
      averagePeriodSec: 8,
      meanWaveDirectionDeg: 290,
      waterTempF: 58,
      sourceFreshnessMinutes: 20
    }
  });
}

describe("forecast response health", () => {
  it("ages the same stored materialization as the browser clock advances", () => {
    const stored = forecastWithSourceFreshness();

    const afterOneHour = parseUsableForecastResponse(
      stored,
      new Date("2026-08-02T13:00:00.000Z")
    );
    const afterThirteenHours = parseUsableForecastResponse(
      stored,
      new Date("2026-08-03T01:00:00.000Z")
    );

    expect(afterOneHour.windows[0]?.sourceFreshnessMinutes).toBe(105);
    expect(afterThirteenHours.windows[0]?.sourceFreshnessMinutes).toBe(825);
    expect(afterOneHour.windows[0]?.sourceFreshness?.map((source) => source.status)).toEqual([
      "fresh",
      "fresh"
    ]);
    expect(afterThirteenHours.windows[0]?.sourceFreshness?.map((source) => source.status)).toEqual([
      "stale",
      "stale"
    ]);
    expect(afterThirteenHours.observation?.sourceFreshnessMinutes).toBe(800);
  });

  it("does not mutate or make source ages younger when the browser clock is behind", () => {
    const stored = forecastWithSourceFreshness();
    const aged = ageForecastFreshness(
      stored,
      new Date("2026-08-02T11:00:00.000Z")
    );

    expect(aged).toBe(stored);
    expect(stored.windows[0]?.sourceFreshnessMinutes).toBe(45);
    expect(stored.windows[0]?.sourceFreshness?.[0]?.freshnessMinutes).toBe(30);
  });
});
