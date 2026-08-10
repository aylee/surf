/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { ForecastResponse } from "@surf/contracts";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  materializeForecastReadModelForSpot
} from "./forecast-read-model";
import type { Env } from "./index";
import {
  forecastDisplayHorizonEnd,
  stableHourlyForecastTimes,
  stableThreeHourForecastTimes
} from "./time";

type QueryMeasurement = {
  sql: string;
  bindings: unknown[];
  rowsRead: number;
  rowsReturned: number;
};

function rowsRead(result: D1Result<unknown>): number {
  return Number((result.meta as { rows_read?: number } | undefined)?.rows_read ?? 0);
}

function measuredDatabase(database: D1Database): {
  db: D1Database;
  measurements: QueryMeasurement[];
} {
  const measurements: QueryMeasurement[] = [];
  const statements = new WeakMap<
    object,
    { statement: D1PreparedStatement; sql: string; bindings: unknown[] }
  >();
  const record = (
    sql: string,
    bindings: unknown[],
    result: D1Result<unknown>
  ): void => {
    measurements.push({
      sql,
      bindings,
      rowsRead: rowsRead(result),
      rowsReturned: Array.isArray(result.results) ? result.results.length : 0
    });
  };
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
    bindings: unknown[] = []
  ): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        }
        if (property === "all") {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.all, target, args) as D1Result<unknown>;
            record(sql, bindings, result);
            return result;
          };
        }
        if (property === "run") {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.run, target, args) as D1Result<unknown>;
            record(sql, bindings, result);
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    statements.set(proxy, { statement, sql, bindings });
    return proxy;
  };
  const db = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => wrap(target.prepare(sql), sql);
      }
      if (property === "batch") {
        return async (prepared: D1PreparedStatement[]) => {
          const unwrapped = prepared.map((statement) =>
            statements.get(statement as object) ?? {
              statement,
              sql: "<untracked D1 statement>",
              bindings: []
            }
          );
          const results = await target.batch(
            unwrapped.map(({ statement }) => statement)
          );
          results.forEach((result, index) => {
            const query = unwrapped[index]!;
            record(query.sql, query.bindings, result as D1Result<unknown>);
          });
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { db, measurements };
}

const GENERATED_AT = new Date("2026-08-10T08:00:00.000Z");
const CDIP_SOURCE_ID = "cdip:mop-forecast";
const NWS_SOURCE_ID = "nws:mtr-grid-wave";
const CDIP_PAYLOAD = JSON.stringify({
  sourceUrl: "https://thredds.cdip.ucsd.edu/test",
  sourceUpdatedAt: "2026-08-10T04:00:00.000Z",
  modelCycleAt: "2026-08-10T04:00:00.000Z",
  significantHeightM: 1,
  nearshoreHeightM: 1,
  exposureAdjustedPointHeightM: 1,
  nearshoreHeightScale: 1,
  modelPointId: "D0941",
  modelPointWaterDepthM: 10,
  modelPointShoreNormalDeg: 225,
  pointRelationship: "direct_nearshore_point"
});
const NWS_PAYLOAD = JSON.stringify({
  sourceUrl: "https://api.weather.gov/gridpoints/MTR/test",
  breakingHeightScale: 1,
  significantHeightM: 2,
  estimatedBreakingHeightM: 2,
  primarySwellHeightM: 2,
  primarySwellPeriodS: 10,
  primarySwellDirectionDeg: 280
});

async function seedReferences(): Promise<void> {
  await env.DB.prepare(
    `insert or ignore into spots (
       id, name, region, lat, lon, timezone, shore_normal_deg, config_json, active
     ) values ('stinson', 'Stinson', 'norcal', 37.900, -122.645,
       'America/Los_Angeles', 225, '{}', 1)`
  ).run();
  await env.DB.prepare(
    `insert or ignore into sources (
       id, name, type, provider, format, parser_runtime, attribution,
       refresh_minutes, active
     ) values (?, ?, 'test', 'test', 'json', 'typescript', 'test', 60, 1),
              (?, ?, 'test', 'test', 'json', 'typescript', 'test', 60, 1)`
  ).bind(CDIP_SOURCE_ID, CDIP_SOURCE_ID, NWS_SOURCE_ID, NWS_SOURCE_ID).run();
}

async function clearSpot(spotId: "stinson" | "bolinas"): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("delete from forecast_fact_bundles where spot_id = ?").bind(spotId),
    env.DB.prepare("delete from forecast_read_models where spot_id = ?").bind(spotId),
    env.DB.prepare("delete from wave_forecasts where spot_id = ?").bind(spotId)
  ]);
}

