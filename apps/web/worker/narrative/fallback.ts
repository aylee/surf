import { isNorcalSpotId } from "@surf/forecast-core";
import {
  assertNarrativeResultSize,
  NarrativeFallbackWatchdogSchema,
  NarrativeGeneratedResultSubmissionSchema,
  type NarrativeFallbackWatchdog,
  type NarrativeGeneratedResultSubmission,
  type NarrativeResultDisposition
} from "@surf/narrative-contracts";
import { acceptSurfAnalysisResult, buildSurfAnalysisSnapshot } from "../analysis";
import { getMaterializedForecastFactBundle } from "../forecast-read-model";
import type { StoredNarrativeJob } from "./repository";
import { getNarrativeJob, markNarrativeJobTerminal } from "./repository";
import type { NarrativeFallbackConfig } from "./config";
import {
  createGeminiNarrativeGenerator,
  GeminiFallbackError,
  type GeminiNarrativeGenerator
} from "./gemini-fallback";

const FALLBACK_PROVIDER_ID = "google-ai";
const FALLBACK_ROUTE = "fallback" as const;
const FALLBACK_INFERENCE_TIMEOUT_MS = 90_000;
const FALLBACK_DEADLINE_RESERVE_MS = FALLBACK_INFERENCE_TIMEOUT_MS + 5_000;
const FALLBACK_REPLAY_LIMIT = 4;

