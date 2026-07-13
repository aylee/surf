import { runPendingStatements } from "./database";
import type { PersistenceResult } from "./types";

export const FORECAST_HISTORY_RETENTION_DAYS = 400;
export const OPERATIONAL_FORECAST_RETENTION_DAYS = 2;

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
  const operationalCutoff = new Date(
    now.getTime() - OPERATIONAL_FORECAST_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  return runPendingStatements(db, [
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
      label: "prune wind_forecasts",
      statement: db
        .prepare("delete from wind_forecasts where forecast_at < ?")
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
      statement: db
        .prepare("delete from source_artifacts where created_at < ?")
        .bind(historyCutoff)
    },
    {
      label: "prune source_runs",
      statement: db
        .prepare(
          `delete from source_runs
           where started_at < ?
             and not exists (select 1 from source_artifacts where source_run_id = source_runs.id)
             and not exists (select 1 from wave_forecasts where source_run_id = source_runs.id)
             and not exists (select 1 from tide_forecasts where source_run_id = source_runs.id)
             and not exists (select 1 from wind_forecasts where source_run_id = source_runs.id)
             and not exists (select 1 from wind_forecast_issues where source_run_id = source_runs.id)
             and not exists (select 1 from wave_observations where source_run_id = source_runs.id)
             and not exists (select 1 from hazard_events where source_run_id = source_runs.id)`
        )
        .bind(historyCutoff)
    }
  ]);
}
