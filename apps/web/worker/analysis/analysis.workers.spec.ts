/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildForecastFactBundle } from "../brief/facts";
import { briefForecastFixture } from "../brief/test-helpers";
import {
  enqueueSurfAnalysis as enqueueSurfAnalysisWithFallback,
  enqueueSurfAnalysisBundles as enqueueSurfAnalysisBundlesWithFallback,
  acceptNarrativeTerminalResult,
  createAndClaimNarrativeJob,
  getNarrativeJob,
  NARRATIVE_MAX_ENQUEUE_ATTEMPTS,
  NARRATIVE_PENDING_REDELIVERY_MS,
  NARRATIVE_QUEUE_RETENTION_MS,
  NARRATIVE_RECONCILIATION_LIMIT,
  reconcileNarrativeEnqueues as reconcileNarrativeEnqueuesWithFallback
} from "../narrative";
import { acceptSurfAnalysisResult } from "./repository";
import { buildSurfAnalysisResponse } from "./response";
import { buildSurfAnalysisSnapshot, buildSurfNarrativeJob } from "./snapshot";
import { localDateForTime, stableThreeHourForecastTimes } from "../time";
import type {
  SurfAnalysisDraftV4,
  SurfAnalysisValidationSnapshot
} from "./types";

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

function queue(send: (body: unknown) => Promise<void>): Queue {
  return { send } as unknown as Queue;
}

type EnqueueSurfAnalysisOptions = Parameters<
  typeof enqueueSurfAnalysisWithFallback
>[0];
type EnqueueSurfAnalysisBundlesOptions = Parameters<
  typeof enqueueSurfAnalysisBundlesWithFallback
>[0];
type ReconcileNarrativeEnqueuesOptions = Parameters<
  typeof reconcileNarrativeEnqueuesWithFallback
>[0];

function noOpFallbackQueue(): Queue {
  return queue(async () => undefined);
}

function enqueueSurfAnalysis(
  options: Omit<EnqueueSurfAnalysisOptions, "fallbackQueue"> & {
    fallbackQueue?: Queue;
  }
) {
  return enqueueSurfAnalysisWithFallback({
    ...options,
    fallbackQueue: options.fallbackQueue ?? noOpFallbackQueue()
  });
}

function enqueueSurfAnalysisBundles(
  options: Omit<EnqueueSurfAnalysisBundlesOptions, "fallbackQueue"> & {
    fallbackQueue?: Queue;
  }
) {
  return enqueueSurfAnalysisBundlesWithFallback({
    ...options,
    fallbackQueue: options.fallbackQueue ?? noOpFallbackQueue()
  });
}

function reconcileNarrativeEnqueues(
  options: Omit<ReconcileNarrativeEnqueuesOptions, "fallbackQueue"> & {
    fallbackQueue?: Queue;
  }
) {
  return reconcileNarrativeEnqueuesWithFallback({
    ...options,
    fallbackQueue: options.fallbackQueue ?? noOpFallbackQueue()
  });
}

function fiveCompleteDateForecast() {
  const forecast = briefForecastFixture();
  const times = stableThreeHourForecastTimes(
    new Date(forecast.generatedAt),
    120,
    forecast.spot.timezone
  );
  return {
    ...forecast,
    windows: times.map((forecastAt, index) => {
      const seed = forecast.windows[index % forecast.windows.length]!;
      return {
        ...seed,
        forecastAt,
        waveState: seed.waveState
          ? {
              ...seed.waveState,
              validFrom: forecastAt,
              validTo: new Date(Date.parse(forecastAt) + 3 * 60 * 60_000).toISOString()
            }
          : seed.waveState
      };
    })
  };
}

async function futureDateBundle() {
  const forecast = fiveCompleteDateForecast();
  const localDates = [
    ...new Set(
      forecast.windows.map((window) =>
        localDateForTime(window.forecastAt, forecast.spot.timezone)
      )
    )
  ].slice(0, 5);
  const localDate = localDates.at(-2);
  if (!localDate) throw new Error("Fixture did not produce a future local date");
  const dateWindows = forecast.windows.filter(
    (window) => localDateForTime(window.forecastAt, forecast.spot.timezone) === localDate
  );
  const representative = dateWindows[Math.floor(dateWindows.length / 2)];
  if (!representative) throw new Error("Fixture did not produce a future forecast window");
  forecast.recommendations = [
    {
      localDate,
      representative,
      constituentWindowIds: [representative.forecastAt],
      startAt: representative.forecastAt,
      endAt: new Date(Date.parse(representative.forecastAt) + 3 * 60 * 60_000).toISOString()
    }
  ];
  return buildForecastFactBundle(forecast, { localDate });
}

function countedDatabase(database: D1Database): {
  db: D1Database;
  queryCount: () => number;
} {
  let queryCount = 0;
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (["all", "first", "raw", "run"].includes(String(property))) {
          return (...args: unknown[]) => {
            queryCount += 1;
            return Reflect.apply(value, target, args);
          };
        }
        return value.bind(target);
      }
    });
  const db = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { db, queryCount: () => queryCount };
}

