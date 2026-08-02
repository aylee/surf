import { describe, expect, it } from "vitest";
import { ForecastResponseSchema } from "@surf/contracts";
import { estimateBreakingWaveHeight } from "@surf/forecast-core";
import { buildForecastResponse } from "./forecast";
import type { Env } from "./index";

type QueryRows = Record<
  "tide" | "tideEvent" | "wind" | "wave" | "observation" | "hazard" | "source" | "issue" | "snapshot",
  unknown[]
>;

function queryDb(rows: QueryRows): D1Database {
  return {
    prepare(sql: string) {
      const key = sql.includes("from tide_events")
        ? "tideEvent"
        : sql.includes("from tide_forecasts")
        ? "tide"
        : sql.includes("from wind_forecasts")
          ? "wind"
          : sql.includes("from wave_forecasts")
            ? "wave"
            : sql.includes("from wave_observations")
              ? "observation"
              : sql.includes("from hazard_events")
                ? "hazard"
                : sql.includes("from forecast_issues")
                  ? "issue"
                  : sql.includes("from forecast_snapshots")
                    ? "snapshot"
                    : "source";
      const all = async () => ({ results: rows[key], success: true, meta: {} });
      return {
        bind() {
          return { all };
        },
        all
      };
    }
  } as unknown as D1Database;
}

function env(db: D1Database): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    SURF_USER_AGENT: "surf-test/1.0 (+https://example.test/contact)",
    ASSETS: {} as Fetcher,
    DB: db,
    RAW_ARTIFACTS: {} as R2Bucket,
    INGEST_QUEUE: {} as Queue
  };
}

const forecastAt = "2026-07-10T04:00:00.000Z";

function liveRows(): QueryRows {
  return {
    tide: [
      {
        forecast_at: forecastAt,
        tide_ft_mllw: 3.2,
        tide_trend: "rising",
        source_run_id: "tide-run"
      }
    ],
    tideEvent: [
      {
        station_id: "9414290",
        event_at: "2026-07-10T06:12:00.000Z",
        tide_ft_mllw: 4.8,
        event_type: "high",
        source_run_id: "tide-run"
      }
    ],
    wind: [
      {
        forecast_at: forecastAt,
        model_cycle_at: "2026-07-10T01:00:00.000Z",
        wind_speed_ms: 3,
        wind_direction_deg: 90,
        gust_ms: 5,
        weather_summary: "Clear",
        source_run_id: "wind-run"
      }
    ],
    wave: [
      {
        source_id: "nws:mtr-grid-wave",
        forecast_at: forecastAt,
        model_cycle_at: "2026-07-09T20:26:07.000Z",
        nearshore_height_m: 0.78,
        offshore_height_m: null,
        significant_height_m: 1.2,
        peak_period_s: 9,
        primary_direction_deg: 300,
        swell_height_m: 1.1,
        swell_period_s: 9,
        swell_direction_deg: 300,
        source_run_id: "wave-run",
        payload_json: JSON.stringify({
          sourceUrl: "https://api.weather.gov/gridpoints/MTR/75,113",
          breakingHeightScale: 0.65,
          significantHeightM: 1.2,
          estimatedBreakingHeightM: 0.78,
          primarySwellHeightM: 1.1,
          primarySwellPeriodS: 9,
          primarySwellDirectionDeg: 300,
          secondarySwellHeightM: 0.4,
          secondarySwellPeriodS: 16,
          secondarySwellDirectionDeg: 210
        })
      }
    ],
    observation: [
      {
        source_id: "ndbc-46237",
        source_run_id: "ndbc-run",
        observed_at: "2026-07-10T02:30:00.000Z",
        wave_height_m: 1.7,
        peak_period_s: 15,
        mean_period_s: 7.5,
        primary_direction_deg: 239,
        water_temp_c: 14.3
      }
    ],
    hazard: [
      {
        starts_at: "2026-07-10T03:00:00.000Z",
        ends_at: "2026-07-10T05:00:00.000Z",
        headline: "Beach Hazards Statement",
        source_run_id: "hazard-run"
      }
    ],
    source: ["tide-run", "wind-run", "wave-run", "ndbc-run", "hazard-run"].map((id) => ({
      id,
      source_id: id,
      status: "success",
      completed_at: "2026-07-10T02:40:00.000Z"
    })),
    issue: [],
    snapshot: []
  };
}

