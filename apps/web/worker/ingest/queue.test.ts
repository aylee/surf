import { describe, expect, it, vi } from "vitest";
import { NORCAL_SPOTS } from "@surf/forecast-core";
import type { Env } from "../index";
import type { IngestSummary } from "./types";
import {
  buildForecastMaterializationMessages,
  processIngestQueueMessage,
  sourceGenerationIsCurrent,
  type IngestQueueDependencies
} from "./queue";

function summary(options: {
  status?: IngestSummary["status"];
  errors?: string[];
  ingestId?: string;
  requestedAt?: string;
  generatedAt?: string;
  sourceCompletedAt?: string;
  sourcePersistenceReady?: boolean;
} = {}): IngestSummary {
  return {
    kind: "manual-ingest",
    region: "norcal",
    requestedAt: options.requestedAt ?? "2026-08-03T01:02:03.456Z",
    startedAt: "2026-08-03T01:02:04.000Z",
    completedAt: "2026-08-03T01:02:20.000Z",
    status: options.status ?? "success",
    sourceRuns: [],
    counts: {
      tidePredictionRows: 1,
      nwsSpotContexts: 1,
      nwsWindForecastRows: 1,
      nwsHazards: 0,
      nwsWaveForecastRows: 1,
      cdipMopWaveForecastRows: 1,
      ndbcObservationRows: 1,
      forecastSnapshotRows: 0,
      forecastReadModelRows: 0,
      forecastFactBundleRows: 0
    },
    caveats: [],
    errors: options.errors ?? [],
    dbContract: "test",
    publication: {
      ingestId: options.ingestId ?? "ingest-123",
      generatedAt: options.generatedAt ?? "2026-08-03T01:02:03.456Z",
      sourceCompletedAt: options.sourceCompletedAt ?? "2026-08-03T01:02:20.000Z",
      sourceIssueFingerprint: "source-fingerprint",
      sourcePersistenceReady: options.sourcePersistenceReady ?? true,
      sourcePersistenceErrors:
        options.sourcePersistenceReady === false ? ["normalized D1 write failed"] : [],
      deferred: true,
      captureHistory: true
    }
  };
}

function testEnv(sendBatch: unknown = vi.fn(async () => undefined)): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    SURF_USER_AGENT: "surf-test/1.0",
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    RAW_ARTIFACTS: {} as R2Bucket,
    INGEST_QUEUE: { sendBatch } as unknown as Queue
  };
}

function dependencies(runIngest: IngestQueueDependencies["runIngest"]): IngestQueueDependencies {
  return {
    runIngest,
    materializeSpot: vi.fn(),
    sourceGenerationIsCurrent: vi.fn(async () => true)
  } as unknown as IngestQueueDependencies;
}

