import { describe, expect, it, vi } from "vitest";
import { NORCAL_SPOTS } from "@surf/forecast-core";
import type {
  ForecastMaterializationOutcome,
  ForecastMaterializationReasonCode
} from "../forecast-read-model";
import type { Env } from "../index";
import type {
  IngestSummary,
  SourceBatchQueueMessage,
  SourceIngestQueueMessage
} from "./types";
import {
  NORCAL_SOURCE_BATCHES,
  SOURCE_BATCH_SCHEMA_VERSION,
  sourceBatchRunSuffix
} from "./source-batches";
import {
  buildForecastMaterializationMessages,
  buildSurfAnalysisSignalMessage,
  buildSourceBatchMessages,
  logInlineIngestTerminalOutcomes,
  processIngestQueueMessage,
  signalInlineForecastBriefs,
  sourceGenerationIsCurrent,
  type ForecastBriefSignal,
  type IngestQueueDependencies
} from "./queue";

function sourceMessage(
  overrides: Partial<SourceIngestQueueMessage> = {}
): SourceIngestQueueMessage {
  return {
    job: "source-ingest",
    kind: "manual-ingest",
    ingestId: "ingest-123",
    requestedAt: "2026-08-03T01:02:03.456Z",
    forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
    region: "norcal",
    ...overrides
  };
}

function sourceBatchMessage(
  overrides: Partial<SourceBatchQueueMessage> = {}
): SourceBatchQueueMessage {
  const configured = NORCAL_SOURCE_BATCHES[0]!;
  return {
    job: "source-batch",
    schemaVersion: SOURCE_BATCH_SCHEMA_VERSION,
    kind: "manual-ingest",
    ingestId: "ingest-123",
    batchKey: configured.batchKey,
    spotIds: [...configured.spotIds],
    requestedAt: "2026-08-03T01:02:03.456Z",
    forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
    region: "norcal",
    ...overrides
  };
}

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
      captureHistory: true,
      forecastOutcomes: []
    }
  };
}

function forecastOutcomes(options: {
  ingestId?: string;
  spotId?: ForecastMaterializationOutcome["spotId"];
  generatedAt?: string;
  materializedAt?: string;
  outcome?: ForecastMaterializationOutcome["outcome"];
  reasonCode?: ForecastMaterializationReasonCode;
  retryable?: boolean;
} = {}): ForecastMaterializationOutcome[] {
  const outcome = options.outcome ?? "publish";
  return (["3h", "1h"] as const).map((interval) => ({
    ingestId: options.ingestId ?? "ingest-123",
    spotId: options.spotId ?? NORCAL_SPOTS[0]!.id,
    interval,
    generationId:
      outcome === "publish" ||
      outcome === "supersede" ||
      (outcome === "skip" && options.reasonCode === "forecast_generation_already_active")
        ? `sha256:${"a".repeat(64)}:ingest:${options.ingestId ?? "ingest-123"}`
        : null,
    generatedAt: options.generatedAt ?? "2026-08-03T01:02:03.456Z",
    materializedAt: options.materializedAt ?? "2026-08-03T01:02:20.000Z",
    outcome,
    retryable: options.retryable ?? outcome === "failure",
    reasonCode:
      options.reasonCode ??
      (outcome === "publish"
        ? "forecast_generation_published"
        : outcome === "supersede"
          ? "newer_generation_active"
          : outcome === "skip"
            ? "no_scored_windows"
            : "forecast_persistence_failed")
  }));
}

function testEnv(sendBatch: unknown = vi.fn(async () => undefined)): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    SURF_USER_AGENT: "surf-test/1.0",
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    RAW_ARTIFACTS: {} as R2Bucket,
    INGEST_QUEUE: { sendBatch, send: vi.fn(async () => undefined) } as unknown as Queue
  };
}

function narrativeTestEnv(
  sendBatch: unknown = vi.fn(async () => undefined),
  send: unknown = vi.fn(async () => undefined)
): Env {
  return {
    ...testEnv(sendBatch),
    INGEST_QUEUE: { sendBatch, send } as unknown as Queue,
    NARRATIVE_ENABLED: "true",
    NARRATIVE_QUEUE: {} as Queue,
    NARRATIVE_FALLBACK_QUEUE: {} as Queue,
    NARRATIVE_RESULT_TOKEN: "test-result-token",
    GEMINI_API_KEY: "test-gemini-token"
  };
}

function dependencies(runIngest: IngestQueueDependencies["runIngest"]): IngestQueueDependencies {
  return {
    runIngest,
    materializeSpot: vi.fn(),
    sourceGenerationIsCurrent: vi.fn(async () => true)
  } as unknown as IngestQueueDependencies;
}

function inlineSignalSpy() {
  return vi.fn<ForecastBriefSignal>(async () => undefined);
}

function expectedInlineSourcePersistenceEntry(
  inlineSummary: IngestSummary,
  reasonCode:
    | "inline_source_persistence_completed"
    | "inline_source_persistence_completed_with_caveats"
) {
  return {
    event: "source_ingest_published",
    message: "source ingest published",
    ingestId: inlineSummary.publication.ingestId,
    generatedAt: inlineSummary.publication.generatedAt,
    outcome: "publish",
    reasonCode,
    sourceStatus: inlineSummary.status,
    sourceCount: inlineSummary.sourceRuns.length,
    partialSourceCount: inlineSummary.sourceRuns.filter(({ status }) => status === "partial").length,
    caveatCount: inlineSummary.caveats.length,
    errorCount: inlineSummary.errors.length,
    materializationJobCount: 0
  };
}

