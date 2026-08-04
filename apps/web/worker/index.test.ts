import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ForecastBriefResponseSchema,
  ForecastResponseSchema,
  type ForecastInterval,
  type ForecastResponse
} from "@surf/contracts";
import { NORCAL_SPOTS } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { buildForecastFactBundle, type ForecastFactBundle } from "./brief";
import { FORECAST_READ_MODEL_SCHEMA_VERSION } from "./forecast-read-model";
import type { Env } from "./index";
import worker from "./index";
import {
  FORECAST_HISTORY_RETENTION_DAYS,
  OPERATIONAL_FORECAST_RETENTION_DAYS,
  pruneRetainedData,
  runNorcalIngest,
  shouldCaptureForecastHistory
} from "./ingest";
import { localDateForTime, stableThreeHourForecastTimes } from "./time";

function dbMock(options: {
  forecastAssemblyRows?: boolean;
  failRunSqlIncludes?: string;
} = {}) {
  const runs: unknown[][] = [];
  const sqls: string[] = [];
  const preparedSql: string[] = [];
  const db = {
    prepare: (sql: string) => {
      preparedSql.push(sql);
      const allFor = async (values: unknown[]) => {
        if (!options.forecastAssemblyRows) return { results: [], success: true, meta: {} };
        const horizonStart = typeof values[1] === "string" ? values[1] : null;
        const waveStart = horizonStart ? new Date(horizonStart).getTime() : Number.NaN;
        const waveForecastAt = Number.isFinite(waveStart)
          ? new Date(waveStart + 3 * 60 * 60 * 1000).toISOString()
          : null;
        if (sql.includes("from tide_forecasts") && horizonStart) {
          return {
            results: [{
              forecast_at: horizonStart,
              tide_ft_mllw: 2.5,
              tide_trend: "rising",
              source_run_id: "tide-run"
            }],
            success: true,
            meta: {}
          };
        }
        if (sql.includes("from wind_forecasts") && horizonStart) {
          return {
            results: [{
              forecast_at: horizonStart,
              model_cycle_at: new Date(
                new Date(horizonStart).getTime() - 60 * 60 * 1000
              ).toISOString(),
              wind_speed_ms: 3,
              wind_direction_deg: 90,
              gust_ms: 5,
              weather_summary: "Clear",
              source_run_id: "wind-run"
            }],
            success: true,
            meta: {}
          };
        }
        if (sql.includes("from wave_forecasts") && waveForecastAt) {
          return {
            results: [{
              source_id: "nws:mtr-grid-wave",
              forecast_at: waveForecastAt,
              model_cycle_at: new Date(
                new Date(waveForecastAt).getTime() - 3 * 60 * 60 * 1000
              ).toISOString(),
              nearshore_height_m: 1,
              offshore_height_m: null,
              significant_height_m: 1.3,
              peak_period_s: 10,
              primary_direction_deg: 290,
              swell_height_m: 1,
              swell_period_s: 10,
              swell_direction_deg: 290,
              payload_json: JSON.stringify({
                sourceUrl: "https://api.weather.gov/gridpoints/MTR/fixture",
                breakingHeightScale: 0.75,
                significantHeightM: 1.3,
                estimatedBreakingHeightM: 1
              }),
              source_run_id: "wave-run"
            }],
            success: true,
            meta: {}
          };
        }
        if (sql.includes("from source_runs")) {
          return {
            results: ["tide-run", "wind-run", "wave-run"].map((id) => ({
              id,
              source_id: id,
              status: "success",
              completed_at: "2026-07-08T15:00:00.000Z"
            })),
            success: true,
            meta: {}
          };
        }
        return { results: [], success: true, meta: {} };
      };
      const all = async () => allFor([]);
      const first = async () => null;
      return {
        bind: (...values: unknown[]) => ({
          all: async () => allFor(values),
          first,
          run: async () => {
            if (options.failRunSqlIncludes && sql.includes(options.failRunSqlIncludes)) {
              throw new Error(`simulated D1 failure for ${options.failRunSqlIncludes}`);
            }
            runs.push(values);
            sqls.push(sql);
            return { success: true, results: [], meta: { changes: 1 } };
          }
        }),
        all,
        first
      };
    }
  } as unknown as D1Database;

  return { db, runs, sqls, preparedSql };
}

function env(db: D1Database = dbMock().db): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    SURF_USER_AGENT: "surf-test/1.0 (+https://example.test/contact)",
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    DB: db,
    RAW_ARTIFACTS: { put: async () => ({}) } as unknown as R2Bucket,
    INGEST_QUEUE: { send: async () => undefined } as unknown as Queue
  };
}

