create table if not exists narrative_jobs (
  job_id text primary key,
  schema_version integer not null,
  domain text not null,
  entity_id text not null,
  local_date text not null,
  fact_fingerprint text not null,
  material_fingerprint text not null,
  generation_fingerprint text not null unique,
  prompt_version text not null,
  output_schema_version integer not null,
  result_target text not null,
  submission_id text not null,
  deadline_at text not null,
  status text not null check (
    status in (
      'enqueueing', 'pending', 'published', 'rejected', 'expired',
      'superseded', 'enqueue_failed'
    )
  ),
  job_json text not null,
  validation_snapshot_json text not null,
  enqueue_lease_until text,
  enqueue_lease_token text,
  enqueue_attempts integer not null default 0,
  enqueued_at text,
  completed_at text,
  last_reason_code text,
  created_at text not null,
  updated_at text not null
);

create index if not exists narrative_jobs_entity_date_idx
  on narrative_jobs (domain, entity_id, local_date, created_at desc);

create index if not exists narrative_jobs_pending_deadline_idx
  on narrative_jobs (status, deadline_at);

create index if not exists narrative_jobs_retention_idx
  on narrative_jobs (updated_at, local_date, status, deadline_at);

create table if not exists narrative_revisions (
  revision_id text primary key,
  job_id text not null unique,
  domain text not null,
  entity_id text not null,
  local_date text not null,
  fact_fingerprint text not null,
  material_fingerprint text not null,
  revision_fingerprint text not null unique,
  prompt_version text not null,
  output_schema_version integer not null,
  model_id text not null,
  report_json text not null,
  validation_json text not null,
  generated_at text not null,
  published_at text not null,
  foreign key (job_id) references narrative_jobs(job_id)
);

create index if not exists narrative_revisions_entity_date_idx
  on narrative_revisions (domain, entity_id, local_date, published_at desc);

create index if not exists narrative_revisions_material_idx
  on narrative_revisions (domain, entity_id, local_date, material_fingerprint, published_at desc);

create index if not exists narrative_revisions_fact_idx
  on narrative_revisions (domain, entity_id, local_date, fact_fingerprint, published_at desc);

create index if not exists narrative_revisions_retention_idx
  on narrative_revisions (published_at, local_date);
