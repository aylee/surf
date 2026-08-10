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
  getActiveMaterializedForecastFactBundle,
  getMaterializedForecastFactBundle,
  getMaterializedForecastJson,
  MAX_FORECAST_FACT_BUNDLE_BYTES,
  MAX_FORECAST_READ_MODEL_BYTES,
  materializeForecastReadModelForSpot,
  materializeForecastReadModels,
  persistForecastMaterialization
} from "./forecast-read-model";
import { buildSynchronizedForecastResponses } from "./forecast";
import { forecastSourceIssueFingerprint, stableJson } from "./forecast-history";
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

function writeDb(
  changesByWrite: number[] = [],
  activeForecastRows: Array<{
    interval: "1h" | "3h";
    generation_id: string;
    generated_at: string;
  }> = []
) {
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
              return {
                success: true,
                meta: { changes: changesByWrite[writes.length - 1] ?? 1 }
              };
            },
            async all() {
              return { success: true, meta: {}, results: activeForecastRows };
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

    expect(result).toMatchObject({
      rowsWritten: 2 + localDates.length,
      forecastRowsWritten: 2,
      factBundleRowsWritten: localDates.length,
      errors: []
    });
    expect(result.forecastOutcomes).toEqual([
      expect.objectContaining({
        ingestId: null,
        spotId: "obsf-north",
        interval: "3h",
        generationId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        outcome: "publish",
        reasonCode: "forecast_generation_published",
        retryable: false
      }),
      expect.objectContaining({
        ingestId: null,
        spotId: "obsf-north",
        interval: "1h",
        generationId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        outcome: "publish",
        reasonCode: "forecast_generation_published",
        retryable: false
      })
    ]);
    expect(new Set(result.forecastOutcomes.map(({ generationId }) => generationId)).size).toBe(1);
    expect(writes.filter((write) => /insert into forecast_read_models/i.test(write.sql))).toHaveLength(2);
    expect(writes.find((write) => /insert into forecast_read_models/i.test(write.sql))?.sql).toContain(
      "excluded.generated_at > forecast_read_models.generated_at"
    );
    expect(writes.filter((write) => /insert into forecast_fact_bundles/i.test(write.sql))).toHaveLength(
      localDates.length
    );
    expect(writes.find((write) => /insert into forecast_fact_bundles/i.test(write.sql))?.sql).toContain(
      "excluded.generated_at > forecast_fact_bundles.generated_at"
    );
    const forecastIntervals = writes
      .filter((write) => /insert into forecast_read_models/i.test(write.sql))
      .map((write) => write.values[1]);
    expect(forecastIntervals).toEqual(["3h", "1h"]);
    const generationIds = writes
      .filter((write) => /insert into forecast_read_models/i.test(write.sql))
      .map((write) => write.values[2]);
    expect(generationIds).toHaveLength(2);
    expect(new Set(generationIds).size).toBe(1);
    expect(generationIds[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    const persistedDates = writes
      .filter((write) => /insert into forecast_fact_bundles/i.test(write.sql))
      .map((write) => write.values[1]);
    expect(persistedDates).toEqual(localDates);
  });

  it("keeps production-shaped five-day forecast rows inside the conservative byte budgets", async () => {
    const fixture = fixtureResponses();
    // Production windows each carry four cadence-bearing source entries; the
    // budget guard must exercise that shape, not slimmer fixture rows.
    const withCadenceEntries = <T extends { windows: object[] }>(forecast: T): T => ({
      ...forecast,
      windows: forecast.windows.map((window) => ({
        ...window,
        sourceFreshness: [
          { capability: "forecast_wave_nearshore", sourceId: "cdip:mop-forecast", sourceRunId: "run-wave", updatedAt: "2026-08-02T12:00:00.000Z", freshnessMinutes: 53, status: "fresh", expectedCadenceMinutes: 360, graceMinutes: 180 },
          { capability: "wind", sourceId: "nws:point-forecast-alerts", sourceRunId: "run-wind", updatedAt: "2026-08-02T12:00:00.000Z", freshnessMinutes: 8, status: "fresh", expectedCadenceMinutes: 360, graceMinutes: 180 },
          { capability: "tide", sourceId: "coops:tide-predictions", sourceRunId: "run-tide", updatedAt: "2026-08-02T12:00:00.000Z", freshnessMinutes: 0, status: "fresh", expectedCadenceMinutes: 1440, graceMinutes: 360 },
          { capability: "observed_wave", sourceId: "ndbc-46026", sourceRunId: "run-obs", updatedAt: "2026-08-02T12:00:00.000Z", freshnessMinutes: 29, status: "fresh", expectedCadenceMinutes: 60, graceMinutes: 60 }
        ]
      }))
    });
    const threeHour = withCadenceEntries(expandForecast(fixture.threeHour, "3h", 41));
    const hourly = withCadenceEntries(expandForecast(fixture.threeHour, "1h", 121));
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
    expect(result.forecastOutcomes).toEqual([
      expect.objectContaining({
        interval: "3h",
        outcome: "skip",
        reasonCode: "synchronized_generation_rejected",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        outcome: "skip",
        reasonCode: "forecast_payload_too_large",
        retryable: false
      })
    ]);
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
    expect(result.forecastOutcomes).toEqual(
      ["3h", "1h"].map((interval) =>
        expect.objectContaining({
          interval,
          outcome: "skip",
          reasonCode: "fact_bundle_payload_too_large",
          retryable: false
        })
      )
    );
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
      ingestId: null,
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
    expect(result.forecastOutcomes).toEqual([
      expect.objectContaining({
        interval: "3h",
        generationId: null,
        outcome: "skip",
        reasonCode: "synchronized_generation_rejected",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        generationId: null,
        outcome: "skip",
        reasonCode: "no_scored_windows",
        retryable: false
      })
    ]);
    expect(writes).toEqual([]);
  });

  it("reports conditional D1 no-ops as interval supersessions instead of publishes", async () => {
    const { threeHour, hourly } = fixtureResponses();
    const localDate = localDateForTime(
      threeHour.windows[0]!.forecastAt,
      threeHour.spot.timezone
    );
    const factBundles = [await buildForecastFactBundle(threeHour, { localDate })];
    const { db } = writeDb(
      [0, 0, 0],
      (["3h", "1h"] as const).map((interval) => ({
        interval,
        generation_id: `active-newer-${interval}`,
        generated_at: "2026-08-02T14:00:00.000Z"
      }))
    );

    const result = await persistForecastMaterialization({
      db,
      threeHour,
      hourly,
      factBundles,
      sourceIssueFingerprint: "older-source-fingerprint",
      materializedAt: "2026-08-02T13:05:00.000Z",
      ingestId: "older-ingest"
    });

    expect(result.rowsWritten).toBe(0);
    expect(result.forecastRowsWritten).toBe(0);
    expect(result.forecastOutcomes).toEqual([
      expect.objectContaining({
        ingestId: "older-ingest",
        interval: "3h",
        generationId: expect.stringMatching(
          /^sha256:[a-f0-9]{64}:ingest:older-ingest$/
        ),
        outcome: "supersede",
        reasonCode: "newer_generation_active",
        retryable: false
      }),
      expect.objectContaining({
        ingestId: "older-ingest",
        interval: "1h",
        generationId: expect.stringMatching(
          /^sha256:[a-f0-9]{64}:ingest:older-ingest$/
        ),
        outcome: "supersede",
        reasonCode: "newer_generation_active",
        retryable: false
      })
    ]);
  });

  it("reports an equal generatedAt redelivery as an already-active no-op", async () => {
    const { threeHour, hourly } = fixtureResponses();
    const localDate = localDateForTime(
      threeHour.windows[0]!.forecastAt,
      threeHour.spot.timezone
    );
    const factBundles = [await buildForecastFactBundle(threeHour, { localDate })];
    const { db } = writeDb(
      [0, 0, 0],
      (["3h", "1h"] as const).map((interval) => ({
        interval,
        generation_id: "sha256:already-active:ingest:duplicate-ingest",
        generated_at: threeHour.generatedAt
      }))
    );

    const result = await persistForecastMaterialization({
      db,
      threeHour,
      hourly,
      factBundles,
      sourceIssueFingerprint: "duplicate-source-fingerprint",
      materializedAt: "2026-08-02T13:06:00.000Z",
      ingestId: "duplicate-ingest"
    });

    expect(result).toMatchObject({
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: []
    });
    expect(result.forecastOutcomes).toEqual([
      expect.objectContaining({
        interval: "3h",
        generationId: "sha256:already-active:ingest:duplicate-ingest",
        outcome: "skip",
        reasonCode: "forecast_generation_already_active",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        generationId: "sha256:already-active:ingest:duplicate-ingest",
        outcome: "skip",
        reasonCode: "forecast_generation_already_active",
        retryable: false
      })
    ]);
  });

  it("preserves mixed per-interval D1 publication truth for an already-mixed table", async () => {
    const { threeHour, hourly } = fixtureResponses();
    const localDate = localDateForTime(
      threeHour.windows[0]!.forecastAt,
      threeHour.spot.timezone
    );
    const factBundles = [await buildForecastFactBundle(threeHour, { localDate })];
    const { db } = writeDb([1, 0, 0], [
      {
        interval: "1h",
        generation_id: "active-newer-1h",
        generated_at: "2026-08-02T14:00:00.000Z"
      }
    ]);

    const result = await persistForecastMaterialization({
      db,
      threeHour,
      hourly,
      factBundles,
      sourceIssueFingerprint: "mixed-table-source-fingerprint",
      materializedAt: "2026-08-02T13:05:00.000Z",
      ingestId: "mixed-table-ingest"
    });

    expect(result).toMatchObject({
      rowsWritten: 1,
      forecastRowsWritten: 1,
      factBundleRowsWritten: 0,
      errors: []
    });
    expect(result.forecastOutcomes).toEqual([
      expect.objectContaining({
        interval: "3h",
        outcome: "publish",
        reasonCode: "forecast_generation_published",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        outcome: "supersede",
        reasonCode: "newer_generation_active",
        retryable: false
      })
    ]);
    expect(new Set(result.forecastOutcomes.map(({ generationId }) => generationId)).size).toBe(1);
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

  it("materializes one spot per queue-sized job", async () => {
    const generatedAt = new Date("2026-08-02T13:00:00.000Z");
    const spotId = "obsf-north";
    vi.mocked(buildSynchronizedForecastResponses).mockClear();
    vi.mocked(buildSynchronizedForecastResponses).mockImplementation(async (_env, requestedSpotId) => {
      const fixture = buildFixtureForecast(requestedSpotId, generatedAt);
      return {
        threeHour: { ...fixture, interval: "3h" },
        hourly: { ...fixture, interval: "1h" }
      };
    });
    const { db, writes } = writeDb();

    const result = await materializeForecastReadModelForSpot(
      { DB: db } as never,
      spotId,
      generatedAt,
      {
        materializedAt: "2026-08-02T13:05:00.000Z",
        ingestId: "ingest-test-id"
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.forecastRowsWritten).toBe(2);
    expect(result.factBundleRowsWritten).toBeGreaterThan(0);
    expect(buildSynchronizedForecastResponses).toHaveBeenCalledOnce();
    expect(buildSynchronizedForecastResponses).toHaveBeenCalledWith(
      expect.anything(),
      spotId,
      generatedAt,
      { failOnReadError: true }
    );
    expect(
      new Set(
        writes
          .filter((write) => /insert into forecast_read_models/i.test(write.sql))
          .map((write) => write.values[0])
      )
    ).toEqual(new Set([spotId]));
    const forecastWrites = writes.filter((write) =>
      /insert into forecast_read_models/i.test(write.sql)
    );
    expect(new Set(forecastWrites.map((write) => write.values[2])).size).toBe(1);
    expect(forecastWrites[0]!.values[2]).toMatch(
      /^sha256:[a-f0-9]{64}:ingest:ingest-test-id$/
    );
    const expectedThreeHour = {
      ...buildFixtureForecast(spotId, generatedAt),
      interval: "3h" as const
    };
    await expect(forecastSourceIssueFingerprint(expectedThreeHour)).resolves.toBe(
      forecastWrites[0]!.values[4]
    );
  });

  it("persists complete hourly facts when the hourly and three-hour leaders differ", async () => {
    const generatedAt = new Date("2026-08-02T13:00:00.000Z");
    const spotId = "obsf-north";
    const fixture = buildFixtureForecast(spotId, generatedAt);
    const dayStartMs = Date.parse("2026-08-02T07:00:00.000Z");
    const makeWindows = (count: number, stepHours: number) =>
      Array.from({ length: count }, (_, index) => {
        const forecastAt = new Date(dayStartMs + index * stepHours * 60 * 60 * 1000).toISOString();
        const isHourlyLeader = forecastAt === "2026-08-02T14:00:00.000Z";
        const isThreeHourLeader = forecastAt === "2026-08-02T16:00:00.000Z";
        return {
          ...fixture.windows[index % fixture.windows.length]!,
          forecastAt,
          surfaceCondition: "clean" as const,
          score: stepHours === 1
            ? isHourlyLeader ? 100 : 5
            : isThreeHourLeader ? 95 : 5,
          confidence: stepHours === 1 && isHourlyLeader ? 100 : 60
        };
      });
    const threeHour = {
      ...fixture,
      interval: "3h" as const,
      windows: makeWindows(40, 3)
    };
    const hourly = {
      ...fixture,
      interval: "1h" as const,
      windows: makeWindows(120, 1)
    };
    vi.mocked(buildSynchronizedForecastResponses).mockClear();
    vi.mocked(buildSynchronizedForecastResponses).mockResolvedValue({ threeHour, hourly });
    const { db, writes } = writeDb();

    const result = await materializeForecastReadModelForSpot(
      { DB: db } as never,
      spotId,
      generatedAt,
      { materializedAt: "2026-08-02T13:05:00.000Z" }
    );

    expect(result.errors).toEqual([]);
    const firstDateWrite = writes.find(
      (write) =>
        /insert into forecast_fact_bundles/i.test(write.sql) &&
        write.values[1] === "2026-08-02"
    );
    expect(firstDateWrite).toBeDefined();
    const bundle = ForecastFactBundleSchema.parse(JSON.parse(String(firstDateWrite!.values[7])));
    expect(bundle.input.windows).toHaveLength(24);
    expect(bundle.input.recommendationWindowIds[0]).toBe("2026-08-02T14:00:00.000Z");
    expect(bundle.input.recommendationWindowIds[0]).not.toBe("2026-08-02T16:00:00.000Z");
  });

  it("does not capture history for a mixed publish and supersession", async () => {
    const generatedAt = new Date("2026-08-02T13:00:00.000Z");
    const spotId = "obsf-north";
    vi.mocked(buildSynchronizedForecastResponses).mockClear();
    vi.mocked(buildSynchronizedForecastResponses).mockImplementation(async () => {
      const fixture = buildFixtureForecast(spotId, generatedAt);
      return {
        threeHour: { ...fixture, interval: "3h" },
        hourly: { ...fixture, interval: "1h" }
      };
    });
    const { db, preparedSql } = writeDb(
      [1, 0, ...Array<number>(20).fill(0)],
      [{
        interval: "1h",
        generation_id: "active-newer-1h",
        generated_at: "2026-08-02T14:00:00.000Z"
      }]
    );

    const result = await materializeForecastReadModelForSpot(
      { DB: db } as never,
      spotId,
      generatedAt,
      {
        materializedAt: "2026-08-02T13:05:00.000Z",
        ingestId: "mixed-table-ingest",
        captureHistory: true
      }
    );

    expect(result.forecastOutcomes.map(({ outcome }) => outcome)).toEqual([
      "publish",
      "supersede"
    ]);
    expect(result.snapshotRowsWritten).toBeUndefined();
    expect(result.historyErrors).toBeUndefined();
    expect(preparedSql.some((sql) => /forecast_(configs|issues|snapshots)/i.test(sql))).toBe(false);
  });

  it("reads a future local-date brief bundle and its active 3h generation", async () => {
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

    const active = await getActiveMaterializedForecastFactBundle(
      db,
      "obsf-north",
      futureDate
    );
    const stored = await getMaterializedForecastFactBundle(db, "obsf-north", futureDate);

    expect(active?.generationId).toBe("sha256:generation");
    expect(active?.bundle.inputFingerprint).toBe(bundle.inputFingerprint);
    expect(stored?.input.localDate).toBe(futureDate);
    expect(stored?.input.spotId).toBe("obsf-north");
    expect(stored?.inputFingerprint).toBe(bundle.inputFingerprint);
  });
});