function fixtureForecast(interval: ForecastInterval): ForecastResponse {
  return {
    ...buildFixtureForecast("obsf-central", new Date("2026-08-02T13:00:00.000Z")),
    interval
  };
}

function withMaterializedRows(
  fallback: D1Database,
  forecasts: ForecastResponse[],
  factBundles: ForecastFactBundle[] = [],
  ingestId?: string
): D1Database {
  return {
    prepare(sql: string) {
      if (sql.includes("from forecast_fact_bundles")) {
        return {
          bind(spotId: string, localDate: string) {
            return {
              async first() {
                const bundle = factBundles.find(
                  (candidate) =>
                    candidate.input.spotId === spotId && candidate.input.localDate === localDate
                );
                return bundle
                  ? {
                      generation_id: ingestId
                        ? `sha256:${"a".repeat(64)}:ingest:${ingestId}`
                        : "sha256:test-generation",
                      schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
                      fact_bundle_json: JSON.stringify(bundle)
                    }
                  : null;
              }
            };
          }
        } as unknown as D1PreparedStatement;
      }
      if (sql.includes("from forecast_read_models")) {
        return {
          bind(spotId: string, interval: ForecastInterval) {
            return {
              async first() {
                const forecast = forecasts.find(
                  (candidate) => candidate.spot.id === spotId && candidate.interval === interval
                );
                return forecast
                  ? {
                      generation_id: ingestId
                        ? `sha256:${"a".repeat(64)}:ingest:${ingestId}`
                        : "sha256:test-generation",
                      generated_at: forecast.generatedAt,
                      schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
                      forecast_json: JSON.stringify(forecast),
                      materialized_at: "2026-08-02T13:05:00.000Z"
                    }
                  : null;
              }
            };
          }
        } as unknown as D1PreparedStatement;
      }
      return fallback.prepare(sql);
    }
  } as unknown as D1Database;
}

