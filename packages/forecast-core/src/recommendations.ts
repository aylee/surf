import type { RatingStatus } from "@surf/contracts";
import type { SurfaceCondition } from "./surface";

/**
 * The minimum deterministic facts needed to choose canonical surf windows.
 * Keeping this structural lets API, UI, and brief fact models share the same
 * selector without importing one another's richer representations.
 */
export type CanonicalRecommendationCandidate = {
  windowId: string;
  forecastAt: string;
  isDaylight: boolean;
  ratingStatus: RatingStatus;
  surfaceCondition: SurfaceCondition;
  score: number;
  confidence: number;
};

const SURFACE_RANK: Record<SurfaceCondition, number> = {
  clean: 3,
  fair: 2,
  choppy: 1,
  unknown: 0
};

type RankedCandidate = CanonicalRecommendationCandidate & { forecastAtMs: number };

/**
 * Returns at most two canonical recommendation window IDs.
 *
 * Only current-or-future daylight windows with a deterministic score are
 * eligible. Surface quality intentionally outranks the numeric spot score,
 * followed by confidence and the earlier opportunity. Window ID is the final
 * tie-breaker so results do not depend on input order.
 */
export function selectCanonicalRecommendationIds<T extends CanonicalRecommendationCandidate>(
  candidates: readonly T[],
  now: Date
): string[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];

  const ranked: RankedCandidate[] = candidates.flatMap((candidate) => {
    const forecastAtMs = new Date(candidate.forecastAt).getTime();
    if (
      !candidate.isDaylight ||
      candidate.ratingStatus !== "scored" ||
      !Number.isFinite(forecastAtMs) ||
      forecastAtMs < nowMs ||
      !Number.isFinite(candidate.score) ||
      !Number.isFinite(candidate.confidence)
    ) {
      return [];
    }
    return [{ ...candidate, forecastAtMs }];
  });

  ranked.sort((left, right) => {
    const surfaceDelta = SURFACE_RANK[right.surfaceCondition] - SURFACE_RANK[left.surfaceCondition];
    if (surfaceDelta !== 0) return surfaceDelta;
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    const confidenceDelta = right.confidence - left.confidence;
    if (confidenceDelta !== 0) return confidenceDelta;
    const timeDelta = left.forecastAtMs - right.forecastAtMs;
    if (timeDelta !== 0) return timeDelta;
    return left.windowId.localeCompare(right.windowId);
  });

  const selected: string[] = [];
  for (const candidate of ranked) {
    if (selected.includes(candidate.windowId)) continue;
    selected.push(candidate.windowId);
    if (selected.length === 2) break;
  }
  return selected;
}
