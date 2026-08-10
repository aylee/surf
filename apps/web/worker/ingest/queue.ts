import { NORCAL_SPOTS } from "@surf/forecast-core";
import {
  materializeForecastReadModelForSpot,
  type ForecastMaterializationOutcome,
  type ForecastMaterializationReasonCode
} from "../forecast-read-model";
import type { Env } from "../index";
import { boundedErrorName } from "../logging";
import { narrativeEnabled } from "../narrative/config";
import { normalizeIngestMessage, runNorcalIngest } from "./coordinator";
import {
  ingestRequiresRetry,
  type ForecastMaterializationQueueMessage,
  type IngestSummary,
  type SourceBatchQueueMessage,
  type SourceIngestQueueMessage,
  SURF_ANALYSIS_SIGNAL_SCHEMA_VERSION,
  type SurfAnalysisSignalQueueMessage
} from "./types";
import {
  NORCAL_SOURCE_BATCHES,
  SOURCE_BATCH_SCHEMA_VERSION,
  sourceBatchRunSuffix
} from "./source-batches";

export type ForecastBriefSignalContext = {
  ingestId: string;
  generationId: string;
  generatedAt: string;
  materializedAt: string;
};

export type ForecastBriefSignal = (
  env: Env,
  spotId: ForecastMaterializationQueueMessage["spotId"],
  generatedAt: Date,
  context: ForecastBriefSignalContext
) => Promise<void>;

export type ForecastBriefSignalRequest = {
  spotId: ForecastMaterializationQueueMessage["spotId"];
  context: ForecastBriefSignalContext;
};

function forecastGenerationIsActiveForSignal(
  outcomes: readonly ForecastMaterializationOutcome[]
): boolean {
  const generationIds = new Set(
    outcomes.flatMap(({ generationId }) => (generationId ? [generationId] : []))
  );
  return (
    outcomes.length === FORECAST_INTERVALS.length &&
    outcomes.every(
      ({ outcome, reasonCode }) =>
        outcome === "publish" ||
        (outcome === "skip" && reasonCode === "forecast_generation_already_active")
    ) &&
    generationIds.size === 1
  );
}

export function buildSurfAnalysisSignalMessage(
  spotId: ForecastMaterializationQueueMessage["spotId"],
  context: ForecastBriefSignalContext,
  region: string
): SurfAnalysisSignalQueueMessage {
  return {
    job: "analysis-signal",
    schemaVersion: SURF_ANALYSIS_SIGNAL_SCHEMA_VERSION,
    domain: "surf",
    ingestId: context.ingestId,
    spotId,
    generationId: context.generationId,
    generatedAt: context.generatedAt,
    materializedAt: context.materializedAt,
    region
  };
}

export async function dispatchSurfAnalysisSignal(
  env: Env,
  spotId: ForecastMaterializationQueueMessage["spotId"],
  _generatedAt: Date,
  context: ForecastBriefSignalContext
): Promise<void> {
  if (!narrativeEnabled(env)) return;
  try {
    await env.INGEST_QUEUE.send(
      buildSurfAnalysisSignalMessage(spotId, context, env.SURF_REGION),
      { contentType: "json" }
    );
    console.info(
      JSON.stringify({
        event: "surf_analysis_signal_dispatched",
        message: "Analysis signal dispatched after forecast publication",
        phase: "analysis_signal_dispatch",
        ingestId: context.ingestId,
        spotId,
        generationId: context.generationId,
        schemaVersion: SURF_ANALYSIS_SIGNAL_SCHEMA_VERSION,
        dispatchOutcome: "enqueued",
        reasonCode: "analysis_signal_queued"
      })
    );
  } catch (error) {
    // Analysis is advisory to deterministic forecast publication. Retrying the
    // materialization after it has committed would only duplicate this signal;
    // the next hourly generation is the bounded recovery path.
    console.error(
      JSON.stringify({
        event: "surf_analysis_signal_dispatch_failed",
        message: "Analysis signal dispatch failed after forecast publication",
        phase: "analysis_signal_dispatch",
        ingestId: context.ingestId,
        spotId,
        generationId: context.generationId,
        schemaVersion: SURF_ANALYSIS_SIGNAL_SCHEMA_VERSION,
        dispatchOutcome: "failed",
        reasonCode: "analysis_signal_dispatch_failed",
        errorName: boundedPipelineErrorName(error)
      })
    );
  }
}

