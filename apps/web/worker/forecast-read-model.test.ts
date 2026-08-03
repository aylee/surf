import { describe, expect, it, vi } from "vitest";
import { NORCAL_SPOTS } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import {
  buildForecastFactBundle,
  ForecastFactBundleSchema,
  type ForecastFactBundle
} from "./brief";
import {
  FORECAST_READ_MODEL_SCHEMA_VERSION,
  getMaterializedForecastFactBundle,
  getMaterializedForecastJson,
  MAX_FORECAST_FACT_BUNDLE_BYTES,
  MAX_FORECAST_READ_MODEL_BYTES,
  materializeForecastReadModels,
  persistForecastMaterialization
} from "./forecast-read-model";
import { buildSynchronizedForecastResponses } from "./forecast";
import { stableJson } from "./forecast-history";
import { localDateForTime } from "./time";

vi.mock("./forecast", () => ({
  buildSynchronizedForecastResponses: vi.fn()
}));

function fixtureResponses() {
  const fixture = buildFixtureForecast("obsf-north", new Date("2026-08-02T13:00:00.000Z"));
  return {
    threeHour: { ...fixture, interval: "3h" as const },
    hourly: { ...fixture, interval: "1h" as const }
  };
}

function writeDb() {
  const preparedSql: string[] = [];
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      preparedSql.push(sql);
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              writes.push({ sql, values });
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
  return { db, preparedSql, writes };
}

function expandForecast(
  forecast: ReturnType<typeof fixtureResponses>["threeHour"],
  interval: "1h" | "3h",
  count: number
) {
  const intervalHours = interval === "1h" ? 1 : 3;
  return {
    ...forecast,
    interval,
    windows: Array.from({ length: count }, (_, index) => {
      const seed = forecast.windows[index % forecast.windows.length]!;
      const forecastAt = new Date(
        new Date(forecast.generatedAt).getTime() + index * intervalHours * 60 * 60 * 1000
      ).toISOString();
      return {
        ...seed,
        forecastAt,
        caveats: [
          "Modeled nearshore wave height is not a breaking wave-face estimate.",
          "Source freshness and confidence are tracked independently for this window.",
          "Local bathymetry may change how the modeled wave state reaches the beach."
        ]
      };
    })
  };
}

function contractMaximumFactBundle(bundle: ForecastFactBundle): ForecastFactBundle {
  const seedWindow = bundle.input.windows[0]!;
  const caveats = Array.from({ length: 16 }, (_, index) =>
    `caveat-${index}:`.padEnd(500, "x")
  );
  const windows = Array.from({ length: 48 }, (_, index) => ({
    ...seedWindow,
    windowId: `window-${index}`,
    caveats
  }));
  return ForecastFactBundleSchema.parse({
    ...bundle,
    input: {
      ...bundle.input,
      windows,
      recommendationWindowIds: [windows[0]!.windowId]
    },
    facts: Array.from({ length: 320 }, (_, index) => ({
      id: `fact:${index}`,
      kind: "caveat",
      role: "tradeoff",
      statement: `fact-${index}:`.padEnd(600, "x"),
      windowId: null,
      material: true
    }))
  });
}

