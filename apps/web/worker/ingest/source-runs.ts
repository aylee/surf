import { CDIP_MOP_SOURCE_ID } from "../adapters/cdip-mop";
import type { AdapterOutcome } from "../adapters/types";
import { combineStatus, errorMessage } from "../adapters/types";
import type {
  ArtifactPersistenceResult,
  PersistenceResult,
  SourceRunRecord
} from "./types";

export const SOURCE_RUNS_CONTRACT =
  "D1 binding DB must expose source_runs with run_key/run_kind plus normalized wave_forecasts, wave_observations, tide_forecasts, wind_forecasts, wind_forecast_issues, hazard_events, forecast_configs, forecast_issues, and forecast_snapshots tables.";

export function defaultRunIdSuffix(): string {
  return crypto.randomUUID();
}

function sourceRunId(sourceId: string, suffix: string): string {
  const prefix = sourceId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${prefix}-${suffix}`;
}

function outcomeRowCount(outcome: AdapterOutcome<unknown, unknown>): number {
  if (outcome.sourceId === "nws:point-forecast-alerts") {
    const metadata = outcome.metadata as { windRowCount?: unknown };
    const windRowCount = metadata.windRowCount;
    return typeof windRowCount === "number" ? windRowCount : outcome.rows.length;
  }
  return outcome.rows.length;
}

function outcomeCycleAt(outcome: AdapterOutcome<unknown, unknown>): string | null {
  if (outcome.sourceId !== CDIP_MOP_SOURCE_ID) return null;
  const metadata = outcome.metadata as { modelCycleAtBySpot?: unknown };
  if (!metadata.modelCycleAtBySpot || typeof metadata.modelCycleAtBySpot !== "object") return null;
  const cycles = [
    ...new Set(
      Object.values(metadata.modelCycleAtBySpot as Record<string, unknown>).flatMap((value) =>
        typeof value === "string" && Number.isFinite(new Date(value).getTime())
          ? [new Date(value).toISOString()]
          : []
      )
    )
  ];
  return cycles.length === 1 ? cycles[0]! : null;
}

export async function recordSourceRun<Row>(
  db: D1Database,
  outcome: AdapterOutcome<Row>,
  options: {
    startedAt: string;
    completedAt: string;
    idSuffix: string;
  }
): Promise<SourceRunRecord> {
  const id = sourceRunId(outcome.sourceId, options.idSuffix);
  const runKey = `${outcome.sourceId}:${options.idSuffix}`;
  const rowCount = outcomeRowCount(outcome as AdapterOutcome<unknown>);
  const cycleAt = outcomeCycleAt(outcome as AdapterOutcome<unknown>);
  const error = outcome.errors.length > 0 ? outcome.errors.join("\n").slice(0, 2000) : null;
  const metadataJson = JSON.stringify({
    provider: outcome.provider,
    capabilities: outcome.capabilities,
    adapterStatus: outcome.status,
    rowCount,
    caveats: outcome.caveats,
    metadata: outcome.metadata,
    dbContract: SOURCE_RUNS_CONTRACT
  });

  if (typeof db.prepare !== "function") {
    return {
      id,
      sourceId: outcome.sourceId,
      status: outcome.status,
      recorded: false,
      rowCount,
      caveatCount: outcome.caveats.length,
      errorCount: outcome.errors.length,
      error: "DB binding does not expose prepare()."
    };
  }

  try {
    await db
      .prepare(
        `insert into source_runs (
          id,
          run_key,
          source_id,
          run_kind,
          cycle_at,
          forecast_hour,
          valid_start_at,
          valid_end_at,
          started_at,
          completed_at,
          status,
          raw_r2_key,
          metadata_json,
          error
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          run_key = excluded.run_key,
          run_kind = excluded.run_kind,
          cycle_at = excluded.cycle_at,
          valid_start_at = excluded.valid_start_at,
          valid_end_at = excluded.valid_end_at,
          completed_at = excluded.completed_at,
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          error = excluded.error`
      )
      .bind(
        id,
        runKey,
        outcome.sourceId,
        "ingest",
        cycleAt,
        null,
        null,
        null,
        options.startedAt,
        null,
        "running",
        null,
        metadataJson,
        error
      )
      .run();

    return {
      id,
      sourceId: outcome.sourceId,
      status: outcome.status,
      recorded: true,
      rowCount,
      caveatCount: outcome.caveats.length,
      errorCount: outcome.errors.length,
      error
    };
  } catch (caught) {
    return {
      id,
      sourceId: outcome.sourceId,
      status: outcome.status,
      recorded: false,
      rowCount,
      caveatCount: outcome.caveats.length,
      errorCount: outcome.errors.length,
      error: `source_runs write failed: ${errorMessage(caught)}`
    };
  }
}

export async function finalizeSourceRun<Row>(
  db: D1Database,
  run: SourceRunRecord,
  outcome: AdapterOutcome<Row>,
  normalized: PersistenceResult,
  artifacts: ArtifactPersistenceResult,
  completedAt: string
): Promise<SourceRunRecord> {
  const errors = [...outcome.errors, ...normalized.errors, ...artifacts.errors];
  const status = combineStatus([outcome.status, errors.length > 0 ? "failure" : "success"]);
  const error = errors.length > 0 ? errors.join("\n").slice(0, 2000) : null;
  const metadataJson = JSON.stringify({
    provider: outcome.provider,
    capabilities: outcome.capabilities,
    adapterStatus: outcome.status,
    adapterRows: outcomeRowCount(outcome as AdapterOutcome<unknown>),
    normalizedRowsWritten: normalized.rowsWritten,
    rawArtifactsWritten: artifacts.rowsWritten,
    caveats: outcome.caveats,
    metadata: outcome.metadata,
    dbContract: SOURCE_RUNS_CONTRACT
  });

  try {
    await db
      .prepare(
        `update source_runs
         set completed_at = ?, status = ?, raw_r2_key = ?, artifact_manifest_json = ?,
             metadata_json = ?, error = ?
         where id = ?`
      )
      .bind(
        completedAt,
        status,
        artifacts.manifestKey,
        artifacts.manifestJson,
        metadataJson,
        error,
        run.id
      )
      .run();
    return {
      ...run,
      status,
      recorded: true,
      rowCount: normalized.rowsWritten,
      errorCount: errors.length,
      error
    };
  } catch (caught) {
    return {
      ...run,
      status: "failure",
      recorded: false,
      rowCount: normalized.rowsWritten,
      errorCount: errors.length + 1,
      error: `source_runs finalization failed: ${errorMessage(caught)}`
    };
  }
}