async function seedRetainedCycles(): Promise<{
  waveHorizonStart: string;
  waveHorizonEnd: string;
  retainedRows: number;
}> {
  const times = stableHourlyForecastTimes(GENERATED_AT, 120, "America/Los_Angeles");
  const waveHorizonStart = new Date(Date.parse(times[0]!) - 3 * 60 * 60_000).toISOString();
  const waveHorizonEnd = new Date(Date.parse(times.at(-1)!) + 90 * 60_000).toISOString();
  const cycleCount = 160;
  const slotCount = 41;
  const cycleStart = new Date(
    Date.parse(waveHorizonStart) - (cycleCount - 1) * 60 * 60_000
  ).toISOString();
  await env.DB.prepare(
    `with recursive
       cycles(value) as (
         values(0) union all select value + 1 from cycles where value < ?
       ),
       slots(value) as (
         values(0) union all select value + 1 from slots where value < ?
       ),
       providers(source_id, payload_json) as (values (?, ?), (?, ?))
     insert into wave_forecasts (
       spot_id, source_id, source_run_id, model_cycle_at, forecast_at, lead_hour,
       offshore_height_m, nearshore_height_m, significant_height_m, peak_period_s,
       mean_period_s, primary_direction_deg, wind_wave_height_m, wind_wave_period_s,
       wind_wave_direction_deg, swell_height_m, swell_period_s, swell_direction_deg,
       payload_json, created_at
     )
     select
       'stinson', providers.source_id, null,
       strftime('%Y-%m-%dT%H:%M:%fZ', datetime(?, '+' || cycles.value || ' hours')),
       strftime('%Y-%m-%dT%H:%M:%fZ', datetime(?, '+' || (slots.value * 3) || ' hours')),
       slots.value * 3,
       null,
       case
         when providers.source_id = ? and cycles.value = ? and slots.value = 1 then null
         when providers.source_id = ? then 1.0
         else 2.0
       end,
       case when providers.source_id = ? then 1.0 else 2.0 end,
       10, null, 280, null, null, null,
       case when providers.source_id = ? then null else 2.0 end,
       case when providers.source_id = ? then null else 10 end,
       case when providers.source_id = ? then null else 280 end,
       providers.payload_json,
       strftime('%Y-%m-%dT%H:%M:%fZ', datetime(?, '+' || cycles.value || ' seconds'))
     from cycles cross join slots cross join providers`
  ).bind(
    cycleCount - 1,
    slotCount - 1,
    CDIP_SOURCE_ID,
    CDIP_PAYLOAD,
    NWS_SOURCE_ID,
    NWS_PAYLOAD,
    cycleStart,
    waveHorizonStart,
    CDIP_SOURCE_ID,
    cycleCount - 1,
    CDIP_SOURCE_ID,
    CDIP_SOURCE_ID,
    CDIP_SOURCE_ID,
    CDIP_SOURCE_ID,
    CDIP_SOURCE_ID,
    cycleStart
  ).run();
  return {
    waveHorizonStart,
    waveHorizonEnd,
    retainedRows: cycleCount * slotCount * 2
  };
}

async function readModels(spotId: string): Promise<Map<string, ForecastResponse>> {
  const result = await env.DB.prepare(
    `select interval, forecast_json
     from forecast_read_models
     where spot_id = ?`
  ).bind(spotId).all<{ interval: string; forecast_json: string }>();
  return new Map(
    (result.results ?? []).map(({ interval, forecast_json }) => [
      interval,
      JSON.parse(forecast_json) as ForecastResponse
    ])
  );
}

