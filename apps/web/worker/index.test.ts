import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./index";
import worker from "./index";
import {
  FORECAST_HISTORY_RETENTION_DAYS,
  OPERATIONAL_FORECAST_RETENTION_DAYS,
  pruneRetainedData,
  shouldCaptureForecastHistory
} from "./ingest";

function dbMock() {
  const runs: unknown[][] = [];
  const sqls: string[] = [];
  const db = {
    prepare: (sql: string) => {
      const all = async () => ({ results: [], success: true, meta: {} });
      return {
        bind: (...values: unknown[]) => ({
          all,
          run: async () => {
            runs.push(values);
            sqls.push(sql);
            return { success: true, results: [], meta: { changes: 1 } };
          }
        }),
        all
      };
    }
  } as unknown as D1Database;

  return { db, runs, sqls };
}

function env(db: D1Database = dbMock().db): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    REPORT_AGENT_ENABLED: "false",
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    DB: db,
    RAW_ARTIFACTS: { put: async () => ({}) } as unknown as R2Bucket,
    CACHE: {} as KVNamespace,
    INGEST_QUEUE: { send: async () => undefined } as unknown as Queue
  };
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
    expect(sqls).toHaveLength(14);
    for (const table of ["wave_forecasts", "tide_forecasts", "wind_forecasts"]) {
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
      "tide_observations",
      "wind_observations",
      "hazard_events",
      "spot_scores",
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns health", async () => {
    const request = new Request("http://surf.test/api/health") as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "surf" });
  });

  it("returns v1 spots", async () => {
    const request = new Request("http://surf.test/api/spots") as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    const body = (await response.json()) as { spots: unknown[] };
    expect(body.spots).toHaveLength(6);
  });

  it("fails closed with unknown windows when normalized forecast rows cannot be read", async () => {
    const request = new Request("http://surf.test/api/forecast/obsf-central") as unknown as Parameters<
      typeof worker.fetch
    >[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    const body = (await response.json()) as {
      windows: Array<{ ratingStatus: string; waveHeightFt: number | null; sourceRunIds: string[] }>;
      spot: { id: string };
    };
    expect(response.status).toBe(200);
    expect(body.spot.id).toBe("obsf-central");
    expect(body.windows.length).toBeGreaterThan(0);
    expect(body.windows[0]).toMatchObject({ ratingStatus: "unknown", waveHeightFt: null, sourceRunIds: [] });
  });

  it("keeps reports disabled without an explicit provider secret", async () => {
    const request = new Request("http://surf.test/api/reports/today") as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    const body = (await response.json()) as { enabled: boolean; reason: string };
    expect(response.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.reason).toContain("REPORT_AGENT_ENABLED");
  });

  it("runs manual ingest and records source-run-like D1 rows", async () => {
    const { db, runs, sqls } = dbMock();
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

    const request = new Request("http://surf.test/api/ingest/once", { method: "POST" }) as unknown as Parameters<
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
    expect(body.counts.forecastSnapshotRows).toBe(120);
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
    expect(sqls.filter((sql) => sql.includes("insert into forecast_snapshots"))).toHaveLength(120);
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
});