async function seedReconciliationJobs(count: number) {
  const bundle = await buildForecastFactBundle(briefForecastFixture());
  const snapshot = await buildSurfAnalysisSnapshot(bundle);
  const template = await buildSurfNarrativeJob(snapshot);
  for (let index = 0; index < count; index += 1) {
    const fingerprint = (index + 1).toString(16).padStart(64, "0");
    await createAndClaimNarrativeJob({
      db: env.DB,
      job: {
        ...template,
        jobId: `narrative.${fingerprint}`,
        generationFingerprint: fingerprint,
        result: {
          ...template.result,
          submissionId: `submission.${fingerprint}`
        }
      },
      snapshot,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
  }
  await env.DB.prepare(
    `update narrative_jobs
     set status = 'enqueue_failed', enqueue_lease_until = null,
         enqueue_lease_token = null, enqueue_attempts = 0, enqueued_at = null`
  ).run();
}

beforeEach(async () => {
  await env.DB.prepare("delete from narrative_revisions").run();
  await env.DB.prepare("delete from narrative_jobs").run();
});

describe("Surf Analysis v5 D1 lifecycle", () => {
  it("enqueues every selectable local date in one materialized generation", async () => {
    const forecast = fiveCompleteDateForecast();
    const localDates = [
      ...new Set(
        forecast.windows.map((window) =>
          localDateForTime(window.forecastAt, forecast.spot.timezone)
        )
      )
    ].slice(0, 5);
    expect(localDates).toHaveLength(5);
    const bundles = await Promise.all(
      localDates.map((localDate) => buildForecastFactBundle(forecast, { localDate }))
    );
    const sent: unknown[] = [];

    const outcomes = await enqueueSurfAnalysisBundles({
      db: env.DB,
      queue: queue(async (body) => {
        sent.push(body);
      }),
      bundles,
      now: new Date("2026-08-02T13:05:00.000Z")
    });

    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome.status === "enqueued")).toBe(true);
    expect(new Set(outcomes.map((outcome) => outcome.localDate))).toEqual(new Set(localDates));
    expect(sent).toHaveLength(5);
  });

  it("isolates one date's Queue failure from the remaining generation", async () => {
    const forecast = briefForecastFixture();
    const localDates = [
      ...new Set(
        forecast.windows.map((window) =>
          localDateForTime(window.forecastAt, forecast.spot.timezone)
        )
      )
    ].slice(0, 3);
    const bundles = await Promise.all(
      localDates.map((localDate) => buildForecastFactBundle(forecast, { localDate }))
    );
    let calls = 0;

    const outcomes = await enqueueSurfAnalysisBundles({
      db: env.DB,
      queue: queue(async () => {
        calls += 1;
        if (calls === 2) throw new Error("one-date failure");
      }),
      bundles,
      now: new Date("2026-08-02T13:05:00.000Z")
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "enqueued",
      "failed",
      "enqueued"
    ]);
    expect(calls).toBe(3);
  });

  it("enqueues one inference across ten identical materializations and irrelevant drift", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const sent: unknown[] = [];
    const producer = queue(async (body) => {
      sent.push(body);
    });

    const outcomes = [];
    for (let index = 0; index < 10; index += 1) {
      outcomes.push(
        await enqueueSurfAnalysis({
          db: env.DB,
          queue: producer,
          bundle,
          now: new Date("2026-08-02T13:05:00.000Z")
        })
      );
    }
    const irrelevantDrift = structuredClone(bundle);
    irrelevantDrift.materialFingerprint = "b".repeat(64);
    const drift = await enqueueSurfAnalysis({
      db: env.DB,
      queue: producer,
      bundle: irrelevantDrift,
      now: new Date("2026-08-02T13:10:00.000Z")
    });

    expect(outcomes.filter((outcome) => outcome.status === "enqueued")).toHaveLength(1);
    expect(drift.status).toBe("duplicate");
    expect(sent).toHaveLength(1);
    expect(
      (await env.DB.prepare("select count(*) as count from narrative_jobs").first<{ count: number }>())
        ?.count
    ).toBe(1);
  });

  it("supersedes an active same-fact job when the prompt or output contract changes", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const first = await buildSurfNarrativeJob(snapshot);
    await createAndClaimNarrativeJob({
      db: env.DB,
      job: first,
      snapshot,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    const nextFingerprint = "a".repeat(64);
    const next = {
      ...first,
      jobId: `narrative.${nextFingerprint}`,
      generationFingerprint: nextFingerprint,
      promptVersion: "surf-analysis-v3-next",
      result: {
        ...first.result,
        submissionId: `submission.${nextFingerprint}`
      }
    };

    const claim = await createAndClaimNarrativeJob({
      db: env.DB,
      job: next,
      snapshot,
      now: new Date("2026-08-02T13:06:00.000Z")
    });

    expect(claim.claimed).toBe(true);
    expect((await getNarrativeJob(env.DB, first.jobId))?.status).toBe("superseded");
    expect((await getNarrativeJob(env.DB, next.jobId))?.status).toBe("enqueueing");
  });

  it("reactivates A after an unpublished A-to-B-to-A fact reversion with a fresh submission", async () => {
    const bundleA = await buildForecastFactBundle(briefForecastFixture());
    const snapshotA = await buildSurfAnalysisSnapshot(bundleA);
    const sentA: unknown[] = [];
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async (body) => {
        sentA.push(body);
      }),
      bundle: bundleA,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    const firstA = sentA[0] as Awaited<ReturnType<typeof buildSurfNarrativeJob>>;

    const bundleB = structuredClone(bundleA);
    const primaryB = bundleB.input.windows.find(
      ({ windowId }) => windowId === bundleB.input.recommendationWindowIds[0]
    );
    if (!primaryB) throw new Error("Fixture did not include its primary window");
    primaryB.surfSizeFt = (primaryB.surfSizeFt ?? 2) + 2;
    primaryB.surfSizeLabel = "6–8 ft";
    const snapshotB = await buildSurfAnalysisSnapshot(bundleB);
    expect(snapshotB.factFingerprint).not.toBe(snapshotA.factFingerprint);
    const sentB: unknown[] = [];
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async (body) => {
        sentB.push(body);
      }),
      bundle: bundleB,
      now: new Date("2026-08-02T13:06:00.000Z")
    });
    const jobB = sentB[0] as Awaited<ReturnType<typeof buildSurfNarrativeJob>>;
    expect((await getNarrativeJob(env.DB, firstA.jobId))?.status).toBe("superseded");

    const returnedA: unknown[] = [];
    await expect(
      enqueueSurfAnalysis({
        db: env.DB,
        queue: queue(async (body) => {
          returnedA.push(body);
        }),
        bundle: bundleA,
        now: new Date("2026-08-02T13:07:00.000Z")
      })
    ).resolves.toMatchObject({ status: "enqueued", jobId: firstA.jobId });
    const activeA = returnedA[0] as Awaited<ReturnType<typeof buildSurfNarrativeJob>>;
    expect(activeA.jobId).toBe(firstA.jobId);
    expect(activeA.result.submissionId).not.toBe(firstA.result.submissionId);
    expect((await getNarrativeJob(env.DB, activeA.jobId))?.enqueueAttempts).toBe(2);
    expect((await getNarrativeJob(env.DB, jobB.jobId))?.status).toBe("superseded");

    await expect(
      acceptSurfAnalysisResult({
        db: env.DB,
        submission: {
          schemaVersion: 1,
          jobId: firstA.jobId,
          submissionId: firstA.result.submissionId,
          providerId: "omlx",
          route: "primary",
          modelId: "delayed-a-model",
          output: validDraft(snapshotA)
        },
        currentFactFingerprint: snapshotA.factFingerprint,
        now: new Date("2026-08-02T13:08:00.000Z")
      })
    ).resolves.toMatchObject({ disposition: "rejected" });
    expect((await getNarrativeJob(env.DB, activeA.jobId))?.status).toBe("pending");
    await expect(
      acceptSurfAnalysisResult({
        db: env.DB,
        submission: {
          schemaVersion: 1,
          jobId: jobB.jobId,
          submissionId: jobB.result.submissionId,
          providerId: "omlx",
          route: "primary",
          modelId: "delayed-b-model",
          output: validDraft(snapshotB)
        },
        currentFactFingerprint: snapshotA.factFingerprint,
        now: new Date("2026-08-02T13:08:30.000Z")
      })
    ).resolves.toMatchObject({ disposition: "superseded" });
    await expect(
      acceptSurfAnalysisResult({
        db: env.DB,
        submission: {
          schemaVersion: 1,
          jobId: activeA.jobId,
          submissionId: activeA.result.submissionId,
          providerId: "omlx",
          route: "primary",
          modelId: "current-a-model",
          output: validDraft(snapshotA)
        },
        currentFactFingerprint: snapshotA.factFingerprint,
        now: new Date("2026-08-02T13:09:00.000Z")
      })
    ).resolves.toMatchObject({ disposition: "published" });
  });

  it("keeps the current fact job active when a superseded reversion exhausted its send budget", async () => {
    const bundleA = await buildForecastFactBundle(briefForecastFixture());
    const sentA: unknown[] = [];
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async (body) => {
        sentA.push(body);
      }),
      bundle: bundleA,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    const jobA = sentA[0] as Awaited<ReturnType<typeof buildSurfNarrativeJob>>;
    const bundleB = structuredClone(bundleA);
    const primaryB = bundleB.input.windows.find(
      ({ windowId }) => windowId === bundleB.input.recommendationWindowIds[0]
    );
    if (!primaryB) throw new Error("Fixture did not include its primary window");
    primaryB.surfSizeFt = (primaryB.surfSizeFt ?? 2) + 2;
    primaryB.surfSizeLabel = "6–8 ft";
    const sentB: unknown[] = [];
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async (body) => {
        sentB.push(body);
      }),
      bundle: bundleB,
      now: new Date("2026-08-02T13:06:00.000Z")
    });
    const jobB = sentB[0] as Awaited<ReturnType<typeof buildSurfNarrativeJob>>;
    await env.DB.prepare(
      "update narrative_jobs set enqueue_attempts = ? where job_id = ?"
    ).bind(NARRATIVE_MAX_ENQUEUE_ATTEMPTS, jobA.jobId).run();
    const resent: unknown[] = [];

    await expect(
      enqueueSurfAnalysis({
        db: env.DB,
        queue: queue(async (body) => {
          resent.push(body);
        }),
        bundle: bundleA,
        now: new Date("2026-08-02T13:07:00.000Z")
      })
    ).resolves.toMatchObject({ status: "duplicate", jobId: jobA.jobId });

    expect(resent).toEqual([]);
    expect((await getNarrativeJob(env.DB, jobA.jobId))?.status).toBe("superseded");
    expect((await getNarrativeJob(env.DB, jobB.jobId))?.status).toBe("pending");
  });

  it("publishes once, serves exact current facts past inference deadline, and rejects stale facts", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const job = await buildSurfNarrativeJob(snapshot);
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async () => undefined),
      bundle,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    const submission = {
      schemaVersion: 1 as const,
      jobId: job.jobId,
      submissionId: job.result.submissionId,
      providerId: "omlx",
      route: "primary" as const,
      modelId: "fixture-model",
      output: validDraft(snapshot)
    };

    expect(
      await acceptSurfAnalysisResult({
        db: env.DB,
        submission,
        currentFactFingerprint: snapshot.factFingerprint,
        now: new Date("2026-08-02T14:00:00.000Z")
      })
    ).toMatchObject({ disposition: "published" });
    expect(
      await acceptSurfAnalysisResult({
        db: env.DB,
        submission,
        currentFactFingerprint: snapshot.factFingerprint,
        now: new Date("2026-08-02T14:01:00.000Z")
      })
    ).toMatchObject({ disposition: "duplicate" });
    expect(
      (await buildSurfAnalysisResponse(
        env.DB,
        bundle,
        new Date("2026-08-04T14:00:00.000Z")
      )).status
    ).toBe("published");

    const changed = structuredClone(bundle);
    const primary = changed.input.windows.find(
      (window) => window.windowId === changed.input.recommendationWindowIds[0]
    )!;
    primary.surfSizeFt = (primary.surfSizeFt ?? 2) + 4;
    primary.surfSizeLabel = "8–10 ft";
    expect((await buildSurfAnalysisResponse(env.DB, changed)).status).toBe("unavailable");
  });

  it("reports exactly one published winner for concurrent valid callbacks", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const job = await buildSurfNarrativeJob(snapshot);
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async () => undefined),
      bundle,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    const submission = {
      schemaVersion: 1 as const,
      jobId: job.jobId,
      submissionId: job.result.submissionId,
      providerId: "omlx",
      route: "primary" as const,
      modelId: "fixture-model",
      output: validDraft(snapshot)
    };

    const outcomes = await Promise.all(
      [0, 1].map(() =>
        acceptSurfAnalysisResult({
          db: env.DB,
          submission,
          currentFactFingerprint: snapshot.factFingerprint,
          now: new Date("2026-08-02T14:00:00.000Z")
        })
      )
    );

    expect(outcomes.map(({ disposition }) => disposition).sort()).toEqual([
      "duplicate",
      "published"
    ]);
    expect(
      await env.DB.prepare("select count(*) as count from narrative_revisions").first<{
        count: number;
      }>()
    ).toEqual({ count: 1 });
  });

  it("returns an authoritative no-call date as unavailable without a storage warning", async () => {
    const forecast = briefForecastFixture();
    forecast.recommendations = [];
    const bundle = await buildForecastFactBundle(forecast);
    expect(bundle.input.recommendationWindowIds).toEqual([]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(buildSurfAnalysisResponse(env.DB, bundle)).resolves.toMatchObject({
        status: "unavailable",
        report: null
      });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("serves published work but never advertises pending while the pipeline is disabled", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const job = await buildSurfNarrativeJob(snapshot);
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async () => undefined),
      bundle,
      now: new Date("2026-08-02T13:05:00.000Z")
    });

    await expect(
      buildSurfAnalysisResponse(
        env.DB,
        bundle,
        new Date("2026-08-02T13:06:00.000Z"),
        false
      )
    ).resolves.toMatchObject({ status: "unavailable", report: null });

    await acceptSurfAnalysisResult({
      db: env.DB,
      submission: {
        schemaVersion: 1,
        jobId: job.jobId,
        submissionId: job.result.submissionId,
        providerId: "omlx",
        route: "primary",
        modelId: "fixture-model",
        output: validDraft(snapshot)
      },
      currentFactFingerprint: snapshot.factFingerprint,
      now: new Date("2026-08-02T14:00:00.000Z")
    });
    await expect(
      buildSurfAnalysisResponse(
        env.DB,
        bundle,
        new Date("2026-08-02T14:01:00.000Z"),
        false
      )
    ).resolves.toMatchObject({ status: "published" });
  });

  it("never serves an obsolete prompt-contract revision while the current contract is pending or rejected", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const current = await buildSurfNarrativeJob(snapshot);
    const oldGeneration = "e".repeat(64);
    const oldJob = {
      ...current,
      jobId: `narrative.${oldGeneration}`,
      generationFingerprint: oldGeneration,
      promptVersion: "surf-analysis-v3-obsolete",
      result: {
        ...current.result,
        submissionId: `submission.${oldGeneration}`
      }
    };
    await createAndClaimNarrativeJob({
      db: env.DB,
      job: oldJob,
      snapshot,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    expect(
      await acceptSurfAnalysisResult({
        db: env.DB,
        submission: {
          schemaVersion: 1,
          jobId: oldJob.jobId,
          submissionId: oldJob.result.submissionId,
          providerId: "omlx",
          route: "primary",
          modelId: "obsolete-contract-model",
          output: validDraft(snapshot)
        },
        currentFactFingerprint: snapshot.factFingerprint,
        now: new Date("2026-08-02T13:06:00.000Z")
      })
    ).toMatchObject({ disposition: "published" });

    const currentMessages: Awaited<ReturnType<typeof buildSurfNarrativeJob>>[] = [];
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async (body) => {
        currentMessages.push(body as Awaited<ReturnType<typeof buildSurfNarrativeJob>>);
      }),
      bundle,
      now: new Date("2026-08-02T13:07:00.000Z")
    });
    expect(
      await buildSurfAnalysisResponse(
        env.DB,
        bundle,
        new Date("2026-08-02T13:07:30.000Z")
      )
    ).toMatchObject({
      status: "pending",
      report: null,
      availableRevisions: 1
    });

    const currentMessage = currentMessages[0]!;
    await acceptNarrativeTerminalResult({
      db: env.DB,
      submission: {
        schemaVersion: 1,
        jobId: currentMessage.jobId,
        submissionId: currentMessage.result.submissionId,
        terminal: {
          status: "rejected",
          reasonCode: "inference_output_invalid"
        }
      },
      now: new Date("2026-08-02T13:08:00.000Z")
    });
    expect(
      await buildSurfAnalysisResponse(
        env.DB,
        bundle,
        new Date("2026-08-02T13:08:30.000Z")
      )
    ).toMatchObject({
      status: "unavailable",
      report: null,
      availableRevisions: 1
    });
  });

  it("marks a result superseded when the exact current fact fingerprint changed", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const job = await buildSurfNarrativeJob(snapshot);
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async () => undefined),
      bundle,
      now: new Date("2026-08-02T13:05:00.000Z")
    });

    const result = await acceptSurfAnalysisResult({
      db: env.DB,
      submission: {
        schemaVersion: 1,
        jobId: job.jobId,
        submissionId: job.result.submissionId,
        providerId: "omlx",
        route: "primary",
        modelId: "fixture-model",
        output: validDraft(snapshot)
      },
      currentFactFingerprint: "f".repeat(64),
      now: new Date("2026-08-02T14:00:00.000Z")
    });

    expect(result.disposition).toBe("superseded");
    expect((await getNarrativeJob(env.DB, job.jobId))?.status).toBe("superseded");
  });

  it("reconciles a failed Queue send from the ledger with the authoritative stored envelope", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const expected = await buildSurfNarrativeJob(await buildSurfAnalysisSnapshot(bundle));
    await expect(
      enqueueSurfAnalysis({
        db: env.DB,
        queue: queue(async () => {
          throw new Error("ambiguous queue failure");
        }),
        bundle,
        now: new Date("2026-08-02T13:05:00.000Z")
      })
    ).rejects.toThrow(/ambiguous/);
    expect((await getNarrativeJob(env.DB, expected.jobId))?.status).toBe("enqueue_failed");
    await expect(
      buildSurfAnalysisResponse(
        env.DB,
        bundle,
        new Date("2026-08-02T13:05:30.000Z")
      )
    ).resolves.toMatchObject({
      status: "pending",
      report: null,
      message: "Analysis is being prepared."
    });
    const sent: unknown[] = [];

    const result = await reconcileNarrativeEnqueues({
      db: env.DB,
      queue: queue(async (body) => {
        sent.push(body);
      }),
      now: new Date("2026-08-02T13:06:00.000Z")
    });

    expect(result.enqueued).toBe(1);
    expect(sent).toEqual([expected]);
    expect((await getNarrativeJob(env.DB, expected.jobId))?.status).toBe("pending");
    expect((await getNarrativeJob(env.DB, expected.jobId))?.enqueueAttempts).toBe(2);
  });

  it("reconciliation keeps future-date watchdogs behind the earliest date", async () => {
    const forecast = fiveCompleteDateForecast();
    const localDates = [
      ...new Set(
        forecast.windows.map((window) =>
          localDateForTime(window.forecastAt, forecast.spot.timezone)
        )
      )
    ].slice(0, 2);
    const bundles = await Promise.all(
      localDates.map((localDate) => buildForecastFactBundle(forecast, { localDate }))
    );
    for (const bundle of bundles) {
      await expect(
        enqueueSurfAnalysis({
          db: env.DB,
          queue: queue(async () => {
            throw new Error("force ledger reconciliation");
          }),
          bundle,
          now: new Date("2026-08-02T13:05:00.000Z"),
          fallbackDelaySeconds: 600
        })
      ).rejects.toThrow(/force ledger reconciliation/);
    }

    const fallbackDelays: number[] = [];
    const result = await reconcileNarrativeEnqueues({
      db: env.DB,
      queue: queue(async () => undefined),
      fallbackQueue: {
        send: async (_body: unknown, options?: { delaySeconds?: number }) => {
          fallbackDelays.push(options?.delaySeconds ?? 0);
        }
      } as unknown as Queue,
      now: new Date("2026-08-02T13:06:00.000Z"),
      fallbackDelaySeconds: 600
    });

    expect(result).toEqual({ enqueued: 2 });
    expect(fallbackDelays).toHaveLength(2);
    expect(Math.min(...fallbackDelays)).toBeLessThan(720);
    expect(Math.max(...fallbackDelays)).toBeGreaterThanOrEqual(900);
  });

  it("recovers a >24h or DLQ-equivalent stale delivery with the same submission and publishes once", async () => {
    const bundle = await futureDateBundle();
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const sent: Awaited<ReturnType<typeof buildSurfNarrativeJob>>[] = [];
    const queued = queue(async (body) => {
      sent.push(body as Awaited<ReturnType<typeof buildSurfNarrativeJob>>);
    });
    const firstSentAt = new Date("2026-08-02T13:05:00.000Z");
    await enqueueSurfAnalysis({ db: env.DB, queue: queued, bundle, now: firstSentAt });

    const afterFreeRetention = new Date(
      firstSentAt.getTime() + NARRATIVE_QUEUE_RETENTION_MS + 60_000
    );
    expect(
      await reconcileNarrativeEnqueues({
        db: env.DB,
        queue: queued,
        now: afterFreeRetention
      })
    ).toEqual({ enqueued: 1 });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]?.result.submissionId).toBe(sent[0]?.result.submissionId);
    expect((await getNarrativeJob(env.DB, sent[0]!.jobId))?.enqueueAttempts).toBe(2);

    // A delayed original (for example, an operator-inspected DLQ copy) and the
    // replacement carry one semantic submission. Either may win; both cannot
    // create distinct revisions.
    const generated = {
      schemaVersion: 1 as const,
      jobId: sent[0]!.jobId,
      submissionId: sent[0]!.result.submissionId,
      providerId: "omlx",
      route: "primary" as const,
      modelId: "delayed-original-delivery",
      output: validDraft(snapshot)
    };
    expect(
      await acceptSurfAnalysisResult({
        db: env.DB,
        submission: generated,
        currentFactFingerprint: snapshot.factFingerprint,
        now: new Date(afterFreeRetention.getTime() + 60_000)
      })
    ).toMatchObject({ disposition: "published" });
    expect(
      await acceptSurfAnalysisResult({
        db: env.DB,
        submission: { ...generated, modelId: "replacement-delivery" },
        currentFactFingerprint: snapshot.factFingerprint,
        now: new Date(afterFreeRetention.getTime() + 120_000)
      })
    ).toMatchObject({ disposition: "duplicate" });
    expect(
      await env.DB.prepare("select count(*) as count from narrative_revisions").first<{
        count: number;
      }>()
    ).toEqual({ count: 1 });
  });

  it("bounds stale pending redelivery attempts and expires the ledger after the final retention window", async () => {
    const bundle = await futureDateBundle();
    const sent: unknown[] = [];
    const queued = queue(async (body) => {
      sent.push(body);
    });
    const firstSentAt = new Date("2026-08-02T13:05:00.000Z");
    const initial = await enqueueSurfAnalysis({
      db: env.DB,
      queue: queued,
      bundle,
      now: firstSentAt
    });
    const secondSentAt = new Date(
      firstSentAt.getTime() + NARRATIVE_PENDING_REDELIVERY_MS
    );
    const thirdSentAt = new Date(
      secondSentAt.getTime() + NARRATIVE_PENDING_REDELIVERY_MS
    );
    await reconcileNarrativeEnqueues({ db: env.DB, queue: queued, now: secondSentAt });
    await reconcileNarrativeEnqueues({ db: env.DB, queue: queued, now: thirdSentAt });
    expect(sent).toHaveLength(NARRATIVE_MAX_ENQUEUE_ATTEMPTS);
    expect((await getNarrativeJob(env.DB, initial.jobId))?.enqueueAttempts).toBe(
      NARRATIVE_MAX_ENQUEUE_ATTEMPTS
    );

    expect(
      await reconcileNarrativeEnqueues({
        db: env.DB,
        queue: queued,
        now: new Date(thirdSentAt.getTime() + NARRATIVE_PENDING_REDELIVERY_MS)
      })
    ).toEqual({ enqueued: 0 });
    expect((await getNarrativeJob(env.DB, initial.jobId))?.status).toBe("pending");

    const deliveryExpiredAt = new Date(
      thirdSentAt.getTime() + NARRATIVE_QUEUE_RETENTION_MS
    );
    expect(
      await reconcileNarrativeEnqueues({
        db: env.DB,
        queue: queued,
        now: deliveryExpiredAt
      })
    ).toEqual({ enqueued: 0 });
    expect(await getNarrativeJob(env.DB, initial.jobId)).toMatchObject({
      status: "expired",
      lastReasonCode: "queue_delivery_attempts_exhausted"
    });

    const firstSubmissionId = (sent[0] as Awaited<ReturnType<typeof buildSurfNarrativeJob>>)
      .result.submissionId;
    const rearmed: Awaited<ReturnType<typeof buildSurfNarrativeJob>>[] = [];
    expect(
      await enqueueSurfAnalysis({
        db: env.DB,
        queue: queue(async (body) => {
          rearmed.push(body as Awaited<ReturnType<typeof buildSurfNarrativeJob>>);
        }),
        bundle,
        now: new Date(deliveryExpiredAt.getTime() + 60_000)
      })
    ).toMatchObject({ status: "enqueued", jobId: initial.jobId });
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]?.result.submissionId).not.toBe(firstSubmissionId);
    expect(await getNarrativeJob(env.DB, initial.jobId)).toMatchObject({
      status: "pending",
      enqueueAttempts: 1
    });

    const rearmedJob = rearmed[0]!;
    await acceptNarrativeTerminalResult({
      db: env.DB,
      submission: {
        schemaVersion: 1,
        jobId: rearmedJob.jobId,
        submissionId: rearmedJob.result.submissionId,
        terminal: {
          status: "rejected",
          reasonCode: "inference_output_invalid"
        }
      },
      now: new Date(deliveryExpiredAt.getTime() + 120_000)
    });
    const forbiddenSecondRearm: unknown[] = [];
    expect(
      await enqueueSurfAnalysis({
        db: env.DB,
        queue: queue(async (body) => {
          forbiddenSecondRearm.push(body);
        }),
        bundle,
        now: new Date(deliveryExpiredAt.getTime() + 180_000)
      })
    ).toMatchObject({ status: "duplicate", jobId: initial.jobId });
    expect(forbiddenSecondRearm).toEqual([]);
    expect(await getNarrativeJob(env.DB, initial.jobId)).toMatchObject({
      status: "rejected",
      enqueueAttempts: 1,
      job: { result: { submissionId: rearmedJob.result.submissionId } }
    });
  });

  it("does not redeliver a stale job after its inference deadline", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const sent: unknown[] = [];
    const initial = await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async (body) => {
        sent.push(body);
      }),
      bundle,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    const stored = await getNarrativeJob(env.DB, initial.jobId);
    if (!stored) throw new Error("Expected a stored narrative job");
    const afterDeadline = new Date(Date.parse(stored.job.deadlineAt) + 1);

    expect(
      await reconcileNarrativeEnqueues({
        db: env.DB,
        queue: queue(async (body) => {
          sent.push(body);
        }),
        now: afterDeadline
      })
    ).toEqual({ enqueued: 0 });
    expect(sent).toHaveLength(1);
    expect(await getNarrativeJob(env.DB, initial.jobId)).toMatchObject({
      status: "expired",
      lastReasonCode: "inference_deadline_elapsed"
    });
  });

  it("keeps successful reconciliation below the Free D1 query budget", async () => {
    await seedReconciliationJobs(NARRATIVE_RECONCILIATION_LIMIT + 1);
    const counted = countedDatabase(env.DB);
    const sent: unknown[] = [];

    expect(
      await reconcileNarrativeEnqueues({
        db: counted.db,
        queue: queue(async (body) => {
          sent.push(body);
        }),
        now: new Date("2026-08-02T13:06:00.000Z"),
        limit: 50
      })
    ).toEqual({ enqueued: NARRATIVE_RECONCILIATION_LIMIT });
    expect(sent).toHaveLength(NARRATIVE_RECONCILIATION_LIMIT);
    expect(counted.queryCount()).toBe(2 + NARRATIVE_RECONCILIATION_LIMIT * 3);
    expect(counted.queryCount()).toBeLessThanOrEqual(50);
  });

  it("keeps failed reconciliation and its ledger finalizer inside the D1 query budget", async () => {
    await seedReconciliationJobs(1);
    const counted = countedDatabase(env.DB);

    await expect(
      reconcileNarrativeEnqueues({
        db: counted.db,
        queue: queue(async () => {
          throw new Error("Queue unavailable");
        }),
        now: new Date("2026-08-02T13:06:00.000Z")
      })
    ).rejects.toThrow(/Queue unavailable/);
    expect(counted.queryCount()).toBe(5);
    expect(counted.queryCount()).toBeLessThanOrEqual(50);
  });

  it("requests one fallback for an invalid primary and fails an invalid fallback closed", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const job = await buildSurfNarrativeJob(snapshot);
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async () => undefined),
      bundle,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    const invalid = validDraft(snapshot);
    invalid.close.watchCardId = "watch:unknown-card";

    const result = await acceptSurfAnalysisResult({
      db: env.DB,
      submission: {
        schemaVersion: 1,
        jobId: job.jobId,
        submissionId: job.result.submissionId,
        providerId: "omlx",
        route: "primary",
        modelId: "fixture-model",
        output: invalid
      },
      currentFactFingerprint: snapshot.factFingerprint,
      now: new Date("2026-08-02T14:00:00.000Z")
    });

    expect(result.disposition).toBe("fallback_requested");
    expect((await getNarrativeJob(env.DB, job.jobId))?.status).toBe("pending");

    const fallback = await acceptSurfAnalysisResult({
      db: env.DB,
      submission: {
        schemaVersion: 1,
        jobId: job.jobId,
        submissionId: job.result.submissionId,
        providerId: "gemini",
        route: "fallback",
        modelId: "fallback-fixture-model",
        output: invalid
      },
      currentFactFingerprint: snapshot.factFingerprint,
      now: new Date("2026-08-02T14:01:00.000Z")
    });
    expect(fallback.disposition).toBe("fallback_failed");
    expect((await getNarrativeJob(env.DB, job.jobId))?.status).toBe("pending");
  });

  it("does not let a delayed attempt-one callback terminate a rearmed attempt", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const firstMessages: unknown[] = [];
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async (body) => {
        firstMessages.push(body);
      }),
      bundle,
      now: new Date("2026-08-02T13:05:00.000Z")
    });
    const first = firstMessages[0] as Awaited<ReturnType<typeof buildSurfNarrativeJob>>;
    await acceptNarrativeTerminalResult({
      db: env.DB,
      submission: {
        schemaVersion: 1,
        jobId: first.jobId,
        submissionId: first.result.submissionId,
        terminal: { status: "rejected", reasonCode: "inference_output_invalid" }
      },
      now: new Date("2026-08-02T13:10:00.000Z")
    });
    const secondMessages: unknown[] = [];
    await enqueueSurfAnalysis({
      db: env.DB,
      queue: queue(async (body) => {
        secondMessages.push(body);
      }),
      bundle,
      now: new Date("2026-08-02T13:11:00.000Z")
    });
    const second = secondMessages[0] as Awaited<ReturnType<typeof buildSurfNarrativeJob>>;
    expect(second.jobId).toBe(first.jobId);
    expect(second.generationFingerprint).toBe(first.generationFingerprint);
    expect(second.result.submissionId).not.toBe(first.result.submissionId);

    await acceptNarrativeTerminalResult({
      db: env.DB,
      submission: {
        schemaVersion: 1,
        jobId: first.jobId,
        submissionId: first.result.submissionId,
        terminal: { status: "expired", reasonCode: "job_expired" }
      },
      now: new Date("2026-08-02T13:12:00.000Z")
    });
    expect((await getNarrativeJob(env.DB, first.jobId))?.status).toBe("pending");

    expect(
      await acceptSurfAnalysisResult({
        db: env.DB,
        submission: {
          schemaVersion: 1,
          jobId: first.jobId,
          submissionId: first.result.submissionId,
          providerId: "omlx",
          route: "primary",
          modelId: "delayed-first-model",
          output: validDraft(snapshot)
        },
        currentFactFingerprint: snapshot.factFingerprint,
        now: new Date("2026-08-02T13:13:00.000Z")
      })
    ).toMatchObject({ disposition: "rejected" });
    expect((await getNarrativeJob(env.DB, first.jobId))?.status).toBe("pending");

    expect(
      await acceptSurfAnalysisResult({
        db: env.DB,
        submission: {
          schemaVersion: 1,
          jobId: second.jobId,
          submissionId: second.result.submissionId,
          providerId: "omlx",
          route: "primary",
          modelId: "current-second-model",
          output: validDraft(snapshot)
        },
        currentFactFingerprint: snapshot.factFingerprint,
        now: new Date("2026-08-02T13:14:00.000Z")
      })
    ).toMatchObject({ disposition: "published" });
  });
});
