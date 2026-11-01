import { runPendingStatements } from "./database";
import type { PersistenceResult } from "./types";
import { RAW_ARTIFACT_METADATA_RETENTION_DAYS, RAW_ARTIFACT_PROVIDER_PREFIXES } from "./raw-policy";

function knownLegacyRawPrefix(column: "r2_key" | "raw_r2_key"): string {
  return `(${RAW_ARTIFACT_PROVIDER_PREFIXES.map((prefix) => `${column} glob 'raw/${prefix}/*'`).join(" or ")})`;
}

// Unknown or malformed archival metadata must not abort the retention pass or
// be interpreted as approval to clear an unrelated resource's pointers.
const SAFE_MANIFEST_JSON = "case when json_valid(artifact_manifest_json) then artifact_manifest_json else '{}' end";
const MANIFEST_CREATED_AT = `json_extract(${SAFE_MANIFEST_JSON}, '$.createdAt')`;

function validUtcJulianDate(value: string): string {
  // julianday alone accepts numeric strings such as "100". Require the UTC
  // timestamp shape emitted by the uploader and a valid calendar round-trip.
  return `case when typeof(${value}) = 'text'
    and ${value} glob '????-??-??T??:??:??*Z'
    and julianday(${value}) is not null
    and strftime('%Y-%m-%dT%H:%M:%S', ${value}) = substr(${value}, 1, 19)
    then julianday(${value}) end`;
}

const LEGACY_MANIFEST_CREATED_AT = validUtcJulianDate(MANIFEST_CREATED_AT);
const LEGACY_COMPLETED_AT = validUtcJulianDate("completed_at");
const LEGACY_MANIFEST_ACTUAL_AT = `max(
  coalesce(${LEGACY_COMPLETED_AT}, ${LEGACY_MANIFEST_CREATED_AT}),
  coalesce(${LEGACY_MANIFEST_CREATED_AT}, ${LEGACY_COMPLETED_AT})
)`;

export const FORECAST_HISTORY_RETENTION_DAYS = 400;
export const OPERATIONAL_FORECAST_RETENTION_DAYS = 2;
export const NARRATIVE_RETENTION_DAYS = 7;
// The paid-fallback claim ledger is also the rolling 31-day budget authority.
// Keep a small clock-skew cushion beyond the budget window before pruning it.
export const NARRATIVE_FALLBACK_LEDGER_RETENTION_DAYS = 35;

