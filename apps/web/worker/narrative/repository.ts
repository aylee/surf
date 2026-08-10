import {
  NarrativeJobSchema,
  type NarrativeJob,
  type NarrativeResultDisposition,
  type NarrativeTerminalResultSubmission
} from "@surf/narrative-contracts";
import {
  SurfAnalysisValidationSnapshotSchema,
  type SurfAnalysisValidationSnapshot
} from "../analysis/types";

export type NarrativeJobStatus =
  | "enqueueing"
  | "pending"
  | "published"
  | "rejected"
  | "expired"
  | "superseded"
  | "enqueue_failed";

// Use a conservative 24-hour retention floor even when the active plan offers
// longer retention. Reissue unresolved delivery halfway through that floor;
// this respects the runner's supported 12-hour visibility lease while the
// final bounded copy survives more than 24 hours offline.
export const NARRATIVE_PENDING_REDELIVERY_MS = 12 * 60 * 60 * 1_000;
export const NARRATIVE_QUEUE_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const NARRATIVE_MAX_ENQUEUE_ATTEMPTS = 3;
export const NARRATIVE_RECONCILIATION_LIMIT = 15;

type NarrativeJobRow = {
  job_id: string;
  schema_version: number;
  domain: string;
  entity_id: string;
  local_date: string;
  fact_fingerprint: string;
  material_fingerprint: string;
  generation_fingerprint: string;
  prompt_version: string;
  output_schema_version: number;
  result_target: string;
  submission_id: string;
  deadline_at: string;
  status: NarrativeJobStatus;
  job_json: string;
  validation_snapshot_json: string;
  enqueue_lease_until: string | null;
  enqueue_lease_token: string | null;
  enqueue_attempts: number;
  enqueued_at: string | null;
  completed_at: string | null;
  last_reason_code: string | null;
  created_at: string;
  updated_at: string;
};

export type StoredNarrativeJob = {
  job: NarrativeJob;
  snapshot: SurfAnalysisValidationSnapshot;
  status: NarrativeJobStatus;
  enqueueLeaseUntil: string | null;
  enqueueLeaseToken: string | null;
  enqueueAttempts: number;
  enqueuedAt: string | null;
  completedAt: string | null;
  lastReasonCode: string | null;
  createdAt: string;
  updatedAt: string;
};

const SELECT_JOB_COLUMNS = `job_id, schema_version, domain, entity_id, local_date,
  fact_fingerprint, material_fingerprint, generation_fingerprint, prompt_version,
  output_schema_version, result_target, submission_id, deadline_at, status, job_json,
  validation_snapshot_json, enqueue_lease_until, enqueue_lease_token, enqueue_attempts, enqueued_at,
  completed_at, last_reason_code, created_at, updated_at`;

function parseStoredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Stored ${label} is not valid JSON`);
  }
}

function parseJobRow(row: NarrativeJobRow): StoredNarrativeJob {
  const job = NarrativeJobSchema.parse(parseStoredJson(row.job_json, "narrative job"));
  const snapshot = SurfAnalysisValidationSnapshotSchema.parse(
    parseStoredJson(row.validation_snapshot_json, "narrative validation snapshot")
  );
  if (
    row.job_id !== job.jobId ||
    row.schema_version !== job.schemaVersion ||
    row.domain !== job.domain ||
    row.entity_id !== job.entity.id ||
    row.local_date !== job.entity.localDate ||
    row.fact_fingerprint !== job.factFingerprint ||
    row.material_fingerprint !== job.materialFingerprint ||
    row.generation_fingerprint !== job.generationFingerprint ||
    row.prompt_version !== job.promptVersion ||
    row.output_schema_version !== job.outputSchemaVersion ||
    row.result_target !== job.result.target ||
    row.submission_id !== job.result.submissionId ||
    row.deadline_at !== job.deadlineAt ||
    snapshot.factFingerprint !== job.factFingerprint ||
    snapshot.materialFingerprint !== job.materialFingerprint
  ) {
    throw new Error("Stored narrative job metadata does not match its envelope and snapshot");
  }
  return {
    job,
    snapshot,
    status: row.status,
    enqueueLeaseUntil: row.enqueue_lease_until,
    enqueueLeaseToken: row.enqueue_lease_token,
    enqueueAttempts: row.enqueue_attempts,
    enqueuedAt: row.enqueued_at,
    completedAt: row.completed_at,
    lastReasonCode: row.last_reason_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getNarrativeJob(
  db: D1Database,
  jobId: string
): Promise<StoredNarrativeJob | null> {
  const row = await db
    .prepare(`select ${SELECT_JOB_COLUMNS} from narrative_jobs where job_id = ? limit 1`)
    .bind(jobId)
    .first<NarrativeJobRow>();
  return row ? parseJobRow(row) : null;
}

export async function getLatestNarrativeJobForFacts(options: {
  db: D1Database;
  domain: string;
  entityId: string;
  localDate: string;
  factFingerprint: string;
  promptVersion: string;
  outputSchemaVersion: number;
  resultTarget: string;
}): Promise<StoredNarrativeJob | null> {
  const row = await options.db
    .prepare(
      `select ${SELECT_JOB_COLUMNS}
       from narrative_jobs
       where domain = ? and entity_id = ? and local_date = ? and fact_fingerprint = ?
         and prompt_version = ? and output_schema_version = ? and result_target = ?
       order by created_at desc
       limit 1`
    )
    .bind(
      options.domain,
      options.entityId,
      options.localDate,
      options.factFingerprint,
      options.promptVersion,
      options.outputSchemaVersion,
      options.resultTarget
    )
    .first<NarrativeJobRow>();
  return row ? parseJobRow(row) : null;
}

export async function createAndClaimNarrativeJob(options: {
  db: D1Database;
  job: NarrativeJob;
  snapshot: SurfAnalysisValidationSnapshot;
  now?: Date;
  leaseMs?: number;
}): Promise<{ claimed: boolean; stored: StoredNarrativeJob }> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? 60_000)).toISOString();
  const leaseToken = crypto.randomUUID();
  const rearmedJob = NarrativeJobSchema.parse({
    ...options.job,
    result: {
      ...options.job.result,
      submissionId: `submission.${options.job.generationFingerprint}.a${crypto.randomUUID()}`
    }
  });
  const published = await options.db
    .prepare(
      `select ${SELECT_JOB_COLUMNS}
       from narrative_jobs
       where domain = ? and entity_id = ? and local_date = ? and fact_fingerprint = ?
         and prompt_version = ? and output_schema_version = ? and result_target = ?
         and status = 'published'
       order by completed_at desc
       limit 1`
    )
    .bind(
      options.job.domain,
      options.job.entity.id,
      options.job.entity.localDate,
      options.job.factFingerprint,
      options.job.promptVersion,
      options.job.outputSchemaVersion,
      options.job.result.target
    )
    .first<NarrativeJobRow>();
  if (published) return { claimed: false, stored: parseJobRow(published) };

  await options.db.batch([
    options.db
      .prepare(
        `insert into narrative_jobs (
           job_id, schema_version, domain, entity_id, local_date, fact_fingerprint,
           material_fingerprint, generation_fingerprint, prompt_version,
           output_schema_version, result_target, submission_id, deadline_at, status,
           job_json, validation_snapshot_json, enqueue_attempts, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enqueue_failed', ?, ?, 0, ?, ?)
         on conflict(generation_fingerprint) do nothing`
      )
      .bind(
        options.job.jobId,
        options.job.schemaVersion,
        options.job.domain,
        options.job.entity.id,
        options.job.entity.localDate,
        options.job.factFingerprint,
        options.job.materialFingerprint,
        options.job.generationFingerprint,
        options.job.promptVersion,
        options.job.outputSchemaVersion,
        options.job.result.target,
        options.job.result.submissionId,
        options.job.deadlineAt,
        JSON.stringify(options.job),
        JSON.stringify(options.snapshot),
        nowIso,
        nowIso
      ),
    options.db
      .prepare(
        `update narrative_jobs
         set status = 'superseded', completed_at = ?, updated_at = ?,
             last_reason_code = 'newer_facts_published'
       where domain = ? and entity_id = ? and local_date = ? and job_id <> ?
           and (
             fact_fingerprint <> ? or prompt_version <> ?
             or output_schema_version <> ? or result_target <> ?
           )
           and status in ('enqueueing', 'pending', 'enqueue_failed')
           and exists (
             select 1 from narrative_jobs as incoming
             where incoming.job_id = ?
               and (
                 (
                   incoming.status in ('enqueue_failed', 'enqueueing', 'pending')
                   and incoming.enqueue_attempts < ? and incoming.deadline_at > ?
                 )
                 or (
                   incoming.status = 'superseded' and incoming.enqueue_attempts < ?
                   and ? > ?
                 )
                 or (
                   incoming.status in ('rejected', 'expired')
                   and incoming.submission_id = ? and ? > ?
                 )
               )
           )`
      )
      .bind(
        nowIso,
        nowIso,
        options.job.domain,
        options.job.entity.id,
        options.job.entity.localDate,
        options.job.jobId,
        options.job.factFingerprint,
        options.job.promptVersion,
        options.job.outputSchemaVersion,
        options.job.result.target,
        options.job.jobId,
        NARRATIVE_MAX_ENQUEUE_ATTEMPTS,
        nowIso,
        NARRATIVE_MAX_ENQUEUE_ATTEMPTS,
        options.job.deadlineAt,
        nowIso,
        options.job.result.submissionId,
        options.job.deadlineAt,
        nowIso
      )
  ]);

  // A later materialization may renew the inference deadline while retaining
  // exactly the same output-visible facts. Re-arm only one bounded terminal
  // attempt; published work is immutable and always wins above.
  await options.db
    .prepare(
      `update narrative_jobs
       set material_fingerprint = ?, deadline_at = ?, job_json = ?,
           validation_snapshot_json = ?, submission_id = ?, status = 'enqueue_failed',
           completed_at = null, enqueue_lease_until = null, enqueue_lease_token = null,
           enqueue_attempts = case
             when status in ('rejected', 'expired') then 0
             else enqueue_attempts
           end,
           enqueued_at = null, updated_at = ?
       where generation_fingerprint = ?
         and (
           (status in ('rejected', 'expired') and submission_id = ?)
           or (status = 'superseded' and enqueue_attempts < ?)
         )
         and ? > ?`
    )
    .bind(
      options.job.materialFingerprint,
      options.job.deadlineAt,
      JSON.stringify(rearmedJob),
      JSON.stringify(options.snapshot),
      rearmedJob.result.submissionId,
      nowIso,
      options.job.generationFingerprint,
      options.job.result.submissionId,
      NARRATIVE_MAX_ENQUEUE_ATTEMPTS,
      options.job.deadlineAt,
      nowIso
    )
    .run();

  await options.db
    .prepare(
      `update narrative_jobs
       set status = 'enqueueing', enqueue_lease_until = ?, enqueue_lease_token = ?,
           enqueued_at = null, completed_at = null,
           enqueue_attempts = enqueue_attempts + 1, last_reason_code = null, updated_at = ?
       where job_id = ?
         and status in ('enqueue_failed', 'enqueueing')
         and enqueue_attempts < ?
         and (enqueued_at is null or status = 'rejected')
         and (enqueue_lease_until is null or enqueue_lease_until <= ?)
         and deadline_at > ?`
    )
    .bind(
      leaseUntil,
      leaseToken,
      nowIso,
      options.job.jobId,
      NARRATIVE_MAX_ENQUEUE_ATTEMPTS,
      nowIso,
      nowIso
    )
    .run();
  const stored = await getNarrativeJob(options.db, options.job.jobId);
  if (!stored) throw new Error("Narrative job disappeared after ledger insertion");
  return {
    claimed:
      stored.status === "enqueueing" &&
      stored.enqueuedAt === null &&
      stored.enqueueLeaseUntil === leaseUntil &&
      stored.enqueueLeaseToken === leaseToken,
    stored
  };
}

export async function listNarrativeJobsForReconciliation(
  db: D1Database,
  now = new Date(),
  limit = NARRATIVE_RECONCILIATION_LIMIT,
  pendingRedeliveryMs = NARRATIVE_PENDING_REDELIVERY_MS
): Promise<StoredNarrativeJob[]> {
  const nowIso = now.toISOString();
  const pendingStaleBefore = new Date(now.getTime() - pendingRedeliveryMs).toISOString();
  const rows = await db
    .prepare(
      `select ${SELECT_JOB_COLUMNS}
       from narrative_jobs
       where enqueue_attempts < ? and deadline_at > ?
         and (enqueue_lease_until is null or enqueue_lease_until <= ?)
         and (
           (status in ('enqueue_failed', 'enqueueing') and enqueued_at is null)
           or (status = 'pending' and enqueued_at is not null and enqueued_at <= ?)
         )
       order by updated_at asc
       limit ?`
    )
    .bind(
      NARRATIVE_MAX_ENQUEUE_ATTEMPTS,
      nowIso,
      nowIso,
      pendingStaleBefore,
      Math.min(Math.max(Math.trunc(limit), 0), NARRATIVE_RECONCILIATION_LIMIT)
    )
    .all<NarrativeJobRow>();
  return rows.results.map(parseJobRow);
}

export async function claimNarrativeJobForEnqueue(options: {
  db: D1Database;
  jobId: string;
  now?: Date;
  leaseMs?: number;
  pendingRedeliveryMs?: number;
}): Promise<StoredNarrativeJob | null> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? 60_000)).toISOString();
  const pendingStaleBefore = new Date(
    now.getTime() - (options.pendingRedeliveryMs ?? NARRATIVE_PENDING_REDELIVERY_MS)
  ).toISOString();
  const leaseToken = crypto.randomUUID();
  await options.db
    .prepare(
      `update narrative_jobs
       set status = 'enqueueing', enqueue_lease_until = ?, enqueue_lease_token = ?,
           enqueue_attempts = enqueue_attempts + 1, enqueued_at = null,
           last_reason_code = null, updated_at = ?
       where job_id = ? and enqueue_attempts < ? and deadline_at > ?
         and (enqueue_lease_until is null or enqueue_lease_until <= ?)
         and (
           (status in ('enqueue_failed', 'enqueueing') and enqueued_at is null)
           or (status = 'pending' and enqueued_at is not null and enqueued_at <= ?)
         )`
    )
    .bind(
      leaseUntil,
      leaseToken,
      nowIso,
      options.jobId,
      NARRATIVE_MAX_ENQUEUE_ATTEMPTS,
      nowIso,
      nowIso,
      pendingStaleBefore
    )
    .run();
  const stored = await getNarrativeJob(options.db, options.jobId);
  return stored?.enqueueLeaseToken === leaseToken && stored.enqueueLeaseUntil === leaseUntil
    ? stored
    : null;
}

export async function expireNarrativeJobs(db: D1Database, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  const retentionExpiredBefore = new Date(
    now.getTime() - NARRATIVE_QUEUE_RETENTION_MS
  ).toISOString();
  await db
    .prepare(
      `update narrative_jobs
       set status = 'expired', completed_at = ?, updated_at = ?,
           enqueue_lease_until = null, enqueue_lease_token = null,
           last_reason_code = case
             when deadline_at <= ? then 'inference_deadline_elapsed'
             else 'queue_delivery_attempts_exhausted'
           end
       where (
         status in ('enqueueing', 'pending', 'enqueue_failed') and deadline_at <= ?
       ) or (
         status = 'pending' and enqueue_attempts >= ?
           and enqueued_at is not null and enqueued_at <= ?
       )`
    )
    .bind(
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      NARRATIVE_MAX_ENQUEUE_ATTEMPTS,
      retentionExpiredBefore
    )
    .run();
}

export async function acceptNarrativeTerminalResult(options: {
  db: D1Database;
  submission: NarrativeTerminalResultSubmission;
  now?: Date;
}): Promise<{ disposition: NarrativeResultDisposition; jobId: string }> {
  const stored = await getNarrativeJob(options.db, options.submission.jobId);
  if (!stored || stored.job.result.submissionId !== options.submission.submissionId) {
    return { disposition: "rejected", jobId: options.submission.jobId };
  }
  if (stored.status === "published") {
    return { disposition: "duplicate", jobId: stored.job.jobId };
  }
  if (
    stored.status === "rejected" ||
    stored.status === "expired" ||
    stored.status === "superseded"
  ) {
    return { disposition: stored.status, jobId: stored.job.jobId };
  }
  const changed = await markNarrativeJobTerminal({
    db: options.db,
    jobId: stored.job.jobId,
    expectedSubmissionId: options.submission.submissionId,
    status: options.submission.terminal.status,
    reasonCode: `runner_${options.submission.terminal.reasonCode}`,
    now: options.now
  });
  if (changed) {
    return {
      disposition: options.submission.terminal.status,
      jobId: stored.job.jobId
    };
  }
  const raced = await getNarrativeJob(options.db, stored.job.jobId);
  return {
    disposition:
      raced?.status === "published"
        ? "duplicate"
        : raced?.job.result.submissionId === options.submission.submissionId &&
            (raced.status === "rejected" ||
              raced.status === "expired" ||
              raced.status === "superseded")
          ? raced.status
          : "rejected",
    jobId: stored.job.jobId
  };
}

export async function markNarrativeJobEnqueued(
  db: D1Database,
  jobId: string,
  leaseToken: string,
  now = new Date()
): Promise<void> {
  const timestamp = now.toISOString();
  await db
    .prepare(
      `update narrative_jobs
       set status = 'pending', enqueued_at = ?,
           enqueue_lease_until = null, enqueue_lease_token = null,
           last_reason_code = null, updated_at = ?
       where job_id = ? and status = 'enqueueing' and enqueue_lease_token = ?`
    )
    .bind(timestamp, timestamp, jobId, leaseToken)
    .run();
}

export async function markNarrativeJobEnqueueFailed(
  db: D1Database,
  jobId: string,
  leaseToken: string,
  reasonCode: string,
  now = new Date()
): Promise<void> {
  const timestamp = now.toISOString();
  await db
    .prepare(
      `update narrative_jobs
       set status = 'enqueue_failed', enqueue_lease_until = null, enqueue_lease_token = null,
           last_reason_code = ?, updated_at = ?
       where job_id = ? and status = 'enqueueing' and enqueue_lease_token = ?`
    )
    .bind(reasonCode.slice(0, 120), timestamp, jobId, leaseToken)
    .run();
}

export async function markNarrativeJobTerminal(options: {
  db: D1Database;
  jobId: string;
  expectedSubmissionId: string;
  status: "rejected" | "expired" | "superseded";
  reasonCode: string;
  now?: Date;
}): Promise<boolean> {
  const timestamp = (options.now ?? new Date()).toISOString();
  const result = await options.db
    .prepare(
      `update narrative_jobs
       set status = ?, completed_at = coalesce(completed_at, ?),
           last_reason_code = ?, enqueue_lease_until = null,
           enqueue_lease_token = null, updated_at = ?
       where job_id = ? and submission_id = ?
         and status in ('enqueueing', 'pending', 'enqueue_failed')`
    )
    .bind(
      options.status,
      timestamp,
      options.reasonCode.slice(0, 120),
      timestamp,
      options.jobId,
      options.expectedSubmissionId
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}
