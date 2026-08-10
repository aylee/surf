import {
  SurfAnalysisReportV3Schema,
  type SurfAnalysisReportV3
} from "@surf/contracts";
import type {
  NarrativeGeneratedResultSubmission,
  NarrativeResultDisposition
} from "@surf/narrative-contracts";
import {
  getNarrativeJob,
  markNarrativeJobTerminal
} from "../narrative/repository";
import { sha256Json } from "./hash";
import { renderSurfAnalysisReport } from "./renderer";
import {
  SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
  SURF_ANALYSIS_PROMPT_VERSION,
  SURF_ANALYSIS_RESULT_TARGET
} from "./types";
import { validateSurfAnalysisDraft } from "./validator";

type NarrativeRevisionRow = {
  revision_id: string;
  job_id: string;
  material_fingerprint: string;
  fact_fingerprint?: string;
  report_json: string;
  published_at: string;
};

export type StoredSurfAnalysisRevision = {
  revisionId: string;
  jobId: string;
  materialFingerprint: string;
  report: SurfAnalysisReportV3;
  publishedAt: string;
};

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Stored Analysis report is not valid JSON");
  }
}

function parseRevision(row: NarrativeRevisionRow): StoredSurfAnalysisRevision {
  const report = SurfAnalysisReportV3Schema.parse(parseJson(row.report_json));
  if (report.revisionId !== row.revision_id || report.updatedAt !== row.published_at) {
    throw new Error("Stored Analysis report metadata does not match its revision row");
  }
  return {
    revisionId: row.revision_id,
    jobId: row.job_id,
    materialFingerprint: row.material_fingerprint,
    report,
    publishedAt: row.published_at
  };
}

export async function getLatestSurfAnalysisRevision(options: {
  db: D1Database;
  spotId: string;
  localDate: string;
  factFingerprint: string;
}): Promise<StoredSurfAnalysisRevision | null> {
  const row = await options.db
    .prepare(
      `select revision.revision_id, revision.job_id, revision.material_fingerprint,
              revision.report_json, revision.published_at, revision.fact_fingerprint
       from narrative_revisions as revision
       join narrative_jobs as job on job.job_id = revision.job_id
       where revision.domain = 'surf' and revision.entity_id = ?
         and revision.local_date = ? and revision.fact_fingerprint = ?
         and revision.prompt_version = ? and revision.output_schema_version = ?
         and job.result_target = ?
       order by revision.published_at desc
       limit 1`
    )
    .bind(
      options.spotId,
      options.localDate,
      options.factFingerprint,
      SURF_ANALYSIS_PROMPT_VERSION,
      SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
      SURF_ANALYSIS_RESULT_TARGET
    )
    .first<NarrativeRevisionRow>();
  return row ? parseRevision(row) : null;
}