describe("forecast assembly", () => {
  it("returns sourced, scaled NWS waves on stable local-clock slots with provenance", async () => {
    const response = await buildForecastResponse(
      env(queryDb(liveRows())),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(response.windows).toHaveLength(41);
    expect(response.interval).toBe("3h");
    expect(() => ForecastResponseSchema.parse(response)).not.toThrow();
    expect(response.windows[0]).toMatchObject({
      forecastAt,
      ratingStatus: "scored",
      waveHeightFt: 0.78 * 3.28084,
      peakPeriodSec: 9,
      primaryDirectionDeg: 300,
      activeCapabilities: ["forecast_wave_nearshore", "tide", "wind", "observed_wave", "hazard"],
      sourceRunIds: ["tide-run", "wind-run", "wave-run", "ndbc-run", "hazard-run"],
      primarySwell: {
        heightFt: 1.1 * 3.28084,
        periodSec: 9,
        directionDeg: 300
      },
      secondarySwell: {
        heightFt: 0.4 * 3.28084,
        periodSec: 16,
        directionDeg: 210
      },
      waveProvenance: {
        sourceId: "nws:mtr-grid-wave",
        sourceUpdatedAt: "2026-07-09T20:26:07.000Z",
        rawSignificantHeightFt: 1.2 * 3.28084,
        breakingHeightScale: 0.65,
        estimatedBreakingHeightFt: 0.78 * 3.28084,
        derivation: "nws_coastal_grid_spot_scale"
      },
      waveState: {
        semantics: "nws_fallback",
        calibrationStatus: "cold_start_uncalibrated",
        validFrom: forecastAt,
        validTo: "2026-07-10T07:00:00.000Z",
        sourceResolutionHours: 3,
        modeledNearshoreHeightFt: 1.2 * 3.28084,
        breakingSurfHeightFt: 0.78 * 3.28084
      },
      windGustKt: 5 * 1.94384,
      weatherSummary: "Clear",
      surfaceCondition: "fair",
      resolution: {
        wave: { method: "exact", sourceIntervalMinutes: 180, displayIntervalMinutes: 180 },
        wind: { method: "aggregated", sourceIntervalMinutes: 60, displayIntervalMinutes: 180 },
        tide: {
          method: "exact",
          sourceIntervalMinutes: 60,
          displayIntervalMinutes: 180,
          validFrom: forecastAt,
          validTo: "2026-07-10T05:00:00.000Z"
        }
      }
    });
    expect(response.windows[0]?.caveats).toContain("Active NWS hazard: Beach Hazards Statement");
    expect(response.sourceNote).toContain("official NOAA/NWS MTR coastal-grid data");
    expect(response.observation).toMatchObject({
      stationId: "46237",
      observedAt: "2026-07-10T02:30:00.000Z",
      waveHeightFt: 1.7 * 3.28084,
      dominantPeriodSec: 15,
      meanWaveDirectionDeg: 239,
      waterTempF: 57.74,
      sourceFreshnessMinutes: 23
    });
    expect(response.observations).toHaveLength(1);
    expect(response.tideEvents).toEqual([
      {
        stationId: "9414290",
        eventAt: "2026-07-10T06:12:00.000Z",
        heightFtMllw: 4.8,
        type: "high",
        sourceRunId: "tide-run"
      }
    ]);
  });

  it("explicitly prefers a usable CDIP MOP row over the NWS fallback", async () => {
    const rows = liveRows();
    const breaking = estimateBreakingWaveHeight({
      significantHeightM: 1.2,
      peakPeriodSec: 15.384616,
      pointDepthM: 10,
      waveFromDirectionDeg: 294.3,
      shoreNormalDeg: 305.41
    });
    rows.wave.push({
      source_id: "cdip:mop-forecast",
      forecast_at: "2026-07-10T03:00:00.000Z",
      model_cycle_at: "2026-07-07T00:00:00.000Z",
      nearshore_height_m: breaking.pointHeightM,
      offshore_height_m: null,
      significant_height_m: 1.2,
      peak_period_s: 15.384616,
      primary_direction_deg: 294.3,
      swell_height_m: null,
      swell_period_s: null,
      swell_direction_deg: null,
      source_run_id: "cdip-run",
      payload_json: JSON.stringify({
        sourceUrl: "https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore/SF043_forecast.nc.ascii?waveTime,waveHs,waveTp,waveDp,waveDm",
        sourceUpdatedAt: "2026-07-10T01:55:58.000Z",
        modelCycleAt: "2026-07-07T00:00:00.000Z",
        sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle",
        modelPointId: "SF043",
        modelPointWaterDepthM: 10,
        pointRelationship: "direct_nearshore_point",
        significantHeightM: 1.2,
        nearshoreHeightM: breaking.pointHeightM,
        exposureAdjustedPointHeightM: breaking.pointHeightM,
        experimentalBreakingHeightM: breaking.estimatedBreakingHeightM,
        breakingDepthM: breaking.breakingDepthM,
        shoalingFactor: breaking.shoalingFactor,
        totalHeightFactor: breaking.totalHeightFactor,
        breakerIndex: breaking.breakerIndex,
        incidenceAngleDeg: breaking.incidenceAngleDeg,
        transformMethod: breaking.method,
        transformVersion: "bulk-hs-linear-shoaling-v1",
        nearshoreHeightScale: 1,
        heightSemantics: "modeled_significant_wave_height_not_breaking_face_height",
        modelPointShoreNormalDeg: 305.41
      })
    });
    rows.source.push({
      id: "cdip-run",
      source_id: "cdip:mop-forecast",
      status: "success",
      completed_at: "2026-07-10T02:40:00.000Z"
    });

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "obsf-north",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(() => ForecastResponseSchema.parse(response)).not.toThrow();
    expect(response.windows[0]).toMatchObject({
      waveHeightFt: breaking.pointHeightM * 3.28084,
      peakPeriodSec: 15.384616,
      primaryDirectionDeg: 294.3,
      primarySwell: null,
      secondarySwell: null,
      sourceRunIds: ["tide-run", "wind-run", "cdip-run", "ndbc-run", "hazard-run"],
      waveProvenance: {
        sourceId: "cdip:mop-forecast",
        provider: "CDIP MOP nearshore model",
        sourceUpdatedAt: "2026-07-10T01:55:58.000Z",
        modelCycleAt: "2026-07-07T00:00:00.000Z",
        rawSignificantHeightFt: 1.2 * 3.28084,
        breakingHeightScale: 1,
        exposureScale: 1,
        shoalingFactor: breaking.shoalingFactor,
        totalHeightFactor: breaking.totalHeightFactor,
        breakerIndex: 0.78,
        breakingDepthM: breaking.breakingDepthM,
        incidenceAngleDeg: breaking.incidenceAngleDeg,
        experimentalBreakingHeightFt: breaking.estimatedBreakingHeightM * 3.28084,
        transformMethod: "linear-energy-flux-snell-depth-limited",
        transformVersion: "bulk-hs-linear-shoaling-v1",
        estimatedBreakingHeightFt: null,
        modeledNearshoreSignificantHeightFt: 1.2 * 3.28084,
        modelPointId: "SF043",
        modelPointWaterDepthM: 10,
        modelPointShoreNormalDeg: 305.41,
        pointRelationship: "direct_nearshore_point",
        sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle",
        derivation: "cdip_mop_point_hs"
      },
      waveState: {
        semantics: "direct_nearshore",
        calibrationStatus: "modeled_uncalibrated",
        validFrom: "2026-07-10T03:00:00.000Z",
        validTo: "2026-07-10T06:00:00.000Z",
        modeledNearshoreHeightFt: breaking.pointHeightM * 3.28084,
        breakingSurfHeightFt: null
      }
    });
    expect(response.windows[0]?.sourceRunIds).not.toContain("wave-run");
    expect(response.windows[0]?.confidence).toBeGreaterThan(74);
    expect(response.windows[0]?.confidence).toBeLessThanOrEqual(89);
    expect(response.windows[0]?.caveats.join(" ")).toContain("uncalibrated-model cap of 89");
    expect(response.windows[0]?.caveats.join(" ")).toContain("not observed breaking-wave face height");
    expect(response.windows[0]?.caveats.join(" ")).toContain("does not affect the displayed height or score");
    expect(response.sourceNote).toContain("prefer public CDIP MOP");
    expect(response.sourceNote).toContain("not a model cycle");
  });

  it("keeps the outside-cove CDIP mapping explicitly proxy-calibrated and confidence-capped", async () => {
    const rows = liveRows();
    rows.wave.push({
      source_id: "cdip:mop-forecast",
      forecast_at: forecastAt,
      model_cycle_at: "2026-07-09T00:00:00.000Z",
      nearshore_height_m: 0.72,
      offshore_height_m: null,
      significant_height_m: 1.2,
      peak_period_s: 12,
      primary_direction_deg: 285,
      swell_height_m: null,
      swell_period_s: null,
      swell_direction_deg: null,
      source_run_id: "cdip-run",
      payload_json: JSON.stringify({
        sourceUrl: "https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore/SM371_forecast.nc.ascii?waveTime,waveHs,waveTp,waveDp,waveDm",
        sourceUpdatedAt: "2026-07-10T01:55:58.000Z",
        modelPointId: "SM371",
        modelPointWaterDepthM: 15.01,
        pointRelationship: "outside_cove_approach_proxy",
        significantHeightM: 1.2,
        exposureAdjustedPointHeightM: 0.72,
        nearshoreHeightScale: 0.6
      })
    });
    rows.source.push({
      id: "cdip-run",
      source_id: "cdip:mop-forecast",
      status: "success",
      completed_at: "2026-07-10T02:40:00.000Z"
    });

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "linda-mar",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(response.windows[0]).toMatchObject({
      primarySwell: null,
      secondarySwell: null,
      waveState: {
        semantics: "cove_proxy",
        calibrationStatus: "proxy_uncalibrated",
        modeledNearshoreHeightFt: 0.72 * 3.28084,
        breakingSurfHeightFt: null
      }
    });
    expect(response.windows[0]?.confidence).toBeLessThanOrEqual(74);
  });

  it("makes an explicit unknown call when wave data is missing and never substitutes fixtures", async () => {
    const rows = liveRows();
    rows.wave = [];
    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(response.windows[0]).toMatchObject({
      forecastAt,
      ratingStatus: "unknown",
      qualityLabel: "unknown",
      score: 0,
      confidence: 0,
      waveHeightFt: null,
      peakPeriodSec: null,
      primaryDirectionDeg: null,
      waveProvenance: null
    });
    expect(response.windows[0]?.activeCapabilities).not.toContain("forecast_wave_nearshore");
    expect(response.windows[0]?.sourceRunIds).not.toContain("fixture");
    expect(response.windows[0]?.caveats.join(" ")).toContain("surf rating is unknown");
  });

  it("uses a fresh fallback buoy when the preferred station is stale", async () => {
    const rows = liveRows();
    rows.observation = [
      {
        ...rows.observation[0] as object,
        source_id: "ndbc-46237",
        observed_at: "2026-07-09T06:00:00.000Z"
      },
      {
        ...rows.observation[0] as object,
        source_id: "ndbc-46013",
        observed_at: "2026-07-10T02:30:00.000Z"
      }
    ];

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(response.observation?.stationId).toBe("46013");
    expect(response.windows[0]?.activeCapabilities).toContain("observed_wave");
  });

  it("uses the roughest hourly surface inside each three-hour planning window", async () => {
    const rows = liveRows();
    rows.wind[0] = {
      ...rows.wind[0] as object,
      wind_speed_ms: 12 / 1.94384,
      wind_direction_deg: 145
    };
    rows.wind.push({
      forecast_at: "2026-07-10T05:00:00.000Z",
      wind_speed_ms: 13 / 1.94384,
      wind_direction_deg: 300,
      gust_ms: 8,
      weather_summary: "Offshore",
      source_run_id: "wind-run"
    });

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(response.windows[0]?.windDirectionDeg).toBe(145);
    expect(response.windows[0]?.windSpeedKt).toBeCloseTo(12, 8);
  });

  it("uses exact hourly wind and tide while holding one declared three-hour wave state", async () => {
    const rows = liveRows();
    rows.tide.push(
      {
        forecast_at: "2026-07-10T05:00:00.000Z",
        tide_ft_mllw: 3.4,
        tide_trend: "rising",
        source_run_id: "tide-run"
      },
      {
        forecast_at: "2026-07-10T06:00:00.000Z",
        tide_ft_mllw: 3.7,
        tide_trend: "rising",
        source_run_id: "tide-run"
      }
    );
    rows.wind.push(
      {
        forecast_at: "2026-07-10T05:00:00.000Z",
        wind_speed_ms: 5 / 1.94384,
        wind_direction_deg: 270,
        gust_ms: 8 / 1.94384,
        weather_summary: "Partly cloudy",
        source_run_id: "wind-run"
      },
      {
        forecast_at: "2026-07-10T06:00:00.000Z",
        wind_speed_ms: 9 / 1.94384,
        wind_direction_deg: 280,
        gust_ms: 12 / 1.94384,
        weather_summary: "Mostly cloudy",
        source_run_id: "wind-run"
      }
    );

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T03:01:00.000Z"),
      "1h"
    );

    expect(response.interval).toBe("1h");
    expect(response.windows).toHaveLength(121);
    expect(response.windows.slice(0, 3).map((window) => window.forecastAt)).toEqual([
      "2026-07-10T04:00:00.000Z",
      "2026-07-10T05:00:00.000Z",
      "2026-07-10T06:00:00.000Z"
    ]);
    expect(response.windows.slice(0, 3).map((window) => window.waveHeightFt)).toEqual([
      0.78 * 3.28084,
      0.78 * 3.28084,
      0.78 * 3.28084
    ]);
    expect(response.windows.slice(0, 3).map((window) => window.windSpeedKt)).toEqual([
      3 * 1.94384,
      5,
      9
    ]);
    expect(response.windows.slice(0, 3).map((window) => window.tideFt)).toEqual([3.2, 3.4, 3.7]);
    expect(response.windows.slice(0, 3).every((window) =>
      window.waveState?.validFrom === forecastAt &&
      window.waveState.validTo === "2026-07-10T07:00:00.000Z" &&
      window.resolution?.wave.method === "held"
    )).toBe(true);
    expect(response.windows[1]).toMatchObject({
      weatherSummary: "Partly cloudy",
      resolution: {
        wind: { method: "exact", displayIntervalMinutes: 60 },
        tide: { method: "exact", displayIntervalMinutes: 60 }
      }
    });
    expect(response.windows[1]?.windGustKt).toBeCloseTo(8, 8);
  });

  it("holds CDIP rows by their actual source timestamps and switches without interpolation", async () => {
    const rows = liveRows();
    const cdipRow = (forecastAtValue: string, heightM: number) => ({
      source_id: "cdip:mop-forecast",
      forecast_at: forecastAtValue,
      model_cycle_at: "2026-07-10T00:00:00.000Z",
      nearshore_height_m: heightM,
      offshore_height_m: null,
      significant_height_m: heightM,
      peak_period_s: 12,
      primary_direction_deg: 290,
      swell_height_m: null,
      swell_period_s: null,
      swell_direction_deg: null,
      source_run_id: "cdip-run",
      payload_json: JSON.stringify({
        sourceUrl: "https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore/SF043_forecast.nc.ascii?waveTime,waveHs,waveTp,waveDp,waveDm",
        sourceUpdatedAt: "2026-07-10T02:30:00.000Z",
        modelPointId: "SF043",
        modelPointWaterDepthM: 10,
        pointRelationship: "direct_nearshore_point",
        significantHeightM: heightM,
        exposureAdjustedPointHeightM: heightM,
        nearshoreHeightScale: 1
      })
    });
    rows.wave = [
      cdipRow("2026-07-10T03:00:00.000Z", 1),
      cdipRow("2026-07-10T06:00:00.000Z", 2)
    ];
    rows.source.push({
      id: "cdip-run",
      source_id: "cdip:mop-forecast",
      status: "success",
      completed_at: "2026-07-10T02:40:00.000Z"
    });

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "obsf-north",
      new Date("2026-07-10T03:01:00.000Z"),
      "1h"
    );

    expect(response.windows.slice(0, 3).map((window) => window.waveHeightFt)).toEqual([
      1 * 3.28084,
      1 * 3.28084,
      2 * 3.28084
    ]);
    expect(response.windows.slice(0, 3).map((window) => window.waveState?.validFrom)).toEqual([
      "2026-07-10T03:00:00.000Z",
      "2026-07-10T03:00:00.000Z",
      "2026-07-10T06:00:00.000Z"
    ]);
    expect(response.windows.slice(0, 3).every((window) =>
      window.resolution?.wave.method === "held"
    )).toBe(true);
  });

  it("fails closed when a CDIP row omits recognized point semantics", async () => {
    const rows = liveRows();
    rows.wave = [{
      source_id: "cdip:mop-forecast",
      forecast_at: "2026-07-10T03:00:00.000Z",
      model_cycle_at: "2026-07-10T00:00:00.000Z",
      nearshore_height_m: 1.2,
      offshore_height_m: null,
      significant_height_m: 1.2,
      peak_period_s: 12,
      primary_direction_deg: 290,
      swell_height_m: null,
      swell_period_s: null,
      swell_direction_deg: null,
      source_run_id: "cdip-run",
      payload_json: JSON.stringify({
        sourceUrl: "https://example.test/cdip",
        sourceUpdatedAt: "2026-07-10T02:30:00.000Z"
      })
    }];

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "obsf-north",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(response.windows[0]).toMatchObject({
      ratingStatus: "unknown",
      waveHeightFt: null,
      waveState: null,
      waveProvenance: null
    });
    expect(response.windows[0]?.activeCapabilities).not.toContain("forecast_wave_nearshore");
    expect(response.windows[0]?.caveats.join(" ")).toContain("omitted recognized nearshore semantics");
  });

  it("uses the official NWS wind issue time for selected-window freshness", async () => {
    const rows = liveRows();
    rows.wind[0] = {
      ...rows.wind[0] as object,
      model_cycle_at: "2026-07-09T12:00:00.000Z"
    };

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T02:53:00.000Z")
    );
    const windFreshness = response.windows[0]?.sourceFreshness?.find(
      (entry) => entry.capability === "wind"
    );

    expect(windFreshness).toMatchObject({
      updatedAt: "2026-07-09T12:00:00.000Z",
      freshnessMinutes: 893,
      status: "stale"
    });
    expect(response.windows[0]?.sourceFreshnessMinutes).toBe(893);
  });

  it("summarizes changes between the latest two persisted deterministic issues", async () => {
    const rows = liveRows();
    rows.issue = [
      { issue_id: "issue-new", issued_at: "2026-07-10T02:00:00.000Z" },
      { issue_id: "issue-old", issued_at: "2026-07-09T20:00:00.000Z" }
    ];
    rows.snapshot = [
      { issue_id: "issue-new", valid_at: forecastAt, raw_facts_json: "new" },
      { issue_id: "issue-old", valid_at: forecastAt, raw_facts_json: "old" },
      { issue_id: "issue-new", valid_at: "2026-07-10T07:00:00.000Z", raw_facts_json: "same" },
      { issue_id: "issue-old", valid_at: "2026-07-10T07:00:00.000Z", raw_facts_json: "same" }
    ];

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(response.issueDelta).toEqual({
      currentIssueId: "issue-new",
      previousIssueId: "issue-old",
      currentIssuedAt: "2026-07-10T02:00:00.000Z",
      previousIssuedAt: "2026-07-09T20:00:00.000Z",
      changedWindowCount: 1
    });
  });
});
