-- Additive request-time read models. Forecast scoring and brief fact assembly
-- happen after ingest; HTTP GETs only read the latest validated materialization.

create table if not exists forecast_read_models (
  spot_id text not null,
  interval text not null check (interval in ('1h', '3h')),
  generation_id text not null,
  generated_at text not null,
  source_issue_fingerprint text not null,
  schema_version integer not null check (schema_version > 0),
  forecast_json text not null,
  materialized_at text not null,
  primary key (spot_id, interval),
  foreign key (spot_id) references spots(id)
);

create index if not exists forecast_read_models_materialized_at_idx
  on forecast_read_models (materialized_at);

create table if not exists forecast_fact_bundles (
  spot_id text not null,
  local_date text not null,
  generation_id text not null,
  generated_at text not null,
  input_fingerprint text not null,
  material_fingerprint text not null,
  schema_version integer not null check (schema_version > 0),
  fact_bundle_json text not null,
  materialized_at text not null,
  primary key (spot_id, local_date),
  foreign key (spot_id) references spots(id)
);

create index if not exists forecast_fact_bundles_generation_idx
  on forecast_fact_bundles (spot_id, generation_id, local_date);

create index if not exists forecast_fact_bundles_materialized_at_idx
  on forecast_fact_bundles (materialized_at);
