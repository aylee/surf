create table if not exists spots (
  id text primary key,
  name text not null,
  region text not null default 'norcal',
  lat real not null,
  lon real not null,
  timezone text not null,
  shore_normal_deg integer,
  config_json text not null,
  active integer not null default 1
);

create table if not exists sources (
  id text primary key,
  name text not null,
  type text not null,
  provider text not null,
  external_id text,
  url text,
  format text not null,
  parser_runtime text not null,
  attribution text not null,
  license_note text,
  refresh_minutes integer not null,
  active integer not null default 1,
  metadata_json text
);

create table if not exists spot_source_map (
  spot_id text not null,
  source_id text not null,
  role text not null,
  distance_km real,
  weight real,
  priority integer not null default 100,
  coverage_status text not null default 'active',
  notes text,
  metadata_json text,
  primary key (spot_id, source_id, role),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id)
);

create index if not exists spot_source_map_spot_role_idx
  on spot_source_map (spot_id, role);

create index if not exists spot_source_map_source_idx
  on spot_source_map (source_id);

create table if not exists source_runs (
  id text primary key,
  run_key text not null,
  source_id text not null,
  run_kind text not null,
  cycle_at text,
  forecast_hour integer,
  valid_start_at text,
  valid_end_at text,
  started_at text not null,
  completed_at text,
  status text not null,
  raw_r2_key text,
  artifact_manifest_json text,
  metadata_json text,
  error text,
  foreign key (source_id) references sources(id)
);

create unique index if not exists source_runs_run_key_idx
  on source_runs (run_key);

create index if not exists source_runs_source_status_idx
  on source_runs (source_id, status);

create index if not exists source_runs_cycle_idx
  on source_runs (cycle_at);

create table if not exists source_artifacts (
  id text primary key,
  source_run_id text not null,
  source_id text not null,
  r2_key text not null,
  artifact_type text not null,
  content_type text,
  byte_size integer,
  checksum_sha256 text,
  created_at text not null,
  metadata_json text,
  foreign key (source_run_id) references source_runs(id),
  foreign key (source_id) references sources(id)
);

create unique index if not exists source_artifacts_r2_key_idx
  on source_artifacts (r2_key);

create index if not exists source_artifacts_source_run_idx
  on source_artifacts (source_run_id);

