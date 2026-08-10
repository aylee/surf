/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import type { ForecastResponse } from "@surf/contracts";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildForecastFactBundle } from "../brief";
import {
  getActiveMaterializedForecastFactBundlesForGeneration,
  persistForecastMaterialization
} from "../forecast-read-model";
import worker, { type Env } from "../index";
import {
  enqueueSurfAnalysis,
  selectSurfAnalysisBundlesForSignal,
  SURF_ANALYSIS_FUTURE_CADENCE_HOURS
} from "../narrative";
import { buildSurfAnalysisSnapshot, buildSurfNarrativeJob } from "../analysis";
import { localDateForTime, stableHourlyForecastTimes, stableThreeHourForecastTimes } from "../time";
import {
  processIngestQueueMessage,
  sourceGenerationIsCurrent,
  type IngestQueueDependencies
} from "./queue";
import type { ForecastMaterializationQueueMessage, SurfAnalysisSignalQueueMessage } from "./types";

function countedDatabase(database: D1Database): {
  db: D1Database;
  queryCount: () => number;
} {
  let queryCount = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (["all", "first", "raw", "run"].includes(String(property))) {
          return (...args: unknown[]) => {
            queryCount += 1;
            return Reflect.apply(value, target, args);
          };
        }
        return value.bind(target);
      }
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const db = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query));
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          queryCount += statements.length;
          return target.batch(
            statements.map((statement) => originals.get(statement as object) ?? statement)
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { db, queryCount: () => queryCount };
}

function expandedForecast(
  interval: "1h" | "3h",
  generatedAt = "2099-08-02T13:00:00.000Z"
): ForecastResponse {
  const fixture = buildFixtureForecast("linda-mar", new Date(generatedAt));
  const times = interval === "1h"
    ? stableHourlyForecastTimes(new Date(generatedAt), 120, fixture.spot.timezone)
    : stableThreeHourForecastTimes(new Date(generatedAt), 120, fixture.spot.timezone);
  return {
    ...fixture,
    interval,
    recommendations: undefined,
    windows: times.map((forecastAt, index) => {
      const seed = fixture.windows[index % fixture.windows.length]!;
      return {
        ...seed,
        forecastAt,
        waveState: seed.waveState
          ? {
              ...seed.waveState,
              validFrom: forecastAt,
              validTo: new Date(
                Date.parse(forecastAt) + (interval === "1h" ? 1 : 3) * 60 * 60_000
              ).toISOString()
            }
          : seed.waveState
      };
    })
  };
}

async function fixtureGeneration(generatedAt?: string) {
  const threeHour = expandedForecast("3h", generatedAt);
  const hourly = expandedForecast("1h", generatedAt);
  const localDates = [
    ...new Set(
      threeHour.windows.map((window) =>
        localDateForTime(window.forecastAt, threeHour.spot.timezone)
      )
    )
  ].slice(0, 5);
  expect(localDates).toHaveLength(5);
  const factBundles = await Promise.all(
    localDates.map((localDate) => buildForecastFactBundle(hourly, { localDate }))
  );
  return { threeHour, hourly, factBundles };
}

function baseEnv(db: D1Database, options: {
  ingestSend?: (body: unknown) => Promise<void>;
  narrativeSend?: (body: unknown) => Promise<void>;
} = {}): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    SURF_USER_AGENT: "surf-analysis-signal-test/1.0",
    DB: db,
    ASSETS: {} as Fetcher,
    RAW_ARTIFACTS: {} as R2Bucket,
    INGEST_QUEUE: {
      send: options.ingestSend ?? (async () => undefined)
    } as unknown as Queue,
    NARRATIVE_QUEUE: {
      send: options.narrativeSend ?? (async () => undefined)
    } as unknown as Queue,
    NARRATIVE_ENABLED: "true",
    NARRATIVE_RESULT_TOKEN: "test-result-token"
  };
}

beforeEach(async () => {
  await env.DB.prepare("delete from narrative_revisions").run();
  await env.DB.prepare("delete from narrative_jobs").run();
  await env.DB.prepare("delete from forecast_fact_bundles where spot_id = 'linda-mar'").run();
  await env.DB.prepare("delete from forecast_read_models where spot_id = 'linda-mar'").run();
});