export type IngestQueueDependencies = {
  runIngest: typeof runNorcalIngest;
  materializeSpot: typeof materializeForecastReadModelForSpot;
  sourceGenerationIsCurrent: typeof sourceGenerationIsCurrent;
};

const defaultDependencies: IngestQueueDependencies = {
  runIngest: runNorcalIngest,
  materializeSpot: materializeForecastReadModelForSpot,
  sourceGenerationIsCurrent
};

const FORECAST_INTERVALS = ["3h", "1h"] as const;
const FORECAST_OUTCOME_CLASSES = ["publish", "skip", "supersede", "failure"] as const;

export type SourceIngestReasonCode =
  | "lineage_check_failed"
  | "newer_source_generation_active"
  | "source_ingest_threw"
  | "source_batch_enqueue_failed"
  | "source_batches_dispatched"
  | "source_persistence_incomplete"
  | "materialization_enqueue_failed"
  | "materialization_jobs_published_from_degraded_source"
  | "materialization_jobs_published_with_caveats"
  | "materialization_jobs_published"
  | "inline_ingest_requires_retry"
  | "inline_source_persistence_completed_with_caveats"
  | "inline_source_persistence_completed"
  | "invalid_forecast_outcome_contract";

export type SourceIngestTerminalOutcome = {
  ingestId: string;
  generatedAt: string;
  outcome: "publish" | "supersede" | "failure";
  reasonCode: SourceIngestReasonCode;
  sourceStatus?: IngestSummary["status"];
  sourceCount?: number;
  partialSourceCount?: number;
  caveatCount?: number;
  errorCount?: number;
  materializationJobCount?: number;
  sourceBatchJobCount?: number;
  batchKey?: string;
  spotCount?: number;
  errorName?: string;
};

const forecastEventByOutcome: Record<
  ForecastMaterializationOutcome["outcome"],
  { event: string; message: string }
> = {
  publish: {
    event: "forecast_materialization_published",
    message: "forecast materialization published"
  },
  skip: {
    event: "forecast_materialization_skipped",
    message: "forecast materialization skipped"
  },
  supersede: {
    event: "forecast_materialization_superseded",
    message: "forecast materialization superseded"
  },
  failure: {
    event: "forecast_materialization_failed",
    message: "forecast materialization failed"
  }
};

const sourceEventByOutcome: Record<
  SourceIngestTerminalOutcome["outcome"],
  { event: string; message: string }
> = {
  publish: { event: "source_ingest_published", message: "source ingest published" },
  supersede: {
    event: "source_ingest_superseded",
    message: "source ingest superseded"
  },
  failure: { event: "source_ingest_failed", message: "source ingest failed" }
};

export function boundedPipelineErrorName(error: unknown): string {
  return boundedErrorName(error);
}

export function logSourceIngestTerminalOutcome(outcome: SourceIngestTerminalOutcome): void {
  const descriptor = outcome.reasonCode === "source_batches_dispatched"
    ? { event: "source_ingest_dispatched", message: "source ingest batches dispatched" }
    : sourceEventByOutcome[outcome.outcome];
  const entry = JSON.stringify({
    ...descriptor,
    ...outcome
  });
  if (outcome.outcome === "failure") console.error(entry);
  else console.info(entry);
}

export function logForecastMaterializationOutcomes(
  outcomes: readonly ForecastMaterializationOutcome[]
): void {
  // Callers validate a complete unique interval set before this boundary so
  // a terminal stage cannot emit a duplicate or silently omit an interval.
  for (const outcome of outcomes) {
    const descriptor = forecastEventByOutcome[outcome.outcome];
    const entry = JSON.stringify({
      ...descriptor,
      ...outcome
    });
    if (outcome.outcome === "failure") console.error(entry);
    else console.info(entry);
  }
}

function terminalForecastOutcomes(
  body: ForecastMaterializationQueueMessage,
  outcome: ForecastMaterializationOutcome["outcome"],
  reasonCode: ForecastMaterializationReasonCode,
  materializedAt: string | null = null,
  retryable = outcome === "failure"
): ForecastMaterializationOutcome[] {
  return FORECAST_INTERVALS.map((interval) => ({
    ingestId: body.ingestId,
    spotId: body.spotId,
    interval,
    generationId: null,
    generatedAt: body.generatedAt,
    materializedAt,
    outcome,
    reasonCode,
    retryable
  }));
}

