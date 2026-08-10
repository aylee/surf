alter table narrative_revisions
  add column provider_id text not null default 'legacy';

alter table narrative_revisions
  add column inference_route text not null default 'legacy';

create table if not exists narrative_fallback_attempts (
  attempt_id text primary key,
  job_id text not null,
  submission_id text not null,
  provider_id text not null check (provider_id = 'google-ai'),
  model_id text not null,
  inference_route text not null check (inference_route = 'fallback'),
  trigger text not null check (
    trigger in ('delayed_watchdog', 'primary_validation_failed')
  ),
  state text not null check (
    state in ('claimed', 'generated', 'completed', 'failed')
  ),
  output_json text,
  disposition text check (
    disposition in (
      'published', 'duplicate', 'fallback_requested', 'fallback_failed',
      'rejected', 'expired', 'superseded'
    )
  ),
  last_reason_code text,
  claimed_at text not null,
  generated_at text,
  completed_at text,
  updated_at text not null,
  unique (job_id, submission_id)
);

create index if not exists narrative_fallback_attempts_claimed_idx
  on narrative_fallback_attempts (claimed_at);

create index if not exists narrative_fallback_attempts_replay_idx
  on narrative_fallback_attempts (state, updated_at);