describe("versioned Analysis signal query budgets", () => {
  it("ACKs malformed and version-skewed Analysis signals without Queue redelivery", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const settlements = [0, 1].map(() => ({ ack: vi.fn(), retry: vi.fn() }));
      await worker.queue(
        {
          queue: "surf-ingest",
          messages: [
            {
              id: "analysis-signal-version-skew",
              timestamp: new Date(),
              attempts: 1,
              body: { job: "analysis-signal", schemaVersion: 2 },
              ...settlements[0]!
            },
            {
              id: "analysis-signal-malformed",
              timestamp: new Date(),
              attempts: 1,
              body: { job: "analysis-signal", schemaVersion: 1, domain: "surf" },
              ...settlements[1]!
            }
          ]
        } as unknown as MessageBatch,
        baseEnv(env.DB)
      );

      for (const settlement of settlements) {
        expect(settlement.ack).toHaveBeenCalledOnce();
        expect(settlement.retry).not.toHaveBeenCalled();
      }
      expect(error).toHaveBeenCalledTimes(2);
      expect(
        error.mock.calls.map(([entry]) => JSON.parse(String(entry)))
      ).toEqual([
        expect.objectContaining({
          event: "surf_analysis_signal_discarded",
          messageId: "analysis-signal-version-skew",
          reasonCode: "analysis_signal_invalid_or_failed"
        }),
        expect.objectContaining({
          event: "surf_analysis_signal_discarded",
          messageId: "analysis-signal-malformed",
          reasonCode: "analysis_signal_invalid_or_failed"
        })
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it("refreshes the earliest recommendation date hourly and future dates every three local hours", async () => {
    const offCadence = await fixtureGeneration("2099-08-02T14:00:00.000Z");
    const offCadenceSelection = selectSurfAnalysisBundlesForSignal({
      bundles: offCadence.factBundles,
      generatedAt: offCadence.threeHour.generatedAt,
      timeZone: offCadence.threeHour.spot.timezone
    });
    expect(SURF_ANALYSIS_FUTURE_CADENCE_HOURS).toBe(3);
    expect(
      offCadenceSelection.bundles.filter(
        ({ input }) => input.recommendationWindowIds.length > 0
      )
    ).toHaveLength(1);
    expect(offCadenceSelection.deferredLocalDates).toHaveLength(4);

    const onCadence = await fixtureGeneration("2099-08-02T13:00:00.000Z");
    const onCadenceSelection = selectSurfAnalysisBundlesForSignal({
      bundles: onCadence.factBundles,
      generatedAt: onCadence.threeHour.generatedAt,
      timeZone: onCadence.threeHour.spot.timezone
    });
    expect(onCadenceSelection.bundles).toHaveLength(5);
    expect(onCadenceSelection.deferredLocalDates).toEqual([]);
  });

  it("keeps materialization and five-date signaling in separate sub-50 D1 invocations", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const generation = await fixtureGeneration();
      const signalMessages: unknown[] = [];
      const materializationDb = countedDatabase(env.DB);
      const materializationEnv = baseEnv(materializationDb.db, {
        ingestSend: async (body) => {
          signalMessages.push(body);
        }
      });
      const dependencies: IngestQueueDependencies = {
        runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
        sourceGenerationIsCurrent,
        materializeSpot: async (workerEnv, _spotId, _now, options) => {
          // The production synchronized build performs seven batched source
          // reads plus exact source-run/snapshot reads. Exercise the optional
          // ninth read as the conservative integrated budget fixture.
          await workerEnv.DB.batch(
            Array.from({ length: 9 }, () => workerEnv.DB.prepare("select 1"))
          );
          return persistForecastMaterialization({
            db: workerEnv.DB,
            ...generation,
            sourceIssueFingerprint: "analysis-signal-budget-source",
            materializedAt: options?.materializedAt ?? "2099-08-02T13:05:00.000Z",
            ingestId: options?.ingestId
          });
        }
      };
      const materialization: ForecastMaterializationQueueMessage = {
        job: "forecast-materialization",
        ingestId: "analysis-signal-budget-ingest",
        spotId: "linda-mar",
        requestedAt: generation.threeHour.generatedAt,
        region: "norcal",
        generatedAt: generation.threeHour.generatedAt,
        sourceCompletedAt: "2099-08-02T13:01:00.000Z",
        captureHistory: false
      };

      await processIngestQueueMessage(
        materializationEnv,
        materialization,
        vi.fn(async () => undefined),
        dependencies
      );

      expect(materializationDb.queryCount()).toBe(17);
      expect(materializationDb.queryCount()).toBeLessThan(50);
      expect(signalMessages).toHaveLength(1);
      expect(signalMessages[0]).toMatchObject({
        job: "analysis-signal",
        schemaVersion: 1,
        domain: "surf",
        ingestId: materialization.ingestId,
        spotId: materialization.spotId
      });
      expect(
        await env.DB.prepare("select count(*) as count from narrative_jobs").first<{ count: number }>()
      ).toEqual({ count: 0 });

      const narrativeMessages: unknown[] = [];
      const signalDb = countedDatabase(env.DB);
      const ack = vi.fn();
      const retry = vi.fn();
      await worker.queue(
        {
          queue: "surf-ingest",
          messages: [{
            id: "analysis-signal-1",
            timestamp: new Date(),
            attempts: 1,
            body: signalMessages[0] as SurfAnalysisSignalQueueMessage,
            ack,
            retry
          }]
        } as unknown as MessageBatch,
        baseEnv(signalDb.db, {
          narrativeSend: async (body) => {
            narrativeMessages.push(body);
          }
        })
      );

      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(narrativeMessages).toHaveLength(5);
      expect(signalDb.queryCount()).toBe(36);
      expect(signalDb.queryCount()).toBeLessThan(50);

      const duplicateDb = countedDatabase(env.DB);
      const duplicateAck = vi.fn();
      await worker.queue(
        {
          queue: "surf-ingest",
          messages: [{
            id: "analysis-signal-redelivery",
            timestamp: new Date(),
            attempts: 2,
            body: signalMessages[0] as SurfAnalysisSignalQueueMessage,
            ack: duplicateAck,
            retry: vi.fn()
          }]
        } as unknown as MessageBatch,
        baseEnv(duplicateDb.db, {
          narrativeSend: async (body) => {
            narrativeMessages.push(body);
          }
        })
      );
      expect(duplicateAck).toHaveBeenCalledOnce();
      expect(narrativeMessages).toHaveLength(5);
      expect(duplicateDb.queryCount()).toBeLessThan(50);
      expect(
        await env.DB.prepare("select count(*) as count from narrative_jobs").first<{ count: number }>()
      ).toEqual({ count: 5 });
    } finally {
      info.mockRestore();
    }
  });

  it("ACKs an advisory partial failure and recovers on the next generation signal", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const generation = await fixtureGeneration();
      const published = await persistForecastMaterialization({
        db: env.DB,
        ...generation,
        sourceIssueFingerprint: "analysis-signal-retry-source",
        materializedAt: "2099-08-02T13:05:00.000Z",
        ingestId: "analysis-signal-retry-ingest"
      });
      const signal: SurfAnalysisSignalQueueMessage = {
        job: "analysis-signal",
        schemaVersion: 1,
        domain: "surf",
        ingestId: "analysis-signal-retry-ingest",
        spotId: "linda-mar",
        generationId: published.forecastOutcomes[0]!.generationId!,
        generatedAt: generation.threeHour.generatedAt,
        materializedAt: "2099-08-02T13:05:00.000Z",
        region: "norcal"
      };
      expect(
        await getActiveMaterializedForecastFactBundlesForGeneration(
          env.DB,
          "linda-mar",
          signal.generationId
        )
      ).toHaveLength(generation.factBundles.length);
      let sends = 0;
      const firstAck = vi.fn();
      const firstRetry = vi.fn();
      await worker.queue(
        {
          queue: "surf-ingest",
          messages: [{
            id: "analysis-signal-partial",
            timestamp: new Date(),
            attempts: 1,
            body: signal,
            ack: firstAck,
            retry: firstRetry
          }]
        } as unknown as MessageBatch,
        baseEnv(env.DB, {
          narrativeSend: async () => {
            sends += 1;
            if (sends === 2) throw new Error("temporary narrative Queue failure");
          }
        })
      );
      expect(firstAck).toHaveBeenCalledOnce();
      expect(firstRetry).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare(
          "select count(*) as count from narrative_jobs where status = 'enqueue_failed'"
        ).first<{ count: number }>()
      ).toEqual({ count: 1 });

      const nextGeneration = await fixtureGeneration("2099-08-02T16:00:00.000Z");
      const nextPublished = await persistForecastMaterialization({
        db: env.DB,
        ...nextGeneration,
        sourceIssueFingerprint: "analysis-signal-next-source",
        materializedAt: "2099-08-02T16:05:00.000Z",
        ingestId: "analysis-signal-next-ingest"
      });
      const nextSignal: SurfAnalysisSignalQueueMessage = {
        ...signal,
        ingestId: "analysis-signal-next-ingest",
        generationId: nextPublished.forecastOutcomes[0]!.generationId!,
        generatedAt: nextGeneration.threeHour.generatedAt,
        materializedAt: "2099-08-02T16:05:00.000Z"
      };
      const secondAck = vi.fn();
      const secondRetry = vi.fn();
      await worker.queue(
        {
          queue: "surf-ingest",
          messages: [{
            id: "analysis-signal-next-generation",
            timestamp: new Date(),
            attempts: 2,
            body: nextSignal,
            ack: secondAck,
            retry: secondRetry
          }]
        } as unknown as MessageBatch,
        baseEnv(env.DB, {
          narrativeSend: async () => {
            sends += 1;
          }
        })
      );
      expect(secondAck).toHaveBeenCalledOnce();
      expect(secondRetry).not.toHaveBeenCalled();
      expect(sends).toBeGreaterThan(5);
      expect(
        await env.DB.prepare(
          "select count(*) as count from narrative_jobs where status = 'enqueue_failed'"
        ).first<{ count: number }>()
      ).toEqual({ count: 0 });
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  it("ACKs a mixed signal when an authoritative date has no recommendation", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const generation = await fixtureGeneration("2099-08-03T05:00:00.000Z");
      const unavailableDates = generation.factBundles.filter(
        ({ input }) => input.recommendationWindowIds.length === 0
      );
      const availableDates = generation.factBundles.filter(
        ({ input }) => input.recommendationWindowIds.length > 0
      );
      expect(unavailableDates.length).toBeGreaterThan(0);
      expect(availableDates.length).toBeGreaterThan(0);
      const published = await persistForecastMaterialization({
        db: env.DB,
        ...generation,
        sourceIssueFingerprint: "analysis-signal-no-call-source",
        materializedAt: "2099-08-02T13:05:00.000Z",
        ingestId: "analysis-signal-no-call-ingest"
      });
      const signal: SurfAnalysisSignalQueueMessage = {
        job: "analysis-signal",
        schemaVersion: 1,
        domain: "surf",
        ingestId: "analysis-signal-no-call-ingest",
        spotId: "linda-mar",
        generationId: published.forecastOutcomes[0]!.generationId!,
        generatedAt: generation.threeHour.generatedAt,
        materializedAt: "2099-08-02T13:05:00.000Z",
        region: "norcal"
      };
      const activeBundles = await getActiveMaterializedForecastFactBundlesForGeneration(
        env.DB,
        "linda-mar",
        signal.generationId
      );
      expect(activeBundles).toHaveLength(generation.factBundles.length);
      expect(
        activeBundles.filter(({ bundle }) =>
          bundle.input.recommendationWindowIds.length === 0
        )
      ).toHaveLength(unavailableDates.length);
      const narrativeMessages: unknown[] = [];
      const ack = vi.fn();
      const retry = vi.fn();

      await worker.queue(
        {
          queue: "surf-ingest",
          messages: [{
            id: "analysis-signal-no-call",
            timestamp: new Date(),
            attempts: 1,
            body: signal,
            ack,
            retry
          }]
        } as unknown as MessageBatch,
        baseEnv(env.DB, {
          narrativeSend: async (body) => {
            narrativeMessages.push(body);
          }
        })
      );

      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(narrativeMessages).toHaveLength(1);
      expect(
        await env.DB.prepare("select count(*) as count from narrative_jobs").first<{ count: number }>()
      ).toEqual({ count: 1 });
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('"reasonCode":"analysis_no_recommendation"')
      );
    } finally {
      info.mockRestore();
    }
  });

  it("ACKs a pending result as superseded when the current date becomes a no-call", async () => {
    const generation = await fixtureGeneration("2099-08-02T13:00:00.000Z");
    await persistForecastMaterialization({
      db: env.DB,
      ...generation,
      sourceIssueFingerprint: "analysis-result-no-call-source",
      materializedAt: "2099-08-02T13:05:00.000Z",
      ingestId: "analysis-result-no-call-ingest"
    });
    const recommended = generation.factBundles.find(
      ({ input }) => input.recommendationWindowIds.length > 0
    );
    if (!recommended) throw new Error("Fixture did not produce a recommended date");
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: { send: async () => undefined } as unknown as Queue,
      bundle: recommended,
      now: new Date("2099-08-02T13:06:00.000Z")
    });
    const snapshot = await buildSurfAnalysisSnapshot(recommended);
    const job = await buildSurfNarrativeJob(snapshot);
    const example = job.inference.messages.find(({ role }) => role === "assistant");
    if (!example) throw new Error("Narrative job did not include its valid output example");

    const noCallForecast = expandedForecast("1h", generation.hourly.generatedAt);
    noCallForecast.recommendations = [];
    const noCall = await buildForecastFactBundle(noCallForecast, {
      localDate: recommended.input.localDate
    });
    expect(noCall.input.recommendationWindowIds).toEqual([]);
    await env.DB.prepare(
      `update forecast_fact_bundles
       set input_fingerprint = ?, material_fingerprint = ?, fact_bundle_json = ?
       where spot_id = ? and local_date = ?`
    ).bind(
      noCall.inputFingerprint,
      noCall.materialFingerprint,
      JSON.stringify(noCall),
      recommended.input.spotId,
      recommended.input.localDate
    ).run();

    const response = await worker.fetch(
      new Request("https://surf.test/api/internal/narratives/results", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-result-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          schemaVersion: 1,
          jobId: job.jobId,
          submissionId: job.result.submissionId,
          modelId: "fixture-model",
          output: JSON.parse(example.content)
        })
      }) as unknown as Parameters<typeof worker.fetch>[0],
      baseEnv(env.DB),
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jobId: job.jobId,
      disposition: "superseded"
    });
  });
});