async function seedDstFallbackRows(now: Date): Promise<void> {
  const hourlyTimes = stableHourlyForecastTimes(now, 120, "America/Los_Angeles");
  const anchors = stableThreeHourForecastTimes(now, 120, "America/Los_Angeles");
  const recentCycleAt = new Date(Date.parse(hourlyTimes[0]!) - 3 * 60 * 60_000).toISOString();
  const olderCycleAt = new Date(Date.parse(recentCycleAt) - 60 * 60_000).toISOString();
  const rows = [olderCycleAt, recentCycleAt].flatMap((modelCycleAt) =>
    anchors.map((forecastAt, index) => ({
      modelCycleAt,
      forecastAt,
      nearshoreHeightM:
        modelCycleAt === recentCycleAt && (index === 0 || index === anchors.length - 1)
          ? null
          : modelCycleAt === recentCycleAt
            ? 3
            : 2,
      createdAt: modelCycleAt
    }))
  );
  await env.DB.prepare(
    `insert into wave_forecasts (
       spot_id, source_id, model_cycle_at, forecast_at, lead_hour,
       nearshore_height_m, significant_height_m, peak_period_s,
       primary_direction_deg, swell_height_m, swell_period_s,
       swell_direction_deg, payload_json, created_at
     )
     select
       'stinson', ?,
       json_extract(item.value, '$.modelCycleAt'),
       json_extract(item.value, '$.forecastAt'),
       0,
       json_extract(item.value, '$.nearshoreHeightM'),
       2, 10, 280, 2, 10, 280, ?,
       json_extract(item.value, '$.createdAt')
     from json_each(?) as item`
  ).bind(NWS_SOURCE_ID, NWS_PAYLOAD, JSON.stringify(rows)).run();
}

