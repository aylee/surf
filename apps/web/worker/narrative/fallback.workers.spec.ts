/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import type { JsonValue, NarrativeJob } from "@surf/narrative-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildForecastFactBundle } from "../brief/facts";
import { briefForecastFixture } from "../brief/test-helpers";
import {
  buildSurfAnalysisSnapshot,
  buildSurfNarrativeJob
} from "../analysis/snapshot";
import type {
  SurfAnalysisDraftV4,
  SurfAnalysisValidationSnapshot
} from "../analysis/types";
import {
  createAndClaimNarrativeJob,
  getNarrativeJob
} from "./repository";
import type { StoredNarrativeJob } from "./repository";
import type { NarrativeFallbackConfig } from "./config";
import { GeminiFallbackError } from "./gemini-fallback";
import {
  buildNarrativeFallbackWatchdog,
  processNarrativeFallbackWatchdog
} from "./fallback";
import { enqueueSurfAnalysis } from "./producer";

const NOW = new Date("2026-08-02T13:05:00.000Z");
const CONFIG: NarrativeFallbackConfig = {
  modelId: "gemini-3.6-flash",
  delaySeconds: 600,
  dailyCap: 4,
  rolling31DayCap: 100
};

function generated(output: JsonValue, modelId = CONFIG.modelId) {
  return { output, modelId };
}

function validDraft(snapshot: SurfAnalysisValidationSnapshot): SurfAnalysisDraftV4 {
  const cards = (placement: SurfAnalysisValidationSnapshot["cards"][number]["placement"]) =>
    snapshot.cards.filter((candidate) => candidate.placement === placement);
  const outlook = cards("outlook");
  const support = cards("primary_support")[0];
  const tradeoff = cards("primary_tradeoff")[0];
  const alternate = cards("alternate")[0];
  const watch = cards("watch")[0];
  if (outlook.length < 2 || !support || !watch) throw new Error("Incomplete Analysis fixture");
  const surfaceOutlook = outlook.find(({ domains }) =>
    domains.some((domain) => domain === "surface" || domain === "wind")
  )!;
  const waveOutlook = outlook.find(({ domains }) => domains.includes("wave"))!;
  return {
    schemaVersion: 1,
    outlook: {
      leadCardId: surfaceOutlook.id,
      supportingCardId: waveOutlook.id
    },
    call: {
      primarySupportCardId: support.id,
      primaryTradeoffCardId: tradeoff?.id ?? null,
      alternateCardId: snapshot.callMode === "primary_and_alternate" ? alternate?.id ?? null : null
    },
    close: { watchCardId: watch.id }
  };
}

async function buildStoredJob(index = 1, deadlineAt?: string): Promise<{
  job: NarrativeJob;
  snapshot: SurfAnalysisValidationSnapshot;
  bundle: Awaited<ReturnType<typeof buildForecastFactBundle>>;
}> {
  const bundle = await buildForecastFactBundle(briefForecastFixture());
  const snapshot = await buildSurfAnalysisSnapshot(bundle);
  const built = await buildSurfNarrativeJob(snapshot);
  const template = deadlineAt ? { ...built, deadlineAt } : built;
  const fingerprint = index.toString(16).padStart(64, "0");
  const job =
    index === 1
      ? template
      : {
          ...template,
          jobId: `narrative.${fingerprint}`,
          generationFingerprint: fingerprint,
          result: {
            ...template.result,
            submissionId: `submission.${fingerprint}`
          }
        };
  const claim = await createAndClaimNarrativeJob({ db: env.DB, job, snapshot, now: NOW });
  if (!claim.claimed) throw new Error("Fixture narrative job was not claimed");
  return { job: claim.stored.job, snapshot, bundle };
}

function watchdog(job: NarrativeJob) {
  return buildNarrativeFallbackWatchdog({
    jobId: job.jobId,
    submissionId: job.result.submissionId,
    now: NOW,
    delaySeconds: 0,
    trigger: "delayed_watchdog"
  });
}

beforeEach(async () => {
  await env.DB.prepare("delete from narrative_fallback_attempts").run();
  await env.DB.prepare("delete from narrative_revisions").run();
  await env.DB.prepare("delete from narrative_jobs").run();
  await env.DB.prepare("delete from forecast_fact_bundles where spot_id = 'linda-mar'").run();
  await env.DB.prepare("delete from forecast_read_models where spot_id = 'linda-mar'").run();
});