describe("worker api", () => {
  it("samples scheduled history every six hours while preserving manual captures", () => {
    expect(shouldCaptureForecastHistory("queued-ingest", "2026-07-10T00:17:00Z")).toBe(true);
    expect(shouldCaptureForecastHistory("queued-ingest", "2026-07-10T01:17:00Z")).toBe(false);
    expect(shouldCaptureForecastHistory("manual-ingest", "2026-07-10T01:17:00Z")).toBe(true);
  });

  it("bounds operational rows separately from the evaluation dataset", async () => {
    const { db, runs, sqls } = dbMock();
    const now = new Date("2026-07-10T12:00:00.000Z");

    const result = await pruneRetainedData(db, now);

    expect(result.errors).toEqual([]);
    expect(sqls).toHaveLength(13);
    for (const table of ["wave_forecasts", "tide_forecasts", "tide_events", "wind_forecasts"]) {
      const index = sqls.findIndex((sql) => sql.includes(`delete from ${table}`));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(runs[index]?.[0]).toBe(
        new Date(
          now.getTime() - OPERATIONAL_FORECAST_RETENTION_DAYS * 24 * 60 * 60 * 1000
        ).toISOString()
      );
    }
    for (const table of [
      "forecast_snapshots",
      "forecast_issues",
      "wind_forecast_issues",
      "wave_observations",
      "hazard_events",
      "source_artifacts",
      "source_runs"
    ]) {
      const index = sqls.findIndex((sql) => sql.includes(`delete from ${table}`));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(runs[index]?.[0]).toBe(
        new Date(
          now.getTime() - FORECAST_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
        ).toISOString()
      );
    }
    expect(sqls.some((sql) => sql.includes("delete from forecast_configs"))).toBe(true);
    expect(sqls.find((sql) => sql.includes("delete from source_runs"))).toContain(
      "not exists (select 1 from wave_forecasts"
    );
    expect(sqls.find((sql) => sql.includes("delete from source_runs"))).toContain(
      "not exists (select 1 from tide_events"
    );
    const factBundleIndex = sqls.findIndex((sql) => sql.includes("delete from forecast_fact_bundles"));
    expect(factBundleIndex).toBeGreaterThanOrEqual(0);
    expect(runs[factBundleIndex]?.[0]).toBe(
      new Date(
        now.getTime() - OPERATIONAL_FORECAST_RETENTION_DAYS * 24 * 60 * 60 * 1000
      ).toISOString()
    );
    expect(sqls[factBundleIndex]).toContain("forecast_read_models.generation_id");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns health", async () => {
    const request = new Request("http://surf.test/api/health") as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(
      request,
      {
        ...env(),
        CF_VERSION_METADATA: {
          id: "worker-version-test-id",
          tag: "",
          timestamp: "2026-08-04T00:00:00.000Z"
        }
      },
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Surf-Worker-Version")).toBe("worker-version-test-id");
    expect(await response.json()).toMatchObject({ status: "ok", service: "surf" });
  });

  it("returns v1 spots", async () => {
    const request = new Request("http://surf.test/api/spots") as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400"
    );
    const body = (await response.json()) as {
      spots: Array<{
        id: string;
        sourceMap: { observedWave: Array<{ provider: string; stationId: string }> };
      }>;
    };
    expect(body.spots).toHaveLength(6);
    expect(body.spots.find((spot) => spot.id === "stinson")?.sourceMap.observedWave).toEqual([
      expect.objectContaining({ provider: "NDBC", stationId: "46237" }),
      expect.objectContaining({ provider: "NDBC", stationId: "46013" }),
      expect.objectContaining({ provider: "NDBC", stationId: "46026" })
    ]);
  });

  it("rejects well-formed spot IDs that are not configured", async () => {
    const request = new Request("http://surf.test/api/forecast/not-configured") as unknown as Parameters<
      typeof worker.fetch
    >[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);

    expect(response.status).toBe(400);
  });

  it("returns a recoverable 503 when no materialized forecast is available", async () => {
    const request = new Request("http://surf.test/api/forecast/obsf-central") as unknown as Parameters<
      typeof worker.fetch
    >[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    const body = (await response.json()) as { error: string; retryable: boolean; spotId: string };
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(body).toEqual({
      error: "forecast_temporarily_unavailable",
      message: "Forecast data is being refreshed. Please retry shortly.",
      retryable: true,
      spotId: "obsf-central",
      interval: "3h"
    });
  });

  it("supports explicit hourly forecast responses without changing the default interval", async () => {
    const materializedDb = withMaterializedRows(
      dbMock().db,
      [fixtureForecast("1h"), fixtureForecast("3h")]
    );
    const hourly = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central?interval=1h") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      env(materializedDb),
      {} as ExecutionContext
    );
    const defaulted = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      env(materializedDb),
      {} as ExecutionContext
    );

    expect(hourly.status).toBe(200);
    expect(await hourly.json()).toMatchObject({ interval: "1h" });
    expect(defaulted.status).toBe(200);
    expect(defaulted.headers.get("Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=300"
    );
    expect(defaulted.headers.get("X-Surf-Ingest-Id")).toBeNull();
    const etag = defaulted.headers.get("ETag");
    expect(etag).toBe('"sha256:test-generation"');
    expect(await defaulted.json()).toMatchObject({ interval: "3h" });

    const unchanged = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central", {
        headers: { "If-None-Match": etag! }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      env(materializedDb),
      {} as ExecutionContext
    );
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  });

  it("exposes exact queued ingest correlation on forecast responses", async () => {
    const ingestId = "ingest-test-id";
    const materializedDb = withMaterializedRows(
      dbMock().db,
      [fixtureForecast("1h"), fixtureForecast("3h")],
      [],
      ingestId
    );
    const request = new Request(
      "http://surf.test/api/forecast/obsf-central"
    ) as unknown as Parameters<typeof worker.fetch>[0];

    const response = await worker.fetch(request, env(materializedDb), {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Surf-Ingest-Id")).toBe(ingestId);
    expect(response.headers.get("ETag")).toBe(
      `"sha256:${"a".repeat(64)}:ingest:${ingestId}"`
    );
  });

  it("rejects unsupported forecast intervals", async () => {
    const response = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central?interval=2h") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      env(),
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
  });

  it("returns a typed deterministic brief when no model revision exists", async () => {
    const { db, preparedSql } = dbMock();
    const forecast = fixtureForecast("3h");
    const bundle = await buildForecastFactBundle(forecast, { localDate: "2026-08-02" });
    const response = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central/brief?date=2026-08-02") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      env(withMaterializedRows(db, [forecast], [bundle])),
      {} as ExecutionContext
    );
    const body = (await response.json()) as {
      status: string;
      brief: { provider: string; spotId: string };
      fallbackReason: string;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=300"
    );
    expect(body).toMatchObject({
      status: "deterministic_fallback",
      brief: { provider: "deterministic", spotId: "obsf-central" },
      fallbackReason: "AI forecast briefs are disabled for this Worker version."
    });
    expect(preparedSql.some((sql) => /forecast_brief_revisions/i.test(sql))).toBe(false);
  });

  it("validates forecast brief dates before reading storage", async () => {
    const response = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central/brief?date=August-2") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      env(),
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
  });

  it("serves deterministic briefs for future dates from materialized fact bundles", async () => {
    const forecast = fixtureForecast("3h");
    const futureDate = localDateForTime(
      forecast.windows.at(-1)!.forecastAt,
      forecast.spot.timezone
    );
    const bundle = await buildForecastFactBundle(forecast, { localDate: futureDate });
    const db = withMaterializedRows(dbMock().db, [forecast], [bundle]);

    const response = await worker.fetch(
      new Request(
        `http://surf.test/api/forecast/obsf-central/brief?date=${futureDate}`
      ) as unknown as Parameters<typeof worker.fetch>[0],
      env(db),
      {} as ExecutionContext
    );
    const body = ForecastBriefResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.brief.localDate).toBe(futureDate);
    expect(body.brief.picks.length).toBeGreaterThan(0);
    expect(body.fallbackReason).toBe("AI forecast briefs are disabled for this Worker version.");
  });

  it("returns a typed safe summary for a valid date outside the forecast horizon", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central/brief?date=2099-01-01") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      env(),
      {} as ExecutionContext
    );
    const body = ForecastBriefResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "deterministic_fallback",
      fallbackReason: null,
      brief: {
        spotId: "obsf-central",
        localDate: "2099-01-01",
        provider: "deterministic",
        picks: []
      }
    });
    expect(warning).toHaveBeenCalledOnce();
    const logged = warning.mock.calls[0]?.[0];
    expect(logged).toContain('"reason":"requested_date_unavailable"');
    expect(logged).not.toContain("Forecast has no windows");
  });

  it("keeps brief and core forecast GETs independent from the Agent", async () => {
    let agentLookups = 0;
    const poisonAgent = {
      getByName() {
        agentLookups += 1;
        throw new Error("Agent GET access is forbidden");
      }
    } as unknown as NonNullable<Env["FORECAST_BRIEF_AGENT"]>;
    const forecast = fixtureForecast("3h");
    const bundle = await buildForecastFactBundle(forecast, { localDate: "2026-08-02" });
    const readDb = withMaterializedRows(dbMock().db, [forecast], [bundle]);
    const agentEnv: Env = {
      ...env(readDb),
      FORECAST_BRIEF_ENABLED: "true",
      GEMINI_API_KEY: "test-key-never-sent",
      FORECAST_BRIEF_AGENT: poisonAgent
    };

    const briefResponse = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central/brief?date=2026-08-02") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      agentEnv,
      {} as ExecutionContext
    );
    const forecastResponse = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      agentEnv,
      {} as ExecutionContext
    );

    expect(briefResponse.status).toBe(200);
    ForecastBriefResponseSchema.parse(await briefResponse.json());
    expect(forecastResponse.status).toBe(200);
    ForecastResponseSchema.parse(await forecastResponse.json());
    expect(agentLookups).toBe(0);
  });

  it("returns a nontechnical typed brief when D1 reads fail", async () => {
    const failureLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failingDb = {
      prepare() {
        throw new Error("internal D1 failure details");
      }
    } as unknown as D1Database;
    const response = await worker.fetch(
      new Request("http://surf.test/api/forecast/obsf-central/brief") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      {
        ...env(failingDb),
        FORECAST_BRIEF_ENABLED: "true",
        GEMINI_API_KEY: "test-key-never-sent"
      },
      {} as ExecutionContext
    );
    const body = ForecastBriefResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "deterministic_fallback",
      fallbackReason: null,
      brief: { provider: "deterministic", spotId: "obsf-central" }
    });
    expect(JSON.stringify(body)).not.toContain("internal D1 failure details");
    expect(JSON.stringify(body)).not.toMatch(/database|storage|exception/i);
    expect(failureLog).toHaveBeenCalled();
    failureLog.mockRestore();
  });

  it("runs manual ingest and records source-run-like D1 rows", async () => {
    const now = new Date("2026-07-08T15:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { db, runs, sqls } = dbMock({ forecastAssemblyRows: true });
    const forecastUrl = "https://api.weather.gov/gridpoints/MTR/85,105/forecast/hourly";
    const observedAt = new Date(Date.now() - 30 * 60 * 1000);
    const ndbcTimestamp = [
      observedAt.getUTCFullYear(),
      observedAt.getUTCMonth() + 1,
      observedAt.getUTCDate(),
      observedAt.getUTCHours(),
      observedAt.getUTCMinutes()
    ]
      .map((value) => String(value).padStart(2, "0"))
      .join(" ");
    const firstCdipEpoch = Math.ceil(Date.now() / (3 * 60 * 60 * 1000)) * 3 * 60 * 60;
    const cdipTimes = [firstCdipEpoch, firstCdipEpoch + 3 * 60 * 60].join(", ");
    const cdipCycle = new Date((firstCdipEpoch - 3 * 60 * 60) * 1000)
      .toISOString()
      .slice(0, 16)
      .replace(/\D/g, "");
    const cdipAscii = `Dataset {
      Int32 waveTime[waveTime = 2];
      Float32 waveHs[waveTime = 2];
      Float32 waveTp[waveTime = 2];
      Float32 waveDp[waveTime = 2];
      Float32 waveDm[waveTime = 2];
    } cdip/model/MOP_alongshore/fixture_forecast.nc;
    ---------------------------------------------
    waveTime[2]
    ${cdipTimes}

    waveHs[2]
    1.2, 1.3

    waveTp[2]
    15, 14

    waveDp[2]
    290, 292

    waveDm[2]
    -999.99, -999.99
    `;
    const cdipDas = `Attributes {
      NC_GLOBAL {
        String history "Runtime arguments: /project/f90_bin/net_model_gf -s ${cdipCycle} -h 240 -g 3";
      }
    }`;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.tidesandcurrents.noaa.gov")) {
        if (url.includes("interval=hilo")) {
          return Response.json({
            predictions: [
              { t: "2026-07-08 18:00", v: "4.1", type: "H" },
              { t: "2026-07-09 00:00", v: "0.2", type: "L" }
            ]
          });
        }
        return Response.json({
          predictions: [
            { t: "2026-07-08 12:00", v: "1.2" },
            { t: "2026-07-08 13:00", v: "1.8" }
          ]
        });
      }
      if (url.includes("/points/")) {
        return Response.json({
          properties: {
            forecastHourly: forecastUrl,
            forecastZone: "https://api.weather.gov/zones/forecast/CAZ006",
            gridId: "MTR",
            gridX: 85,
            gridY: 105
          }
        });
      }
      if (url === forecastUrl) {
        return Response.json({
          properties: {
            updated: "2026-07-08T18:30:00Z",
            periods: [
              {
                startTime: "2026-07-08T12:00:00-07:00",
                endTime: "2026-07-08T13:00:00-07:00",
                windSpeed: "5 mph",
                windDirection: "N",
                shortForecast: "Clear"
              }
            ]
          }
        });
      }
      if (/api\.weather\.gov\/gridpoints\/MTR\/\d+,\d+$/.test(url)) {
        const validTime = "2026-07-08T12:00:00Z/P10D";
        const layer = (uom: string, value: number) => ({ uom, values: [{ validTime, value }] });
        return Response.json({
          properties: {
            updateTime: "2026-07-08T12:00:00Z",
            validTimes: validTime,
            waveHeight: layer("wmoUnit:m", 1.2),
            wavePeriod: layer("nwsUnit:s", 9),
            wavePeriod2: layer("nwsUnit:s", 15),
            primarySwellHeight: layer("wmoUnit:m", 1.1),
            primarySwellDirection: layer("wmoUnit:degree_(angle)", 290),
            secondarySwellHeight: layer("wmoUnit:m", 0.3),
            secondarySwellDirection: layer("wmoUnit:degree_(angle)", 210),
            windWaveHeight: layer("wmoUnit:m", 0.2)
          }
        });
      }
      if (url.includes("thredds.cdip.ucsd.edu/thredds/fileServer/cdip/model/MOP_alongshore/")) {
        expect(init?.method).toBe("HEAD");
        return new Response(null, {
          headers: { "Last-Modified": new Date(Date.now() - 60 * 60 * 1000).toUTCString() }
        });
      }
      if (url.endsWith("_forecast.nc.das")) {
        return new Response(cdipDas, { headers: { "Content-Type": "text/plain" } });
      }
      if (url.includes("thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore/")) {
        return new Response(cdipAscii, { headers: { "Content-Type": "text/plain" } });
      }
      if (url.includes("www.ndbc.noaa.gov/data/realtime2/")) {
        return new Response(
          `#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE\n` +
            `#yr mo dy hr mn degT m/s m/s m sec sec degT hPa degC degC degC nmi hPa ft\n` +
            `${ndbcTimestamp} MM MM MM 1.7 15 7.5 239 MM 13.2 14.3 MM MM MM MM`
        );
      }
      if (url.includes("/alerts/active")) {
        return Response.json({ features: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const request = new Request("http://127.0.0.1/api/ingest/once", { method: "POST" }) as unknown as Parameters<
      typeof worker.fetch
    >[0];
    const response = await worker.fetch(request, env(db), {} as ExecutionContext);
    const body = (await response.json()) as {
      status: string;
      counts: {
        tidePredictionRows: number;
        nwsWindForecastRows: number;
        nwsWaveForecastRows: number;
        cdipMopWaveForecastRows: number;
        ndbcObservationRows: number;
        forecastSnapshotRows: number;
        forecastReadModelRows: number;
        forecastFactBundleRows: number;
      };
      sourceRuns: Array<{ recorded: boolean; sourceId: string }>;
      errors: string[];
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("success");
    expect(body.counts.tidePredictionRows).toBe(12);
    expect(body.counts.nwsWindForecastRows).toBe(6);
    expect(body.counts.nwsWaveForecastRows).toBe(246);
    expect(body.counts.cdipMopWaveForecastRows).toBe(10);
    expect(body.counts.ndbcObservationRows).toBe(4);
    expect(body.counts.forecastReadModelRows).toBe(NORCAL_SPOTS.length * 2);
    expect(body.counts.forecastFactBundleRows).toBeGreaterThanOrEqual(NORCAL_SPOTS.length * 5);
    const expectedSnapshotRows = NORCAL_SPOTS.reduce(
      (total, spot) =>
        total +
        stableThreeHourForecastTimes(now, 120, spot.timezone).filter((forecastAt) => {
          const hour = Number(
            new Intl.DateTimeFormat("en-US", {
              hour: "2-digit",
              hourCycle: "h23",
              timeZone: spot.timezone
            })
              .formatToParts(new Date(forecastAt))
              .find((part) => part.type === "hour")?.value
          );
          return hour >= 6 && hour < 18;
        }).length,
      0
    );
    expect(body.counts.forecastSnapshotRows).toBe(expectedSnapshotRows);
    expect(body.sourceRuns.map((run) => run.sourceId)).toEqual([
      "coops:tide-predictions",
      "nws:point-forecast-alerts",
      "nws:mtr-grid-wave",
      "cdip:mop-forecast",
      "ndbc:realtime2-standard-meteorological"
    ]);
    expect(body.sourceRuns.every((run) => run.recorded)).toBe(true);
    expect(body.errors).toEqual([]);
    expect(runs.length).toBeGreaterThan(286);
    expect(runs[0]).toHaveLength(14);
    expect(runs.some((values) => values[1] === "nws:mtr-grid-wave")).toBe(true);
    expect(runs.some((values) => values.some((value) => typeof value === "string" && value.startsWith("raw/")))).toBe(true);
    expect(sqls.filter((sql) => sql.includes("insert into wind_forecast_issues"))).toHaveLength(6);
    expect(sqls.filter((sql) => sql.includes("insert into forecast_configs"))).toHaveLength(6);
    expect(sqls.filter((sql) => sql.includes("insert into forecast_issues"))).toHaveLength(6);
    expect(sqls.filter((sql) => sql.includes("insert into forecast_snapshots"))).toHaveLength(
      expectedSnapshotRows
    );
    expect(sqls.filter((sql) => sql.includes("insert into forecast_read_models"))).toHaveLength(
      body.counts.forecastReadModelRows
    );
    expect(sqls.filter((sql) => sql.includes("insert into forecast_fact_bundles"))).toHaveLength(
      body.counts.forecastFactBundleRows
    );
    expect(sqls.filter((sql) => sql.includes("delete from forecast_snapshots"))).toHaveLength(1);
    expect(sqls.filter((sql) => sql.includes("delete from wave_forecasts"))).toHaveLength(1);
    const bolinasWindWrite = runs.find(
      (values, index) =>
        sqls[index]?.includes("insert into wind_forecasts") &&
        values[0] === "bolinas" &&
        values[1] === "nws:point-forecast-alerts"
    );
    expect(bolinasWindWrite).toMatchObject({
      3: "2026-07-08T18:30:00.000Z",
      5: 1
    });
    const bolinasWaveWrite = runs.find(
      (values) => values[0] === "bolinas" && values[1] === "nws:mtr-grid-wave" && values.length === 20
    );
    expect(bolinasWaveWrite).toMatchObject({
      3: "2026-07-08T12:00:00.000Z",
      7: 0.78,
      8: 1.2,
      9: 9,
      11: 290
    });

    const failedPersistence = dbMock({
      forecastAssemblyRows: true,
      failRunSqlIncludes: "insert into tide_forecasts"
    });
    const failedSummary = await runNorcalIngest(env(failedPersistence.db), {
      kind: "manual-ingest",
      requestedAt: now.toISOString(),
      now,
      ingestId: "failed-persistence-ingest",
      idSuffix: "failed-persistence-ingest",
      deferForecastMaterialization: true
    });
    expect(failedSummary.publication.sourcePersistenceReady).toBe(false);
    expect(failedSummary.publication.sourcePersistenceErrors).toEqual(
      expect.arrayContaining([expect.stringContaining("simulated D1 failure")])
    );
    expect(failedSummary.counts.forecastReadModelRows).toBe(0);
  });

  it("protects manual ingest in production", async () => {
    const productionEnv = {
      ...env(),
      ENVIRONMENT: "production",
      INGEST_TOKEN: "ingest-test-token"
    };
    const request = new Request("http://surf.test/api/ingest/once", {
      method: "POST"
    }) as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, productionEnv, {} as ExecutionContext);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("queues authenticated production ingest without running it on the HTTP request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T01:02:03.456Z"));
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.stubGlobal("crypto", {
      randomUUID: () => "ingest-test-id",
      subtle: {
        digest,
        timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer) {
          const leftBytes = new Uint8Array(left);
          const rightBytes = new Uint8Array(right);
          if (leftBytes.length !== rightBytes.length) return false;
          return leftBytes.every((byte, index) => byte === rightBytes[index]);
        }
      }
    });
    const messages: unknown[] = [];
    const productionEnv = {
      ...env(),
      ENVIRONMENT: "production",
      INGEST_TOKEN: "ingest-test-token",
      CF_VERSION_METADATA: {
        id: "11111111-2222-4333-8444-555555555555",
        tag: "",
        timestamp: "2026-08-03T01:00:00.000Z"
      },
      INGEST_QUEUE: {
        send: async (message: unknown) => {
          messages.push(message);
        }
      } as unknown as Queue
    };
    const response = await worker.fetch(
      new Request("https://surf.test/api/ingest/once", {
        method: "POST",
        headers: {
          Authorization: "Bearer ingest-test-token"
        }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      productionEnv,
      {} as ExecutionContext
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "accepted",
      ingestId: "ingest-test-id",
      requestedAt: "2026-08-03T01:02:03.456Z",
      forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
      region: "norcal"
    });
    expect(messages).toEqual([
      {
        job: "source-ingest",
        kind: "manual-ingest",
        ingestId: "ingest-test-id",
        requestedAt: "2026-08-03T01:02:03.456Z",
        forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
        region: "norcal"
      }
    ]);

    messages.length = 0;
    const deployResponse = await worker.fetch(
      new Request("https://surf.test/api/ingest/once", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ingest-test-token",
          "X-Surf-Expected-Worker-Version": "11111111-2222-4333-8444-555555555555"
        }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      productionEnv,
      {} as ExecutionContext
    );
    expect(deployResponse.status).toBe(202);
    expect(await deployResponse.json()).toEqual({
      status: "accepted",
      ingestId: "11111111-2222-4333-8444-555555555555",
      requestedAt: "2026-08-03T01:02:03.456Z",
      forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
      region: "norcal"
    });
    expect(messages).toEqual([
      {
        job: "source-ingest",
        kind: "manual-ingest",
        ingestId: "11111111-2222-4333-8444-555555555555",
        requestedAt: "2026-08-03T01:02:03.456Z",
        forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
        region: "norcal"
      }
    ]);

    vi.setSystemTime(new Date("2026-08-03T01:02:04.456Z"));
    const replayResponse = await worker.fetch(
      new Request("https://surf.test/api/ingest/once", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ingest-test-token",
          "X-Surf-Expected-Worker-Version": "11111111-2222-4333-8444-555555555555"
        }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      productionEnv,
      {} as ExecutionContext
    );
    expect(replayResponse.status).toBe(202);
    expect(await replayResponse.json()).toMatchObject({
      ingestId: "11111111-2222-4333-8444-555555555555",
      requestedAt: "2026-08-03T01:02:04.456Z"
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      ingestId: "11111111-2222-4333-8444-555555555555",
      requestedAt: "2026-08-03T01:02:04.456Z"
    });
  });

  it("rejects a remote ingest version precondition before Queue.send", async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.stubGlobal("crypto", {
      subtle: {
        digest,
        timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer) {
          const leftBytes = new Uint8Array(left);
          const rightBytes = new Uint8Array(right);
          if (leftBytes.length !== rightBytes.length) return false;
          return leftBytes.every((byte, index) => byte === rightBytes[index]);
        }
      }
    });
    const messages: unknown[] = [];
    const productionEnv = {
      ...env(),
      ENVIRONMENT: "production",
      INGEST_TOKEN: "ingest-test-token",
      CF_VERSION_METADATA: {
        id: "11111111-2222-4333-8444-555555555555",
        tag: "",
        timestamp: "2026-08-03T01:00:00.000Z"
      },
      INGEST_QUEUE: {
        send: async (message: unknown) => {
          messages.push(message);
        }
      } as unknown as Queue
    };

    const unauthorized = await worker.fetch(
      new Request("https://surf.test/api/ingest/once", {
        method: "PATCH",
        headers: {
          "X-Surf-Expected-Worker-Version": "11111111-2222-4333-8444-555555555555"
        }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      productionEnv,
      {} as ExecutionContext
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(messages).toEqual([]);

    const missing = await worker.fetch(
      new Request("https://surf.test/api/ingest/once", {
        method: "PATCH",
        headers: { Authorization: "Bearer ingest-test-token" }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      productionEnv,
      {} as ExecutionContext
    );
    expect(missing.status).toBe(428);
    expect(await missing.json()).toEqual({
      error: "worker_version_precondition_required"
    });

    const malformed = await worker.fetch(
      new Request("https://surf.test/api/ingest/once", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ingest-test-token",
          "X-Surf-Expected-Worker-Version": "latest"
        }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      productionEnv,
      {} as ExecutionContext
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "worker_version_precondition_invalid"
    });
    expect(messages).toEqual([]);

    const mismatch = await worker.fetch(
      new Request("https://surf.test/api/ingest/once", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ingest-test-token",
          "X-Surf-Expected-Worker-Version": "66666666-7777-4888-8999-000000000000"
        }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      productionEnv,
      {} as ExecutionContext
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      error: "worker_version_mismatch",
      expectedWorkerVersion: "66666666-7777-4888-8999-000000000000",
      actualWorkerVersion: "11111111-2222-4333-8444-555555555555"
    });

    const unavailable = await worker.fetch(
      new Request("https://surf.test/api/ingest/once", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ingest-test-token",
          "X-Surf-Expected-Worker-Version": "66666666-7777-4888-8999-000000000000"
        }
      }) as unknown as Parameters<typeof worker.fetch>[0],
      { ...productionEnv, CF_VERSION_METADATA: undefined },
      {} as ExecutionContext
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: "worker_version_unavailable",
      expectedWorkerVersion: "66666666-7777-4888-8999-000000000000"
    });

    expect(messages).toEqual([]);
  });

  it("materializes exactly one spot from each forecast queue job", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db, runs, sqls } = dbMock({ forecastAssemblyRows: true });
    const ack = vi.fn();
    const retry = vi.fn();
    const invalidAck = vi.fn();
    const invalidRetry = vi.fn();

    await worker.queue(
      {
        queue: "surf-ingest",
        messages: [
          {
            id: "invalid-materialization",
            timestamp: new Date("2026-07-08T15:05:00.000Z"),
            attempts: 1,
            body: { job: "forecast-materialization", spotId: "obsf-north" },
            ack: invalidAck,
            retry: invalidRetry
          },
          {
            id: "materialize-obsf-north",
            timestamp: new Date("2026-07-08T15:05:00.000Z"),
            attempts: 1,
            body: {
              job: "forecast-materialization",
              ingestId: "ingest-test-id",
              spotId: "obsf-north",
              requestedAt: "2026-07-08T15:00:00.000Z",
              region: "norcal",
              generatedAt: "2026-07-08T15:00:00.000Z",
              sourceCompletedAt: "2026-07-08T15:05:00.000Z",
              captureHistory: false
            },
            ack,
            retry
          }
        ]
      } as unknown as MessageBatch,
      env(db)
    );

    expect(invalidRetry).toHaveBeenCalledOnce();
    expect(invalidRetry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(invalidAck).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const forecastWrites = runs.filter((_values, index) =>
      sqls[index]?.includes("insert into forecast_read_models")
    );
    expect(forecastWrites).toHaveLength(2);
    expect(new Set(forecastWrites.map((values) => values[0]))).toEqual(
      new Set(["obsf-north"])
    );
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("ingest queue message failed"));
    errorLog.mockRestore();
  });
});
