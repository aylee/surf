-- Append-only forecast-as-issued history for deterministic evaluation.
-- Keep the v1 latest-value tables unchanged so this migration is safe to
-- apply to an already-running D1 database.

-- Global time indexes keep the six-hour retention job from scanning the
-- spot-prefixed operational indexes. The original per-spot read indexes stay
-- intact for dashboard queries.
create index if not exists source_runs_started_at_idx
  on source_runs (started_at);

create index if not exists source_artifacts_created_at_idx
  on source_artifacts (created_at);

create index if not exists wave_forecasts_forecast_at_idx
  on wave_forecasts (forecast_at);

create index if not exists tide_forecasts_forecast_at_idx
  on tide_forecasts (forecast_at);

create index if not exists wind_forecasts_forecast_at_idx
  on wind_forecasts (forecast_at);

create index if not exists wave_observations_observed_at_idx
  on wave_observations (observed_at);

create index if not exists tide_observations_observed_at_idx
  on tide_observations (observed_at);

create index if not exists wind_observations_observed_at_idx
  on wind_observations (observed_at);

create index if not exists hazard_events_updated_at_idx
  on hazard_events (updated_at);

create table if not exists wind_forecast_issues (
  spot_id text not null,
  source_id text not null,
  source_run_id text not null,
  issue_key text not null,
  issued_at text not null,
  model_cycle_at text,
  forecast_at text not null,
  lead_hours real,
  wind_speed_ms real,
  wind_direction_deg integer,
  gust_ms real,
  weather_summary text,
  payload_json text,
  captured_at text not null,
  primary key (spot_id, source_id, issue_key, forecast_at),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists wind_forecast_issues_spot_forecast_at_idx
  on wind_forecast_issues (spot_id, forecast_at);

create index if not exists wind_forecast_issues_source_issued_at_idx
  on wind_forecast_issues (source_id, issued_at);

create index if not exists wind_forecast_issues_source_run_idx
  on wind_forecast_issues (source_run_id);

create index if not exists wind_forecast_issues_captured_at_idx
  on wind_forecast_issues (captured_at);

create table if not exists forecast_configs (
  spot_id text not null,
  config_hash text not null,
  config_json text not null,
  created_at text not null,
  primary key (spot_id, config_hash),
  foreign key (spot_id) references spots(id)
);

create table if not exists forecast_issues (
  spot_id text not null,
  issue_id text not null,
  captured_at text not null,
  issued_at text not null,
  source_issue_fingerprint text not null,
  spot_config_hash text not null,
  source_note text not null,
  issue_context_json text not null,
  expected_window_count integer not null,
  forecast_engine_version text not null,
  presentation_version text not null,
  snapshot_schema_version integer not null,
  created_at text not null,
  primary key (spot_id, issue_id),
  foreign key (spot_id) references spots(id),
  foreign key (spot_id, spot_config_hash)
    references forecast_configs(spot_id, config_hash)
);

create index if not exists forecast_issues_spot_issued_at_idx
  on forecast_issues (spot_id, issued_at);

create index if not exists forecast_issues_captured_at_idx
  on forecast_issues (captured_at);

create table if not exists forecast_snapshots (
  spot_id text not null,
  issue_id text not null,
  captured_at text not null,
  issued_at text not null,
  valid_at text not null,
  lead_hours real not null,
  rating_status text not null,
  quality_label text not null,
  surface_condition text not null,
  displayed_height_ft real,
  displayed_height_label text not null,
  score integer not null,
  confidence integer not null,
  wave_score integer not null,
  wind_score integer not null,
  tide_score integer not null,
  source_score integer not null,
  peak_period_s real,
  primary_direction_deg integer,
  tide_ft real,
  tide_trend text,
  wind_speed_kt real,
  wind_direction_deg integer,
  source_updated_at text,
  source_run_ids_json text not null,
  source_versions_json text not null,
  source_issue_fingerprint text not null,
  raw_facts_json text not null,
  spot_config_json text not null,
  spot_config_hash text not null,
  forecast_engine_version text not null,
  presentation_version text not null,
  snapshot_schema_version integer not null,
  created_at text not null,
  primary key (spot_id, issue_id, valid_at),
  foreign key (spot_id) references spots(id)
);

create index if not exists forecast_snapshots_spot_valid_at_idx
  on forecast_snapshots (spot_id, valid_at);

create index if not exists forecast_snapshots_spot_issued_at_idx
  on forecast_snapshots (spot_id, issued_at);

create index if not exists forecast_snapshots_issue_idx
  on forecast_snapshots (issue_id);

create index if not exists forecast_snapshots_captured_at_idx
  on forecast_snapshots (captured_at);