function validForecastOutcomeSet(
  outcomes: readonly ForecastMaterializationOutcome[] | undefined,
  expected: {
    ingestId: string;
    spotId: ForecastMaterializationQueueMessage["spotId"];
    generatedAt: string;
    materializedAt: string;
  },
  forecastRowsWritten?: number
): boolean {
  if (!Array.isArray(outcomes)) return false;
  if (outcomes.length !== FORECAST_INTERVALS.length) return false;
  const intervals = new Set(outcomes.map(({ interval }) => interval));
  if (!FORECAST_INTERVALS.every((interval) => intervals.has(interval))) return false;
  if (
    outcomes.some(
      (outcome) =>
        outcome.ingestId !== expected.ingestId ||
        outcome.spotId !== expected.spotId ||
        outcome.generatedAt !== expected.generatedAt ||
        outcome.materializedAt !== expected.materializedAt ||
        !FORECAST_OUTCOME_CLASSES.includes(outcome.outcome) ||
        (outcome.generationId !== null && typeof outcome.generationId !== "string") ||
        typeof outcome.retryable !== "boolean" ||
        !outcome.reasonCode ||
        ((outcome.outcome === "publish" ||
          outcome.outcome === "supersede" ||
          (outcome.outcome === "skip" &&
            outcome.reasonCode === "forecast_generation_already_active")) &&
          (!outcome.generationId || outcome.retryable)) ||
        (outcome.outcome === "supersede" && outcome.retryable) ||
        (outcome.outcome === "failure" && !outcome.retryable)
    )
  ) {
    return false;
  }
  const outcomeClasses = new Set(outcomes.map(({ outcome }) => outcome));
  if (
    outcomeClasses.size > 1 &&
    !outcomes.every(
      ({ outcome, reasonCode }) =>
        outcome === "publish" ||
        outcome === "supersede" ||
        (outcome === "skip" && reasonCode === "forecast_generation_already_active")
    )
  ) {
    return false;
  }
  if (new Set(outcomes.map(({ retryable }) => retryable)).size !== 1) return false;
  const generationIds = new Set(
    outcomes.flatMap(({ generationId }) => (generationId ? [generationId] : []))
  );
  if (generationIds.size > 1) return false;
  if (forecastRowsWritten === undefined) return true;
  const published = outcomes.filter(({ outcome }) => outcome === "publish");
  return (
    published.length === forecastRowsWritten &&
    (published.length === 0 || new Set(published.map(({ generationId }) => generationId)).size === 1)
  );
}

function normalizeInlineForecastOutcomes(summary: IngestSummary): {
  outcomes: ForecastMaterializationOutcome[];
  publishedSignals: ForecastBriefSignalRequest[];
  valid: boolean;
} {
  const rawOutcomes = summary.publication.forecastOutcomes;
  const normalized: ForecastMaterializationOutcome[] = [];
  let valid =
    Array.isArray(rawOutcomes) &&
    rawOutcomes.length === NORCAL_SPOTS.length * FORECAST_INTERVALS.length;
  for (const spot of NORCAL_SPOTS) {
    const spotOutcomes = Array.isArray(rawOutcomes)
      ? rawOutcomes.filter(({ spotId }) => spotId === spot.id)
      : [];
    if (
      validForecastOutcomeSet(spotOutcomes, {
        ingestId: summary.publication.ingestId,
        spotId: spot.id,
        generatedAt: summary.publication.generatedAt,
        materializedAt: summary.publication.sourceCompletedAt
      })
    ) {
      normalized.push(...spotOutcomes);
      continue;
    }
    valid = false;
    normalized.push(
      ...FORECAST_INTERVALS.map((interval): ForecastMaterializationOutcome => ({
        ingestId: summary.publication.ingestId,
        spotId: spot.id,
        interval,
        generationId: null,
        generatedAt: summary.publication.generatedAt,
        materializedAt: summary.publication.sourceCompletedAt,
        outcome: "failure",
        reasonCode: "invalid_forecast_outcome_contract",
        retryable: true
      }))
    );
  }
  if (
    normalized.filter(({ outcome }) => outcome === "publish").length !==
    summary.counts.forecastReadModelRows
  ) {
    valid = false;
  }
  const publishedSignals = valid
    ? NORCAL_SPOTS.flatMap((spot): ForecastBriefSignalRequest[] => {
        const spotOutcomes = normalized.filter(({ spotId }) => spotId === spot.id);
        if (!forecastGenerationIsActiveForSignal(spotOutcomes)) {
          return [];
        }
        const generationId = spotOutcomes[0]!.generationId;
        if (!generationId) return [];
        return [
          {
            spotId: spot.id,
            context: {
              ingestId: summary.publication.ingestId,
              generationId,
              generatedAt: summary.publication.generatedAt,
              materializedAt: summary.publication.sourceCompletedAt
            }
          }
        ];
      })
    : [];
  return { outcomes: normalized, publishedSignals, valid };
}