describe("forecast materialization queue orchestration", () => {
  it("fans one immutable child job per spot out of the source invocation", async () => {
    const sentBatches: Array<Array<{ body: unknown }>> = [];
    const sendBatch = vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      sentBatches.push([...messages]);
    });
    const runOptions: Array<{ idSuffix?: string }> = [];
    const runIngest: IngestQueueDependencies["runIngest"] = vi.fn(async (_env, options) => {
      runOptions.push(options);
      return summary();
    });
    const deps = dependencies(runIngest);
    const signalBrief = vi.fn(async () => undefined);

    await processIngestQueueMessage(
      testEnv(sendBatch),
      {
        job: "source-ingest",
        kind: "manual-ingest",
        ingestId: "ingest-123",
        requestedAt: "2026-08-03T01:02:03.456Z",
        forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
        region: "norcal"
      },
      signalBrief,
      deps
    );

    expect(runIngest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deferForecastMaterialization: true,
        ingestId: "ingest-123",
        idSuffix: "ingest-123",
        now: new Date("2026-08-03T01:02:03.456Z")
      })
    );
    expect(deps.materializeSpot).not.toHaveBeenCalled();
    expect(signalBrief).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledOnce();
    const messages = sentBatches[0]!.map((entry) => entry.body);
    expect(messages).toHaveLength(NORCAL_SPOTS.length);
    expect(messages.map((message) => (message as { spotId: string }).spotId)).toEqual(
      NORCAL_SPOTS.map((spot) => spot.id)
    );
    expect(messages).toEqual(
      buildForecastMaterializationMessages(summary()).map((body) => body)
    );
  });

  it("dispatches independently-valid spot jobs before retrying a degraded source run", async () => {
    const sentBatches: Array<Array<{ body: unknown }>> = [];
    const sendBatch = vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      sentBatches.push([...messages]);
    });
    const deps = dependencies(
      vi.fn(async () => summary({ status: "failure", errors: ["optional provider failed"] })) as IngestQueueDependencies["runIngest"]
    );

    await expect(
      processIngestQueueMessage(
        testEnv(sendBatch),
        {
          job: "source-ingest",
          kind: "manual-ingest",
          ingestId: "ingest-123",
          requestedAt: "2026-08-03T01:02:03.456Z",
          forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
          region: "norcal"
        },
        vi.fn(async () => undefined),
        deps
      )
    ).rejects.toThrow("optional provider failed");
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sentBatches[0]).toHaveLength(NORCAL_SPOTS.length);
  });

  it("does not dispatch spot jobs when normalized source persistence is incomplete", async () => {
    const sendBatch = vi.fn(async () => undefined);
    const deps = dependencies(
      vi.fn(async () =>
        summary({
          status: "failure",
          errors: ["normalized D1 write failed"],
          sourcePersistenceReady: false
        })) as IngestQueueDependencies["runIngest"]
    );

    await expect(
      processIngestQueueMessage(
        testEnv(sendBatch),
        {
          job: "source-ingest",
          kind: "manual-ingest",
          ingestId: "ingest-123",
          requestedAt: "2026-08-03T01:02:03.456Z",
          forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
          region: "norcal"
        },
        vi.fn(async () => undefined),
        deps
      )
    ).rejects.toThrow("source ingest persistence is incomplete");
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("reuses source-run and child identities under at-least-once redelivery", async () => {
    const sentBatches: Array<Array<{ body: unknown }>> = [];
    const sendBatch = vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      sentBatches.push([...messages]);
    });
    const runOptions: Array<{ idSuffix?: string }> = [];
    const runIngest: IngestQueueDependencies["runIngest"] = vi.fn(async (_env, options) => {
      runOptions.push(options);
      return summary();
    });
    const deps = dependencies(runIngest);
    const sourceMessage = {
      job: "source-ingest",
      kind: "manual-ingest",
      ingestId: "ingest-123",
      requestedAt: "2026-08-03T01:02:03.456Z",
      forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
      region: "norcal"
    };

    await processIngestQueueMessage(
      testEnv(sendBatch),
      sourceMessage,
      vi.fn(async () => undefined),
      deps
    );
    await processIngestQueueMessage(
      testEnv(sendBatch),
      sourceMessage,
      vi.fn(async () => undefined),
      deps
    );

    expect(runIngest).toHaveBeenCalledTimes(2);
    expect(runOptions.map((options) => options.idSuffix)).toEqual(["ingest-123", "ingest-123"]);
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[1]).toEqual(sentBatches[0]);
  });

  it("skips an older source job before it can overwrite a newer generation's inputs", async () => {
    const sentBatches: Array<Array<{ body: unknown }>> = [];
    const sendBatch = vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      sentBatches.push([...messages]);
    });
    let latestGeneration: string | null = null;
    const runIngest: IngestQueueDependencies["runIngest"] = vi.fn(async (_env, options) => {
      const generatedAt = options.now!.toISOString();
      latestGeneration = generatedAt;
      return summary({
        ingestId: options.ingestId,
        requestedAt: options.requestedAt,
        generatedAt,
        sourceCompletedAt: new Date(Date.parse(generatedAt) + 60_000).toISOString()
      });
    });
    const materializeSpot = vi.fn(async () => ({
      rowsWritten: 7,
      forecastRowsWritten: 2,
      factBundleRowsWritten: 5,
      errors: []
    }));
    const deps: IngestQueueDependencies = {
      runIngest,
      materializeSpot: materializeSpot as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async (_db, generatedAt) =>
        latestGeneration === null || Date.parse(latestGeneration) <= Date.parse(generatedAt)
      )
    };
    const newer = {
      job: "source-ingest",
      kind: "scheduled-ingest",
      ingestId: "newer-ingest",
      requestedAt: "2026-08-03T01:05:00.000Z",
      forecastGeneratedAt: "2026-08-03T01:05:00.000Z",
      region: "norcal"
    };
    const older = {
      ...newer,
      ingestId: "older-ingest",
      requestedAt: "2026-08-03T01:00:00.000Z",
      forecastGeneratedAt: "2026-08-03T01:00:00.000Z"
    };

    await processIngestQueueMessage(
      testEnv(sendBatch),
      newer,
      vi.fn(async () => undefined),
      deps
    );
    await processIngestQueueMessage(
      testEnv(sendBatch),
      older,
      vi.fn(async () => undefined),
      deps
    );

    expect(runIngest).toHaveBeenCalledOnce();
    expect(sentBatches).toHaveLength(1);
    const newerChild = sentBatches[0]![0]!.body;
    await processIngestQueueMessage(
      testEnv(sendBatch),
      newerChild,
      vi.fn(async () => undefined),
      deps
    );
    expect(materializeSpot).toHaveBeenCalledOnce();
    expect(materializeSpot).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      new Date("2026-08-03T01:05:00.000Z"),
      expect.objectContaining({ ingestId: "newer-ingest" })
    );
  });

  it("skips an older logical child even when it completed after a newer generation", async () => {
    const materializeSpot = vi.fn();
    const signalBrief = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deps: IngestQueueDependencies = {
      runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot: materializeSpot as unknown as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => false)
    };

    await processIngestQueueMessage(
      testEnv(),
      buildForecastMaterializationMessages(
        summary({
          generatedAt: "2026-08-03T01:00:00.000Z",
          sourceCompletedAt: "2026-08-03T01:20:00.000Z"
        })
      )[0],
      signalBrief,
      deps
    );

    expect(materializeSpot).not.toHaveBeenCalled();
    expect(signalBrief).not.toHaveBeenCalled();
    expect(deps.sourceGenerationIsCurrent).toHaveBeenCalledWith(
      expect.anything(),
      "2026-08-03T01:00:00.000Z"
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining("superseded source generation"));
    info.mockRestore();
  });

  it("keeps a failed spot job isolated from brief signaling and eligible for retry", async () => {
    const signalBrief = vi.fn();
    const materializeSpot = vi.fn(async () => ({
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: ["D1 temporarily unavailable"]
    }));
    const deps: IngestQueueDependencies = {
      runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot: materializeSpot as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => true)
    };

    await expect(
      processIngestQueueMessage(
        testEnv(),
        buildForecastMaterializationMessages(summary())[0],
        signalBrief,
        deps
      )
    ).rejects.toThrow("D1 temporarily unavailable");
    expect(materializeSpot).toHaveBeenCalledOnce();
    expect(signalBrief).not.toHaveBeenCalled();
  });

  it("signals only the published spot and treats history errors as non-gating", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const signalBrief = vi.fn(async () => undefined);
    const materializeSpot = vi.fn(async () => ({
      rowsWritten: 7,
      forecastRowsWritten: 2,
      factBundleRowsWritten: 5,
      errors: [],
      historyErrors: ["snapshot write failed"]
    }));
    const deps: IngestQueueDependencies = {
      runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot: materializeSpot as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => true)
    };
    const message = buildForecastMaterializationMessages(summary())[0]!;

    await processIngestQueueMessage(testEnv(), message, signalBrief, deps);

    expect(materializeSpot).toHaveBeenCalledWith(
      expect.anything(),
      message.spotId,
      new Date(message.generatedAt),
      expect.objectContaining({
        captureHistory: true,
        ingestId: message.ingestId
      })
    );
    expect(signalBrief).toHaveBeenCalledOnce();
    expect(signalBrief).toHaveBeenCalledWith(
      expect.anything(),
      message.spotId,
      new Date(message.generatedAt)
    );
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("history capture"));
    warning.mockRestore();
  });

  it("compares child lineage with the latest indexed logical source generation", async () => {
    const dbFor = (latestGenerationAt: string | null) => ({
      prepare: () => ({
        first: async () => ({ latest_generation_at: latestGenerationAt })
      })
    }) as unknown as D1Database;

    await expect(
      sourceGenerationIsCurrent(dbFor("2026-08-03T01:00:00.000Z"), "2026-08-03T01:05:00.000Z")
    ).resolves.toBe(true);
    await expect(
      sourceGenerationIsCurrent(dbFor("2026-08-03T01:05:00.000Z"), "2026-08-03T01:00:00.000Z")
    ).resolves.toBe(false);
  });

  it("rejects poison queue job types instead of turning them into scheduled ingests", async () => {
    const runIngest = vi.fn();
    const deps = dependencies(runIngest as unknown as IngestQueueDependencies["runIngest"]);

    await expect(
      processIngestQueueMessage(
        testEnv(),
        { job: "unknown-job" },
        vi.fn(async () => undefined),
        deps
      )
    ).rejects.toThrow("unknown job type");
    expect(runIngest).not.toHaveBeenCalled();
  });

  it.each([null, "bad-message", [], {}])(
    "rejects malformed queue body %j instead of synthesizing an ingest",
    async (body) => {
      const runIngest = vi.fn();
      const deps = dependencies(runIngest as unknown as IngestQueueDependencies["runIngest"]);

      await expect(
        processIngestQueueMessage(
          testEnv(),
          body,
          vi.fn(async () => undefined),
          deps
        )
      ).rejects.toThrow(/must be an object|legacy ingest queue message is invalid/i);
      expect(runIngest).not.toHaveBeenCalled();
    }
  );

  it("normalizes a legacy source message to one stable retry identity", async () => {
    const runOptions: Array<{ ingestId?: string }> = [];
    const runIngest: IngestQueueDependencies["runIngest"] = vi.fn(async (_env, options) => {
      runOptions.push(options);
      return summary();
    });
    const deps = dependencies(runIngest);
    const legacy = {
      kind: "scheduled-ingest",
      requestedAt: "2026-08-03T01:02:03.456Z",
      region: "norcal"
    };

    await processIngestQueueMessage(testEnv(), legacy, vi.fn(async () => undefined), deps);
    await processIngestQueueMessage(testEnv(), legacy, vi.fn(async () => undefined), deps);

    expect(runOptions.map(({ ingestId }) => ingestId)).toEqual([
      "legacy-20260803010203456",
      "legacy-20260803010203456"
    ]);
  });
});
