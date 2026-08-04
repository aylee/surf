import { afterEach, describe, expect, it, vi } from "vitest";
import { FORECAST_READ_MODEL_SCHEMA_VERSION } from "./forecast-read-model";
import { getForecastReadiness } from "./forecast-readiness";
import type { Env } from "./index";
import worker from "./index";

type DatabaseRow = {
  spot_id: unknown;
  interval: unknown;
  generation_id: unknown;
  schema_version: unknown;
  generated_at: unknown;
  materialized_at: unknown;
};

function readinessDatabase(rows: DatabaseRow[], failure?: Error) {
  const preparedSql: string[] = [];
  const boundValues: unknown[][] = [];
  let executions = 0;
  const db = {
    prepare(sql: string) {
      preparedSql.push(sql);
      return {
        bind(...values: unknown[]) {
          boundValues.push(values);
          return {
            async all() {
              executions += 1;
              if (failure) throw failure;
              return { success: true, results: rows, meta: {} };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
  return {
    db,
    preparedSql,
    boundValues,
    executionCount: () => executions
  };
}

async function expectReadinessUnavailable(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Surf-Worker-Version")).toBe(
    "11111111-2222-3333-4444-555555555555"
  );
  expect(response.headers.get("Retry-After")).toBe("5");
  expect(await response.json()).toEqual({
    error: "forecast_readiness_unavailable",
    message: "Forecast readiness is temporarily unavailable.",
    retryable: true
  });
}

function testEnv(db: D1Database): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    SURF_USER_AGENT: "surf-test/1.0 (+https://example.test/contact)",
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    DB: db,
    RAW_ARTIFACTS: { put: async () => ({}) } as unknown as R2Bucket,
    INGEST_QUEUE: { send: async () => undefined } as unknown as Queue,
    CF_VERSION_METADATA: {
      id: "11111111-2222-3333-4444-555555555555",
      tag: "",
      timestamp: "2026-08-04T00:00:00.000Z"
    }
  };
}

const generatedAt = "2026-08-04T06:13:19.808Z";
const materializedAt = "2026-08-04T06:13:48.853Z";
const generationId = `sha256:${"a".repeat(64)}:ingest:deploy-lineage`;

describe("forecast readiness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes one metadata-only SELECT and returns exact rows including missing read models", async () => {
    const database = readinessDatabase([
      {
        spot_id: "bolinas",
        interval: "3h",
        generation_id: generationId,
        schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
        generated_at: generatedAt,
        materialized_at: materializedAt
      },
      {
        spot_id: "bolinas",
        interval: "1h",
        generation_id: null,
        schema_version: null,
        generated_at: null,
        materialized_at: null
      }
    ]);

    const response = await getForecastReadiness(database.db, "norcal");

    expect(database.preparedSql).toHaveLength(1);
    expect(database.boundValues).toEqual([["norcal"]]);
    expect(database.executionCount()).toBe(1);
    expect(database.preparedSql[0]).toMatch(/^select\s/i);
    expect(database.preparedSql[0]).toContain("cross join");
    expect(database.preparedSql[0]).toContain("left join forecast_read_models");
    expect(database.preparedSql[0]).toContain("target_spot.active = 1");
    expect(database.preparedSql[0]).toContain("target_spot.region = ?");
    expect(database.preparedSql[0]).toContain("order by target_spot.id asc");
    expect(database.preparedSql[0]).not.toContain("forecast_json");
    expect(Object.keys(response)).toEqual(["forecastReadModels"]);
    expect(response).toEqual({
      forecastReadModels: [
        {
          spotId: "bolinas",
          interval: "3h",
          generationId,
          ingestId: "deploy-lineage",
          generatedAt,
          materializedAt
        },
        {
          spotId: "bolinas",
          interval: "1h",
          generationId: null,
          ingestId: null,
          generatedAt: null,
          materializedAt: null
        }
      ]
    });
    for (const row of response.forecastReadModels) {
      expect(Object.keys(row)).toEqual([
        "spotId",
        "interval",
        "generationId",
        "ingestId",
        "generatedAt",
        "materializedAt"
      ]);
    }
  });

  it.each([
    {
      name: "partially missing metadata",
      row: {
        generation_id: generationId,
        schema_version: null,
        generated_at: generatedAt,
        materialized_at: materializedAt
      }
    },
    {
      name: "an unsupported schema",
      row: {
        generation_id: generationId,
        schema_version: 999,
        generated_at: generatedAt,
        materialized_at: materializedAt
      }
    },
    {
      name: "an invalid generation timestamp",
      row: {
        generation_id: generationId,
        schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
        generated_at: "not-a-date",
        materialized_at: materializedAt
      }
    },
    {
      name: "a noncanonical generation timestamp",
      row: {
        generation_id: generationId,
        schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
        generated_at: "2026-08-04T06:13:19Z",
        materialized_at: materializedAt
      }
    },
    {
      name: "an invalid generation identity",
      row: {
        generation_id: "sha256:not-a-digest:ingest:deploy-lineage",
        schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
        generated_at: generatedAt,
        materialized_at: materializedAt
      }
    },
    {
      name: "materialization before generation",
      row: {
        generation_id: generationId,
        schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
        generated_at: materializedAt,
        materialized_at: generatedAt
      }
    }
  ])("fails closed for $name", async ({ row }) => {
    const database = readinessDatabase([
      {
        spot_id: "bolinas",
        interval: "3h",
        ...row
      }
    ]);

    await expect(getForecastReadiness(database.db, "norcal")).rejects.toThrow(
      "Stored forecast readiness metadata is invalid"
    );
  });

  it("serves public no-store metadata with Worker version lineage", async () => {
    const database = readinessDatabase([
      {
        spot_id: "bolinas",
        interval: "3h",
        generation_id: generationId,
        schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
        generated_at: generatedAt,
        materialized_at: materializedAt
      }
    ]);

    const response = await worker.fetch(
      new Request("https://surf.test/api/forecast-readiness") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      testEnv(database.db),
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Surf-Worker-Version")).toBe(
      "11111111-2222-3333-4444-555555555555"
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({
      forecastReadModels: [
        {
          spotId: "bolinas",
          interval: "3h",
          generationId,
          ingestId: "deploy-lineage",
          generatedAt,
          materializedAt
        }
      ]
    });
  });

  it("returns a no-store 503 without partial metadata when stored rows are malformed", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const database = readinessDatabase([
      {
        spot_id: "bolinas",
        interval: "3h",
        generation_id: generationId,
        schema_version: null,
        generated_at: generatedAt,
        materialized_at: materializedAt
      }
    ]);

    const response = await worker.fetch(
      new Request("https://surf.test/api/forecast-readiness") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      testEnv(database.db),
      {} as ExecutionContext
    );

    await expectReadinessUnavailable(response);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({
      event: "forecast_readiness_lookup_failed",
      message: "forecast readiness lookup failed",
      reasonCode: "readiness_lookup_failed",
      errorName: "Error"
    });
    expect(String(errorLog.mock.calls[0]![0])).not.toContain(
      "Stored forecast readiness metadata is invalid"
    );
    errorLog.mockRestore();
  });

  it("returns the same bounded-pending response when the D1 SELECT fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const database = readinessDatabase([], new Error("simulated D1 read failure secret"));

    const response = await worker.fetch(
      new Request("https://surf.test/api/forecast-readiness") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      testEnv(database.db),
      {} as ExecutionContext
    );

    await expectReadinessUnavailable(response);
    expect(database.executionCount()).toBe(1);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({
      event: "forecast_readiness_lookup_failed",
      message: "forecast readiness lookup failed",
      reasonCode: "readiness_lookup_failed",
      errorName: "Error"
    });
    expect(String(errorLog.mock.calls[0]![0])).not.toContain("simulated D1 read failure secret");
    errorLog.mockRestore();
  });
});
