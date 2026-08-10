/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pruneRetainedData } from "./ingest";

async function insertJob(options: {
  id: string;
  index: number;
  localDate: string;
  status: string;
  deadlineAt: string;
  updatedAt: string;
}): Promise<void> {
  const fingerprint = options.index.toString(16).padStart(64, "0");
  await env.DB.prepare(
    `insert into narrative_jobs (
       job_id, schema_version, domain, entity_id, local_date, fact_fingerprint,
       material_fingerprint, generation_fingerprint, prompt_version,
       output_schema_version, result_target, submission_id, deadline_at, status,
       job_json, validation_snapshot_json, enqueue_attempts, created_at, updated_at
     ) values (?, 1, 'surf', 'linda-mar', ?, ?, ?, ?, 'surf-analysis-v4-natural-1', 5,
       'surf.analysis.v4', ?, ?, ?, '{}', '{}', 1, ?, ?)`
  )
    .bind(
      options.id,
      options.localDate,
      fingerprint,
      fingerprint,
      fingerprint,
      `submission.${options.id}`,
      options.deadlineAt,
      options.status,
      options.updatedAt,
      options.updatedAt
    )
    .run();
}

describe("narrative retention in workerd D1", () => {
  it("deletes revisions before jobs while preserving current and live work", async () => {
    const indexes = await env.DB.prepare(
      `select name from sqlite_master
       where type = 'index' and name in (
         'narrative_fallback_attempts_claimed_idx',
         'narrative_jobs_retention_idx', 'narrative_revisions_retention_idx'
       ) order by name`
    ).all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual([
      "narrative_fallback_attempts_claimed_idx",
      "narrative_jobs_retention_idx",
      "narrative_revisions_retention_idx"
    ]);

    const now = new Date("2026-08-09T12:00:00.000Z");
    const old = "2026-06-01T12:00:00.000Z";
    const future = "2026-08-10T12:00:00.000Z";
    await insertJob({
      id: "job.old-published",
      index: 1,
      localDate: "2026-06-01",
      status: "published",
      deadlineAt: old,
      updatedAt: old
    });
    await insertJob({
      id: "job.old-rejected",
      index: 2,
      localDate: "2026-06-01",
      status: "rejected",
      deadlineAt: old,
      updatedAt: old
    });
    await insertJob({
      id: "job.current-published",
      index: 3,
      localDate: "2026-08-09",
      status: "published",
      deadlineAt: old,
      updatedAt: old
    });
    await insertJob({
      id: "job.live-pending",
      index: 4,
      localDate: "2026-06-01",
      status: "pending",
      deadlineAt: future,
      updatedAt: old
    });
    await insertJob({
      id: "job.abandoned-pending",
      index: 5,
      localDate: "2026-06-01",
      status: "pending",
      deadlineAt: old,
      updatedAt: old
    });
    await env.DB.prepare(
      `insert into narrative_revisions (
         revision_id, job_id, domain, entity_id, local_date, fact_fingerprint,
         material_fingerprint, revision_fingerprint, prompt_version,
         output_schema_version, model_id, report_json, validation_json,
         generated_at, published_at
       ) select 'revision.old', job_id, domain, entity_id, local_date, fact_fingerprint,
         material_fingerprint, ?, prompt_version, output_schema_version, 'fixture', '{}', '{}', ?, ?
       from narrative_jobs where job_id = 'job.old-published'`
    )
      .bind("6".padStart(64, "0"), old, old)
      .run();
    await env.DB.prepare(
      `insert into narrative_fallback_attempts (
         attempt_id, job_id, submission_id, provider_id, model_id,
         inference_route, trigger, state, claimed_at, updated_at
       ) values ('fallback.old', 'job.old-rejected',
         'submission.job.old-rejected', 'google-ai', 'gemini-3.6-flash',
         'fallback', 'delayed_watchdog', 'failed', ?, ?)`
    )
      .bind(old, old)
      .run();

    const result = await pruneRetainedData(env.DB, now);

    expect(result.errors).toEqual([]);
    const jobs = await env.DB.prepare(
      "select job_id from narrative_jobs order by job_id"
    ).all<{ job_id: string }>();
    expect(jobs.results.map((row) => row.job_id)).toEqual([
      "job.current-published",
      "job.live-pending"
    ]);
    expect(
      await env.DB.prepare(
        "select revision_id from narrative_revisions where revision_id = 'revision.old'"
      ).first()
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "select attempt_id from narrative_fallback_attempts where attempt_id = 'fallback.old'"
      ).first()
    ).toBeNull();
  });
});
