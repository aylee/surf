import { NORCAL_SPOTS } from "@surf/forecast-core";
import { materializeForecastReadModelForSpot } from "../forecast-read-model";
import type { Env } from "../index";
import { normalizeIngestMessage, runNorcalIngest } from "./coordinator";
import {
  ingestRequiresRetry,
  type ForecastMaterializationQueueMessage,
  type IngestSummary
} from "./types";

export type ForecastBriefSignalContext = {
  ingestId: string;
  generatedAt: string;
  materializedAt: string;
};

export type ForecastBriefSignal = (
  env: Env,
  spotId: ForecastMaterializationQueueMessage["spotId"],
  generatedAt: Date,
  context: ForecastBriefSignalContext
) => Promise<void>;

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

const FAILURE_EVIDENCE_LIMIT = 3;
const FAILURE_EVIDENCE_MAX_CHARS = 500;

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

function queueErrorEvidence(error: unknown): { errorName: string; error: string } {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      error: error.message.slice(0, 1000)
    };
  }
  return {
    errorName: typeof error,
    error: String(error).slice(0, 1000)
  };
}

function boundedFailureEvidence(failures: string[]): {
  failures: string[];
  omittedFailureCount: number;
} {
  const samples = failures
    .slice(0, FAILURE_EVIDENCE_LIMIT)
    .map((failure) => failure.slice(0, FAILURE_EVIDENCE_MAX_CHARS));
  return {
    failures: samples,
    omittedFailureCount: Math.max(0, failures.length - samples.length)
  };
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
      console.error(
        JSON.stringify({
          event: "forecast_materialization_failed",
          message: "forecast materialization lineage check failed",
          phase: "lineage_check",
          ingestId: body.ingestId,
          spotId: body.spotId,
          generatedAt: body.generatedAt,
          ...queueErrorEvidence(error)
        })
      );
      throw error;
    }
    if (!sourceIsCurrent) {
      console.info(
        JSON.stringify({
          event: "forecast_materialization_superseded",
          message: "forecast materialization skipped superseded source generation",
          ingestId: body.ingestId,
          spotId: body.spotId,
          generatedAt: body.generatedAt,
          sourceCompletedAt: body.sourceCompletedAt
        })
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
      console.error(
        JSON.stringify({
          event: "forecast_materialization_failed",
          message: "forecast materialization threw before publication",
          phase: "materialize",
          ingestId: body.ingestId,
          spotId: body.spotId,
          generatedAt: body.generatedAt,
          materializedAt,
          ...queueErrorEvidence(error)
        })
      );
      throw error;
    }
    if (
      result.errors.length > 0 ||
      result.forecastRowsWritten !== 2 ||
      result.factBundleRowsWritten === 0
    ) {
      const failureEvidence = boundedFailureEvidence(result.errors);
      const failureSummary = [
        ...failureEvidence.failures,
        ...(failureEvidence.omittedFailureCount > 0
          ? [`${failureEvidence.omittedFailureCount} additional failures omitted`]
          : [])
      ].join("; ");
      const error = new Error(
        `forecast materialization failed for ${body.spotId}: ${failureSummary || "incomplete publication"}`
      );
      console.error(
        JSON.stringify({
          event: "forecast_materialization_failed",
          message: "forecast materialization rejected before publication",
          phase: "materialize",
          ingestId: body.ingestId,
          spotId: body.spotId,
          generatedAt: body.generatedAt,
          materializedAt,
          rowsWritten: result.rowsWritten,
          forecastRowsWritten: result.forecastRowsWritten,
          factBundleRowsWritten: result.factBundleRowsWritten,
          ...(result.snapshotRowsWritten === undefined
            ? {}
            : { snapshotRowsWritten: result.snapshotRowsWritten }),
          failureCount: result.errors.length,
          ...failureEvidence,
          ...queueErrorEvidence(error)
        })
      );
      throw error;
    }
    console.info(
      JSON.stringify({
        event: "forecast_materialization_published",
        message: "forecast materialization published",
        ingestId: body.ingestId,
        spotId: body.spotId,
        generatedAt: body.generatedAt,
        materializedAt,
        rowsWritten: result.rowsWritten,
        forecastRowsWritten: result.forecastRowsWritten,
        factBundleRowsWritten: result.factBundleRowsWritten,
        ...(result.snapshotRowsWritten === undefined
          ? {}
          : { snapshotRowsWritten: result.snapshotRowsWritten })
      })
    );
    if ((result.historyErrors?.length ?? 0) > 0) {
      console.warn(
        JSON.stringify({
          message: "forecast history capture completed with failures",
          spotId: body.spotId,
          failures: result.historyErrors
        })
      );
    }
    await signalBrief(env, body.spotId, new Date(body.generatedAt), {
      ingestId: body.ingestId,
      generatedAt: body.generatedAt,
      materializedAt
    });
    return;
  }

  if (!(await dependencies.sourceGenerationIsCurrent(env.DB, body.forecastGeneratedAt))) {
    console.info(
      JSON.stringify({
        message: "source ingest skipped superseded logical generation",
        ingestId: body.ingestId,
        generatedAt: body.forecastGeneratedAt
      })
    );
    return;
  }

  const summary = await dependencies.runIngest(env, {
    kind: body.kind === "manual-ingest" ? "manual-ingest" : "queued-ingest",
    requestedAt: body.requestedAt,
    region: body.region,
    now: new Date(body.forecastGeneratedAt),
    ingestId: body.ingestId,
    idSuffix: body.ingestId,
    deferForecastMaterialization: true
  });
  if (!summary.publication.sourcePersistenceReady) {
    throw new Error(
      `source ingest persistence is incomplete: ${summary.publication.sourcePersistenceErrors.join("; ")}`
    );
  }
  // Dispatch usable per-spot work before retrying a degraded source ingest.
  // Each materialization independently validates whether the normalized rows
  // are sufficient, so one provider error cannot freeze every spot.
  await env.INGEST_QUEUE.sendBatch(
    buildForecastMaterializationMessages(summary).map((materialization) => ({
      body: materialization
    }))
  );
  if (ingestRequiresRetry(summary)) {
    throw new Error(`ingest completed with ${summary.status}: ${summary.errors.join("; ")}`);
  }
  if (summary.status === "partial") {
    console.warn(
      JSON.stringify({
        message: "ingest queue message completed with source caveats",
        caveatCount: summary.caveats.length,
        partialSources: summary.sourceRuns
          .filter((run) => run.status === "partial")
          .map((run) => run.sourceId)
      })
    );
  }
}
