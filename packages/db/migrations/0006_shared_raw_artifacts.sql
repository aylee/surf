-- Shared payloads have many per-run captures. Keep the legacy unique-key table
-- and its rows intact so this migration is additive and old Workers can roll back.
create table if not exists raw_artifact_captures (
  id text primary key,
  source_run_id text not null,
  source_id text not null,
  r2_key text not null,
  content_type text not null,
  byte_size integer not null,
  stored_bytes integer not null,
  checksum_sha256 text not null,
  request_url text not null,
  captured_at text not null,
  created_at text not null,
  available_until text not null,
  metadata_expires_at text not null,
  content_encoding text not null default 'gzip' check (content_encoding = 'gzip'),
  foreign key (source_run_id) references source_runs(id),
  foreign key (source_id) references sources(id)
);
create index if not exists raw_artifact_captures_r2_key_idx
  on raw_artifact_captures (r2_key);
create index if not exists raw_artifact_captures_source_run_idx
  on raw_artifact_captures (source_run_id);
create index if not exists raw_artifact_captures_expiry_idx
  on raw_artifact_captures (metadata_expires_at);
