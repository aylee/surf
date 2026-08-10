import { CDIP_MOP_SOURCE_ID } from "../adapters/cdip-mop";
import type { AdapterOutcome } from "../adapters/types";
import { combineStatus, errorMessage } from "../adapters/types";
import type {
  ArtifactPersistenceResult,
  PersistenceResult,
  SourceRunRecord
} from "./types";

export const SOURCE_RUNS_CONTRACT =
  "D1 binding DB must expose source_runs with run_key/run_kind plus normalized wave_forecasts, wave_observations, tide_forecasts, tide_events, wind_forecasts, wind_forecast_issues, hazard_events, forecast_configs, forecast_issues, forecast_snapshots, forecast_read_models, and forecast_fact_bundles tables.";

export function defaultRunIdSuffix(): string {
  return crypto.randomUUID();
}

function sourceRunId(sourceId: string, suffix: string): string {
  const prefix = sourceId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${prefix}-${suffix}`;
}

function outcomeRowCount(outcome: AdapterOutcome<unknown, unknown>): number {
  if (outcome.sourceId === "coops:tide-predictions") {
    const events = (outcome as AdapterOutcome<unknown, unknown> & { events?: unknown }).events;
    return outcome.rows.length + (Array.isArray(events) ? events.length : 0);
  }
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

export type SourceRunInput = {
  outcome: AdapterOutcome<unknown, unknown>;
  startedAt: string;
  completedAt: string;
  idSuffix: string;
};

function initialSourceRun(input: SourceRunInput): {
  record: SourceRunRecord;
  value: Record<string, unknown>;
} {
  const { outcome } = input;
  const id = sourceRunId(outcome.sourceId, input.idSuffix);
  const rowCount = outcomeRowCount(outcome);
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
  return {
    record: {
      id,
      sourceId: outcome.sourceId,
      startedAt: input.startedAt,
      status: outcome.status,
      recorded: true,
      rowCount,
      caveatCount: outcome.caveats.length,
      errorCount: outcome.errors.length,
      error
    },
    value: {
      id,
      runKey: `${outcome.sourceId}:${input.idSuffix}`,
      sourceId: outcome.sourceId,
      cycleAt: outcomeCycleAt(outcome),
      startedAt: input.startedAt,
      metadataJson,
      error
    }
  };
}

export async function recordSourceRuns(
  db: D1Database,
  inputs: readonly SourceRunInput[]
): Promise<SourceRunRecord[]> {
  const prepared = inputs.map(initialSourceRun);
  if (prepared.length === 0) return [];
  if (typeof db.prepare !== "function") {
    return prepared.map(({ record }) => ({
      ...record,
      recorded: false,
      error: "DB binding does not expose prepare()."
    }));
  }

  try {
    await db.prepare(
      `insert into source_runs (
        id, run_key, source_id, run_kind, cycle_at, forecast_hour,
        valid_start_at, valid_end_at, started_at, completed_at, status,
        raw_r2_key, metadata_json, error
      )
      select
        json_extract(item.value, '$.id'),
        json_extract(item.value, '$.runKey'),
        json_extract(item.value, '$.sourceId'),
        'ingest',
        json_extract(item.value, '$.cycleAt'),
        null,
        null,
        null,
        json_extract(item.value, '$.startedAt'),
        null,
        'running',
        null,
        json_extract(item.value, '$.metadataJson'),
        json_extract(item.value, '$.error')
      from json_each(?) as item
      where 1
      on conflict(id) do update set
        run_key = excluded.run_key,
        run_kind = excluded.run_kind,
        cycle_at = excluded.cycle_at,
        valid_start_at = excluded.valid_start_at,
        valid_end_at = excluded.valid_end_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        error = excluded.error
      where excluded.started_at >= source_runs.started_at`
    ).bind(JSON.stringify(prepared.map(({ value }) => value))).run();
    return prepared.map(({ record }) => record);
  } catch (caught) {
    return prepared.map(({ record }) => ({
      ...record,
      recorded: false,
      error: `source_runs write failed: ${errorMessage(caught)}`
    }));
  }
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
  return (await recordSourceRuns(db, [{
    outcome: outcome as AdapterOutcome<unknown, unknown>,
    ...options
  }]))[0]!;
}

export type SourceRunFinalization = {
  run: SourceRunRecord;
  outcome: AdapterOutcome<unknown, unknown>;
  normalized: PersistenceResult;
  artifacts: ArtifactPersistenceResult;
  completedAt: string;
};

function finalizedSourceRun(input: SourceRunFinalization): {
  record: SourceRunRecord;
  value: Record<string, unknown>;
} {
  const errors = [
    ...input.outcome.errors,
    ...input.normalized.errors,
    ...input.artifacts.errors
  ];
  const status = combineStatus([
    input.outcome.status,
    errors.length > 0 ? "failure" : "success"
  ]);
  const error = errors.length > 0 ? errors.join("\n").slice(0, 2000) : null;
  const metadataJson = JSON.stringify({
    provider: input.outcome.provider,
    capabilities: input.outcome.capabilities,
    adapterStatus: input.outcome.status,
    adapterRows: outcomeRowCount(input.outcome),
    normalizedRowsWritten: input.normalized.rowsWritten,
    rawArtifactsWritten: input.artifacts.rowsWritten,
    caveats: input.outcome.caveats,
    metadata: input.outcome.metadata,
    dbContract: SOURCE_RUNS_CONTRACT
  });
  return {
    record: {
      ...input.run,
      status,
      recorded: true,
      rowCount: input.normalized.rowsWritten,
      errorCount: errors.length,
      error
    },
    value: {
      id: input.run.id,
      completedAt: input.completedAt,
      status,
      rawR2Key: input.artifacts.manifestKey,
      artifactManifestJson: input.artifacts.manifestJson,
      metadataJson,
      error
    }
  };
}

export async function finalizeSourceRuns(
  db: D1Database,
  inputs: readonly SourceRunFinalization[]
): Promise<SourceRunRecord[]> {
  const prepared = inputs.map(finalizedSourceRun);
  if (prepared.length === 0) return [];
  try {
    await db.prepare(
      `update source_runs
       set
         completed_at = updates.completed_at,
         status = updates.status,
         raw_r2_key = updates.raw_r2_key,
         artifact_manifest_json = updates.artifact_manifest_json,
         metadata_json = updates.metadata_json,
         error = updates.error
       from (
         select
           json_extract(item.value, '$.id') as id,
           json_extract(item.value, '$.completedAt') as completed_at,
           json_extract(item.value, '$.status') as status,
           json_extract(item.value, '$.rawR2Key') as raw_r2_key,
           json_extract(item.value, '$.artifactManifestJson') as artifact_manifest_json,
           json_extract(item.value, '$.metadataJson') as metadata_json,
           json_extract(item.value, '$.error') as error
         from json_each(?) as item
       ) as updates
       where source_runs.id = updates.id`
    ).bind(JSON.stringify(prepared.map(({ value }) => value))).run();
    return prepared.map(({ record }) => record);
  } catch (caught) {
    return prepared.map(({ record }) => ({
      ...record,
      status: "failure",
      recorded: false,
      errorCount: record.errorCount + 1,
      error: `source_runs finalization failed: ${errorMessage(caught)}`
    }));
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
  return (await finalizeSourceRuns(db, [{
    run,
    outcome: outcome as AdapterOutcome<unknown, unknown>,
    normalized,
    artifacts,
    completedAt
  }]))[0]!;
}