describe("forecast materialization queue orchestration", () => {
  it("signals every complete inline publish pair with the queue-equivalent context", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inlineSummary = summary();
    inlineSummary.counts.forecastReadModelRows = NORCAL_SPOTS.length * 2;
    inlineSummary.publication.deferred = false;
    inlineSummary.publication.forecastOutcomes = NORCAL_SPOTS.flatMap((spot) =>
      forecastOutcomes({ spotId: spot.id })
    );

    const requests = logInlineIngestTerminalOutcomes(inlineSummary);
    expect(requests).toHaveLength(NORCAL_SPOTS.length);
    expect(requests).toEqual(
      NORCAL_SPOTS.map((spot) => ({
        spotId: spot.id,
        context: {
          ingestId: inlineSummary.publication.ingestId,
          generationId: `sha256:${"a".repeat(64)}:ingest:${inlineSummary.publication.ingestId}`,
          generatedAt: inlineSummary.publication.generatedAt,
          materializedAt: inlineSummary.publication.sourceCompletedAt
        }
      }))
    );
    const signalBrief = inlineSignalSpy();
    const workerEnv = testEnv();
    await signalInlineForecastBriefs(workerEnv, requests, signalBrief);
    expect(signalBrief.mock.calls).toEqual(
      requests.map(({ spotId, context }) => [
        workerEnv,
        spotId,
        new Date(context.generatedAt),
        context
      ])
    );
    expect(
      info.mock.calls
        .map(([entry]) => JSON.parse(String(entry)))
        .filter(({ event }) => event === "source_ingest_published")
    ).toEqual([
      expectedInlineSourcePersistenceEntry(
        inlineSummary,
        "inline_source_persistence_completed"
      )
    ]);
    info.mockRestore();
    error.mockRestore();
  });

  it("does not signal inline all-superseded pairs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inlineSummary = summary();
    inlineSummary.counts.forecastReadModelRows = 0;
    inlineSummary.publication.forecastOutcomes = NORCAL_SPOTS.flatMap((spot) =>
      forecastOutcomes({ spotId: spot.id, outcome: "supersede" })
    );

    const requests = logInlineIngestTerminalOutcomes(inlineSummary);
    const signalBrief = inlineSignalSpy();
    await signalInlineForecastBriefs(testEnv(), requests, signalBrief);

    expect(requests).toEqual([]);
    expect(signalBrief).not.toHaveBeenCalled();
    expect(
      info.mock.calls
        .map(([entry]) => JSON.parse(String(entry)))
        .filter(({ event }) => event === "source_ingest_published")
    ).toEqual([
      expectedInlineSourcePersistenceEntry(
        inlineSummary,
        "inline_source_persistence_completed"
      )
    ]);
    info.mockRestore();
    error.mockRestore();
  });

  it("signals complete inline pairs but excludes a mixed publish and supersession", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inlineSummary = summary();
    inlineSummary.publication.forecastOutcomes = NORCAL_SPOTS.flatMap((spot) =>
      forecastOutcomes({ spotId: spot.id })
    );
    inlineSummary.publication.forecastOutcomes[1] = {
      ...inlineSummary.publication.forecastOutcomes[1]!,
      outcome: "supersede",
      reasonCode: "newer_generation_active"
    };
    inlineSummary.counts.forecastReadModelRows = NORCAL_SPOTS.length * 2 - 1;

    const requests = logInlineIngestTerminalOutcomes(inlineSummary);
    const signalBrief = inlineSignalSpy();
    await signalInlineForecastBriefs(testEnv(), requests, signalBrief);

    expect(requests.map(({ spotId }) => spotId)).toEqual(
      NORCAL_SPOTS.slice(1).map(({ id }) => id)
    );
    expect(signalBrief).toHaveBeenCalledTimes(NORCAL_SPOTS.length - 1);
    expect(signalBrief.mock.calls.some(([, spotId]) => spotId === NORCAL_SPOTS[0]!.id)).toBe(
      false
    );
    expect(
      info.mock.calls
        .map(([entry]) => JSON.parse(String(entry)))
        .filter(({ event }) => event === "source_ingest_published")
    ).toEqual([
      expectedInlineSourcePersistenceEntry(
        inlineSummary,
        "inline_source_persistence_completed"
      )
    ]);
    info.mockRestore();
    error.mockRestore();
  });

  it("describes successful inline source persistence with caveats independently of forecasts", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inlineSummary = summary({ status: "partial" });
    inlineSummary.caveats = [
      {
        code: "optional_source_partial",
        message: "An optional source completed with a bounded caveat."
      }
    ];
    inlineSummary.counts.forecastReadModelRows = NORCAL_SPOTS.length * 2;
    inlineSummary.publication.forecastOutcomes = NORCAL_SPOTS.flatMap((spot) =>
      forecastOutcomes({ spotId: spot.id })
    );

    expect(logInlineIngestTerminalOutcomes(inlineSummary)).toHaveLength(NORCAL_SPOTS.length);
    expect(
      info.mock.calls
        .map(([entry]) => JSON.parse(String(entry)))
        .filter(({ event }) => event === "source_ingest_published")
    ).toEqual([
      expectedInlineSourcePersistenceEntry(
        inlineSummary,
        "inline_source_persistence_completed_with_caveats"
      )
    ]);
    expect(error).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });

  it("replaces only a malformed inline spot pair and never signals an invalid outcome set", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inlineSummary = summary();
    inlineSummary.counts.forecastReadModelRows = NORCAL_SPOTS.length * 2;
    inlineSummary.publication.deferred = false;
    inlineSummary.publication.forecastOutcomes = NORCAL_SPOTS.flatMap((spot) =>
      forecastOutcomes({ spotId: spot.id })
    );
    inlineSummary.publication.forecastOutcomes[1] = {
      ...inlineSummary.publication.forecastOutcomes[0]!
    };

    const requests = logInlineIngestTerminalOutcomes(inlineSummary);
    const signalBrief = inlineSignalSpy();
    await signalInlineForecastBriefs(testEnv(), requests, signalBrief);

    expect(requests).toEqual([]);
    expect(signalBrief).not.toHaveBeenCalled();

    const entries = [...info.mock.calls, ...error.mock.calls].map(([entry]) =>
      JSON.parse(String(entry))
    );
    const sourceEntries = entries.filter(({ event }) => String(event).startsWith("source_ingest_"));
    const forecastEntries = entries.filter(({ event }) =>
      String(event).startsWith("forecast_materialization_")
    );
    expect(sourceEntries).toEqual([
      expect.objectContaining({
        event: "source_ingest_failed",
        outcome: "failure",
        reasonCode: "invalid_forecast_outcome_contract"
      })
    ]);
    expect(forecastEntries).toHaveLength(NORCAL_SPOTS.length * 2);
    expect(
      forecastEntries.filter(({ spotId }) => spotId === NORCAL_SPOTS[0]!.id)
    ).toEqual([
      expect.objectContaining({
        interval: "3h",
        outcome: "failure",
        reasonCode: "invalid_forecast_outcome_contract",
        retryable: true
      }),
      expect.objectContaining({
        interval: "1h",
        outcome: "failure",
        reasonCode: "invalid_forecast_outcome_contract",
        retryable: true
      })
    ]);
    expect(
      forecastEntries.filter(({ spotId }) => spotId !== NORCAL_SPOTS[0]!.id)
    ).toHaveLength((NORCAL_SPOTS.length - 1) * 2);
    expect(
      forecastEntries
        .filter(({ spotId }) => spotId !== NORCAL_SPOTS[0]!.id)
        .every(({ outcome, retryable }) => outcome === "publish" && retryable === false)
    ).toBe(true);
    info.mockRestore();
    error.mockRestore();
  });

  it("dispatches stable source batches, then fans only one batch's spot jobs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sentBatches: Array<Array<{ body: unknown }>> = [];
    const sendBatch = vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      sentBatches.push([...messages]);
    });
    const runOptions: Array<{ idSuffix?: string; spotIds?: readonly string[] }> = [];
    const runIngest: IngestQueueDependencies["runIngest"] = vi.fn(async (_env, options) => {
      runOptions.push(options);
      return summary();
    });
    const deps = dependencies(runIngest);
    const signalBrief = vi.fn(async () => undefined);

    const source = sourceMessage();
    await processIngestQueueMessage(testEnv(sendBatch), source, signalBrief, deps);

    expect(runIngest).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledOnce();
    const batchMessages = sentBatches[0]!.map((entry) => entry.body);
    expect(batchMessages).toEqual(buildSourceBatchMessages(source));
    expect(batchMessages).toHaveLength(NORCAL_SOURCE_BATCHES.length);

    const sourceBatch = batchMessages[0] as SourceBatchQueueMessage;
    await processIngestQueueMessage(testEnv(sendBatch), sourceBatch, signalBrief, deps);

    expect(runIngest).toHaveBeenCalledOnce();
    expect(runIngest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deferForecastMaterialization: true,
        ingestId: "ingest-123",
        idSuffix: sourceBatchRunSuffix("ingest-123", sourceBatch.batchKey),
        now: new Date("2026-08-03T01:02:03.456Z"),
        spotIds: sourceBatch.spotIds
      })
    );
    expect(deps.materializeSpot).not.toHaveBeenCalled();
    expect(signalBrief).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledTimes(2);
    const messages = sentBatches[1]!.map((entry) => entry.body);
    expect(messages).toHaveLength(sourceBatch.spotIds.length);
    expect(messages.map((message) => (message as { spotId: string }).spotId)).toEqual(
      sourceBatch.spotIds
    );
    expect(messages).toEqual(
      buildForecastMaterializationMessages(summary(), sourceBatch.spotIds)
    );
    const terminal = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ outcome }) => outcome !== undefined);
    expect(terminal).toEqual([
      expect.objectContaining({
        event: "source_ingest_dispatched",
        ingestId: "ingest-123",
        outcome: "publish",
        reasonCode: "source_batches_dispatched",
        sourceBatchJobCount: NORCAL_SOURCE_BATCHES.length
      }),
      expect.objectContaining({
        event: "source_ingest_published",
        ingestId: "ingest-123",
        outcome: "publish",
        reasonCode: "materialization_jobs_published",
        materializationJobCount: sourceBatch.spotIds.length,
        batchKey: sourceBatch.batchKey,
        spotCount: sourceBatch.spotIds.length
      })
    ]);
    info.mockRestore();
  });

  it("preserves all eleven spot jobs and twenty-two interval outcomes across the batch barrier", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sentBatches: Array<Array<{ body: unknown }>> = [];
    const sendBatch = vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      sentBatches.push([...messages]);
    });
    const runIngest: IngestQueueDependencies["runIngest"] = vi.fn(async (_env, options) =>
      summary({
        ingestId: options.ingestId,
        requestedAt: options.requestedAt,
        generatedAt: options.now!.toISOString()
      })
    );
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => ({
      rowsWritten: 7,
      forecastRowsWritten: 2,
      factBundleRowsWritten: 5,
      errors: [],
      forecastOutcomes: forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt
      })
    }));
    const deps: IngestQueueDependencies = {
      runIngest,
      materializeSpot: materializeSpot as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => true)
    };
    const analysisSignals = vi.fn(async (_body: unknown, _options?: unknown) => undefined);
    const workerEnv = narrativeTestEnv(sendBatch, analysisSignals);
    const source = sourceMessage();
    const signalBrief = vi.fn(async () => undefined);

    await processIngestQueueMessage(workerEnv, source, signalBrief, deps);
    const sourceBatches = sentBatches[0]!.map(({ body }) => body);
    for (const sourceBatch of sourceBatches) {
      await processIngestQueueMessage(workerEnv, sourceBatch, signalBrief, deps);
    }

    const materializationMessages = sentBatches
      .slice(1)
      .flatMap((batch) => batch.map(({ body }) => body));
    expect(materializationMessages).toHaveLength(NORCAL_SPOTS.length);
    expect(
      materializationMessages
        .map((message) => (message as { spotId: string }).spotId)
        .sort()
    ).toEqual(NORCAL_SPOTS.map(({ id }) => id).sort());
    expect(
      materializationMessages
        .map((message) => JSON.stringify(message))
        .sort()
    ).toEqual(
      buildForecastMaterializationMessages(summary())
        .map((message) => JSON.stringify(message))
        .sort()
    );

    for (const materialization of materializationMessages) {
      await processIngestQueueMessage(workerEnv, materialization, signalBrief, deps);
    }

    expect(runIngest).toHaveBeenCalledTimes(NORCAL_SOURCE_BATCHES.length);
    expect(materializeSpot).toHaveBeenCalledTimes(NORCAL_SPOTS.length);
    expect(signalBrief).not.toHaveBeenCalled();
    expect(analysisSignals).toHaveBeenCalledTimes(NORCAL_SPOTS.length);
    expect(
      analysisSignals.mock.calls.map(([message]) => message)
    ).toEqual(
      expect.arrayContaining(
        NORCAL_SPOTS.map((spot) =>
          expect.objectContaining({
            job: "analysis-signal",
            schemaVersion: 1,
            domain: "surf",
            spotId: spot.id
          })
        )
      )
    );
    const publishedIntervals = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ event }) => event === "forecast_materialization_published");
    expect(publishedIntervals).toHaveLength(NORCAL_SPOTS.length * 2);
    expect(
      publishedIntervals.map(({ spotId, interval }) => `${spotId}:${interval}`).sort()
    ).toEqual(
      NORCAL_SPOTS.flatMap(({ id }) => [`${id}:1h`, `${id}:3h`]).sort()
    );
    info.mockRestore();
  });

  it("ACKs a degraded source run after dispatching its complete usable child set", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
        sourceBatchMessage(),
        vi.fn(async () => undefined),
        deps
      )
    ).resolves.toBeUndefined();
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sentBatches[0]).toHaveLength(NORCAL_SOURCE_BATCHES[0]!.spotIds.length);
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
    const terminal = JSON.parse(String(info.mock.calls[0]![0]));
    expect(terminal).toEqual(
      expect.objectContaining({
        event: "source_ingest_published",
        ingestId: "ingest-123",
        outcome: "publish",
        sourceStatus: "failure",
        reasonCode: "materialization_jobs_published_from_degraded_source",
        errorCount: 1,
        materializationJobCount: NORCAL_SOURCE_BATCHES[0]!.spotIds.length,
        batchKey: NORCAL_SOURCE_BATCHES[0]!.batchKey
      })
    );
    expect(JSON.stringify(terminal)).not.toContain("optional provider failed");
    info.mockRestore();
    error.mockRestore();
  });

  it("does not dispatch spot jobs when normalized source persistence is incomplete", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
        sourceBatchMessage(),
        vi.fn(async () => undefined),
        deps
      )
    ).rejects.toThrow("source ingest persistence is incomplete");
    expect(sendBatch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual(
      expect.objectContaining({
        event: "source_ingest_failed",
        outcome: "failure",
        reasonCode: "source_persistence_incomplete",
        materializationJobCount: 0
      })
    );
    expect(String(error.mock.calls[0]![0])).not.toContain("normalized D1 write failed");
    error.mockRestore();
  });

  it("emits one bounded source failure when the lineage check throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runIngest = vi.fn();
    const deps: IngestQueueDependencies = {
      runIngest: runIngest as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot: vi.fn() as unknown as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => {
        const failure = new Error("sensitive D1 details");
        failure.name = "D1 Request Error";
        throw failure;
      })
    };

    await expect(
      processIngestQueueMessage(
        testEnv(),
        {
          job: "source-ingest",
          kind: "scheduled-ingest",
          ingestId: "ingest-123",
          requestedAt: "2026-08-03T01:02:03.456Z",
          forecastGeneratedAt: "2026-08-03T01:02:03.456Z",
          region: "norcal"
        },
        vi.fn(),
        deps
      )
    ).rejects.toThrow("sensitive D1 details");

    expect(runIngest).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual(
      expect.objectContaining({
        event: "source_ingest_failed",
        ingestId: "ingest-123",
        outcome: "failure",
        reasonCode: "lineage_check_failed",
        errorName: "OtherError"
      })
    );
    expect(String(error.mock.calls[0]![0])).not.toContain("sensitive D1 details");
    error.mockRestore();
  });

  it("reuses identities and suppresses duplicate publication/signaling after root and batch redelivery", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sentBatches: Array<Array<{ body: unknown }>> = [];
    const sendBatch = vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      sentBatches.push([...messages]);
    });
    const runOptions: Array<{ idSuffix?: string; spotIds?: readonly string[] }> = [];
    const runIngest: IngestQueueDependencies["runIngest"] = vi.fn(async (_env, options) => {
      runOptions.push(options);
      return summary();
    });
    let generationActive = false;
    const materializeSpot: IngestQueueDependencies["materializeSpot"] = vi.fn(
      async (_env, spotId, now, options) => {
        const duplicate = generationActive;
        generationActive = true;
        return {
          rowsWritten: duplicate ? 0 : 3,
          forecastRowsWritten: duplicate ? 0 : 2,
          factBundleRowsWritten: duplicate ? 0 : 1,
          errors: [],
          forecastOutcomes: forecastOutcomes({
            ingestId: options?.ingestId,
            spotId,
            generatedAt: now.toISOString(),
            materializedAt: options?.materializedAt,
            outcome: duplicate ? "skip" : "publish",
            reasonCode: duplicate
              ? "forecast_generation_already_active"
              : "forecast_generation_published",
            retryable: false
          })
        };
      }
    );
    const deps: IngestQueueDependencies = {
      runIngest,
      materializeSpot,
      sourceGenerationIsCurrent: vi.fn(async () => true)
    };
    const signalBrief = vi.fn(async () => undefined);
    const analysisSignals = vi.fn(async (_body: unknown, _options?: unknown) => undefined);
    const workerEnv = narrativeTestEnv(sendBatch, analysisSignals);
    const source = sourceMessage();

    await processIngestQueueMessage(
      workerEnv,
      source,
      signalBrief,
      deps
    );
    await processIngestQueueMessage(
      workerEnv,
      source,
      signalBrief,
      deps
    );

    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[1]).toEqual(sentBatches[0]);

    const configuredBatch = sentBatches[0]![0]!.body as SourceBatchQueueMessage;
    const reorderedBatch = {
      ...configuredBatch,
      spotIds: [...configuredBatch.spotIds].reverse()
    };
    await processIngestQueueMessage(
      workerEnv,
      reorderedBatch,
      signalBrief,
      deps
    );
    await processIngestQueueMessage(
      workerEnv,
      configuredBatch,
      signalBrief,
      deps
    );

    expect(runIngest).toHaveBeenCalledTimes(2);
    const expectedSuffix = sourceBatchRunSuffix("ingest-123", configuredBatch.batchKey);
    expect(runOptions.map((options) => options.idSuffix)).toEqual([
      expectedSuffix,
      expectedSuffix
    ]);
    expect(runOptions.map((options) => options.spotIds)).toEqual([
      configuredBatch.spotIds,
      configuredBatch.spotIds
    ]);
    expect(sentBatches).toHaveLength(4);
    expect(sentBatches[3]).toEqual(sentBatches[2]);

    const firstChild = sentBatches[2]![0]!.body;
    const duplicateChild = sentBatches[3]![0]!.body;
    await processIngestQueueMessage(workerEnv, firstChild, signalBrief, deps);
    await processIngestQueueMessage(workerEnv, duplicateChild, signalBrief, deps);

    expect(signalBrief).not.toHaveBeenCalled();
    expect(analysisSignals).toHaveBeenCalledOnce();
    const forecastTerminals = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ outcome, interval }) => outcome !== undefined && interval !== undefined);
    expect(forecastTerminals.filter(({ outcome }) => outcome === "publish")).toHaveLength(2);
    expect(forecastTerminals.filter(({ outcome }) => outcome === "skip")).toEqual([
      expect.objectContaining({
        interval: "3h",
        reasonCode: "forecast_generation_already_active",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        reasonCode: "forecast_generation_already_active",
        retryable: false
      })
    ]);
    info.mockRestore();
  });

  it("skips an older source job before it can overwrite a newer generation's inputs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
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
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => ({
      rowsWritten: 7,
      forecastRowsWritten: 2,
      factBundleRowsWritten: 5,
      errors: [],
      forecastOutcomes: forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt
      })
    }));
    const deps: IngestQueueDependencies = {
      runIngest,
      materializeSpot: materializeSpot as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async (_db, generatedAt) =>
        latestGeneration === null || Date.parse(latestGeneration) <= Date.parse(generatedAt)
      )
    };
    const newer = sourceMessage({
      kind: "scheduled-ingest",
      ingestId: "newer-ingest",
      requestedAt: "2026-08-03T01:05:00.000Z",
      forecastGeneratedAt: "2026-08-03T01:05:00.000Z"
    });
    const older = sourceMessage({
      kind: "scheduled-ingest",
      ingestId: "older-ingest",
      requestedAt: "2026-08-03T01:00:00.000Z",
      forecastGeneratedAt: "2026-08-03T01:00:00.000Z"
    });

    await processIngestQueueMessage(
      testEnv(sendBatch),
      newer,
      vi.fn(async () => undefined),
      deps
    );
    await processIngestQueueMessage(
      testEnv(sendBatch),
      sentBatches[0]![0]!.body,
      vi.fn(async () => undefined),
      deps
    );
    expect(runIngest).toHaveBeenCalledOnce();
    expect(sentBatches).toHaveLength(2);

    await processIngestQueueMessage(
      testEnv(sendBatch),
      older,
      vi.fn(async () => undefined),
      deps
    );

    expect(runIngest).toHaveBeenCalledOnce();
    expect(sentBatches).toHaveLength(2);
    const newerChild = sentBatches[1]![0]!.body;
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
    const sourceTerminal = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ event }) => String(event).startsWith("source_ingest_"));
    expect(sourceTerminal).toEqual([
      expect.objectContaining({
        event: "source_ingest_dispatched",
        ingestId: "newer-ingest",
        outcome: "publish",
        reasonCode: "source_batches_dispatched"
      }),
      expect.objectContaining({
        event: "source_ingest_published",
        ingestId: "newer-ingest",
        outcome: "publish",
        reasonCode: "materialization_jobs_published"
      }),
      expect.objectContaining({
        event: "source_ingest_superseded",
        ingestId: "older-ingest",
        outcome: "supersede",
        reasonCode: "newer_source_generation_active"
      })
    ]);
    info.mockRestore();
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
    const terminal = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ outcome }) => outcome !== undefined);
    expect(terminal).toHaveLength(2);
    expect(terminal.map(({ interval }) => interval)).toEqual(["3h", "1h"]);
    expect(terminal).toEqual(
      terminal.map(() =>
        expect.objectContaining({
          event: "forecast_materialization_superseded",
          ingestId: "ingest-123",
          spotId: NORCAL_SPOTS[0]!.id,
          generationId: null,
          outcome: "supersede",
          reasonCode: "newer_source_generation_active"
        })
      )
    );
    info.mockRestore();
  });

  it("records a lineage-check failure before the queue retries it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const materializeSpot = vi.fn();
    const signalBrief = vi.fn();
    const deps: IngestQueueDependencies = {
      runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot: materializeSpot as unknown as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => {
        throw new Error("D1 lineage query timed out");
      })
    };
    const message = buildForecastMaterializationMessages(summary())[0]!;

    await expect(
      processIngestQueueMessage(testEnv(), message, signalBrief, deps)
    ).rejects.toThrow("D1 lineage query timed out");

    expect(materializeSpot).not.toHaveBeenCalled();
    expect(signalBrief).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
    const terminal = error.mock.calls.map(([entry]) => JSON.parse(String(entry)));
    expect(terminal.map(({ interval }) => interval)).toEqual(["3h", "1h"]);
    expect(terminal).toEqual(
      terminal.map(() =>
        expect.objectContaining({
          event: "forecast_materialization_failed",
          ingestId: message.ingestId,
          spotId: message.spotId,
          generationId: null,
          outcome: "failure",
          reasonCode: "lineage_check_failed"
        })
      )
    );
    expect(JSON.stringify(terminal)).not.toContain("D1 lineage query timed out");
    info.mockRestore();
    error.mockRestore();
  });

  it("keeps a failed spot job isolated from brief signaling and eligible for retry", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signalBrief = vi.fn();
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => ({
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: ["D1 temporarily unavailable"],
      forecastOutcomes: forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt,
        outcome: "failure"
      })
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
    ).rejects.toThrow("forecast materialization failed");
    expect(materializeSpot).toHaveBeenCalledOnce();
    expect(signalBrief).not.toHaveBeenCalled();
    expect(info.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toContainEqual(
      expect.objectContaining({
        event: "forecast_materialization_started",
        ingestId: "ingest-123",
        spotId: NORCAL_SPOTS[0]!.id,
        generatedAt: "2026-08-03T01:02:03.456Z"
      })
    );
    expect(error).toHaveBeenCalledTimes(2);
    const terminal = error.mock.calls.map(([entry]) => JSON.parse(String(entry)));
    expect(terminal.map(({ interval }) => interval)).toEqual(["3h", "1h"]);
    expect(terminal).toEqual(
      terminal.map(() =>
        expect.objectContaining({
          event: "forecast_materialization_failed",
          ingestId: "ingest-123",
          spotId: NORCAL_SPOTS[0]!.id,
          generationId: null,
          outcome: "failure",
          reasonCode: "forecast_persistence_failed",
          retryable: true
        })
      )
    );
    expect(JSON.stringify(terminal)).not.toContain("D1 temporarily unavailable");
    info.mockRestore();
    error.mockRestore();
  });

  it("acknowledges a newer-generation supersession without retrying or signaling", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signalBrief = vi.fn();
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => ({
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: [],
      forecastOutcomes: forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt,
        outcome: "supersede",
        reasonCode: "newer_generation_active",
        retryable: false
      })
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
    ).resolves.toBeUndefined();

    expect(signalBrief).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    const terminal = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ outcome }) => outcome !== undefined);
    expect(terminal).toHaveLength(2);
    expect(terminal.every(({ event }) => event === "forecast_materialization_superseded")).toBe(
      true
    );
    expect(terminal.every(({ outcome }) => outcome === "supersede")).toBe(true);
    expect(terminal.every(({ retryable }) => retryable === false)).toBe(true);
    info.mockRestore();
    error.mockRestore();
  });

  it("signals once when a same-generation retry fills its missing interval", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signalBrief = vi.fn(async () => undefined);
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => {
      const outcomes = forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt
      });
      outcomes[0] = {
        ...outcomes[0]!,
        outcome: "skip",
        reasonCode: "forecast_generation_already_active",
        retryable: false
      };
      return {
        rowsWritten: 1,
        forecastRowsWritten: 1,
        factBundleRowsWritten: 0,
        errors: [],
        forecastOutcomes: outcomes
      };
    });
    const deps: IngestQueueDependencies = {
      runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot: materializeSpot as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => true)
    };
    const message = buildForecastMaterializationMessages(summary())[0]!;

    const analysisSignals = vi.fn(async () => undefined);
    await expect(
      processIngestQueueMessage(narrativeTestEnv(undefined, analysisSignals), message, signalBrief, deps)
    ).resolves.toBeUndefined();

    expect(error).not.toHaveBeenCalled();
    expect(signalBrief).not.toHaveBeenCalled();
    expect(analysisSignals).toHaveBeenCalledOnce();
    expect(analysisSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "analysis-signal",
        schemaVersion: 1,
        domain: "surf",
        spotId: message.spotId,
        ingestId: message.ingestId,
        generationId: expect.stringMatching(/^sha256:/),
        generatedAt: message.generatedAt
      }),
      { contentType: "json" }
    );
    const terminal = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ outcome }) => outcome !== undefined);
    expect(terminal.map(({ interval, outcome, reasonCode }) => ({
      interval,
      outcome,
      reasonCode
    }))).toEqual([
      {
        interval: "3h",
        outcome: "skip",
        reasonCode: "forecast_generation_already_active"
      },
      {
        interval: "1h",
        outcome: "publish",
        reasonCode: "forecast_generation_published"
      }
    ]);
    info.mockRestore();
    error.mockRestore();
  });

  it("preserves and acknowledges mixed per-interval D1 truth without signaling success", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const signalBrief = vi.fn();
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => {
      const outcomes = forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt
      });
      outcomes[1] = {
        ...outcomes[1]!,
        outcome: "supersede",
        reasonCode: "newer_generation_active",
        retryable: false
      };
      return {
        rowsWritten: 1,
        forecastRowsWritten: 1,
        factBundleRowsWritten: 0,
        errors: [],
        forecastOutcomes: outcomes,
        historyErrors: ["history follows only a complete synchronized publication"]
      };
    });
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
    ).resolves.toBeUndefined();

    expect(signalBrief).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    const terminal = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ outcome }) => outcome !== undefined);
    expect(terminal).toHaveLength(2);
    expect(terminal.map(({ interval, outcome, event, retryable }) => ({
      interval,
      outcome,
      event,
      retryable
    }))).toEqual([
      {
        interval: "3h",
        outcome: "publish",
        event: "forecast_materialization_published",
        retryable: false
      },
      {
        interval: "1h",
        outcome: "supersede",
        event: "forecast_materialization_superseded",
        retryable: false
      }
    ]);
    info.mockRestore();
    error.mockRestore();
    warning.mockRestore();
  });

  it("acknowledges a deterministic materialization skip without retrying or signaling", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signalBrief = vi.fn();
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => ({
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: ["no scored windows"],
      forecastOutcomes: forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt,
        outcome: "skip",
        reasonCode: "no_scored_windows",
        retryable: false
      })
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
    ).resolves.toBeUndefined();

    expect(signalBrief).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    const terminal = info.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .filter(({ outcome }) => outcome !== undefined);
    expect(terminal).toHaveLength(2);
    expect(terminal.every(({ event }) => event === "forecast_materialization_skipped")).toBe(
      true
    );
    expect(terminal.every(({ outcome }) => outcome === "skip")).toBe(true);
    expect(terminal.every(({ retryable }) => retryable === false)).toBe(true);
    expect(JSON.stringify(terminal)).not.toContain("no scored windows");
    info.mockRestore();
    error.mockRestore();
  });

  it("emits exactly two bounded failure outcomes without raw failure samples", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failures = ["x".repeat(700), "second", "third", "fourth", "fifth"];
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => ({
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: failures,
      forecastOutcomes: forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt,
        outcome: "failure"
      })
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
        vi.fn(),
        deps
      )
    ).rejects.toThrow("forecast materialization failed");

    expect(error).toHaveBeenCalledTimes(2);
    const terminal = error.mock.calls.map(([entry]) => JSON.parse(String(entry)));
    expect(terminal.map(({ interval }) => interval)).toEqual(["3h", "1h"]);
    expect(terminal.every(({ outcome }) => outcome === "failure")).toBe(true);
    expect(terminal.every(({ reasonCode }) => reasonCode === "forecast_persistence_failed")).toBe(
      true
    );
    expect(JSON.stringify(terminal)).not.toContain("x".repeat(20));
    expect(JSON.stringify(terminal)).not.toContain("second");
    info.mockRestore();
    error.mockRestore();
  });

  it("replaces a malformed duplicate outcome set with exactly one failure per interval", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const duplicate = forecastOutcomes()[0]!;
    const materializeSpot = vi.fn(async () => ({
      rowsWritten: 7,
      forecastRowsWritten: 2,
      factBundleRowsWritten: 5,
      errors: [],
      forecastOutcomes: [duplicate, duplicate]
    }));
    const deps: IngestQueueDependencies = {
      runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot: materializeSpot as unknown as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => true)
    };

    await expect(
      processIngestQueueMessage(
        testEnv(),
        buildForecastMaterializationMessages(summary())[0],
        vi.fn(),
        deps
      )
    ).rejects.toThrow("outcome contract failed");

    const terminal = error.mock.calls.map(([entry]) => JSON.parse(String(entry)));
    expect(terminal).toHaveLength(2);
    expect(terminal.map(({ interval }) => interval)).toEqual(["3h", "1h"]);
    expect(terminal.every(({ reasonCode }) => reasonCode === "invalid_forecast_outcome_contract"))
      .toBe(true);
    expect(
      info.mock.calls
        .map(([entry]) => JSON.parse(String(entry)))
        .filter(({ outcome }) => outcome !== undefined)
    ).toEqual([]);
    info.mockRestore();
    error.mockRestore();
  });

  it("records a thrown materialization failure before the queue retries it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signalBrief = vi.fn();
    const materializeSpot = vi.fn(async () => {
      throw new Error("D1 read timed out");
    });
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
    ).rejects.toThrow("D1 read timed out");

    expect(error).toHaveBeenCalledTimes(2);
    const terminal = error.mock.calls.map(([entry]) => JSON.parse(String(entry)));
    expect(terminal.map(({ interval }) => interval)).toEqual(["3h", "1h"]);
    expect(terminal.every(({ outcome }) => outcome === "failure")).toBe(true);
    expect(terminal.every(({ reasonCode }) => reasonCode === "materialization_threw")).toBe(
      true
    );
    expect(JSON.stringify(terminal)).not.toContain("D1 read timed out");
    expect(signalBrief).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });

  it("signals only the published spot and treats history errors as non-gating", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const signalBrief = vi.fn(async () => undefined);
    const materializeSpot = vi.fn(async (_env, spotId, now, options) => ({
      rowsWritten: 7,
      forecastRowsWritten: 2,
      factBundleRowsWritten: 5,
      errors: [],
      forecastOutcomes: forecastOutcomes({
        ingestId: options?.ingestId,
        spotId,
        generatedAt: now.toISOString(),
        materializedAt: options?.materializedAt
      }),
      historyErrors: ["snapshot write failed"]
    }));
    const deps: IngestQueueDependencies = {
      runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot: materializeSpot as IngestQueueDependencies["materializeSpot"],
      sourceGenerationIsCurrent: vi.fn(async () => true)
    };
    const message = buildForecastMaterializationMessages(summary())[0]!;

    const analysisSignals = vi.fn(async () => undefined);
    await processIngestQueueMessage(
      narrativeTestEnv(undefined, analysisSignals),
      message,
      signalBrief,
      deps
    );

    expect(materializeSpot).toHaveBeenCalledWith(
      expect.anything(),
      message.spotId,
      new Date(message.generatedAt),
      expect.objectContaining({
        captureHistory: true,
        ingestId: message.ingestId
      })
    );
    expect(signalBrief).not.toHaveBeenCalled();
    expect(analysisSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "analysis-signal",
        schemaVersion: 1,
        domain: "surf",
        spotId: message.spotId,
        ingestId: message.ingestId,
        generationId: `sha256:${"a".repeat(64)}:ingest:${message.ingestId}`,
        generatedAt: message.generatedAt,
        materializedAt: expect.any(String)
      }),
      { contentType: "json" }
    );
    const entries = info.mock.calls.map(([entry]) => JSON.parse(String(entry)));
    expect(entries[0]).toEqual({
      event: "forecast_materialization_started",
      message: "forecast materialization started",
      ingestId: message.ingestId,
      spotId: message.spotId,
      generatedAt: message.generatedAt,
      sourceCompletedAt: message.sourceCompletedAt
    });
    const terminal = entries.filter(({ outcome }) => outcome !== undefined);
    expect(terminal).toHaveLength(2);
    expect(terminal.map(({ interval }) => interval)).toEqual(["3h", "1h"]);
    expect(new Set(terminal.map(({ generationId }) => generationId)).size).toBe(1);
    expect(terminal).toEqual(
      terminal.map(() =>
        expect.objectContaining({
          event: "forecast_materialization_published",
          ingestId: message.ingestId,
          spotId: message.spotId,
          outcome: "publish",
          reasonCode: "forecast_generation_published"
        })
      )
    );
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0]![0]))).toEqual(
      expect.objectContaining({
        event: "forecast_history_capture_failed",
        ingestId: message.ingestId,
        spotId: message.spotId,
        reasonCode: "history_persistence_failed",
        failureCount: 1
      })
    );
    expect(String(warning.mock.calls[0]![0])).not.toContain("snapshot write failed");
    info.mockRestore();
    warning.mockRestore();
  });

  it("ACKs a published forecast when advisory Analysis dispatch fails and does not repeat it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let generationActive = false;
    const materializeSpot: IngestQueueDependencies["materializeSpot"] = vi.fn(
      async (_env, spotId, now, options) => {
        const duplicate = generationActive;
        generationActive = true;
        return {
          rowsWritten: duplicate ? 0 : 7,
          forecastRowsWritten: duplicate ? 0 : 2,
          factBundleRowsWritten: duplicate ? 0 : 5,
          errors: [],
          forecastOutcomes: forecastOutcomes({
            ingestId: options?.ingestId,
            spotId,
            generatedAt: now.toISOString(),
            materializedAt: options?.materializedAt,
            outcome: duplicate ? "skip" : "publish",
            reasonCode: duplicate
              ? "forecast_generation_already_active"
              : "forecast_generation_published",
            retryable: false
          })
        };
      }
    );
    const dependenciesWithPublication: IngestQueueDependencies = {
      runIngest: vi.fn() as unknown as IngestQueueDependencies["runIngest"],
      materializeSpot,
      sourceGenerationIsCurrent: vi.fn(async () => true)
    };
    const analysisSend = vi.fn(async () => {
      throw new Error("secret Queue transport detail");
    });
    const env = narrativeTestEnv(undefined, analysisSend);
    const message = buildForecastMaterializationMessages(summary())[0]!;

    await expect(
      processIngestQueueMessage(env, message, vi.fn(), dependenciesWithPublication)
    ).resolves.toBeUndefined();
    await expect(
      processIngestQueueMessage(env, message, vi.fn(), dependenciesWithPublication)
    ).resolves.toBeUndefined();

    expect(analysisSend).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    const failure = JSON.parse(String(error.mock.calls[0]![0]));
    expect(failure).toEqual(
      expect.objectContaining({
        event: "surf_analysis_signal_dispatch_failed",
        ingestId: message.ingestId,
        spotId: message.spotId,
        dispatchOutcome: "failed",
        reasonCode: "analysis_signal_dispatch_failed",
        errorName: "Error"
      })
    );
    expect(JSON.stringify(failure)).not.toContain("secret Queue transport detail");
    info.mockRestore();
    error.mockRestore();
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

  it("processes only the versioned Analysis signal envelope in its own invocation", async () => {
    const signal = vi.fn(async () => undefined);
    const context = {
      ingestId: "ingest-123",
      generationId: `sha256:${"a".repeat(64)}:ingest:ingest-123`,
      generatedAt: "2026-08-03T01:02:03.456Z",
      materializedAt: "2026-08-03T01:03:00.000Z"
    };
    const message = buildSurfAnalysisSignalMessage(
      NORCAL_SPOTS[0]!.id,
      context,
      "norcal"
    );

    await processIngestQueueMessage(testEnv(), message, signal);
    expect(signal).toHaveBeenCalledWith(
      expect.anything(),
      NORCAL_SPOTS[0]!.id,
      new Date(context.generatedAt),
      context
    );
    await expect(
      processIngestQueueMessage(
        testEnv(),
        { ...message, schemaVersion: 2 },
        signal
      )
    ).rejects.toThrow("Analysis signal queue message is invalid");
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
    const sentBatches: Array<Array<{ body: unknown }>> = [];
    const sendBatch = vi.fn(async (messages: Iterable<{ body: unknown }>) => {
      sentBatches.push([...messages]);
    });
    const runIngest = vi.fn() as unknown as IngestQueueDependencies["runIngest"];
    const deps = dependencies(runIngest);
    const legacy = {
      kind: "scheduled-ingest",
      requestedAt: "2026-08-03T01:02:03.456Z",
      region: "norcal"
    };

    await processIngestQueueMessage(testEnv(sendBatch), legacy, vi.fn(async () => undefined), deps);
    await processIngestQueueMessage(testEnv(sendBatch), legacy, vi.fn(async () => undefined), deps);

    expect(runIngest).not.toHaveBeenCalled();
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[1]).toEqual(sentBatches[0]);
    expect(
      sentBatches.flatMap((batch) =>
        batch.map(({ body }) => (body as SourceBatchQueueMessage).ingestId)
      )
    ).toEqual(Array(NORCAL_SOURCE_BATCHES.length * 2).fill("legacy-20260803010203456"));
  });
});
