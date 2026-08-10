import { describe, expect, it, vi } from "vitest";
import {
  ForecastResponseSchema,
  sourceFreshnessVerdict,
  type ScoredForecastWindow
} from "@surf/contracts";
import { estimateBreakingWaveHeight } from "@surf/forecast-core";
import { buildForecastResponse, buildSynchronizedForecastResponses } from "./forecast";
import type { Env } from "./index";
import {
  forecastDisplayHorizonEnd,
  stableHourlyForecastTimes,
  stableThreeHourForecastTimes
} from "./time";

type QueryRows = Record<
  "tide" | "tideEvent" | "wind" | "wave" | "observation" | "hazard" | "source" | "issue" | "snapshot",
  unknown[]
>;

type QueryKey = keyof QueryRows;

function queryKey(sql: string): QueryKey {
  return sql.includes("from tide_events")
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
}

type CapturedQuery = { key: QueryKey; sql: string; bindings: unknown[] };

function queryDb(rows: QueryRows, captured?: CapturedQuery[]): D1Database {
  return {
    prepare(sql: string) {
      const key = queryKey(sql);
      const all = async () => ({ results: rows[key], success: true, meta: {} });
      return {
        bind(...bindings: unknown[]) {
          captured?.push({ key, sql, bindings });
          return { all };
        },
        all
      };
    }
  } as unknown as D1Database;
}

function batchingQueryDb(rows: QueryRows) {
  let batchCalls = 0;
  let batchedStatements = 0;
  let individualAllCalls = 0;
  const individualQueries: CapturedQuery[] = [];

  const statement = (
    key: QueryKey,
    sql: string,
    allowIndividual = false,
    bindings: unknown[] = []
  ): D1PreparedStatement => ({
    __queryKey: key,
    __allowIndividual: allowIndividual,
    bind(...nextBindings: unknown[]) {
      return statement(key, sql, allowIndividual, nextBindings);
    },
    async all() {
      individualAllCalls += 1;
      if (allowIndividual) {
        individualQueries.push({ key, sql, bindings });
        return { results: rows[key], success: true, meta: {} };
      }
      throw new Error("Initial forecast reads must use D1 batch when it is available");
    }
  } as unknown as D1PreparedStatement);
  const db = {
    prepare(sql: string) {
      return statement(queryKey(sql), sql, sql.includes("from json_each(?)"));
    },
    async batch(statements: D1PreparedStatement[]) {
      batchCalls += 1;
      batchedStatements += statements.length;
      return statements.map((prepared) => ({
        results: rows[(prepared as D1PreparedStatement & { __queryKey: QueryKey }).__queryKey],
        success: true,
        meta: {}
      }));
    }
  } as unknown as D1Database;
  return {
    db,
    batchCalls: () => batchCalls,
    batchedStatements: () => batchedStatements,
    individualAllCalls: () => individualAllCalls,
    individualQueries: () => individualQueries
  };
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

function trackIndexedReads<T>(values: T[]): { values: T[]; reads: () => number } {
  let readCount = 0;
  const valuesProxy = new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) readCount += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  return { values: valuesProxy, reads: () => readCount };
}

const forecastAt = "2026-07-10T04:00:00.000Z";

function requireWindow(
  response: { windows: ScoredForecastWindow[] },
  at = forecastAt
): ScoredForecastWindow {
  const window = response.windows.find((candidate) => candidate.forecastAt === at);
  if (!window) throw new Error(`Expected forecast window at ${at}`);
  return window;
}

