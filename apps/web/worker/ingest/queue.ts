import { NORCAL_SPOTS } from "@surf/forecast-core";
import { materializeForecastReadModelForSpot } from "../forecast-read-model";
import type { Env } from "../index";
import { normalizeIngestMessage, runNorcalIngest } from "./coordinator";
import {
  ingestRequiresRetry,
  type ForecastMaterializationQueueMessage,
  type IngestSummary
} from "./types";

export type ForecastBriefSignal = (
  env: Env,
  spotId: ForecastMaterializationQueueMessage["spotId"],
  generatedAt: Date
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
    if (!(await dependencies.sourceGenerationIsCurrent(env.DB, body.generatedAt))) {
      console.info(
        JSON.stringify({
          message: "forecast materialization skipped superseded source generation",
          ingestId: body.ingestId,
          spotId: body.spotId,
          generatedAt: body.generatedAt,
          sourceCompletedAt: body.sourceCompletedAt
        })
      );
      return;
    }
    const result = await dependencies.materializeSpot(
      env,
      body.spotId,
      new Date(body.generatedAt),
      {
        materializedAt: new Date().toISOString(),
        captureHistory: body.captureHistory,
        ingestId: body.ingestId
      }
    );
    if (
      result.errors.length > 0 ||
      result.forecastRowsWritten !== 2 ||
      result.factBundleRowsWritten === 0
    ) {
      throw new Error(
        `forecast materialization failed for ${body.spotId}: ${result.errors.join("; ") || "incomplete publication"}`
      );
    }
    if ((result.historyErrors?.length ?? 0) > 0) {
      console.warn(
        JSON.stringify({
          message: "forecast history capture completed with failures",
          spotId: body.spotId,
          failures: result.historyErrors
        })
      );
    }
    await signalBrief(env, body.spotId, new Date(body.generatedAt));
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
