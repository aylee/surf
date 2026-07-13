import { describe, expect, it } from "vitest";
import { ForecastResponseSchema } from "@surf/contracts";
import { estimateBreakingWaveHeight } from "@surf/forecast-core";
import { buildForecastResponse } from "./forecast";
import type { Env } from "./index";

type QueryRows = Record<"tide" | "wind" | "wave" | "observation" | "hazard" | "source", unknown[]>;

function queryDb(rows: QueryRows): D1Database {
  return {
    prepare(sql: string) {
      const key = sql.includes("from tide_forecasts")
        ? "tide"
        : sql.includes("from wind_forecasts")
          ? "wind"
          : sql.includes("from wave_forecasts")
            ? "wave"
            : sql.includes("from wave_observations")
              ? "observation"
            : sql.includes("from hazard_events")
              ? "hazard"
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
    wind: [
      {
        forecast_at: forecastAt,
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
    }))
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
      primarySwell: {
        heightFt: 1.2 * 3.28084,
        periodSec: 15.384616,
        directionDeg: 294.3
      },
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
      }
    });
    expect(response.windows[0]?.sourceRunIds).not.toContain("wave-run");
    expect(response.windows[0]?.confidence).toBeLessThanOrEqual(74);
    expect(response.windows[0]?.caveats.join(" ")).toContain("not observed breaking-wave face height");
    expect(response.windows[0]?.caveats.join(" ")).toContain("does not affect the displayed height or score");
    expect(response.sourceNote).toContain("prefer public CDIP MOP");
    expect(response.sourceNote).toContain("not a model cycle");
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
});