create table if not exists wave_forecasts (
  spot_id text not null,
  source_id text not null,
  source_run_id text,
  model_cycle_at text not null,
  forecast_at text not null,
  lead_hour integer not null,
  offshore_height_m real,
  nearshore_height_m real,
  significant_height_m real,
  peak_period_s real,
  mean_period_s real,
  primary_direction_deg integer,
  wind_wave_height_m real,
  wind_wave_period_s real,
  wind_wave_direction_deg integer,
  swell_height_m real,
  swell_period_s real,
  swell_direction_deg integer,
  payload_json text,
  created_at text not null,
  primary key (spot_id, source_id, model_cycle_at, forecast_at),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists wave_forecasts_spot_forecast_at_idx
  on wave_forecasts (spot_id, forecast_at);

create index if not exists wave_forecasts_source_run_idx
  on wave_forecasts (source_run_id);

create table if not exists tide_forecasts (
  spot_id text not null,
  source_id text not null,
  source_run_id text,
  station_id text not null,
  forecast_at text not null,
  tide_ft_mllw real not null,
  tide_m_mllw real,
  tide_trend text,
  high_low text,
  payload_json text,
  created_at text not null,
  primary key (spot_id, station_id, forecast_at),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists tide_forecasts_spot_forecast_at_idx
  on tide_forecasts (spot_id, forecast_at);

create index if not exists tide_forecasts_source_run_idx
  on tide_forecasts (source_run_id);

create table if not exists wind_forecasts (
  spot_id text not null,
  source_id text not null,
  source_run_id text,
  model_cycle_at text,
  forecast_at text not null,
  lead_hour integer,
  wind_speed_ms real,
  wind_direction_deg integer,
  gust_ms real,
  weather_summary text,
  payload_json text,
  created_at text not null,
  primary key (spot_id, source_id, forecast_at),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists wind_forecasts_spot_forecast_at_idx
  on wind_forecasts (spot_id, forecast_at);

create index if not exists wind_forecasts_source_run_idx
  on wind_forecasts (source_run_id);

create table if not exists wave_observations (
  spot_id text not null,
  source_id text not null,
  source_run_id text,
  observed_at text not null,
  wave_height_m real,
  peak_period_s real,
  mean_period_s real,
  primary_direction_deg integer,
  wind_wave_height_m real,
  swell_height_m real,
  water_temp_c real,
  payload_json text,
  created_at text not null,
  primary key (spot_id, source_id, observed_at),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists wave_observations_spot_observed_at_idx
  on wave_observations (spot_id, observed_at);

create index if not exists wave_observations_source_run_idx
  on wave_observations (source_run_id);

create table if not exists tide_observations (
  spot_id text not null,
  source_id text not null,
  source_run_id text,
  station_id text not null,
  observed_at text not null,
  water_level_ft_mllw real,
  water_level_m_mllw real,
  sigma_ft real,
  payload_json text,
  created_at text not null,
  primary key (spot_id, station_id, observed_at),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists tide_observations_spot_observed_at_idx
  on tide_observations (spot_id, observed_at);

create index if not exists tide_observations_source_run_idx
  on tide_observations (source_run_id);

create table if not exists wind_observations (
  spot_id text not null,
  source_id text not null,
  source_run_id text,
  observed_at text not null,
  wind_speed_ms real,
  wind_direction_deg integer,
  gust_ms real,
  payload_json text,
  created_at text not null,
  primary key (spot_id, source_id, observed_at),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists wind_observations_spot_observed_at_idx
  on wind_observations (spot_id, observed_at);

create index if not exists wind_observations_source_run_idx
  on wind_observations (source_run_id);

create table if not exists hazard_events (
  spot_id text not null,
  source_id text not null,
  source_run_id text,
  event_id text not null,
  event_type text not null,
  severity text,
  certainty text,
  urgency text,
  starts_at text,
  ends_at text,
  headline text not null,
  description text,
  instruction text,
  payload_json text,
  updated_at text not null,
  primary key (spot_id, source_id, event_id),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists hazard_events_spot_starts_at_idx
  on hazard_events (spot_id, starts_at);

create index if not exists hazard_events_source_run_idx
  on hazard_events (source_run_id);

create table if not exists spot_scores (
  spot_id text not null,
  forecast_at text not null,
  quality_label text not null,
  score integer not null,
  confidence integer not null,
  wave_score integer not null,
  wind_score integer not null,
  tide_score integer not null,
  source_score integer not null,
  explanation text not null,
  components_json text,
  caveats_json text,
  source_freshness_minutes integer,
  computed_from_run_id text,
  computed_at text not null,
  primary key (spot_id, forecast_at),
  foreign key (spot_id) references spots(id),
  foreign key (computed_from_run_id) references source_runs(id)
);

create index if not exists spot_scores_computed_at_idx
  on spot_scores (computed_at);

create index if not exists spot_scores_source_run_idx
  on spot_scores (computed_from_run_id);

create table if not exists session_feedback (
  id text primary key,
  spot_id text not null,
  forecast_at text,
  occurred_at text not null,
  rating integer,
  notes text,
  conditions_json text,
  source_snapshot_json text,
  created_at text not null,
  foreign key (spot_id) references spots(id)
);

create index if not exists session_feedback_spot_occurred_at_idx
  on session_feedback (spot_id, occurred_at);

create table if not exists backtest_runs (
  id text primary key,
  name text not null,
  spot_id text,
  source_id text,
  comparison_source_id text,
  valid_start_at text not null,
  valid_end_at text not null,
  started_at text not null,
  completed_at text,
  status text not null,
  metric_summary_json text,
  metadata_json text,
  error text,
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (comparison_source_id) references sources(id)
);

create index if not exists backtest_runs_status_idx
  on backtest_runs (status);

create index if not exists backtest_runs_spot_idx
  on backtest_runs (spot_id);

create table if not exists backtest_metrics (
  backtest_run_id text not null,
  spot_id text not null,
  source_id text not null,
  metric text not null,
  value real not null,
  unit text,
  sample_count integer not null,
  metadata_json text,
  primary key (backtest_run_id, spot_id, source_id, metric),
  foreign key (backtest_run_id) references backtest_runs(id),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id)
);

create index if not exists backtest_metrics_spot_metric_idx
  on backtest_metrics (spot_id, metric);

create table if not exists forecast_reports (
  id text primary key,
  region_id text not null,
  issued_at text not null,
  valid_start_at text not null,
  valid_end_at text not null,
  status text not null,
  model_summary_json text not null,
  source_run_ids_json text,
  score_snapshot_json text,
  report_markdown text,
  generated_by text not null,
  disabled_reason text,
  created_at text not null
);

create index if not exists forecast_reports_region_issued_at_idx
  on forecast_reports (region_id, issued_at);

create index if not exists forecast_reports_status_idx
  on forecast_reports (status);
