-- Additive trust-workbench read models. Existing three-hour operational and
-- issued-history tables remain unchanged.

create table if not exists tide_events (
  spot_id text not null,
  source_id text not null,
  source_run_id text,
  station_id text not null,
  event_at text not null,
  tide_ft_mllw real not null,
  event_type text not null check (event_type in ('high', 'low')),
  payload_json text,
  created_at text not null,
  primary key (spot_id, station_id, event_at),
  foreign key (spot_id) references spots(id),
  foreign key (source_id) references sources(id),
  foreign key (source_run_id) references source_runs(id)
);

create index if not exists tide_events_spot_event_at_idx
  on tide_events (spot_id, event_at);

create index if not exists tide_events_source_run_idx
  on tide_events (source_run_id);

create table if not exists forecast_brief_revisions (
  spot_id text not null,
  local_date text not null,
  revision integer not null check (revision > 0),
  input_fingerprint text not null,
  material_fingerprint text not null,
  status text not null check (status in ('validated')),
  generated_at text not null,
  expires_at text,
  provider text not null,
  model_id text not null,
  prompt_version text not null,
  schema_version integer not null check (schema_version > 0),
  brief_json text not null,
  fact_refs_json text not null,
  validation_json text not null,
  created_at text not null,
  primary key (spot_id, local_date, revision),
  foreign key (spot_id) references spots(id)
);

create unique index if not exists forecast_brief_revisions_input_idx
  on forecast_brief_revisions (spot_id, local_date, input_fingerprint);

create index if not exists forecast_brief_revisions_latest_idx
  on forecast_brief_revisions (spot_id, local_date, revision desc);

create index if not exists forecast_brief_revisions_created_at_idx
  on forecast_brief_revisions (created_at);
