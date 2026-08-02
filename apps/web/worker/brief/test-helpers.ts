import type { ForecastResponse } from "@surf/contracts";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { forecastBriefFrame, forecastBriefWindowLabel } from "./facts";
import type { ForecastBriefDraft, ForecastFactBundle } from "./types";

export function briefForecastFixture(): ForecastResponse {
  const forecast = buildFixtureForecast("linda-mar", new Date("2026-08-02T13:00:00.000Z"));
  return {
    ...forecast,
    interval: "3h",
    windows: forecast.windows.map((window) => ({
      ...window,
      windGustKt: (window.windSpeedKt ?? 0) + 2,
      surfaceCondition: "clean" as const,
      waveState: {
        semantics: "direct_nearshore" as const,
        calibrationStatus: "modeled_uncalibrated" as const,
        validFrom: window.forecastAt,
        validTo: new Date(new Date(window.forecastAt).getTime() + 3 * 60 * 60 * 1000).toISOString(),
        sourceResolutionHours: 3,
        modeledNearshoreHeightFt: window.waveHeightFt,
        breakingSurfHeightFt: null,
        periodSec: window.peakPeriodSec,
        directionDeg: window.primaryDirectionDeg
      },
      sourceFreshness: [
        {
          capability: "forecast_wave_nearshore" as const,
          sourceId: "cdip-mop",
          sourceRunId: "fixture",
          updatedAt: "2026-08-02T12:15:00.000Z",
          freshnessMinutes: 45,
          status: "fresh" as const
        }
      ]
    })),
    observation: {
      stationId: "46237",
      observedAt: "2026-08-02T12:45:00.000Z",
      waveHeightFt: 3.2,
      dominantPeriodSec: 10,
      averagePeriodSec: 8,
      meanWaveDirectionDeg: 285,
      waterTempF: 58,
      sourceFreshnessMinutes: 15
    },
    sunPhases: [
      {
        localDate: "2026-08-02",
        firstLight: "2026-08-02T12:46:00.000Z",
        sunrise: "2026-08-02T13:15:00.000Z",
        sunset: "2026-08-03T03:17:00.000Z",
        lastLight: "2026-08-03T03:45:00.000Z"
      }
    ]
  };
}

export function validDraftFor(bundle: ForecastFactBundle): ForecastBriefDraft {
  const frame = forecastBriefFrame(bundle);
  return {
    headline: frame.headline,
    setup: frame.setup,
    picks: bundle.input.recommendationWindowIds.map((windowId) => {
      const condition = bundle.facts.find(
        (fact) => fact.windowId === windowId && fact.kind === "condition"
      )!;
      const wave = bundle.facts.find((fact) => fact.windowId === windowId && fact.kind === "wave")!;
      return {
        windowId,
        label: forecastBriefWindowLabel(bundle, windowId),
        why: condition.statement,
        tradeoff: wave.statement,
        factRefs: [condition.id, wave.id]
      };
    }),
    bustFactors: (() => {
      const caveat = bundle.facts.find((fact) => fact.kind === "caveat")!;
      return [{ text: caveat.statement, factRefs: [caveat.id] }];
    })(),
    lesson: {
      topic: "Modeled wave state",
      text: "This is not an observed breaking-wave face height.",
      factRefs: [bundle.facts.find((fact) => fact.kind === "wave")!.id]
    }
  };
}