export async function pruneRetainedData(
  db: D1Database,
  now: Date
): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["D1 binding does not expose prepare() for retention."] };
  }
  const historyCutoff = new Date(
    now.getTime() - FORECAST_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const rawMetadataCutoff = new Date(
    now.getTime() - RAW_ARTIFACT_METADATA_RETENTION_DAYS * 86_400_000
  ).toISOString();
  const operationalCutoff = new Date(
    now.getTime() - OPERATIONAL_FORECAST_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const narrativeCutoff = new Date(
    now.getTime() - NARRATIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const narrativeFallbackCutoff = new Date(
    now.getTime() -
      NARRATIVE_FALLBACK_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const currentDate = now.toISOString().slice(0, 10);
  return runPendingStatements(db, [
    {
      label: "prune narrative_fallback_attempts",
      statement: db
        .prepare("delete from narrative_fallback_attempts where claimed_at < ?")
        .bind(narrativeFallbackCutoff)
    },
    {
      // Revisions own a foreign key to jobs, so this must remain before the
      // narrative_jobs deletion below.
      label: "prune narrative_revisions",
      statement: db
        .prepare(
          `delete from narrative_revisions
           where published_at < ? and local_date < ?`
        )
        .bind(narrativeCutoff, currentDate)
    },
    {
      label: "prune narrative_jobs",
      statement: db
        .prepare(
          `delete from narrative_jobs
           where updated_at < ? and local_date < ?
             and (
               status in ('published', 'rejected', 'expired', 'superseded')
               or (status in ('enqueueing', 'pending', 'enqueue_failed') and deadline_at < ?)
             )
             and not exists (
               select 1 from narrative_revisions
               where narrative_revisions.job_id = narrative_jobs.job_id
             )`
        )
        .bind(narrativeCutoff, currentDate, narrativeCutoff)
    },
    {
      label: "prune forecast_snapshots",
      statement: db
        .prepare("delete from forecast_snapshots where captured_at < ?")
        .bind(historyCutoff)
    },
    {
      label: "prune forecast_issues",
      statement: db
        .prepare("delete from forecast_issues where captured_at < ?")
        .bind(historyCutoff)
    },
    {
      label: "prune wind_forecast_issues",
      statement: db
        .prepare("delete from wind_forecast_issues where captured_at < ?")
        .bind(historyCutoff)
    },
    {
      label: "prune wave_forecasts",
      statement: db
        .prepare("delete from wave_forecasts where forecast_at < ?")
        .bind(operationalCutoff)
    },
    {
      label: "prune tide_forecasts",
      statement: db
        .prepare("delete from tide_forecasts where forecast_at < ?")
        .bind(operationalCutoff)
    },
    {
      label: "prune tide_events",
      statement: db
        .prepare("delete from tide_events where event_at < ?")
        .bind(operationalCutoff)
    },
    {
      label: "prune wind_forecasts",
      statement: db
        .prepare("delete from wind_forecasts where forecast_at < ?")
        .bind(operationalCutoff)
    },
    {
      label: "prune inactive forecast_fact_bundles",
      statement: db
        .prepare(
          `delete from forecast_fact_bundles
           where materialized_at < ?
             and not exists (
               select 1 from forecast_read_models
               where forecast_read_models.spot_id = forecast_fact_bundles.spot_id
                 and forecast_read_models.interval = '3h'
                 and forecast_read_models.generation_id = forecast_fact_bundles.generation_id
             )`
        )
        .bind(operationalCutoff)
    },
    {
      label: "prune wave_observations",
      statement: db
        .prepare("delete from wave_observations where observed_at < ?")
        .bind(historyCutoff)
    },
    {
      label: "prune hazard_events",
      statement: db
        .prepare("delete from hazard_events where updated_at < ?")
        .bind(historyCutoff)
    },
    {
      label: "prune forecast_configs",
      statement: db.prepare(
        `delete from forecast_configs
         where not exists (
           select 1 from forecast_issues
           where forecast_issues.spot_id = forecast_configs.spot_id
             and forecast_issues.spot_config_hash = forecast_configs.config_hash
         )`
      ).bind()
    },
    {
      label: "prune source_artifacts",
      statement: db.prepare(`delete from source_artifacts
        where created_at < ?
          or (created_at <= ? and ${knownLegacyRawPrefix("r2_key")})`)
        .bind(historyCutoff, rawMetadataCutoff)
    },
    {
      label: "prune raw_artifact_captures",
      statement: db.prepare("delete from raw_artifact_captures where metadata_expires_at <= ?")
        .bind(now.toISOString())
    },
    {
      label: "expire raw manifests",
      statement: db.prepare(`update source_runs
        set artifact_manifest_json = null, raw_r2_key = null
        where (
          json_extract(${SAFE_MANIFEST_JSON}, '$.schemaVersion') = 2
          and json_extract(${SAFE_MANIFEST_JSON}, '$.metadataExpiresAt') <= ?
        ) or (
          ${knownLegacyRawPrefix("raw_r2_key")}
          and ${LEGACY_MANIFEST_ACTUAL_AT} <= julianday(?)
        )`)
        .bind(now.toISOString(), rawMetadataCutoff)
    },
    {
      label: "prune source_runs",
      statement: db
        .prepare(
          `delete from source_runs
           where started_at < ?
             and not exists (select 1 from source_artifacts where source_run_id = source_runs.id)
             and not exists (select 1 from raw_artifact_captures where source_run_id = source_runs.id)
             and not exists (select 1 from wave_forecasts where source_run_id = source_runs.id)
             and not exists (select 1 from tide_forecasts where source_run_id = source_runs.id)
             and not exists (select 1 from tide_events where source_run_id = source_runs.id)
             and not exists (select 1 from wind_forecasts where source_run_id = source_runs.id)
             and not exists (select 1 from wind_forecast_issues where source_run_id = source_runs.id)
             and not exists (select 1 from wave_observations where source_run_id = source_runs.id)
             and not exists (select 1 from hazard_events where source_run_id = source_runs.id)`
        )
        .bind(historyCutoff)
    }
  ]);
}