export async function countSurfAnalysisRevisions(
  db: D1Database,
  spotId: string,
  localDate: string
): Promise<number> {
  const row = await db
    .prepare(
      `select count(*) as count from narrative_revisions
       where domain = 'surf' and entity_id = ? and local_date = ?`
    )
    .bind(spotId, localDate)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function markResultTerminal(options: {
  db: D1Database;
  jobId: string;
  submissionId: string;
  status: "rejected" | "expired" | "superseded";
  reasonCode: string;
  now: Date;
}): Promise<NarrativeResultDisposition> {
  const changed = await markNarrativeJobTerminal({
    db: options.db,
    jobId: options.jobId,
    expectedSubmissionId: options.submissionId,
    status: options.status,
    reasonCode: options.reasonCode,
    now: options.now
  });
  if (changed) return options.status;
  const raced = await getNarrativeJob(options.db, options.jobId);
  if (raced?.status === "published") return "duplicate";
  if (
    raced?.job.result.submissionId === options.submissionId &&
    (raced.status === "rejected" || raced.status === "expired" || raced.status === "superseded")
  ) {
    return raced.status;
  }
  return "rejected";
}

export async function acceptSurfAnalysisResult(options: {
  db: D1Database;
  submission: NarrativeGeneratedResultSubmission;
  currentFactFingerprint: string | null;
  now?: Date;
}): Promise<{ disposition: NarrativeResultDisposition; jobId: string }> {
  const now = options.now ?? new Date();
  const stored = await getNarrativeJob(options.db, options.submission.jobId);
  if (!stored || stored.job.domain !== "surf" || stored.job.result.target !== SURF_ANALYSIS_RESULT_TARGET) {
    return { disposition: "rejected", jobId: options.submission.jobId };
  }
  if (stored.job.result.submissionId !== options.submission.submissionId) {
    return { disposition: "rejected", jobId: options.submission.jobId };
  }
  if (stored.status === "published") {
    return { disposition: "duplicate", jobId: stored.job.jobId };
  }
  if (stored.status === "rejected" || stored.status === "expired" || stored.status === "superseded") {
    return { disposition: stored.status, jobId: stored.job.jobId };
  }
  if (new Date(stored.job.deadlineAt).getTime() <= now.getTime()) {
    const disposition = await markResultTerminal({
      db: options.db,
      jobId: stored.job.jobId,
      submissionId: options.submission.submissionId,
      status: "expired",
      reasonCode: "result_after_deadline",
      now
    });
    return { disposition, jobId: stored.job.jobId };
  }
  if (
    options.currentFactFingerprint === null ||
    options.currentFactFingerprint !== stored.job.factFingerprint
  ) {
    const disposition = await markResultTerminal({
      db: options.db,
      jobId: stored.job.jobId,
      submissionId: options.submission.submissionId,
      status: "superseded",
      reasonCode: "forecast_facts_changed",
      now
    });
    return { disposition, jobId: stored.job.jobId };
  }

  const revisionFingerprint = await sha256Json({
    domain: stored.job.domain,
    entityId: stored.job.entity.id,
    localDate: stored.job.entity.localDate,
    facts: stored.job.factFingerprint,
    prompt: stored.job.promptVersion,
    schema: stored.job.outputSchemaVersion,
    provider: options.submission.providerId,
    route: options.submission.route,
    model: options.submission.modelId
  });
  const revisionId = `revision.${revisionFingerprint}`;
  const publishedAt = now.toISOString();
  let validated: ReturnType<typeof validateSurfAnalysisDraft>;
  let report: SurfAnalysisReportV3;
  try {
    validated = validateSurfAnalysisDraft(options.submission.output, stored.snapshot, now);
    report = renderSurfAnalysisReport({
      draft: validated.draft,
      snapshot: stored.snapshot,
      revisionId,
      publishedAt
    });
  } catch {
    // A provider's semantic miss is not a terminal fact-lifecycle outcome.
    // The cloud watchdog may still publish a grounded fallback, and a late
    // primary result may still win if the fallback also misses validation.
    return {
      disposition:
        options.submission.route === "primary"
          ? "fallback_requested"
          : "fallback_failed",
      jobId: stored.job.jobId
    };
  }
  const [insertResult, publishResult] = await options.db.batch([
    options.db
      .prepare(
        `insert into narrative_revisions (
           revision_id, job_id, domain, entity_id, local_date, fact_fingerprint,
           material_fingerprint, revision_fingerprint, prompt_version,
           output_schema_version, model_id, provider_id, inference_route,
           report_json, validation_json,
           generated_at, published_at
         )
         select ?, job_id, domain, entity_id, local_date, fact_fingerprint,
                material_fingerprint, ?, prompt_version, output_schema_version,
                ?, ?, ?, ?, ?, ?, ?
         from narrative_jobs
         where job_id = ? and submission_id = ? and fact_fingerprint = ?
           and deadline_at > ? and status in ('enqueueing', 'pending', 'enqueue_failed')
         on conflict(job_id) do nothing`
      )
      .bind(
        revisionId,
        revisionFingerprint,
        options.submission.modelId,
        options.submission.providerId,
        options.submission.route,
        JSON.stringify(report),
        JSON.stringify(validated.validation),
        publishedAt,
        publishedAt,
        stored.job.jobId,
        stored.job.result.submissionId,
        stored.job.factFingerprint,
        publishedAt
      ),
    options.db
      .prepare(
        `update narrative_jobs
         set status = 'published', completed_at = ?, updated_at = ?,
             enqueue_lease_until = null, enqueue_lease_token = null,
             last_reason_code = null
         where job_id = ? and submission_id = ?
           and status in ('enqueueing', 'pending', 'enqueue_failed')
           and exists (
           select 1 from narrative_revisions where narrative_revisions.job_id = narrative_jobs.job_id
         )`
      )
      .bind(
        publishedAt,
        publishedAt,
        stored.job.jobId,
        stored.job.result.submissionId
      )
  ]);
  if (insertResult?.meta.changes === 1 && publishResult?.meta.changes === 1) {
    return { disposition: "published", jobId: stored.job.jobId };
  }
  const raced = await getNarrativeJob(options.db, stored.job.jobId);
  return {
    disposition:
      raced?.status === "published"
        ? "duplicate"
        : raced?.status === "expired" || raced?.status === "superseded" || raced?.status === "rejected"
          ? raced.status
          : "rejected",
    jobId: stored.job.jobId
  };
}
