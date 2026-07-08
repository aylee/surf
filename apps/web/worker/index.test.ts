import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./index";
import worker from "./index";

function dbMock() {
  const runs: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          runs.push(values);
          return { success: true };
        }
      })
    })
  } as unknown as D1Database;

  return { db, runs };
}

function env(db: D1Database = dbMock().db): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    REPORT_AGENT_ENABLED: "false",
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    DB: db,
    RAW_ARTIFACTS: {} as R2Bucket,
    CACHE: {} as KVNamespace,
    INGEST_QUEUE: { send: async () => undefined } as unknown as Queue
  };
}

describe("worker api", () => {
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

  it("returns fixture forecasts without regressing the forecast path", async () => {
    const request = new Request("http://surf.test/api/forecast/obsf-central") as unknown as Parameters<
      typeof worker.fetch
    >[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    const body = (await response.json()) as { windows: unknown[]; spot: { id: string } };
    expect(response.status).toBe(200);
    expect(body.spot.id).toBe("obsf-central");
    expect(body.windows.length).toBeGreaterThan(0);
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
    const { db, runs } = dbMock();
    const forecastUrl = "https://api.weather.gov/gridpoints/MTR/85,105/forecast/hourly";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
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
      counts: { tidePredictionRows: number; nwsWindForecastRows: number };
      sourceRuns: Array<{ recorded: boolean; sourceId: string }>;
      errors: string[];
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("success");
    expect(body.counts.tidePredictionRows).toBe(12);
    expect(body.counts.nwsWindForecastRows).toBe(6);
    expect(body.sourceRuns.map((run) => run.sourceId)).toEqual([
      "coops:tide-predictions",
      "nws:point-forecast-alerts"
    ]);
    expect(body.sourceRuns.every((run) => run.recorded)).toBe(true);
    expect(body.errors).toEqual([]);
    expect(runs).toHaveLength(20);
    expect(runs[0]).toHaveLength(14);
  });
});