export function logInlineIngestTerminalOutcomes(
  summary: IngestSummary
): ForecastBriefSignalRequest[] {
  const normalized = normalizeInlineForecastOutcomes(summary);
  const failed =
    !summary.publication.sourcePersistenceReady ||
    ingestRequiresRetry(summary) ||
    !normalized.valid;
  logSourceIngestTerminalOutcome({
    ingestId: summary.publication.ingestId,
    generatedAt: summary.publication.generatedAt,
    outcome: failed ? "failure" : "publish",
    reasonCode: !summary.publication.sourcePersistenceReady
      ? "source_persistence_incomplete"
      : !normalized.valid
        ? "invalid_forecast_outcome_contract"
        : ingestRequiresRetry(summary)
          ? "inline_ingest_requires_retry"
          : summary.status === "partial"
            ? "inline_source_persistence_completed_with_caveats"
            : "inline_source_persistence_completed",
    sourceStatus: summary.status,
    sourceCount: summary.sourceRuns.length,
    partialSourceCount: summary.sourceRuns.filter(({ status }) => status === "partial").length,
    caveatCount: summary.caveats.length,
    errorCount: summary.errors.length,
    materializationJobCount: 0
  });
  logForecastMaterializationOutcomes(normalized.outcomes);
  return failed ? [] : normalized.publishedSignals;
}

export async function signalInlineForecastBriefs(
  env: Env,
  requests: readonly ForecastBriefSignalRequest[],
  signalBrief: ForecastBriefSignal
): Promise<void> {
  await Promise.all(
    requests.map(({ spotId, context }) =>
      signalBrief(env, spotId, new Date(context.generatedAt), context)
    )
  );
}

export async function sourceGenerationIsCurrent(
  db: D1Database,
  generatedAt: string
): Promise<boolean> {
  // source_runs.started_at stores the latest logical generation timestamp for
  // each lineage, not a retry's wall-clock completion time. Exact retries keep
  // it stable; a deliberately reused lineage may advance it but never regress.
  const row = await db
    .prepare(
      `select started_at as latest_generation_at
       from source_runs
       where run_kind = 'ingest'
       order by started_at desc
       limit 1`
    )
    .first<{ latest_generation_at: string | null }>();
  if (!row?.latest_generation_at) return true;
  return Date.parse(row.latest_generation_at) <= Date.parse(generatedAt);
}

export function buildForecastMaterializationMessages(
  summary: Pick<IngestSummary, "requestedAt" | "region" | "publication">,
  spotIds: readonly ForecastMaterializationQueueMessage["spotId"][] = NORCAL_SPOTS.map(
    ({ id }) => id
  )
): ForecastMaterializationQueueMessage[] {
  return spotIds.map((spotId) => ({
    job: "forecast-materialization",
    ingestId: summary.publication.ingestId,
    spotId,
    requestedAt: summary.requestedAt,
    region: summary.region,
    generatedAt: summary.publication.generatedAt,
    sourceCompletedAt: summary.publication.sourceCompletedAt,
    captureHistory: summary.publication.captureHistory
  }));
}

export function buildSourceBatchMessages(
  source: SourceIngestQueueMessage
): SourceBatchQueueMessage[] {
  return NORCAL_SOURCE_BATCHES.map(({ batchKey, spotIds }) => ({
    job: "source-batch",
    schemaVersion: SOURCE_BATCH_SCHEMA_VERSION,
    kind: source.kind,
    ingestId: source.ingestId,
    batchKey,
    spotIds: [...spotIds],
    requestedAt: source.requestedAt,
    forecastGeneratedAt: source.forecastGeneratedAt,
    region: source.region
  }));
}