describe("forecast read model repository", () => {
  it("persists synchronized 1h/3h JSON and a fact bundle for every forecast date", async () => {
    const { threeHour, hourly } = fixtureResponses();
    const localDates = [
      ...new Set(
        threeHour.windows.map((window) =>
          localDateForTime(window.forecastAt, threeHour.spot.timezone)
        )
      )
    ];
    const factBundles = await Promise.all(
      localDates.map((localDate) => buildForecastFactBundle(threeHour, { localDate }))
    );
    const { db, writes } = writeDb();

    const result = await persistForecastMaterialization({
      db,
      threeHour,
      hourly,
      factBundles,
      sourceIssueFingerprint: "source-fingerprint",
      materializedAt: "2026-08-02T13:05:00.000Z"
    });

    expect(result).toEqual({
      rowsWritten: 2 + localDates.length,
      forecastRowsWritten: 2,
      factBundleRowsWritten: localDates.length,
      errors: []
    });
    expect(writes.filter((write) => /insert into forecast_read_models/i.test(write.sql))).toHaveLength(2);
    expect(writes.find((write) => /insert into forecast_read_models/i.test(write.sql))?.sql).toContain(
      "excluded.generated_at >= forecast_read_models.generated_at"
    );
    expect(writes.filter((write) => /insert into forecast_fact_bundles/i.test(write.sql))).toHaveLength(
      localDates.length
    );
    expect(writes.find((write) => /insert into forecast_fact_bundles/i.test(write.sql))?.sql).toContain(
      "excluded.generated_at >= forecast_fact_bundles.generated_at"
    );
    const forecastIntervals = writes
      .filter((write) => /insert into forecast_read_models/i.test(write.sql))
      .map((write) => write.values[1]);
    expect(forecastIntervals).toEqual(["3h", "1h"]);
    const persistedDates = writes
      .filter((write) => /insert into forecast_fact_bundles/i.test(write.sql))
      .map((write) => write.values[1]);
    expect(persistedDates).toEqual(localDates);
  });

  it("keeps production-shaped five-day forecast rows inside the conservative byte budgets", async () => {
    const fixture = fixtureResponses();
    const threeHour = expandForecast(fixture.threeHour, "3h", 41);
    const hourly = expandForecast(fixture.threeHour, "1h", 121);
    const localDates = [
      ...new Set(
        threeHour.windows.map((window) =>
          localDateForTime(window.forecastAt, threeHour.spot.timezone)
        )
      )
    ];
    const factBundles = await Promise.all(
      localDates.map((localDate) => buildForecastFactBundle(threeHour, { localDate }))
    );
    const forecastBytes = [threeHour, hourly].map(
      (forecast) => new TextEncoder().encode(stableJson(forecast)).byteLength
    );
    const factBundleBytes = factBundles.map(
      (bundle) => new TextEncoder().encode(stableJson(bundle)).byteLength
    );
    const { db, writes } = writeDb();

    const result = await persistForecastMaterialization({
      db,
      threeHour,
      hourly,
      factBundles,
      sourceIssueFingerprint: "production-shaped-source-fingerprint",
      materializedAt: "2026-08-02T13:05:00.000Z"
    });

    expect(Math.max(...forecastBytes)).toBeLessThan(MAX_FORECAST_READ_MODEL_BYTES);
    expect(Math.max(...factBundleBytes)).toBeLessThan(MAX_FORECAST_FACT_BUNDLE_BYTES);
    expect(result.errors).toEqual([]);
    expect(writes).toHaveLength(2 + factBundles.length);
  });

  it("rejects an oversized forecast row before preparing any D1 write", async () => {
    const { threeHour, hourly } = fixtureResponses();
    const oversizedHourly = {
      ...hourly,
      windows: hourly.windows.map((window, index) =>
        index === 0
          ? { ...window, caveats: ["x".repeat(MAX_FORECAST_READ_MODEL_BYTES)] }
          : window
      )
    };
    const localDate = localDateForTime(
      threeHour.windows[0]!.forecastAt,
      threeHour.spot.timezone
    );
    const factBundles = [await buildForecastFactBundle(threeHour, { localDate })];
    const { db, preparedSql, writes } = writeDb();

    const result = await persistForecastMaterialization({
      db,
      threeHour,
      hourly: oversizedHourly,
      factBundles,
      sourceIssueFingerprint: "oversized-forecast-fingerprint",
      materializedAt: "2026-08-02T13:05:00.000Z"
    });

    expect(result.rowsWritten).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("serialized 1h forecast payload");
    expect(result.errors[0]).toContain(`limit ${MAX_FORECAST_READ_MODEL_BYTES}`);
    expect(result.errors[0]).toContain("previous materialization remains active");
    expect(preparedSql).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("rejects a contract-maximum fact bundle before preparing any D1 write", async () => {
    const { threeHour, hourly } = fixtureResponses();
    const localDate = localDateForTime(
      threeHour.windows[0]!.forecastAt,
      threeHour.spot.timezone
    );
    const baseBundle = await buildForecastFactBundle(threeHour, { localDate });
    const oversizedBundle = contractMaximumFactBundle(baseBundle);
    const oversizedBytes = new TextEncoder().encode(stableJson(oversizedBundle)).byteLength;
    const { db, preparedSql, writes } = writeDb();

    const result = await persistForecastMaterialization({
      db,
      threeHour,
      hourly,
      factBundles: [oversizedBundle],
      sourceIssueFingerprint: "oversized-fact-bundle-fingerprint",
      materializedAt: "2026-08-02T13:05:00.000Z"
    });

    expect(oversizedBytes).toBeGreaterThan(MAX_FORECAST_FACT_BUNDLE_BYTES);
    expect(result.rowsWritten).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`serialized ${localDate} fact bundle payload`);
    expect(result.errors[0]).toContain(`limit ${MAX_FORECAST_FACT_BUNDLE_BYTES}`);
    expect(result.errors[0]).toContain("previous materialization remains active");
    expect(preparedSql).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("returns pre-serialized forecast JSON without rebuilding or parsing it", async () => {
    const forecastJson = '{"spot":{"id":"obsf-north"},"opaqueFutureField":true}';
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  generation_id: "sha256:generation",
                  generated_at: "2026-08-02T13:00:00.000Z",
                  schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
                  forecast_json: forecastJson,
                  materialized_at: "2026-08-02T13:05:00.000Z"
                };
              }
            };
          }
        };
      }
    } as unknown as D1Database;

    await expect(getMaterializedForecastJson(db, "obsf-north", "3h")).resolves.toEqual({
      generationId: "sha256:generation",
      generatedAt: "2026-08-02T13:00:00.000Z",
      materializedAt: "2026-08-02T13:05:00.000Z",
      forecastJson
    });
  });

  it("keeps the prior generation active when either interval has no scored window", async () => {
    const { threeHour, hourly } = fixtureResponses();
    const unknownHourly = {
      ...hourly,
      windows: hourly.windows.map((window) => ({
        ...window,
        ratingStatus: "unknown" as const
      }))
    };
    const localDate = localDateForTime(
      threeHour.windows[0]!.forecastAt,
      threeHour.spot.timezone
    );
    const factBundles = [await buildForecastFactBundle(threeHour, { localDate })];
    const { db, writes } = writeDb();

    const result = await persistForecastMaterialization({
      db,
      threeHour,
      hourly: unknownHourly,
      factBundles,
      sourceIssueFingerprint: "source-fingerprint",
      materializedAt: "2026-08-02T13:05:00.000Z"
    });

    expect(result.rowsWritten).toBe(0);
    expect(result.errors).toEqual([
      "Forecast read model publication rejected because 1h contained no scored windows; the previous materialization remains active."
    ]);
    expect(writes).toEqual([]);
  });

  it("publishes healthy spots when another spot cannot produce a scored generation", async () => {
    const generatedAt = new Date("2026-08-02T13:00:00.000Z");
    const rejectedSpotId = NORCAL_SPOTS[0]!.id;
    vi.mocked(buildSynchronizedForecastResponses).mockClear();
    vi.mocked(buildSynchronizedForecastResponses).mockImplementation(
      async (_env, spotId) => {
        const fixture = buildFixtureForecast(spotId, generatedAt);
        return {
          threeHour: {
            ...fixture,
            interval: "3h"
          },
          hourly: {
            ...fixture,
            interval: "1h",
            windows:
              spotId === rejectedSpotId
                ? fixture.windows.map((window) => ({
                  ...window,
                  ratingStatus: "unknown" as const
                }))
                : fixture.windows
          }
        };
      }
    );
    const { db, writes } = writeDb();

    const result = await materializeForecastReadModels(
      { DB: db } as never,
      generatedAt,
      "partial-source-fingerprint",
      "2026-08-02T13:05:00.000Z"
    );

    expect(result.errors).toContain(
      "Forecast read model publication rejected because 1h contained no scored windows; the previous materialization remains active."
    );
    expect(buildSynchronizedForecastResponses).toHaveBeenCalledTimes(NORCAL_SPOTS.length);
    expect(result.forecastRowsWritten).toBe((NORCAL_SPOTS.length - 1) * 2);
    const publishedSpotIds = new Set(
      writes
        .filter((write) => /insert into forecast_read_models/i.test(write.sql))
        .map((write) => write.values[0])
    );
    expect(publishedSpotIds.has(rejectedSpotId)).toBe(false);
    expect(publishedSpotIds.size).toBe(NORCAL_SPOTS.length - 1);
  });

  it("reads a future local-date brief bundle tied to the active 3h generation", async () => {
    const { threeHour } = fixtureResponses();
    const futureDate = localDateForTime(threeHour.windows.at(-1)!.forecastAt, threeHour.spot.timezone);
    const bundle = await buildForecastFactBundle(threeHour, { localDate: futureDate });
    const db = {
      prepare(sql: string) {
        expect(sql).toContain("model.generation_id = bundle.generation_id");
        return {
          bind(spotId: string, localDate: string) {
            expect([spotId, localDate]).toEqual(["obsf-north", futureDate]);
            return {
              async first() {
                return {
                  generation_id: "sha256:generation",
                  schema_version: FORECAST_READ_MODEL_SCHEMA_VERSION,
                  fact_bundle_json: JSON.stringify(bundle)
                };
              }
            };
          }
        };
      }
    } as unknown as D1Database;

    const stored = await getMaterializedForecastFactBundle(db, "obsf-north", futureDate);

    expect(stored?.input.localDate).toBe(futureDate);
    expect(stored?.input.spotId).toBe("obsf-north");
    expect(stored?.inputFingerprint).toBe(bundle.inputFingerprint);
  });
});