describe("production-shaped forecast materialization in Workerd D1", () => {
  beforeEach(async () => {
    await seedReferences();
    await clearSpot("stinson");
    await clearSpot("bolinas");
  });

  it("bounds retained-cycle reads while preserving exact older-cycle fallback", async () => {
    const { waveHorizonStart, waveHorizonEnd, retainedRows } = await seedRetainedCycles();
    expect(retainedRows).toBe(13_120);

    const legacy = await env.DB.prepare(
      `select source_id, forecast_at, model_cycle_at, nearshore_height_m
       from (
         select source_id, forecast_at, model_cycle_at, nearshore_height_m, created_at,
                row_number() over (
                  partition by source_id, forecast_at
                  order by case when nearshore_height_m is not null then 0 else 1 end,
                           model_cycle_at desc, created_at desc
                ) as source_rank
         from wave_forecasts
         where spot_id = ? and forecast_at >= ? and forecast_at <= ?
       )
       where source_rank = 1
       order by forecast_at asc`
    ).bind("stinson", waveHorizonStart, waveHorizonEnd).all();
    const legacyRowsRead = rowsRead(legacy);
    expect(legacyRowsRead).toBeGreaterThanOrEqual(retainedRows);

    const measured = measuredDatabase(env.DB);
    const result = await materializeForecastReadModelForSpot(
      { DB: measured.db } as Env,
      "stinson",
      GENERATED_AT,
      {
        materializedAt: "2026-08-10T08:05:00.000Z",
        ingestId: "rows-read-worker-spec"
      }
    );
    expect(result).toMatchObject({
      forecastRowsWritten: 2,
      errors: []
    });

    const sourceReadMeasurements = measured.measurements.filter(({ sql }) =>
      [
        "from tide_forecasts",
        "from tide_events",
        "from wind_forecasts",
        "from wave_forecasts",
        "from wave_observations",
        "from hazard_events",
        "from forecast_issues",
        "from forecast_snapshots",
        "from json_each(?) as referenced"
      ].some((fragment) => sql.includes(fragment))
    );
    const optimizedRowsRead = sourceReadMeasurements.reduce(
      (total, measurement) => total + measurement.rowsRead,
      0
    );
    expect(optimizedRowsRead).toBeLessThan(1_500);
    expect(optimizedRowsRead).toBeLessThan(legacyRowsRead / 5);

    const recentWaveQuery = measured.measurements.find(({ sql }) =>
      sql.includes("where rowid in") && sql.includes("model_cycle_at >= coalesce(")
    );
    expect(recentWaveQuery).toBeDefined();
    const queryPlan = await env.DB.prepare(
      `explain query plan ${recentWaveQuery!.sql}`
    ).bind(...recentWaveQuery!.bindings).all<{ detail: string }>();
    const plan = (queryPlan.results ?? []).map(({ detail }) => detail).join("\n");
    expect(plan).toContain("USING INTEGER PRIMARY KEY");
    expect(plan).toContain("sqlite_autoindex_wave_forecasts_1");
    expect(plan).not.toContain("wave_forecasts_spot_forecast_at_idx");
    expect(plan).not.toContain("USE TEMP B-TREE");

    const fallbackQuery = measured.measurements.find(({ sql }) =>
      sql.includes("model_cycle_at < coalesce(")
    );
    expect(fallbackQuery).toBeDefined();
    expect(fallbackQuery!.rowsRead).toBeLessThan(1_000);

    const models = await readModels("stinson");
    const hourly = models.get("1h")!;
    const threeHour = models.get("3h")!;
    expect(hourly.windows.map(({ forecastAt }) => forecastAt)).toEqual(
      stableHourlyForecastTimes(GENERATED_AT, 120, "America/Los_Angeles")
    );
    expect(threeHour.windows.map(({ forecastAt }) => forecastAt)).toEqual(
      stableThreeHourForecastTimes(GENERATED_AT, 120, "America/Los_Angeles")
    );
    expect(hourly.windows[0]).toMatchObject({
      ratingStatus: "scored",
      waveHeightFt: 3.28084,
      waveProvenance: { sourceId: CDIP_SOURCE_ID }
    });
    expect(threeHour.windows[0]).toMatchObject({
      ratingStatus: "scored",
      waveHeightFt: 3.28084,
      waveProvenance: { sourceId: CDIP_SOURCE_ID }
    });
    expect(forecastDisplayHorizonEnd(hourly.windows.map(({ forecastAt }) => forecastAt), "1h"))
      .toBe(forecastDisplayHorizonEnd(
        threeHour.windows.map(({ forecastAt }) => forecastAt),
        "3h"
      ));
  });

  it("uses NWS when mapped CDIP is absent and never consults CDIP for Bolinas", async () => {
    const times = stableHourlyForecastTimes(GENERATED_AT, 120, "America/Los_Angeles");
    const forecastStart = new Date(Date.parse(times[0]!) - 3 * 60 * 60_000).toISOString();
    const insert = async (spotId: "stinson" | "bolinas", sourceId: string, heightM: number) => {
      await env.DB.prepare(
        `insert into wave_forecasts (
           spot_id, source_id, model_cycle_at, forecast_at, lead_hour,
           nearshore_height_m, significant_height_m, peak_period_s,
           primary_direction_deg, swell_height_m, swell_period_s,
           swell_direction_deg, payload_json, created_at
         ) values (?, ?, ?, ?, 0, ?, ?, 10, 280, ?, 10, 280, ?, ?)`
      ).bind(
        spotId,
        sourceId,
        forecastStart,
        times[0],
        heightM,
        heightM,
        heightM,
        sourceId === CDIP_SOURCE_ID ? CDIP_PAYLOAD : NWS_PAYLOAD,
        forecastStart
      ).run();
    };
    await insert("stinson", NWS_SOURCE_ID, 2);
    await insert("bolinas", NWS_SOURCE_ID, 2);
    // This deliberately invalid catalog/data combination proves the no-CDIP
    // spot's query derives its sources from the registry rather than whatever
    // rows happen to exist.
    await insert("bolinas", CDIP_SOURCE_ID, 9);

    const stinson = measuredDatabase(env.DB);
    const stinsonResult = await materializeForecastReadModelForSpot(
      { DB: stinson.db } as Env,
      "stinson",
      GENERATED_AT,
      { materializedAt: "2026-08-10T08:06:00.000Z", ingestId: "nws-only-stinson" }
    );
    expect(stinsonResult.errors).toEqual([]);
    const stinsonModels = await readModels("stinson");
    expect(stinsonModels.get("1h")!.windows[0]).toMatchObject({
      ratingStatus: "scored",
      waveHeightFt: 2 * 3.28084,
      waveProvenance: { sourceId: NWS_SOURCE_ID }
    });

    const bolinas = measuredDatabase(env.DB);
    const bolinasResult = await materializeForecastReadModelForSpot(
      { DB: bolinas.db } as Env,
      "bolinas",
      GENERATED_AT,
      { materializedAt: "2026-08-10T08:07:00.000Z", ingestId: "nws-only-bolinas" }
    );
    expect(bolinasResult.errors).toEqual([]);
    const bolinasRecentQuery = bolinas.measurements.find(({ sql }) =>
      sql.includes("where rowid in")
    )!;
    expect(bolinasRecentQuery.bindings).toContain(NWS_SOURCE_ID);
    expect(bolinasRecentQuery.bindings).not.toContain(CDIP_SOURCE_ID);
    const bolinasModels = await readModels("bolinas");
    expect(bolinasModels.get("1h")!.windows[0]).toMatchObject({
      ratingStatus: "scored",
      waveHeightFt: 2 * 3.28084,
      waveProvenance: { sourceId: NWS_SOURCE_ID }
    });
  });

  it.each([
    ["normal", "2026-08-10T18:00:00.000Z"],
    ["spring-forward", "2026-03-08T18:00:00.000Z"],
    ["fall-back", "2026-11-01T18:00:00.000Z"]
  ] as const)(
    "keeps complete 1h/3h dates and older-cycle edge fallback across %s days",
    async (_dateKind, nowAt) => {
      await clearSpot("stinson");
      const now = new Date(nowAt);
      await seedDstFallbackRows(now);

      const result = await materializeForecastReadModelForSpot(
        { DB: env.DB } as Env,
        "stinson",
        now,
        { materializedAt: now.toISOString(), ingestId: `dst-${_dateKind}` }
      );
      expect(result.errors).toEqual([]);

      const models = await readModels("stinson");
      const hourly = models.get("1h")!;
      const threeHour = models.get("3h")!;
      const expectedHourly = stableHourlyForecastTimes(now, 120, "America/Los_Angeles");
      const expectedThreeHour = stableThreeHourForecastTimes(now, 120, "America/Los_Angeles");
      expect(hourly.windows.map(({ forecastAt }) => forecastAt)).toEqual(expectedHourly);
      expect(threeHour.windows.map(({ forecastAt }) => forecastAt)).toEqual(expectedThreeHour);
      for (const response of [hourly, threeHour]) {
        expect(response.windows[0]).toMatchObject({
          ratingStatus: "scored",
          waveHeightFt: 2 * 3.28084,
          waveProvenance: { sourceId: NWS_SOURCE_ID }
        });
        expect(response.windows.at(-1)).toMatchObject({
          ratingStatus: "scored",
          waveHeightFt: 2 * 3.28084,
          waveProvenance: { sourceId: NWS_SOURCE_ID }
        });
        expect(
          response.windows.find(({ forecastAt }) => forecastAt === expectedThreeHour[1])
        ).toMatchObject({
          ratingStatus: "scored",
          waveHeightFt: 3 * 3.28084,
          waveProvenance: { sourceId: NWS_SOURCE_ID }
        });
      }
      expect(forecastDisplayHorizonEnd(expectedHourly, "1h"))
        .toBe(forecastDisplayHorizonEnd(expectedThreeHour, "3h"));
    }
  );
});
