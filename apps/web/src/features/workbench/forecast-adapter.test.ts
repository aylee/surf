import { describe, expect, it } from "vitest";
import { ForecastResponseSchema, type ApiSpot, type ForecastResponse } from "@surf/contracts";
import { getSpotProfile } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import {
  adaptForecastResponse,
  parseBriefResponse,
  readWorkbenchUrl,
  sourceHealthForWindow
} from "./forecast-adapter";

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

function fixture(overrides: Partial<ForecastResponse> = {}): ForecastResponse {
  return ForecastResponseSchema.parse({ ...buildFixtureForecast("bolinas"), ...overrides });
}

describe("forecast workbench adapter", () => {
  it("keeps a direct CDIP bulk wave state separate from swell components", () => {
    const base = buildFixtureForecast("bolinas");
    const forecast = fixture({
      interval: "1h",
      windows: [
        {
          ...base.windows[0]!,
          windGustKt: 11,
          weatherSummary: "Mostly cloudy",
          waveState: {
            semantics: "direct_nearshore",
            calibrationStatus: "modeled_uncalibrated",
            validFrom: base.windows[0]!.forecastAt,
            validTo: new Date(new Date(base.windows[0]!.forecastAt).getTime() + 3 * 3_600_000).toISOString(),
            sourceResolutionHours: 3,
            modeledNearshoreHeightFt: 3.4,
            breakingSurfHeightFt: null,
            periodSec: 10,
            directionDeg: 289
          },
          resolution: {
            wave: {
              sourceIntervalMinutes: 180,
              displayIntervalMinutes: 60,
              method: "held",
              validFrom: base.windows[0]!.forecastAt,
              validTo: new Date(new Date(base.windows[0]!.forecastAt).getTime() + 3 * 3_600_000).toISOString()
            },
            wind: {
              sourceIntervalMinutes: 60,
              displayIntervalMinutes: 60,
              method: "exact",
              validFrom: base.windows[0]!.forecastAt,
              validTo: new Date(new Date(base.windows[0]!.forecastAt).getTime() + 3_600_000).toISOString()
            },
            tide: {
              sourceIntervalMinutes: 60,
              displayIntervalMinutes: 60,
              method: "exact",
              validFrom: base.windows[0]!.forecastAt,
              validTo: new Date(new Date(base.windows[0]!.forecastAt).getTime() + 3_600_000).toISOString()
            }
          }
        }
      ],
      tideEvents: [{
        stationId: "9414958",
        eventAt: base.windows[0]!.forecastAt,
        type: "high",
        heightFtMllw: 5.1,
        sourceRunId: "run"
      }]
    });

    const adapted = adaptForecastResponse(forecast, spot, "1h");

    expect(adapted.interval).toBe("1h");
    expect(adapted.windows[0]?.modeledHeightFt).toBe(3.4);
    expect(adapted.windows[0]?.waveSemanticsLabel).toBe("Modeled nearshore Hs");
    expect(adapted.windows[0]?.waveResolutionMethod).toBe("held");
    expect(adapted.windows[0]?.resolutionHours).toBe(3);
    expect(adapted.windows[0]?.swellComponents).toEqual([]);
    expect(adapted.windows[0]?.windGustKt).toBe(11);
    expect(adapted.tideEvents[0]).toMatchObject({ type: "high", heightFt: 5.1 });
  });

  it("retains explicit NWS swell partitions", () => {
    const adapted = adaptForecastResponse(fixture(), spot, "3h");
    expect(adapted.windows[0]?.waveSemantics).toBe("nws_fallback");
    expect(adapted.windows[0]?.waveResolutionMethod).toBe("exact");
    expect(adapted.windows[0]?.swellComponents[0]?.label).toBe("Primary");
  });

  it("keeps an unavailable wave field unavailable without inventing semantics or validity", () => {
    const base = buildFixtureForecast("bolinas");
    const forecast = fixture({
      interval: "1h",
      windows: [{
        ...base.windows[0]!,
        waveHeightFt: null,
        peakPeriodSec: null,
        primaryDirectionDeg: null,
        primarySwell: null,
        secondarySwell: null,
        waveProvenance: null,
        waveState: null,
        sourceFreshness: [{
          capability: "forecast_wave_nearshore",
          sourceId: "wave:unavailable",
          sourceRunId: null,
          updatedAt: null,
          freshnessMinutes: null,
          status: "missing"
        }],
        resolution: {
          wave: {
            sourceIntervalMinutes: null,
            displayIntervalMinutes: 60,
            method: "unavailable",
            validFrom: null,
            validTo: null
          },
          wind: {
            sourceIntervalMinutes: 60,
            displayIntervalMinutes: 60,
            method: "exact",
            validFrom: base.windows[0]!.forecastAt,
            validTo: new Date(new Date(base.windows[0]!.forecastAt).getTime() + 3_600_000).toISOString()
          },
          tide: {
            sourceIntervalMinutes: 60,
            displayIntervalMinutes: 60,
            method: "exact",
            validFrom: base.windows[0]!.forecastAt,
            validTo: new Date(new Date(base.windows[0]!.forecastAt).getTime() + 3_600_000).toISOString()
          }
        }
      }]
    });

    const adapted = adaptForecastResponse(forecast, spot, "1h");
    const window = adapted.windows[0]!;

    expect(window.waveSemantics).toBe("unavailable");
    expect(window.waveSemanticsLabel).toBe("Wave state unavailable");
    expect(window.waveResolutionMethod).toBe("unavailable");
    expect(window.validFrom).toBeNull();
    expect(window.validTo).toBeNull();
    expect(window.resolutionHours).toBeNull();
    expect(window.dataHealth).toBe("limited");
    expect(sourceHealthForWindow(window)).toMatchObject([{
      id: "forecast_wave_nearshore:wave:unavailable",
      status: "missing",
      ageMinutes: null
    }]);
  });

  it("parses the validated brief envelope and object bust factors", () => {
    const brief = parseBriefResponse({
      status: "model",
      brief: {
        provider: "google",
        headline: "Early wind window",
        setup: "Public facts only.",
        revision: 2,
        generatedAt: "2026-08-02T12:00:00Z",
        picks: [{ windowId: "window:1", label: "Sun 7:00 AM", why: "Wind is lighter.", tradeoff: "Lower tide." }],
        bustFactors: [{ text: "Wind arrives early.", factRefs: ["wind:1"] }],
        lesson: { topic: "Period", text: "Period changes wave energy.", factRefs: ["wave:1"] }
      }
    });

    expect(brief).toMatchObject({
      status: "model",
      provider: "google",
      headline: "Early wind window",
      revision: 2,
      picks: [{ label: "Sun 7:00 AM" }],
      bustFactors: ["Wind arrives early."]
    });
  });

  it("preserves a stale deterministic brief and its fallback reason", () => {
    const brief = parseBriefResponse({
      status: "stale",
      fallbackReason: "Forecast inputs changed materially.",
      availableRevisions: 3,
      brief: {
        provider: "deterministic",
        headline: "Use the deterministic read",
        setup: "The prior model brief no longer matches the inputs.",
        revision: 3,
        generatedAt: "2026-08-02T12:00:00Z",
        picks: [{ windowId: "window:1", label: "Sun 7:00 AM", why: "The score leads.", tradeoff: "Check freshness." }],
        bustFactors: [],
        lesson: { topic: "Freshness", text: "Check source age." }
      }
    });

    expect(brief).toMatchObject({
      status: "stale",
      provider: "deterministic",
      fallbackReason: "Forecast inputs changed materially.",
      availableRevisions: 3,
      picks: [{ label: "Sun 7:00 AM" }]
    });
  });

  it("defaults URL state to a three-hour table on the Forecast tab", () => {
    expect(readWorkbenchUrl("?spot=bolinas")).toEqual({
      interval: "3h",
      view: "table",
      tab: "forecast",
      date: null,
      at: null
    });
  });

  it("reads the analysis tab from a deep link and rejects unknown tab values", () => {
    expect(readWorkbenchUrl("?spot=bolinas&tab=analysis").tab).toBe("analysis");
    expect(readWorkbenchUrl("?spot=bolinas&tab=bogus").tab).toBe("forecast");
    expect(readWorkbenchUrl("?spot=bolinas&tab=").tab).toBe("forecast");
  });
});