function windowsFrom(
  response: { windows: ScoredForecastWindow[] },
  startAt: string,
  count: number
): ScoredForecastWindow[] {
  const startIndex = response.windows.findIndex((window) => window.forecastAt === startAt);
  if (startIndex < 0) throw new Error(`Expected forecast window at ${startAt}`);
  return response.windows.slice(startIndex, startIndex + count);
}

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
        source_id: "nws:point-forecast-alerts",
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
  it("loads one batched source snapshot for synchronized 1h/3h assembly", async () => {
    const rows = liveRows();
    const batched = batchingQueryDb(rows);
    const now = new Date("2026-07-10T02:53:07.000Z");

    const synchronized = await buildSynchronizedForecastResponses(
      env(batched.db),
      "bolinas",
      now,
      { failOnReadError: true }
    );
    const expectedThreeHour = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      now,
      "3h",
      { failOnReadError: true }
    );
    const expectedHourly = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      now,
      "1h",
      { failOnReadError: true }
    );

    expect(batched.batchCalls()).toBe(1);
    expect(batched.batchedStatements()).toBe(7);
    expect(batched.individualAllCalls()).toBe(1);
    expect(batched.individualQueries()).toEqual([
      expect.objectContaining({
        key: "source",
        sql: expect.stringContaining("from json_each(?)"),
        bindings: [
          JSON.stringify(["tide-run", "wind-run", "wave-run", "ndbc-run", "hazard-run"])
        ]
      })
    ]);
    const { recommendations: threeHourRecommendations, ...threeHourCore } = synchronized.threeHour;
    const { recommendations: hourlyRecommendations, ...hourlyCore } = synchronized.hourly;
    expect(threeHourCore).toEqual(expectedThreeHour);
    expect(hourlyCore).toEqual(expectedHourly);
    expect(threeHourRecommendations).toEqual(hourlyRecommendations);
  });

  it("emits one bounded nonterminal diagnostic when standalone assembly falls back", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = {
      prepare() {
        throw new Error("D1 read exposed token=should-not-appear");
      }
    } as unknown as D1Database;

    const response = await buildForecastResponse(
      env(db),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z"),
      "3h"
    );

    expect(response.windows.every(({ ratingStatus }) => ratingStatus === "unknown")).toBe(true);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({
      event: "forecast_assembly_failed",
      message: "forecast assembly failed",
      spotId: "bolinas",
      interval: "3h",
      reasonCode: "forecast_assembly_failed",
      errorName: "Error"
    });
    expect(String(errorLog.mock.calls[0]![0])).not.toContain("should-not-appear");
    expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).not.toHaveProperty("outcome");
    errorLog.mockRestore();
  });

  it("emits only the synchronized diagnostic before a fail-fast caller owns terminal logging", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = {
      prepare() {
        throw new Error("synchronized D1 token=should-not-appear");
      }
    } as unknown as D1Database;

    await expect(
      buildSynchronizedForecastResponses(
        env(db),
        "bolinas",
        new Date("2026-07-10T02:53:07.000Z"),
        { failOnReadError: true }
      )
    ).rejects.toThrow("synchronized D1 token=should-not-appear");

    expect(errorLog).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({
      event: "synchronized_forecast_assembly_failed",
      message: "synchronized forecast assembly failed",
      spotId: "bolinas",
      reasonCode: "synchronized_forecast_assembly_failed",
      errorName: "Error"
    });
    expect(String(errorLog.mock.calls[0]![0])).not.toContain("should-not-appear");
    expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).not.toHaveProperty("outcome");
    errorLog.mockRestore();
  });

  it("returns sourced, scaled NWS waves on stable local-clock slots with provenance", async () => {
    const response = await buildForecastResponse(
      env(queryDb(liveRows())),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z")
    );

    expect(response.windows).toHaveLength(40);
    expect(response.windows[0]?.forecastAt).toBe("2026-07-09T07:00:00.000Z");
    expect(response.windows.at(-1)?.forecastAt).toBe("2026-07-14T04:00:00.000Z");
    expect(response.interval).toBe("3h");
    expect(() => ForecastResponseSchema.parse(response)).not.toThrow();
    const sourcedWindow = requireWindow(response);
    expect(sourcedWindow).toMatchObject({
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
    expect(sourcedWindow.caveats).toContain("Active NWS hazard: Beach Hazards Statement");
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
    expect(response.hazards).toEqual([{
      headline: "Beach Hazards Statement",
      startsAt: "2026-07-10T03:00:00.000Z",
      endsAt: "2026-07-10T05:00:00.000Z",
      sourceId: "nws:point-forecast-alerts",
      sourceRunId: "hazard-run"
    }]);
  });

  it.each([
    ["normal", "2026-07-10T18:00:00.000Z", "1h"],
    ["normal", "2026-07-10T18:00:00.000Z", "3h"],
    ["spring-forward", "2026-03-08T18:00:00.000Z", "1h"],
    ["spring-forward", "2026-03-08T18:00:00.000Z", "3h"],
    ["fall-back", "2026-11-01T18:00:00.000Z", "1h"],
    ["fall-back", "2026-11-01T18:00:00.000Z", "3h"]
  ] as const)(
    "keeps final-date tide extrema through the exclusive %s %s display horizon",
    async (_dateKind, nowAt, interval) => {
      const now = new Date(nowAt);
      const times = interval === "1h"
        ? stableHourlyForecastTimes(now, 120, "America/Los_Angeles")
        : stableThreeHourForecastTimes(now, 120, "America/Los_Angeles");
      const displayEnd = forecastDisplayHorizonEnd(times, interval)!;
      const rows = liveRows();
      rows.tideEvent = [
        {
          station_id: "9414290",
          event_at: new Date(Date.parse(displayEnd) - 30 * 60_000).toISOString(),
          tide_ft_mllw: 5.1,
          event_type: "high",
          source_run_id: "tide-run"
        },
        {
          station_id: "9414290",
          event_at: displayEnd,
          tide_ft_mllw: 0.2,
          event_type: "low",
          source_run_id: "tide-run"
        }
      ];
      const captured: CapturedQuery[] = [];

      const response = await buildForecastResponse(
        env(queryDb(rows, captured)),
        "bolinas",
        now,
        interval,
        { failOnReadError: true }
      );

      expect(response.tideEvents?.map((event) => event.eventAt)).toEqual([
        new Date(Date.parse(displayEnd) - 30 * 60_000).toISOString()
      ]);
      const tideEventQuery = captured.find((query) => query.key === "tideEvent");
      expect(tideEventQuery?.sql).toContain("event_at < ?");
      expect(tideEventQuery?.bindings).toEqual(["bolinas", times[0], displayEnd]);
    }
  );

  it("maps a 4:30–6:30 local hazard to every overlapping hourly and three-hour slot", async () => {
    const rows = liveRows();
    rows.hazard = [{
      source_id: "nws:point-forecast-alerts",
      starts_at: "2026-07-10T11:30:00.000Z",
      ends_at: "2026-07-10T13:30:00.000Z",
      headline: "Between-slot advisory",
      source_run_id: "hazard-run"
    }];
    const now = new Date("2026-07-10T10:00:00.000Z");

    const [hourly, threeHour] = await Promise.all([
      buildForecastResponse(env(queryDb(rows)), "bolinas", now, "1h", { failOnReadError: true }),
      buildForecastResponse(env(queryDb(rows)), "bolinas", now, "3h", { failOnReadError: true })
    ]);
    const hasHazard = (window: ScoredForecastWindow) =>
      window.caveats.includes("Active NWS hazard: Between-slot advisory");

    expect(hourly.windows.filter(hasHazard).map((window) => window.forecastAt)).toEqual([
      "2026-07-10T11:00:00.000Z",
      "2026-07-10T12:00:00.000Z",
      "2026-07-10T13:00:00.000Z"
    ]);
    expect(threeHour.windows.filter(hasHazard).map((window) => window.forecastAt)).toEqual([
      "2026-07-10T10:00:00.000Z",
      "2026-07-10T13:00:00.000Z"
    ]);
    expect(threeHour.hazards).toEqual(hourly.hazards);
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
    const cdipWindow = requireWindow(response);
    expect(cdipWindow).toMatchObject({
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
    expect(cdipWindow.sourceRunIds).not.toContain("wave-run");
    expect(cdipWindow.confidence).toBeGreaterThan(74);
    expect(cdipWindow.confidence).toBeLessThanOrEqual(89);
    expect(cdipWindow.caveats.join(" ")).toContain("uncalibrated-model cap of 89");
    expect(cdipWindow.caveats.join(" ")).toContain("not observed breaking-wave face height");
    expect(cdipWindow.caveats.join(" ")).toContain("does not affect the displayed height or score");
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

    const proxyWindow = requireWindow(response);
    expect(proxyWindow).toMatchObject({
      primarySwell: null,
      secondarySwell: null,
      waveState: {
        semantics: "cove_proxy",
        calibrationStatus: "proxy_uncalibrated",
        modeledNearshoreHeightFt: 0.72 * 3.28084,
        breakingSurfHeightFt: null
      }
    });
    expect(proxyWindow.confidence).toBeLessThanOrEqual(74);
  });

  it("makes an explicit unknown call when wave data is missing and never substitutes fixtures", async () => {
    const rows = liveRows();
    rows.wave = [];
    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z")
    );

    const missingWaveWindow = requireWindow(response);
    expect(missingWaveWindow).toMatchObject({
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
    expect(missingWaveWindow.activeCapabilities).not.toContain("forecast_wave_nearshore");
    expect(missingWaveWindow.sourceRunIds).not.toContain("fixture");
    expect(missingWaveWindow.caveats.join(" ")).toContain("surf rating is unknown");
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
    expect(requireWindow(response).activeCapabilities).toContain("observed_wave");
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

    const roughestWindow = requireWindow(response);
    expect(roughestWindow.windDirectionDeg).toBe(145);
    expect(roughestWindow.windSpeedKt).toBeCloseTo(12, 8);
  });

  it("preserves first-row tie behavior while using indexed tide, wind, wave, hazard, and source-run lookups", async () => {
    const rows = liveRows();
    rows.tide = [
      {
        forecast_at: "2026-07-10T05:00:00.000Z",
        tide_ft_mllw: 5,
        tide_trend: "falling",
        source_run_id: "tide-run"
      },
      {
        forecast_at: "2026-07-10T03:00:00.000Z",
        tide_ft_mllw: 3,
        tide_trend: "rising",
        source_run_id: "tide-run"
      }
    ];
    rows.wind = [
      {
        forecast_at: "2026-07-10T05:00:00.000Z",
        model_cycle_at: null,
        wind_speed_ms: 4,
        wind_direction_deg: 300,
        gust_ms: 5,
        weather_summary: "first input row",
        source_run_id: "wind-run"
      },
      {
        forecast_at: forecastAt,
        model_cycle_at: null,
        wind_speed_ms: 4,
        wind_direction_deg: 300,
        gust_ms: 5,
        weather_summary: "earlier timestamp",
        source_run_id: "wind-run"
      }
    ];
    rows.wave = [
      { ...rows.wave[0] as object, nearshore_height_m: 0.5 },
      { ...rows.wave[0] as object, nearshore_height_m: 1.5 }
    ];
    rows.hazard = [
      {
        source_id: "nws:point-forecast-alerts",
        starts_at: "2026-07-10T03:30:00.000Z",
        ends_at: "2026-07-10T06:00:00.000Z",
        headline: "First input hazard",
        source_run_id: "hazard-run"
      },
      {
        source_id: "nws:point-forecast-alerts",
        starts_at: "2026-07-10T03:00:00.000Z",
        ends_at: "2026-07-10T06:00:00.000Z",
        headline: "Earlier-starting hazard",
        source_run_id: "hazard-run"
      }
    ];
    rows.source = [
      {
        id: "tide-run",
        source_id: "tide",
        status: "success",
        completed_at: "2026-07-10T02:00:00.000Z"
      },
      {
        id: "tide-run",
        source_id: "tide-duplicate",
        status: "success",
        completed_at: "2026-07-10T02:30:00.000Z"
      },
      ...rows.source.filter((row) => (row as { id?: string }).id !== "tide-run")
    ];

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T02:53:07.000Z")
    );

    const tiedWindow = requireWindow(response);
    expect(tiedWindow).toMatchObject({
      tideFt: 5,
      tideTrend: "falling",
      windSpeedKt: 4 * 1.94384,
      weatherSummary: "first input row",
      waveHeightFt: 0.5 * 3.28084
    });
    expect(tiedWindow.caveats).toContain("Active NWS hazard: First input hazard");
    expect(tiedWindow.sourceFreshness?.find((entry) => entry.capability === "tide")).toMatchObject({
      updatedAt: "2026-07-10T02:00:00.000Z",
      freshnessMinutes: 53
    });
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
    expect(response.windows).toHaveLength(120);
    expect(response.windows[0]?.forecastAt).toBe("2026-07-09T07:00:00.000Z");
    expect(response.windows.at(-1)?.forecastAt).toBe("2026-07-14T06:00:00.000Z");
    expect(new Date(response.windows[0]!.forecastAt).getTime()).toBeLessThan(
      new Date("2026-07-10T03:01:00.000Z").getTime()
    );
    const sourcedWindows = windowsFrom(response, forecastAt, 3);
    expect(sourcedWindows.map((window) => window.forecastAt)).toEqual([
      "2026-07-10T04:00:00.000Z",
      "2026-07-10T05:00:00.000Z",
      "2026-07-10T06:00:00.000Z"
    ]);
    expect(sourcedWindows.map((window) => window.waveHeightFt)).toEqual([
      0.78 * 3.28084,
      0.78 * 3.28084,
      0.78 * 3.28084
    ]);
    expect(sourcedWindows.map((window) => window.windSpeedKt)).toEqual([
      3 * 1.94384,
      5,
      9
    ]);
    expect(sourcedWindows.map((window) => window.tideFt)).toEqual([3.2, 3.4, 3.7]);
    expect(sourcedWindows.every((window) =>
      window.waveState?.validFrom === forecastAt &&
      window.waveState.validTo === "2026-07-10T07:00:00.000Z" &&
      window.resolution?.wave.method === "held"
    )).toBe(true);
    expect(sourcedWindows[1]).toMatchObject({
      weatherSummary: "Partly cloudy",
      resolution: {
        wind: { method: "exact", displayIntervalMinutes: 60 },
        tide: { method: "exact", displayIntervalMinutes: 60 }
      }
    });
    expect(sourcedWindows[1]?.windGustKt).toBeCloseTo(8, 8);
  });

  it("keeps dense 1-hour assembly linear in normalized input rows", async () => {
    const rows = liveRows();
    const now = new Date("2026-07-10T03:01:00.000Z");
    const hourlyTimes = stableHourlyForecastTimes(
      now,
      120,
      "America/Los_Angeles"
    );
    const threeHourTimes = stableThreeHourForecastTimes(
      now,
      120,
      "America/Los_Angeles"
    );
    rows.tide = hourlyTimes.map((forecastAtValue, index) => ({
      forecast_at: forecastAtValue,
      tide_ft_mllw: 2 + index / 100,
      tide_trend: index % 2 === 0 ? "rising" : "falling",
      source_run_id: "tide-run"
    }));
    rows.wind = hourlyTimes.map((forecastAtValue, index) => ({
      forecast_at: forecastAtValue,
      model_cycle_at: "2026-07-10T01:00:00.000Z",
      wind_speed_ms: 2 + index / 100,
      wind_direction_deg: 280,
      gust_ms: 3 + index / 100,
      weather_summary: "Clear",
      source_run_id: "wind-run"
    }));
    rows.wave = threeHourTimes.map((forecastAtValue, index) => ({
      ...rows.wave[0] as object,
      forecast_at: forecastAtValue,
      nearshore_height_m: 0.7 + index / 100
    }));
    rows.observation = [];
    rows.hazard = [];

    const tideReads = trackIndexedReads(rows.tide);
    const windReads = trackIndexedReads(rows.wind);
    const waveReads = trackIndexedReads(rows.wave);
    const sourceReads = trackIndexedReads(rows.source);
    rows.tide = tideReads.values;
    rows.wind = windReads.values;
    rows.wave = waveReads.values;
    rows.source = sourceReads.values;

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      now,
      "1h"
    );

    expect(response.windows).toHaveLength(hourlyTimes.length);
    expect(response.windows.every((window) => window.ratingStatus === "scored")).toBe(true);
    expect(response.windows.slice(0, 3).map((window) => window.waveHeightFt)).toEqual([
      0.7 * 3.28084,
      0.7 * 3.28084,
      0.7 * 3.28084
    ]);
    // These deterministic access counts reject a return to per-window full-array scans
    // without relying on machine-dependent wall-clock thresholds.
    expect(tideReads.reads()).toBeLessThanOrEqual(2 * hourlyTimes.length);
    expect(windReads.reads()).toBeLessThanOrEqual(2 * hourlyTimes.length);
    expect(waveReads.reads()).toBeLessThanOrEqual(3 * threeHourTimes.length);
    expect(sourceReads.reads()).toBeLessThanOrEqual(2 * rows.source.length);
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

    const heldWindows = windowsFrom(response, forecastAt, 3);
    expect(heldWindows.map((window) => window.waveHeightFt)).toEqual([
      1 * 3.28084,
      1 * 3.28084,
      2 * 3.28084
    ]);
    expect(heldWindows.map((window) => window.waveState?.validFrom)).toEqual([
      "2026-07-10T03:00:00.000Z",
      "2026-07-10T03:00:00.000Z",
      "2026-07-10T06:00:00.000Z"
    ]);
    expect(heldWindows.every((window) =>
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

    const invalidSemanticsWindow = requireWindow(response);
    expect(invalidSemanticsWindow).toMatchObject({
      ratingStatus: "unknown",
      waveHeightFt: null,
      waveState: null,
      waveProvenance: null
    });
    expect(invalidSemanticsWindow.activeCapabilities).not.toContain("forecast_wave_nearshore");
    expect(invalidSemanticsWindow.caveats.join(" ")).toContain("omitted recognized nearshore semantics");
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
    const selectedWindow = requireWindow(response);
    const windFreshness = selectedWindow.sourceFreshness?.find(
      (entry) => entry.capability === "wind"
    );

    expect(windFreshness).toMatchObject({
      updatedAt: "2026-07-09T12:00:00.000Z",
      freshnessMinutes: 893,
      status: "stale"
    });
    expect(selectedWindow.sourceFreshnessMinutes).toBe(893);
  });

  it("ships adapter-declared cadence and grace on every source freshness entry", async () => {
    const response = await buildForecastResponse(
      env(queryDb(liveRows())),
      "bolinas",
      new Date("2026-07-10T02:53:00.000Z")
    );

    expect(response.windows.length).toBeGreaterThan(0);
    for (const window of response.windows) {
      expect(window.sourceFreshness?.length).toBeGreaterThan(0);
      for (const entry of window.sourceFreshness ?? []) {
        expect(entry.expectedCadenceMinutes).toBeGreaterThan(0);
        expect(entry.graceMinutes).toBeGreaterThanOrEqual(0);
        // The shipped status must agree with the shared contracts verdict:
        // late renders as stale; fresh/aging stay quiet-fresh.
        const verdict = sourceFreshnessVerdict(entry);
        if (entry.freshnessMinutes === null) {
          expect(entry.status).toBe("missing");
        } else {
          expect(entry.status).toBe(verdict === "late" ? "stale" : "fresh");
        }
      }
    }

    const selectedFreshness = requireWindow(response).sourceFreshness ?? [];
    expect(selectedFreshness.find((entry) => entry.capability === "wind")).toMatchObject({
      expectedCadenceMinutes: 360,
      graceMinutes: 180
    });
    expect(selectedFreshness.find((entry) => entry.capability === "tide")).toMatchObject({
      expectedCadenceMinutes: 1440,
      graceMinutes: 360
    });
    expect(selectedFreshness.find((entry) => entry.capability === "observed_wave")).toMatchObject({
      expectedCadenceMinutes: 60,
      graceMinutes: 60
    });
    expect(selectedFreshness.find((entry) => entry.capability.startsWith("forecast_wave"))).toMatchObject({
      sourceId: "nws:mtr-grid-wave",
      expectedCadenceMinutes: 720,
      graceMinutes: 240
    });
  });

  it("declares the CDIP cadence when the selected wave row is a MOP forecast", async () => {
    const rows = liveRows();
    rows.wave[0] = { ...(rows.wave[0] as object), source_id: "cdip:mop-forecast" };

    const response = await buildForecastResponse(
      env(queryDb(rows)),
      "bolinas",
      new Date("2026-07-10T02:53:00.000Z")
    );

    expect(
      requireWindow(response).sourceFreshness?.find((entry) => entry.capability.startsWith("forecast_wave"))
    ).toMatchObject({
      sourceId: "cdip:mop-forecast",
      expectedCadenceMinutes: 360,
      graceMinutes: 180
    });
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
