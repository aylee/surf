import type { ForecastResponse } from "@surf/contracts";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import type { ForecastBriefDraft, ForecastFactBundle } from "./types";

export function briefForecastFixture(): ForecastResponse {
  const forecast = buildFixtureForecast("linda-mar", new Date("2026-08-02T13:00:00.000Z"));
  return {
    ...forecast,
    interval: "3h",
    windows: forecast.windows.map((window) => ({
      ...window,
      caveats: ["A wind shift could weaken the surface-quality read."],
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
  const firstWindowId = bundle.input.recommendationWindowIds[0]!;
  const recommendation = bundle.facts.find(
    (fact) => fact.windowId === firstWindowId && fact.kind === "recommendation"
  )!;
  const condition = bundle.facts.find(
    (fact) => fact.windowId === firstWindowId && fact.kind === "condition"
  )!;
  const wind = bundle.facts.find(
    (fact) => fact.windowId === firstWindowId && fact.kind === "wind"
  )!;
  const firstTradeoff = bundle.facts.find(
    (fact) => fact.windowId === firstWindowId && fact.role === "tradeoff"
  )!;
  return {
    summary: {
      text: "Clean surface conditions and offshore wind favor the leading daylight window, while a possible wind shift tempers the call.",
      factRefs: [recommendation.id, condition.id, wind.id, firstTradeoff.id]
    },
    picks: bundle.input.recommendationWindowIds.map((windowId, index) => {
      const windowRecommendation = bundle.facts.find(
        (fact) => fact.windowId === windowId && fact.kind === "recommendation"
      )!;
      const windowCondition = bundle.facts.find(
        (fact) => fact.windowId === windowId && fact.kind === "condition"
      )!;
      const windowWind = bundle.facts.find(
        (fact) => fact.windowId === windowId && fact.kind === "wind"
      )!;
      const tradeoff = bundle.facts.find(
        (fact) => fact.windowId === windowId && fact.role === "tradeoff"
      )!;
      return {
        windowId,
        why: {
          text:
            index === 0
              ? "Clean surface conditions and offshore wind make this a leading daylight option."
              : "Clean surface conditions and offshore wind keep this daylight window worth a look.",
          factRefs: [windowRecommendation.id, windowCondition.id, windowWind.id]
        },
        tradeoff: {
          text:
            index === 0
              ? "The surface advantage could fade if the wind shifts."
              : "A wind shift remains the main threat to the expected surface quality.",
          factRefs: [tradeoff.id]
        }
      };
    }),
    bustFactors: [{
      text: "A wind shift could undercut the expected surface quality.",
      factRefs: [firstTradeoff.id]
    }],
    lesson: {
      topic: "Wind relationship",
      text: "Offshore describes how the wind meets this shoreline and why the surface reads cleaner.",
      factRefs: [wind.id]
    }
  };
}