describe("cloud narrative fallback in workerd D1", () => {
  it("loads the active production fact bundle before claiming fallback", async () => {
    const { job, snapshot, bundle } = await buildStoredJob();
    const generationId = "generation.fallback-production-loader";
    await env.DB.batch([
      env.DB.prepare(
        `insert into forecast_read_models (
           spot_id, interval, generation_id, generated_at, source_issue_fingerprint,
           schema_version, forecast_json, materialized_at
         ) values (?, '3h', ?, ?, 'fixture', 1, '{}', ?)`
      ).bind(
        bundle.input.spotId,
        generationId,
        bundle.input.generatedAt,
        NOW.toISOString()
      ),
      env.DB.prepare(
        `insert into forecast_fact_bundles (
           spot_id, local_date, generation_id, generated_at, input_fingerprint,
           material_fingerprint, schema_version, fact_bundle_json, materialized_at
         ) values (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(
        bundle.input.spotId,
        bundle.input.localDate,
        generationId,
        bundle.input.generatedAt,
        bundle.inputFingerprint,
        bundle.materialFingerprint,
        JSON.stringify(bundle),
        NOW.toISOString()
      )
    ]);

    const generate = vi.fn(async () => generated(validDraft(snapshot)));
    const outcome = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate
    });

    expect(outcome).toMatchObject({ action: "published", disposition: "published" });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("publishes one valid fallback with exact provider and route provenance", async () => {
    const { job, snapshot } = await buildStoredJob();
    const generate = vi.fn(async () => generated(validDraft(snapshot)));

    const first = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });
    const duplicate = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });

    expect(first).toMatchObject({ action: "published", disposition: "published" });
    expect(duplicate).toMatchObject({
      action: "skipped",
      reasonCode: "fallback_attempt_completed"
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        `select provider_id, inference_route, model_id
         from narrative_revisions where job_id = ?`
      )
        .bind(job.jobId)
        .first()
    ).toEqual({
      provider_id: "google-ai",
      inference_route: "fallback",
      model_id: "gemini-3.6-flash"
    });
    expect(
      await env.DB.prepare(
        `select state, output_json, disposition
         from narrative_fallback_attempts where job_id = ?`
      )
        .bind(job.jobId)
        .first()
    ).toEqual({ state: "completed", output_json: null, disposition: "published" });
  });

  it("uses resampled generation and publication times after provider inference", async () => {
    const { job, snapshot } = await buildStoredJob();
    const providerCompletedAt = new Date(NOW.getTime() + 10_000);
    const generatedAt = new Date(NOW.getTime() + 11_000);
    const publishedAt = new Date(NOW.getTime() + 12_000);
    const times = [providerCompletedAt, generatedAt, publishedAt];
    const clock = vi.fn(() => times.shift() ?? publishedAt);

    const outcome = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      clock,
      generator: async () => generated(validDraft(snapshot)),
      currentFingerprint: async () => snapshot.factFingerprint
    });

    expect(outcome).toMatchObject({ action: "published", disposition: "published" });
    expect(
      await env.DB.prepare(
        `select model_id, generated_at, completed_at
         from narrative_fallback_attempts where job_id = ?`
      )
        .bind(job.jobId)
        .first()
    ).toEqual({
      model_id: CONFIG.modelId,
      generated_at: generatedAt.toISOString(),
      completed_at: publishedAt.toISOString()
    });
    expect(
      await env.DB.prepare(
        "select published_at from narrative_revisions where job_id = ?"
      )
        .bind(job.jobId)
        .first()
    ).toEqual({ published_at: publishedAt.toISOString() });
  });

  it("expires a fallback whose provider call crosses the authoritative deadline", async () => {
    const deadlineAt = new Date(NOW.getTime() + 95_001);
    const completedAt = new Date(deadlineAt.getTime() + 1);
    const { job, snapshot } = await buildStoredJob(1, deadlineAt.toISOString());
    const generate = vi.fn(async () => generated(validDraft(snapshot)));

    const outcome = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      clock: () => completedAt,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });

    expect(outcome).toEqual({
      jobId: job.jobId,
      action: "failed",
      reasonCode: "gemini_fallback_deadline_exceeded",
      disposition: "expired"
    });
    expect(generate).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ timeoutMs: 90_000 })
    );
    expect(
      await env.DB.prepare(
        `select state, generated_at, completed_at, output_json, last_reason_code
         from narrative_fallback_attempts where job_id = ?`
      )
        .bind(job.jobId)
        .first()
    ).toEqual({
      state: "failed",
      generated_at: null,
      completed_at: completedAt.toISOString(),
      output_json: null,
      last_reason_code: "gemini_fallback_deadline_exceeded"
    });
    expect((await getNarrativeJob(env.DB, job.jobId))?.status).toBe("expired");
    expect(
      await env.DB.prepare("select count(*) as count from narrative_revisions").first()
    ).toEqual({ count: 0 });
  });

  it("persists successful provider output before publish and replays without another call", async () => {
    const { job, snapshot } = await buildStoredJob();
    const generate = vi.fn(async () => generated(validDraft(snapshot)));
    const publicationFailure = new Error("simulated publication outage");
    const fingerprint = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(snapshot.factFingerprint)
      .mockRejectedValueOnce(publicationFailure);

    await expect(
      processNarrativeFallbackWatchdog({
        db: env.DB,
        watchdog: watchdog(job),
        config: CONFIG,
        geminiApiKey: "test-key",
        now: NOW,
        generator: generate,
        currentFingerprint: fingerprint
      })
    ).rejects.toBe(publicationFailure);
    expect(
      await env.DB.prepare(
        "select state, output_json from narrative_fallback_attempts where job_id = ?"
      )
        .bind(job.jobId)
        .first<{ state: string; output_json: string | null }>()
    ).toMatchObject({ state: "generated", output_json: expect.any(String) });

    const replay = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });

    expect(replay).toMatchObject({ action: "published", disposition: "published" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("atomically caps paid calls across different logical jobs", async () => {
    const first = await buildStoredJob(1);
    const second = await buildStoredJob(2);
    const generate = vi.fn(async (job: NarrativeJob) =>
      generated(validDraft(job.jobId === first.job.jobId ? first.snapshot : second.snapshot))
    );
    const capped = { ...CONFIG, dailyCap: 1 };

    const outcomes = await Promise.all([
      processNarrativeFallbackWatchdog({
        db: env.DB,
        watchdog: watchdog(first.job),
        config: capped,
        geminiApiKey: "test-key",
        now: NOW,
        generator: generate,
        currentFingerprint: async () => first.snapshot.factFingerprint
      }),
      processNarrativeFallbackWatchdog({
        db: env.DB,
        watchdog: watchdog(second.job),
        config: capped,
        geminiApiKey: "test-key",
        now: NOW,
        generator: generate,
        currentFingerprint: async () => second.snapshot.factFingerprint
      })
    ]);

    expect(outcomes.map(({ action }) => action).sort()).toEqual([
      "published",
      "skipped"
    ]);
    expect(outcomes.find(({ action }) => action === "skipped")).toMatchObject({
      reasonCode: "fallback_not_claimed"
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("enforces the rolling 31-day cap independently of the 24-hour cap", async () => {
    const claimedAt = new Date(NOW.getTime() - 48 * 60 * 60_000).toISOString();
    await env.DB.prepare(
      `insert into narrative_fallback_attempts (
         attempt_id, job_id, submission_id, provider_id, model_id,
         inference_route, trigger, state, claimed_at, updated_at
       ) values ('fallback.history', 'narrative.history', 'submission.history',
         'google-ai', 'gemini-3.6-flash', 'fallback', 'delayed_watchdog',
         'failed', ?, ?)`
    )
      .bind(claimedAt, claimedAt)
      .run();
    const { job, snapshot } = await buildStoredJob();
    const generate = vi.fn(async () => generated(validDraft(snapshot)));

    const outcome = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: { ...CONFIG, rolling31DayCap: 1 },
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });

    expect(outcome).toMatchObject({
      action: "skipped",
      reasonCode: "fallback_not_claimed"
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("records a provider failure once and never spends again for the submission", async () => {
    const { job, snapshot } = await buildStoredJob();
    const generate = vi.fn(async () => {
      throw new GeminiFallbackError("gemini_fallback_network", false);
    });

    const first = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });
    const duplicate = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });

    expect(first).toMatchObject({
      action: "failed",
      reasonCode: "gemini_fallback_network"
    });
    expect(duplicate).toMatchObject({
      action: "skipped",
      reasonCode: "fallback_attempt_failed"
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("supersedes a stale or no-call watchdog before claiming paid fallback", async () => {
    const { job } = await buildStoredJob();
    const generate = vi.fn(async () => generated({}));

    const outcome = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => null
    });

    expect(outcome).toMatchObject({
      action: "skipped",
      reasonCode: "fallback_current_facts_changed",
      disposition: "superseded"
    });
    expect(generate).not.toHaveBeenCalled();
    expect((await getNarrativeJob(env.DB, job.jobId))?.status).toBe("superseded");
    expect(
      await env.DB.prepare(
        "select count(*) as count from narrative_fallback_attempts where job_id = ?"
      )
        .bind(job.jobId)
        .first()
    ).toEqual({ count: 0 });
  });

  it("defers one safe pre-claim read failure and still spends at most once", async () => {
    const { job, snapshot } = await buildStoredJob();
    const generate = vi.fn(async () => generated(validDraft(snapshot)));
    const retryableFingerprint = vi.fn(
      async (_db: D1Database, _stored: StoredNarrativeJob): Promise<string | null> =>
        snapshot.factFingerprint
    );
    retryableFingerprint.mockRejectedValueOnce(new Error("temporary fact read failure"));

    const deferred = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: retryableFingerprint
    });
    expect(deferred).toMatchObject({
      action: "deferred",
      reasonCode: "fallback_preclaim_retryable"
    });
    expect(generate).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "select count(*) as count from narrative_fallback_attempts where job_id = ?"
      )
        .bind(job.jobId)
        .first()
    ).toEqual({ count: 0 });

    const retried = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: buildNarrativeFallbackWatchdog({
        jobId: job.jobId,
        submissionId: job.result.submissionId,
        now: NOW,
        delaySeconds: 0,
        trigger: "delayed_watchdog",
        preclaimRetryCount: 1
      }),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });
    expect(retried).toMatchObject({ action: "published" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized fallback result before persistence", async () => {
    const { job, snapshot } = await buildStoredJob();
    const generate = vi.fn(async () => generated({ padding: "x".repeat(70_000) }));

    const outcome = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: generate,
      currentFingerprint: async () => snapshot.factFingerprint
    });

    expect(outcome).toMatchObject({
      action: "failed",
      reasonCode: "gemini_fallback_output_invalid"
    });
    expect(
      await env.DB.prepare(
        "select state, output_json, last_reason_code from narrative_fallback_attempts where job_id = ?"
      )
        .bind(job.jobId)
        .first()
    ).toEqual({
      state: "failed",
      output_json: null,
      last_reason_code: "gemini_fallback_output_invalid"
    });
    expect(
      await env.DB.prepare("select count(*) as count from narrative_revisions").first()
    ).toEqual({ count: 0 });
  });

  it("keeps the job live when the fallback fails semantic validation", async () => {
    const { job, snapshot } = await buildStoredJob();
    const outcome = await processNarrativeFallbackWatchdog({
      db: env.DB,
      watchdog: watchdog(job),
      config: CONFIG,
      geminiApiKey: "test-key",
      now: NOW,
      generator: async () => generated({}),
      currentFingerprint: async () => snapshot.factFingerprint
    });

    expect(outcome).toMatchObject({
      action: "skipped",
      disposition: "fallback_failed"
    });
    expect((await getNarrativeJob(env.DB, job.jobId))?.status).toBe("enqueueing");
    expect(
      await env.DB.prepare(
        "select state, disposition from narrative_fallback_attempts where job_id = ?"
      )
        .bind(job.jobId)
        .first()
    ).toEqual({ state: "completed", disposition: "fallback_failed" });
  });

  it("sends the delayed watchdog before primary delivery and never exposes an unguarded job", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const order: string[] = [];
    const result = await enqueueSurfAnalysis({
      db: env.DB,
      queue: {
        send: async () => {
          order.push("primary");
        }
      } as unknown as Queue,
      fallbackQueue: {
        send: async () => {
          order.push("fallback");
        }
      } as unknown as Queue,
      bundle,
      now: NOW,
      fallbackDelaySeconds: 600
    });

    expect(result.status).toBe("enqueued");
    expect(order).toEqual(["fallback", "primary"]);
  });

  it("does not send primary work when the watchdog delivery fails", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const primary = vi.fn(async () => undefined);

    await expect(
      enqueueSurfAnalysis({
        db: env.DB,
        queue: { send: primary } as unknown as Queue,
        fallbackQueue: {
          send: async () => {
            throw new Error("fallback queue unavailable");
          }
        } as unknown as Queue,
        bundle,
        now: NOW
      })
    ).rejects.toThrow("fallback queue unavailable");
    expect(primary).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("select status from narrative_jobs limit 1").first()
    ).toEqual({ status: "enqueue_failed" });
  });
});