export async function processIngestQueueMessage(
  env: Env,
  rawBody: unknown,
  signalBrief: ForecastBriefSignal,
  dependencies: IngestQueueDependencies = defaultDependencies
): Promise<void> {
  const body = normalizeIngestMessage(rawBody, env.SURF_REGION);
  if (body.job === "analysis-signal") {
    await signalBrief(env, body.spotId, new Date(body.generatedAt), {
      ingestId: body.ingestId,
      generationId: body.generationId,
      generatedAt: body.generatedAt,
      materializedAt: body.materializedAt
    });
    return;
  }
  if (body.job === "forecast-materialization") {
    console.info(
      JSON.stringify({
        event: "forecast_materialization_started",
        message: "forecast materialization started",
        ingestId: body.ingestId,
        spotId: body.spotId,
        generatedAt: body.generatedAt,
        sourceCompletedAt: body.sourceCompletedAt
      })
    );
    let sourceIsCurrent: boolean;
    try {
      sourceIsCurrent = await dependencies.sourceGenerationIsCurrent(env.DB, body.generatedAt);
    } catch (error) {
      logForecastMaterializationOutcomes(
        terminalForecastOutcomes(body, "failure", "lineage_check_failed")
      );
      throw error;
    }
    if (!sourceIsCurrent) {
      logForecastMaterializationOutcomes(
        terminalForecastOutcomes(body, "supersede", "newer_source_generation_active")
      );
      return;
    }
    const materializedAt = new Date().toISOString();
    let result: Awaited<ReturnType<typeof materializeForecastReadModelForSpot>>;
    try {
      result = await dependencies.materializeSpot(
        env,
        body.spotId,
        new Date(body.generatedAt),
        {
          materializedAt,
          captureHistory: body.captureHistory,
          ingestId: body.ingestId
        }
      );
    } catch (error) {
      logForecastMaterializationOutcomes(
        terminalForecastOutcomes(body, "failure", "materialization_threw", materializedAt)
      );
      throw error;
    }
    const validOutcomes = validForecastOutcomeSet(
      result.forecastOutcomes,
      { ...body, materializedAt },
      result.forecastRowsWritten
    );
    if (!validOutcomes) {
      logForecastMaterializationOutcomes(
        terminalForecastOutcomes(
          body,
          "failure",
          "invalid_forecast_outcome_contract",
          materializedAt
        )
      );
      throw new Error(`forecast materialization outcome contract failed for ${body.spotId}`);
    }
    const generationIsActive = forecastGenerationIsActiveForSignal(result.forecastOutcomes);
    if (generationIsActive) {
      const duplicateRows = result.forecastOutcomes.filter(
        ({ outcome, reasonCode }) =>
          outcome === "skip" && reasonCode === "forecast_generation_already_active"
      ).length;
      const publicationComplete =
        result.errors.length === 0 &&
        result.forecastRowsWritten === FORECAST_INTERVALS.length - duplicateRows &&
        (result.factBundleRowsWritten > 0 || duplicateRows > 0);
      if (!publicationComplete) {
        logForecastMaterializationOutcomes(
          terminalForecastOutcomes(
            body,
            "failure",
            "incomplete_publication",
            materializedAt
          )
        );
        throw new Error(`forecast materialization failed for ${body.spotId}: incomplete_publication`);
      }
      logForecastMaterializationOutcomes(result.forecastOutcomes);
    } else {
      logForecastMaterializationOutcomes(result.forecastOutcomes);
      if (!result.forecastOutcomes.some(({ retryable }) => retryable)) return;
      const reasonCodes = [
        ...new Set(result.forecastOutcomes.map(({ reasonCode }) => reasonCode))
      ].slice(0, FORECAST_INTERVALS.length);
      throw new Error(
        `forecast materialization failed for ${body.spotId}: ${reasonCodes.join(",") || "incomplete_publication"}`
      );
    }
    if ((result.historyErrors?.length ?? 0) > 0) {
      const generationIds = [
        ...new Set(
          result.forecastOutcomes.flatMap(({ generationId }) =>
            generationId ? [generationId] : []
          )
        )
      ];
      console.warn(
        JSON.stringify({
          event: "forecast_history_capture_failed",
          message: "forecast history capture completed with failures",
          ingestId: body.ingestId,
          spotId: body.spotId,
          generationId: generationIds.length === 1 ? generationIds[0] : null,
          reasonCode: "history_persistence_failed",
          failureCount: result.historyErrors?.length ?? 0
        })
      );
    }
    if (result.forecastOutcomes.some(({ outcome }) => outcome === "publish")) {
      await dispatchSurfAnalysisSignal(env, body.spotId, new Date(body.generatedAt), {
        ingestId: body.ingestId,
        generationId: result.forecastOutcomes[0]!.generationId!,
        generatedAt: body.generatedAt,
        materializedAt
      });
    }
    return;
  }

  let sourceIsCurrent: boolean;
  try {
    sourceIsCurrent = await dependencies.sourceGenerationIsCurrent(
      env.DB,
      body.forecastGeneratedAt
    );
  } catch (error) {
    logSourceIngestTerminalOutcome({
      ingestId: body.ingestId,
      generatedAt: body.forecastGeneratedAt,
      outcome: "failure",
      reasonCode: "lineage_check_failed",
      errorName: boundedPipelineErrorName(error)
    });
    throw error;
  }
  if (!sourceIsCurrent) {
    logSourceIngestTerminalOutcome({
      ingestId: body.ingestId,
      generatedAt: body.forecastGeneratedAt,
      outcome: "supersede",
      reasonCode: "newer_source_generation_active"
    });
    return;
  }

  if (body.job === "source-ingest") {
    const sourceBatches = buildSourceBatchMessages(body);
    try {
      await env.INGEST_QUEUE.sendBatch(
        sourceBatches.map((sourceBatch) => ({ body: sourceBatch }))
      );
    } catch (error) {
      logSourceIngestTerminalOutcome({
        ingestId: body.ingestId,
        generatedAt: body.forecastGeneratedAt,
        outcome: "failure",
        reasonCode: "source_batch_enqueue_failed",
        sourceBatchJobCount: 0,
        errorName: boundedPipelineErrorName(error)
      });
      throw error;
    }
    logSourceIngestTerminalOutcome({
      ingestId: body.ingestId,
      generatedAt: body.forecastGeneratedAt,
      outcome: "publish",
      reasonCode: "source_batches_dispatched",
      sourceBatchJobCount: sourceBatches.length
    });
    return;
  }

  let summary: IngestSummary;
  try {
    summary = await dependencies.runIngest(env, {
      kind: body.kind === "manual-ingest" ? "manual-ingest" : "queued-ingest",
      requestedAt: body.requestedAt,
      region: body.region,
      now: new Date(body.forecastGeneratedAt),
      ingestId: body.ingestId,
      idSuffix: sourceBatchRunSuffix(body.ingestId, body.batchKey),
      deferForecastMaterialization: true,
      spotIds: body.spotIds
    });
  } catch (error) {
    logSourceIngestTerminalOutcome({
      ingestId: body.ingestId,
      generatedAt: body.forecastGeneratedAt,
      outcome: "failure",
      reasonCode: "source_ingest_threw",
      errorName: boundedPipelineErrorName(error)
    });
    throw error;
  }
  const sourceContext = {
    ingestId: body.ingestId,
    generatedAt: body.forecastGeneratedAt,
    sourceStatus: summary.status,
    sourceCount: summary.sourceRuns.length,
    partialSourceCount: summary.sourceRuns.filter(({ status }) => status === "partial").length,
    caveatCount: summary.caveats.length,
    errorCount: summary.errors.length,
    batchKey: body.batchKey,
    spotCount: body.spotIds.length
  };
  if (!summary.publication.sourcePersistenceReady) {
    logSourceIngestTerminalOutcome({
      ...sourceContext,
      outcome: "failure",
      reasonCode: "source_persistence_incomplete",
      materializationJobCount: 0
    });
    throw new Error("source ingest persistence is incomplete");
  }
  // Dispatch usable per-spot work before recording a degraded source ingest.
  // Each materialization independently validates whether the normalized rows
  // are sufficient, so one provider error cannot freeze every spot. Once the
  // complete child set is accepted, this message must ACK: retrying it would
  // amplify identical child messages. The next hourly root retries providers.
  const materializationMessages = buildForecastMaterializationMessages(summary, body.spotIds);
  try {
    await env.INGEST_QUEUE.sendBatch(
      materializationMessages.map((materialization) => ({ body: materialization }))
    );
  } catch (error) {
    logSourceIngestTerminalOutcome({
      ...sourceContext,
      outcome: "failure",
      reasonCode: "materialization_enqueue_failed",
      materializationJobCount: 0,
      errorName: boundedPipelineErrorName(error)
    });
    throw error;
  }
  if (ingestRequiresRetry(summary)) {
    logSourceIngestTerminalOutcome({
      ...sourceContext,
      outcome: "publish",
      reasonCode: "materialization_jobs_published_from_degraded_source",
      materializationJobCount: materializationMessages.length
    });
    return;
  }
  logSourceIngestTerminalOutcome({
    ...sourceContext,
    outcome: "publish",
    reasonCode:
      summary.status === "partial"
        ? "materialization_jobs_published_with_caveats"
        : "materialization_jobs_published",
    materializationJobCount: materializationMessages.length
  });
}