type FallbackAttemptRow = {
  attempt_id: string;
  job_id: string;
  submission_id: string;
  provider_id: string;
  model_id: string;
  inference_route: "fallback";
  trigger: NarrativeFallbackWatchdog["trigger"];
  state: "claimed" | "generated" | "completed" | "failed";
  output_json: string | null;
  disposition: NarrativeResultDisposition | null;
  last_reason_code: string | null;
  claimed_at: string;
  generated_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export type NarrativeFallbackOutcome = {
  jobId: string;
  action:
    | "deferred"
    | "skipped"
    | "generated"
    | "published"
    | "failed";
  reasonCode: string;
  disposition?: NarrativeResultDisposition;
};

export function buildNarrativeFallbackWatchdog(options: {
  jobId: string;
  submissionId: string;
  now?: Date;
  delaySeconds: number;
  trigger: NarrativeFallbackWatchdog["trigger"];
  preclaimRetryCount?: number;
}): NarrativeFallbackWatchdog {
  const now = options.now ?? new Date();
  return NarrativeFallbackWatchdogSchema.parse({
    schemaVersion: 1,
    job: "narrative-fallback-watchdog",
    jobId: options.jobId,
    submissionId: options.submissionId,
    eligibleAt: new Date(now.getTime() + options.delaySeconds * 1_000).toISOString(),
    trigger: options.trigger,
    preclaimRetryCount: options.preclaimRetryCount ?? 0
  });
}

export async function enqueueNarrativeFallbackWatchdog(options: {
  queue: Queue;
  jobId: string;
  submissionId: string;
  now?: Date;
  delaySeconds: number;
  trigger: NarrativeFallbackWatchdog["trigger"];
  preclaimRetryCount?: number;
}): Promise<void> {
  const watchdog = buildNarrativeFallbackWatchdog(options);
  await options.queue.send(watchdog, {
    contentType: "json",
    ...(options.delaySeconds > 0 ? { delaySeconds: options.delaySeconds } : {})
  });
}

async function getFallbackAttempt(
  db: D1Database,
  jobId: string,
  submissionId: string
): Promise<FallbackAttemptRow | null> {
  return db
    .prepare(
      `select attempt_id, job_id, submission_id, provider_id, model_id,
              inference_route, trigger, state, output_json, disposition,
              last_reason_code, claimed_at, generated_at, completed_at, updated_at
       from narrative_fallback_attempts
       where job_id = ? and submission_id = ?
       limit 1`
    )
    .bind(jobId, submissionId)
    .first<FallbackAttemptRow>();
}

async function claimFallbackAttempt(options: {
  db: D1Database;
  watchdog: NarrativeFallbackWatchdog;
  config: NarrativeFallbackConfig;
  now: Date;
}): Promise<FallbackAttemptRow | null> {
  const nowIso = options.now.toISOString();
  const dailyCutoff = new Date(options.now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const rollingCutoff = new Date(
    options.now.getTime() - 31 * 24 * 60 * 60 * 1_000
  ).toISOString();
  const deadlineReserve = new Date(
    options.now.getTime() + FALLBACK_DEADLINE_RESERVE_MS
  ).toISOString();
  const attemptId = `fallback.${crypto.randomUUID()}`;
  return options.db
    .prepare(
      `insert into narrative_fallback_attempts (
         attempt_id, job_id, submission_id, provider_id, model_id,
         inference_route, trigger, state, claimed_at, updated_at
       )
       select ?, job_id, submission_id, ?, ?, 'fallback', ?, 'claimed', ?, ?
       from narrative_jobs
       where job_id = ? and submission_id = ?
         and status in ('enqueueing', 'pending', 'enqueue_failed')
         and deadline_at > ?
         and not exists (
           select 1 from narrative_revisions
           where narrative_revisions.job_id = narrative_jobs.job_id
         )
         and (
           select count(*) from narrative_fallback_attempts where claimed_at >= ?
         ) < ?
         and (
           select count(*) from narrative_fallback_attempts where claimed_at >= ?
         ) < ?
       on conflict(job_id, submission_id) do nothing
       returning attempt_id, job_id, submission_id, provider_id, model_id,
                 inference_route, trigger, state, output_json, disposition,
                 last_reason_code, claimed_at, generated_at, completed_at, updated_at`
    )
    .bind(
      attemptId,
      FALLBACK_PROVIDER_ID,
      options.config.modelId,
      options.watchdog.trigger,
      nowIso,
      nowIso,
      options.watchdog.jobId,
      options.watchdog.submissionId,
      deadlineReserve,
      dailyCutoff,
      options.config.dailyCap,
      rollingCutoff,
      options.config.rolling31DayCap
    )
    .first<FallbackAttemptRow>();
}

async function markFallbackFailed(options: {
  db: D1Database;
  attemptId: string;
  reasonCode: string;
  now: Date;
}): Promise<void> {
  const timestamp = options.now.toISOString();
  await options.db
    .prepare(
      `update narrative_fallback_attempts
       set state = 'failed', completed_at = ?, updated_at = ?,
           last_reason_code = ?, output_json = null
       where attempt_id = ? and state = 'claimed'`
    )
    .bind(timestamp, timestamp, options.reasonCode.slice(0, 120), options.attemptId)
    .run();
}

async function persistFallbackOutput(options: {
  db: D1Database;
  attemptId: string;
  submission: NarrativeGeneratedResultSubmission;
  now: Date;
}): Promise<FallbackAttemptRow> {
  const timestamp = options.now.toISOString();
  const result = await options.db
    .prepare(
      `update narrative_fallback_attempts
       set state = 'generated', model_id = ?, output_json = ?, generated_at = ?, updated_at = ?,
           last_reason_code = null
       where attempt_id = ? and state = 'claimed'`
    )
    .bind(
      options.submission.modelId,
      JSON.stringify(options.submission.output),
      timestamp,
      timestamp,
      options.attemptId
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new Error("Fallback output persistence lost its at-most-once claim");
  }
  const stored = await getFallbackAttempt(
    options.db,
    options.submission.jobId,
    options.submission.submissionId
  );
  if (!stored || stored.state !== "generated") {
    throw new Error("Persisted fallback output could not be read back");
  }
  return stored;
}

async function currentFactFingerprint(
  db: D1Database,
  stored: StoredNarrativeJob
): Promise<string | null> {
  if (stored.job.domain !== "surf" || !isNorcalSpotId(stored.job.entity.id)) return null;
  const bundle = await getMaterializedForecastFactBundle(
    db,
    stored.job.entity.id,
    stored.job.entity.localDate
  );
  return bundle && bundle.input.recommendationWindowIds.length > 0
    ? (await buildSurfAnalysisSnapshot(bundle)).factFingerprint
    : null;
}

async function completeFallbackAttempt(options: {
  db: D1Database;
  attempt: FallbackAttemptRow;
  disposition: NarrativeResultDisposition;
  now: Date;
}): Promise<void> {
  const timestamp = options.now.toISOString();
  await options.db
    .prepare(
      `update narrative_fallback_attempts
       set state = 'completed', disposition = ?, completed_at = ?, updated_at = ?,
           output_json = null,
           last_reason_code = ?
       where attempt_id = ? and state = 'generated'`
    )
    .bind(
      options.disposition,
      timestamp,
      timestamp,
      `fallback_${options.disposition}`.slice(0, 120),
      options.attempt.attempt_id
    )
    .run();
}

async function publishGeneratedAttempt(options: {
  db: D1Database;
  attempt: FallbackAttemptRow;
  now: Date;
  clock?: () => Date;
  currentFingerprint?: (
    db: D1Database,
    stored: StoredNarrativeJob
  ) => Promise<string | null>;
}): Promise<NarrativeFallbackOutcome> {
  const currentTime = () => options.clock?.() ?? options.now;
  if (options.attempt.state !== "generated" || options.attempt.output_json === null) {
    return {
      jobId: options.attempt.job_id,
      action: "skipped",
      reasonCode: "fallback_output_not_replayable"
    };
  }
  const stored = await getNarrativeJob(options.db, options.attempt.job_id);
  if (!stored || stored.job.result.submissionId !== options.attempt.submission_id) {
    await completeFallbackAttempt({
      db: options.db,
      attempt: options.attempt,
      disposition: "rejected",
      now: currentTime()
    });
    return {
      jobId: options.attempt.job_id,
      action: "skipped",
      reasonCode: "fallback_job_identity_changed",
      disposition: "rejected"
    };
  }
  const submission = NarrativeGeneratedResultSubmissionSchema.parse({
    schemaVersion: 1,
    jobId: options.attempt.job_id,
    submissionId: options.attempt.submission_id,
    providerId: options.attempt.provider_id,
    route: FALLBACK_ROUTE,
    modelId: options.attempt.model_id,
    output: JSON.parse(options.attempt.output_json)
  });
  const fingerprint = await (options.currentFingerprint ?? currentFactFingerprint)(
    options.db,
    stored
  );
  const publicationNow = currentTime();
  const result = await acceptSurfAnalysisResult({
    db: options.db,
    submission,
    currentFactFingerprint: fingerprint,
    now: publicationNow
  });
  await completeFallbackAttempt({
    db: options.db,
    attempt: options.attempt,
    disposition: result.disposition,
    now: publicationNow
  });
  return {
    jobId: options.attempt.job_id,
    action: result.disposition === "published" ? "published" : "skipped",
    reasonCode: `fallback_${result.disposition}`,
    disposition: result.disposition
  };
}

async function expireFallbackAfterInference(options: {
  db: D1Database;
  attempt: FallbackAttemptRow;
  stored: StoredNarrativeJob;
  now: Date;
}): Promise<NarrativeFallbackOutcome> {
  const reasonCode = "gemini_fallback_deadline_exceeded";
  await markFallbackFailed({
    db: options.db,
    attemptId: options.attempt.attempt_id,
    reasonCode,
    now: options.now
  });
  const expired = await markNarrativeJobTerminal({
    db: options.db,
    jobId: options.stored.job.jobId,
    expectedSubmissionId: options.stored.job.result.submissionId,
    status: "expired",
    reasonCode: "fallback_deadline_expired_after_inference",
    now: options.now
  });
  return {
    jobId: options.stored.job.jobId,
    action: "failed",
    reasonCode,
    ...(expired ? { disposition: "expired" as const } : {})
  };
}

export async function processNarrativeFallbackWatchdog(options: {
  db: D1Database;
  watchdog: NarrativeFallbackWatchdog;
  config: NarrativeFallbackConfig;
  geminiApiKey: string;
  now?: Date;
  clock?: () => Date;
  generator?: GeminiNarrativeGenerator;
  currentFingerprint?: (
    db: D1Database,
    stored: StoredNarrativeJob
  ) => Promise<string | null>;
}): Promise<NarrativeFallbackOutcome> {
  const clock =
    options.clock ??
    (options.now
      ? () => new Date(options.now!.getTime())
      : () => new Date());
  const now = options.now ?? clock();
  if (Date.parse(options.watchdog.eligibleAt) > now.getTime()) {
    return {
      jobId: options.watchdog.jobId,
      action: "deferred",
      reasonCode: "fallback_watchdog_early"
    };
  }
  let existing: FallbackAttemptRow | null;
  try {
    existing = await getFallbackAttempt(
      options.db,
      options.watchdog.jobId,
      options.watchdog.submissionId
    );
  } catch {
    return {
      jobId: options.watchdog.jobId,
      action: "deferred",
      reasonCode: "fallback_preclaim_retryable"
    };
  }
  if (existing) {
    return existing.state === "generated"
      ? publishGeneratedAttempt({
          db: options.db,
          attempt: existing,
          now,
          clock,
          currentFingerprint: options.currentFingerprint
        })
      : {
          jobId: options.watchdog.jobId,
          action: "skipped",
          reasonCode: `fallback_attempt_${existing.state}`
        };
  }

  // Check authoritative facts before claiming paid-provider budget. The
  // publication path repeats this check after inference to close the race
  // while the provider is running, but an already-stale watchdog spends zero.
  let currentJob: StoredNarrativeJob | null;
  let currentFingerprint: string | null;
  try {
    currentJob = await getNarrativeJob(options.db, options.watchdog.jobId);
    if (
      !currentJob ||
      currentJob.job.result.submissionId !== options.watchdog.submissionId
    ) {
      return {
        jobId: options.watchdog.jobId,
        action: "skipped",
        reasonCode: "fallback_job_identity_changed"
      };
    }
    currentFingerprint = await (
      options.currentFingerprint ?? currentFactFingerprint
    )(options.db, currentJob);
  } catch {
    return {
      jobId: options.watchdog.jobId,
      action: "deferred",
      reasonCode: "fallback_preclaim_retryable"
    };
  }
  if (currentFingerprint !== currentJob.job.factFingerprint) {
    await markNarrativeJobTerminal({
      db: options.db,
      jobId: currentJob.job.jobId,
      expectedSubmissionId: currentJob.job.result.submissionId,
      status: "superseded",
      reasonCode: "fallback_current_facts_changed",
      now
    });
    return {
      jobId: options.watchdog.jobId,
      action: "skipped",
      reasonCode: "fallback_current_facts_changed",
      disposition: "superseded"
    };
  }

  let attempt: FallbackAttemptRow | null;
  try {
    attempt = await claimFallbackAttempt({
      db: options.db,
      watchdog: options.watchdog,
      config: options.config,
      now
    });
  } catch {
    return {
      jobId: options.watchdog.jobId,
      action: "deferred",
      reasonCode: "fallback_preclaim_retryable"
    };
  }
  if (!attempt) {
    return {
      jobId: options.watchdog.jobId,
      action: "skipped",
      reasonCode: "fallback_not_claimed"
    };
  }
  const stored = await getNarrativeJob(options.db, options.watchdog.jobId);
  if (!stored || stored.job.result.submissionId !== options.watchdog.submissionId) {
    await markFallbackFailed({
      db: options.db,
      attemptId: attempt.attempt_id,
      reasonCode: "fallback_job_identity_changed",
      now
    });
    return {
      jobId: options.watchdog.jobId,
      action: "failed",
      reasonCode: "fallback_job_identity_changed"
    };
  }

  let generation: Awaited<ReturnType<GeminiNarrativeGenerator>>;
  try {
    generation = await (options.generator ?? createGeminiNarrativeGenerator())(stored.job, {
      apiKey: options.geminiApiKey,
      modelId: options.config.modelId,
      timeoutMs: Math.min(
        FALLBACK_INFERENCE_TIMEOUT_MS,
        Math.max(1, Date.parse(stored.job.deadlineAt) - now.getTime() - 5_000)
      )
    });
  } catch (error) {
    const failedAt = clock();
    if (failedAt.getTime() >= Date.parse(stored.job.deadlineAt)) {
      return expireFallbackAfterInference({
        db: options.db,
        attempt,
        stored,
        now: failedAt
      });
    }
    const reasonCode =
      error instanceof GeminiFallbackError
        ? error.code
        : "gemini_fallback_failed";
    await markFallbackFailed({
      db: options.db,
      attemptId: attempt.attempt_id,
      reasonCode,
      now: failedAt
    });
    return {
      jobId: options.watchdog.jobId,
      action: "failed",
      reasonCode
    };
  }
  const providerCompletedAt = clock();
  if (providerCompletedAt.getTime() >= Date.parse(stored.job.deadlineAt)) {
    return expireFallbackAfterInference({
      db: options.db,
      attempt,
      stored,
      now: providerCompletedAt
    });
  }
  if (typeof generation.modelId !== "string" || generation.modelId.length === 0) {
    await markFallbackFailed({
      db: options.db,
      attemptId: attempt.attempt_id,
      reasonCode: "gemini_fallback_model_identity_missing",
      now: providerCompletedAt
    });
    return {
      jobId: options.watchdog.jobId,
      action: "failed",
      reasonCode: "gemini_fallback_model_identity_missing"
    };
  }
  if (generation.modelId !== options.config.modelId) {
    await markFallbackFailed({
      db: options.db,
      attemptId: attempt.attempt_id,
      reasonCode: "gemini_fallback_model_identity_mismatch",
      now: providerCompletedAt
    });
    return {
      jobId: options.watchdog.jobId,
      action: "failed",
      reasonCode: "gemini_fallback_model_identity_mismatch"
    };
  }
  let submission: NarrativeGeneratedResultSubmission;
  try {
    submission = NarrativeGeneratedResultSubmissionSchema.parse(
      assertNarrativeResultSize(
        NarrativeGeneratedResultSubmissionSchema.parse({
          schemaVersion: 1,
          jobId: stored.job.jobId,
          submissionId: stored.job.result.submissionId,
          providerId: FALLBACK_PROVIDER_ID,
          route: FALLBACK_ROUTE,
          modelId: generation.modelId,
          output: generation.output
        })
      )
    );
  } catch {
    const failedAt = clock();
    if (failedAt.getTime() >= Date.parse(stored.job.deadlineAt)) {
      return expireFallbackAfterInference({
        db: options.db,
        attempt,
        stored,
        now: failedAt
      });
    }
    await markFallbackFailed({
      db: options.db,
      attemptId: attempt.attempt_id,
      reasonCode: "gemini_fallback_output_invalid",
      now: failedAt
    });
    return {
      jobId: options.watchdog.jobId,
      action: "failed",
      reasonCode: "gemini_fallback_output_invalid"
    };
  }
  const generatedAt = clock();
  if (generatedAt.getTime() >= Date.parse(stored.job.deadlineAt)) {
    return expireFallbackAfterInference({
      db: options.db,
      attempt,
      stored,
      now: generatedAt
    });
  }
  const generated = await persistFallbackOutput({
    db: options.db,
    attemptId: attempt.attempt_id,
    submission,
    now: generatedAt
  });
  return publishGeneratedAttempt({
    db: options.db,
    attempt: generated,
    now: generatedAt,
    clock,
    currentFingerprint: options.currentFingerprint
  });
}

export async function replayGeneratedNarrativeFallbacks(options: {
  db: D1Database;
  now?: Date;
  clock?: () => Date;
  limit?: number;
}): Promise<{ replayed: number }> {
  const clock =
    options.clock ??
    (options.now
      ? () => new Date(options.now!.getTime())
      : () => new Date());
  const rows = await options.db
    .prepare(
      `select attempt_id, job_id, submission_id, provider_id, model_id,
              inference_route, trigger, state, output_json, disposition,
              last_reason_code, claimed_at, generated_at, completed_at, updated_at
       from narrative_fallback_attempts
       where state = 'generated'
       order by updated_at asc
       limit ?`
    )
    .bind(Math.min(Math.max(Math.trunc(options.limit ?? FALLBACK_REPLAY_LIMIT), 0), FALLBACK_REPLAY_LIMIT))
    .all<FallbackAttemptRow>();
  let replayed = 0;
  for (const attempt of rows.results) {
    await publishGeneratedAttempt({
      db: options.db,
      attempt,
      now: clock(),
      clock
    });
    replayed += 1;
  }
  return { replayed };
}
