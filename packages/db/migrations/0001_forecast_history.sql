-- Append-only forecast-as-issued history for deterministic evaluation.
-- Keep the v1 latest-value tables unchanged so this migration is safe to
-- apply to an already-running D1 database.

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
