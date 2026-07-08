create table if not exists spots (
  id text primary key,
  name text not null,
  lat real not null,
  lon real not null,
  timezone text not null,
  shore_normal_deg integer,
  config_json text not null,
  active integer not null default 1
);

create table if not exists sources (
  id text primary key,
  type text not null,
  provider text not null,
  url text,
  license_note text,
  refresh_minutes integer not null
);

create table if not exists spot_source_map (
  spot_id text not null,
  source_id text not null,
  role text not null,
  distance_km real,
  weight real,
  metadata_json text,
  primary key (spot_id, source_id, role)
);

create table if not exists source_runs (
  id text primary key,
  source_id text not null,
  cycle_at text,
  forecast_hour integer,
  started_at text not null,
  completed_at text,
  status text not null,
  raw_r2_key text,
  metadata_json text,
  error text
);

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
  computed_at text not null,
  primary key (spot_id, forecast_at)
);

