import type { ForecastFactBundle } from "../brief/types";
import { buildSurfAnalysisSnapshot, buildSurfNarrativeJob } from "../analysis";
import {
  claimNarrativeJobForEnqueue,
  createAndClaimNarrativeJob,
  expireNarrativeJobs,
  listNarrativeJobsForReconciliation,
  NARRATIVE_PENDING_REDELIVERY_MS,
  NARRATIVE_RECONCILIATION_LIMIT,
  markNarrativeJobEnqueued,
  markNarrativeJobEnqueueFailed
} from "./repository";
import { enqueueNarrativeFallbackWatchdog } from "./fallback";
import {
  NARRATIVE_FALLBACK_DEFAULT_DELAY_SECONDS,
  NARRATIVE_FALLBACK_MAX_DELAY_SECONDS
} from "./config";

export const SURF_ANALYSIS_FUTURE_CADENCE_HOURS = 3 as const;
const SURF_ANALYSIS_FALLBACK_FUTURE_TIER_SECONDS = 300;
const SURF_ANALYSIS_FALLBACK_FAIRNESS_SPREAD_SECONDS = 120;

export function surfAnalysisFallbackDelaySeconds(options: {
  baseDelaySeconds: number;
  spotId: string;
  localDate: string;
  futureDatePriority?: number;
}): number {
  let hash = 2_166_136_261;
  for (const character of `${options.localDate}:${options.spotId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const fairnessOffset = hash % SURF_ANALYSIS_FALLBACK_FAIRNESS_SPREAD_SECONDS;
  const futureDatePriority = Math.min(
    Math.max(Math.trunc(options.futureDatePriority ?? 0), 0),
    4
  );
  return Math.min(
    NARRATIVE_FALLBACK_MAX_DELAY_SECONDS,
    options.baseDelaySeconds +
      futureDatePriority * SURF_ANALYSIS_FALLBACK_FUTURE_TIER_SECONDS +
      fairnessOffset
  );
}

function localHourForTime(value: string, timeZone: string): number {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date(value))
      .find((part) => part.type === "hour")?.value
  );
  if (!Number.isInteger(hour)) throw new Error("Analysis signal local hour is invalid");
  return hour;
}

export function selectSurfAnalysisBundlesForSignal(options: {
  bundles: ForecastFactBundle[];
  generatedAt: string;
  timeZone: string;
}): { bundles: ForecastFactBundle[]; deferredLocalDates: string[] } {
  const sorted = [...options.bundles].sort((left, right) =>
    left.input.localDate.localeCompare(right.input.localDate)
  );
  const recommended = sorted.filter(
    ({ input }) => input.recommendationWindowIds.length > 0
  );
  const earliestRecommendedDate = recommended[0]?.input.localDate ?? null;
  const refreshFutureDates =
    localHourForTime(options.generatedAt, options.timeZone) %
      SURF_ANALYSIS_FUTURE_CADENCE_HOURS ===
    0;
  const selected = sorted.filter(
    ({ input }) =>
      input.recommendationWindowIds.length === 0 ||
      input.localDate === earliestRecommendedDate ||
      refreshFutureDates
  );
  const selectedDates = new Set(selected.map(({ input }) => input.localDate));
  return {
    bundles: selected,
    deferredLocalDates: sorted.flatMap(({ input }) =>
      selectedDates.has(input.localDate) ? [] : [input.localDate]
    )
  };
}

export async function enqueueSurfAnalysis(options: {
  db: D1Database;
  queue: Queue;
  fallbackQueue: Queue;
  bundle: ForecastFactBundle;
  now?: Date;
  fallbackDelaySeconds?: number;
  fallbackFutureDatePriority?: number;
}): Promise<{ status: "enqueued" | "duplicate"; jobId: string }> {
  const snapshot = await buildSurfAnalysisSnapshot(options.bundle);
  const job = await buildSurfNarrativeJob(snapshot);
  const claim = await createAndClaimNarrativeJob({
    db: options.db,
    job,
    snapshot,
    now: options.now
  });
  if (!claim.claimed) return { status: "duplicate", jobId: claim.stored.job.jobId };
  const leaseToken = claim.stored.enqueueLeaseToken;
  if (!leaseToken) throw new Error("Narrative enqueue claim has no lease token");
  try {
    // The watchdog is sent first. A ledger row is never marked pending unless
    // both the cloud fallback and local-primary deliveries were accepted.
    await enqueueNarrativeFallbackWatchdog({
      queue: options.fallbackQueue,
      jobId: claim.stored.job.jobId,
      submissionId: claim.stored.job.result.submissionId,
      now: options.now,
      delaySeconds: surfAnalysisFallbackDelaySeconds({
        baseDelaySeconds:
          options.fallbackDelaySeconds ?? NARRATIVE_FALLBACK_DEFAULT_DELAY_SECONDS,
        spotId: options.bundle.input.spotId,
        localDate: options.bundle.input.localDate,
        futureDatePriority: options.fallbackFutureDatePriority
      }),
      trigger: "delayed_watchdog"
    });
    await options.queue.send(claim.stored.job, { contentType: "json" });
    await markNarrativeJobEnqueued(
      options.db,
      claim.stored.job.jobId,
      leaseToken,
      options.now
    );
    return { status: "enqueued", jobId: claim.stored.job.jobId };
  } catch (error) {
    await markNarrativeJobEnqueueFailed(
      options.db,
      claim.stored.job.jobId,
      leaseToken,
      "queue_send_failed",
      options.now
    );
    throw error;
  }
}

export type SurfAnalysisEnqueueOutcome =
  | { localDate: string; status: "enqueued" | "duplicate"; jobId: string }
  | {
      localDate: string;
      status: "unavailable";
      reasonCode: "analysis_no_recommendation";
    }
  | { localDate: string; status: "failed"; error: unknown };

export async function enqueueSurfAnalysisBundles(options: {
  db: D1Database;
  queue: Queue;
  fallbackQueue: Queue;
  bundles: ForecastFactBundle[];
  now?: Date;
  fallbackDelaySeconds?: number;
}): Promise<SurfAnalysisEnqueueOutcome[]> {
  const outcomes: SurfAnalysisEnqueueOutcome[] = [];
  const recommendedDates = [
    ...new Set(
      options.bundles
        .filter(({ input }) => input.recommendationWindowIds.length > 0)
        .map(({ input }) => input.localDate)
    )
  ].sort();
  for (const bundle of options.bundles) {
    if (bundle.input.recommendationWindowIds.length === 0) {
      outcomes.push({
        localDate: bundle.input.localDate,
        status: "unavailable",
        reasonCode: "analysis_no_recommendation"
      });
      continue;
    }
    try {
      const result = await enqueueSurfAnalysis({
        db: options.db,
        queue: options.queue,
        fallbackQueue: options.fallbackQueue,
        bundle,
        now: options.now,
        fallbackDelaySeconds: options.fallbackDelaySeconds,
        fallbackFutureDatePriority: recommendedDates.indexOf(bundle.input.localDate)
      });
      outcomes.push({ localDate: bundle.input.localDate, ...result });
    } catch (error) {
      outcomes.push({ localDate: bundle.input.localDate, status: "failed", error });
    }
  }
  return outcomes;
}

export async function reconcileNarrativeEnqueues(options: {
  db: D1Database;
  queue: Queue;
  fallbackQueue: Queue;
  now?: Date;
  limit?: number;
  pendingRedeliveryMs?: number;
  fallbackDelaySeconds?: number;
}): Promise<{ enqueued: number }> {
  const now = options.now ?? new Date();
  await expireNarrativeJobs(options.db, now);
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? NARRATIVE_RECONCILIATION_LIMIT), 0),
    NARRATIVE_RECONCILIATION_LIMIT
  );
  const pendingRedeliveryMs =
    options.pendingRedeliveryMs ?? NARRATIVE_PENDING_REDELIVERY_MS;
  const candidates = await listNarrativeJobsForReconciliation(
    options.db,
    now,
    limit,
    pendingRedeliveryMs
  );
  const candidateDatePriorities = new Map(
    [...new Set(candidates.map(({ job }) => job.entity.localDate))]
      .sort()
      .map((localDate, index) => [localDate, index] as const)
  );
  let enqueued = 0;
  for (const candidate of candidates) {
    const claim = await claimNarrativeJobForEnqueue({
      db: options.db,
      jobId: candidate.job.jobId,
      now,
      pendingRedeliveryMs
    });
    if (!claim?.enqueueLeaseToken) continue;
    try {
      await enqueueNarrativeFallbackWatchdog({
        queue: options.fallbackQueue,
        jobId: claim.job.jobId,
        submissionId: claim.job.result.submissionId,
        now,
        delaySeconds: surfAnalysisFallbackDelaySeconds({
          baseDelaySeconds:
            options.fallbackDelaySeconds ?? NARRATIVE_FALLBACK_DEFAULT_DELAY_SECONDS,
          spotId: claim.job.entity.id,
          localDate: claim.job.entity.localDate,
          futureDatePriority:
            candidateDatePriorities.get(claim.job.entity.localDate) ?? 0
        }),
        trigger: "delayed_watchdog"
      });
      await options.queue.send(claim.job, { contentType: "json" });
      await markNarrativeJobEnqueued(
        options.db,
        claim.job.jobId,
        claim.enqueueLeaseToken,
        now
      );
      enqueued += 1;
    } catch (error) {
      await markNarrativeJobEnqueueFailed(
        options.db,
        claim.job.jobId,
        claim.enqueueLeaseToken,
        "queue_reconciliation_send_failed",
        now
      );
      throw error;
    }
  }
  return { enqueued };
}