describe("cadence-aware data health", () => {
  function forecastWithWaveEntry(
    freshnessMinutes: number,
    cadence?: { expectedCadenceMinutes: number; graceMinutes: number }
  ): ForecastResponse {
    const base = fixture();
    return ForecastResponseSchema.parse({
      ...base,
      windows: base.windows.map((window) => ({
        ...window,
        confidence: 90,
        caveats: [],
        sourceFreshness: [
          {
            capability: "forecast_wave_nearshore",
            sourceId: "cdip:test",
            sourceRunId: "wave-run",
            updatedAt: "2026-08-02T11:30:00.000Z",
            freshnessMinutes,
            status: "fresh",
            ...(cadence ?? {})
          }
        ]
      }))
    });
  }

  it("maps the shared verdict onto good/watch/limited boundaries", () => {
    const cadence = { expectedCadenceMinutes: 360, graceMinutes: 180 };
    const good = adaptForecastResponse(forecastWithWaveEntry(360, cadence), spot, "3h");
    const watch = adaptForecastResponse(forecastWithWaveEntry(540, cadence), spot, "3h");
    const limited = adaptForecastResponse(forecastWithWaveEntry(541, cadence), spot, "3h");
    expect(good.windows[0]?.dataHealth).toBe("good");
    expect(watch.windows[0]?.dataHealth).toBe("watch");
    expect(limited.windows[0]?.dataHealth).toBe("limited");
  });

  it("judges legacy no-entry windows with the contracts fallback boundary", () => {
    const base = fixture();
    const legacy = (sourceFreshnessMinutes: number) =>
      ForecastResponseSchema.parse({
        ...base,
        windows: base.windows.map((window) => ({
          ...window,
          sourceFreshness: undefined,
          sourceFreshnessMinutes,
          waveProvenance: {
            sourceId: "nws:mtr-grid-wave",
            provider: "NOAA/NWS MTR",
            sourceUrl: "https://api.weather.gov/gridpoints/MTR/85,105",
            sourceUpdatedAt: "2026-08-02T11:30:00.000Z",
            rawSignificantHeightFt: 3.2,
            breakingHeightScale: 1,
            estimatedBreakingHeightFt: 3.2,
            derivation: "nws_coastal_grid_spot_scale"
          }
        }))
      });
    const aging = adaptForecastResponse(legacy(350), spot, "3h");
    const late = adaptForecastResponse(legacy(400), spot, "3h");
    // 240 + 120 = 360 preserves the historical boundary: aging renders as
    // quiet-fresh; only late renders stale.
    expect(sourceHealthForWindow(aging.windows[0]!)[0]?.status).toBe("fresh");
    expect(sourceHealthForWindow(late.windows[0]!)[0]?.status).toBe("stale");
  });
});
