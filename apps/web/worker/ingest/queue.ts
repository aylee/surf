import { NORCAL_SPOTS } from "@surf/forecast-core";
import {
  materializeForecastReadModelForSpot,
  type ForecastMaterializationOutcome,
  type ForecastMaterializationReasonCode
} from "../forecast-read-model";
import type { Env } from "../index";
import { boundedErrorName } from "../logging";
import { normalizeIngestMessage, runNorcalIngest } from "./coordinator";
import {
  ingestRequiresRetry,
  type ForecastMaterializationQueueMessage,
  type IngestSummary
} from "./types";

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
  | "source_persistence_incomplete"
  | "materialization_enqueue_failed"
  | "source_ingest_requires_retry"
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
  const descriptor = sourceEventByOutcome[outcome.outcome];
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
        ((outcome.outcome === "publish" || outcome.outcome === "supersede") &&
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
    !outcomes.every(({ outcome }) => outcome === "publish" || outcome === "supersede")
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
        if (
          spotOutcomes.length !== FORECAST_INTERVALS.length ||
          !spotOutcomes.every(({ outcome }) => outcome === "publish")
        ) {
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
  summary: Pick<IngestSummary, "requestedAt" | "region" | "publication">
): ForecastMaterializationQueueMessage[] {
  return NORCAL_SPOTS.map((spot) => ({
    job: "forecast-materialization",
    ingestId: summary.publication.ingestId,
    spotId: spot.id,
    requestedAt: summary.requestedAt,
    region: summary.region,
    generatedAt: summary.publication.generatedAt,
    sourceCompletedAt: summary.publication.sourceCompletedAt,
    captureHistory: summary.publication.captureHistory
  }));
}

export async function processIngestQueueMessage(
  env: Env,
  rawBody: unknown,
  signalBrief: ForecastBriefSignal,
  dependencies: IngestQueueDependencies = defaultDependencies
): Promise<void> {
  const body = normalizeIngestMessage(rawBody, env.SURF_REGION);
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
    const allPublished = result.forecastOutcomes.every(({ outcome }) => outcome === "publish");
    if (allPublished) {
      const publicationComplete =
        result.errors.length === 0 &&
        result.forecastRowsWritten === FORECAST_INTERVALS.length &&
        result.factBundleRowsWritten > 0;
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
    await signalBrief(env, body.spotId, new Date(body.generatedAt), {
      ingestId: body.ingestId,
      generationId: result.forecastOutcomes[0]!.generationId!,
      generatedAt: body.generatedAt,
      materializedAt
    });
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

  let summary: IngestSummary;
  try {
    summary = await dependencies.runIngest(env, {
      kind: body.kind === "manual-ingest" ? "manual-ingest" : "queued-ingest",
      requestedAt: body.requestedAt,
      region: body.region,
      now: new Date(body.forecastGeneratedAt),
      ingestId: body.ingestId,
      idSuffix: body.ingestId,
      deferForecastMaterialization: true
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
    errorCount: summary.errors.length
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
  // Dispatch usable per-spot work before retrying a degraded source ingest.
  // Each materialization independently validates whether the normalized rows
  // are sufficient, so one provider error cannot freeze every spot.
  const materializationMessages = buildForecastMaterializationMessages(summary);
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
      outcome: "failure",
      reasonCode: "source_ingest_requires_retry",
      materializationJobCount: materializationMessages.length
    });
    throw new Error(`source ingest requires retry: ${summary.status}`);
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
