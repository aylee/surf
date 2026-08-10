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
  /** Civil-light boundaries for the candidate's local date, when available. */
  civilLightStartAt?: string | null;
  civilLightEndAt?: string | null;
  ratingStatus: RatingStatus;
  surfaceCondition: SurfaceCondition;
  score: number;
  confidence: number;
};

export type CanonicalRecommendationWindow = {
  /** The highest-ranked hourly candidate that represents this grouped window. */
  representativeWindowId: string;
  /** Eligible adjacent hourly candidates, ordered from earliest to latest. */
  constituentWindowIds: string[];
  /** Civil-light-clipped inclusive start and exclusive end instants. */
  startAt: string;
  endAt: string;
  surfaceCondition: SurfaceCondition;
  score: number;
  confidence: number;
};

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Returns whether a display interval has any usable overlap with civil light.
 * Boundaries are half-open: an interval ending exactly at first light, or
 * beginning exactly at last light, is dark. Invalid or inverted inputs never
 * become eligible.
 */
export function intervalOverlapsCivilLight(
  intervalStartAt: string,
  intervalEndAt: string,
  civilLightStartAt: string,
  civilLightEndAt: string
): boolean {
  return intervalOverlapsRange(
    intervalStartAt,
    intervalEndAt,
    civilLightStartAt,
    civilLightEndAt
  );
}

/**
 * Half-open overlap against a bounded or open-ended source interval. Missing
 * range bounds are unbounded; malformed supplied bounds fail closed.
 */
export function intervalOverlapsRange(
  intervalStartAt: string,
  intervalEndAt: string,
  rangeStartAt: string | null,
  rangeEndAt: string | null
): boolean {
  const intervalStartMs = Date.parse(intervalStartAt);
  const intervalEndMs = Date.parse(intervalEndAt);
  const rangeStartMs = rangeStartAt === null ? Number.NEGATIVE_INFINITY : Date.parse(rangeStartAt);
  const rangeEndMs = rangeEndAt === null ? Number.POSITIVE_INFINITY : Date.parse(rangeEndAt);
  if (
    !Number.isFinite(intervalStartMs) ||
    !Number.isFinite(intervalEndMs) ||
    (rangeStartAt !== null && !Number.isFinite(rangeStartMs)) ||
    (rangeEndAt !== null && !Number.isFinite(rangeEndMs)) ||
    intervalEndMs <= intervalStartMs ||
    rangeEndMs <= rangeStartMs
  ) {
    return false;
  }
  return intervalEndMs > rangeStartMs && intervalStartMs < rangeEndMs;
}

/**
 * Treat small score jitter as one usable session while keeping materially
 * different hours separate. Five points is narrow relative to the 0–100
 * score bands and is explicit so recommendation changes remain testable.
 */
export const CANONICAL_RECOMMENDATION_SCORE_BAND = 5;

/**
 * A recommendation is a practical surf session, not merely any positive
 * overlap with civil light. Partial first/last-light hours may still extend an
 * adjacent viable group, but a standalone clipped sliver must provide at least
 * 45 minutes before it can be published as a call.
 */
export const CANONICAL_RECOMMENDATION_MIN_DURATION_MS = 45 * 60 * 1000;

type RankedCandidate = CanonicalRecommendationCandidate & {
  forecastAtMs: number;
  clippedStartMs: number;
  clippedEndMs: number;
};

function rankCandidates(left: RankedCandidate, right: RankedCandidate): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) return scoreDelta;
  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta !== 0) return confidenceDelta;
  const timeDelta = left.forecastAtMs - right.forecastAtMs;
  if (timeDelta !== 0) return timeDelta;
  return left.windowId.localeCompare(right.windowId);
}

function optionalInstantMs(value: string | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function eligibleCandidate(
  candidate: CanonicalRecommendationCandidate,
  nowMs: number
): RankedCandidate | null {
  const forecastAtMs = new Date(candidate.forecastAt).getTime();
  const civilLightStartMs = optionalInstantMs(candidate.civilLightStartAt);
  const civilLightEndMs = optionalInstantMs(candidate.civilLightEndAt);
  if (
    !candidate.isDaylight ||
    candidate.ratingStatus !== "scored" ||
    candidate.surfaceCondition === "unknown" ||
    !Number.isFinite(forecastAtMs) ||
    forecastAtMs < nowMs ||
    !Number.isFinite(candidate.score) ||
    !Number.isFinite(candidate.confidence) ||
    civilLightStartMs === null ||
    civilLightEndMs === null
  ) {
    return null;
  }

  const clippedStartMs = Math.max(forecastAtMs, civilLightStartMs ?? forecastAtMs);
  const hourlyEndMs = forecastAtMs + ONE_HOUR_MS;
  const clippedEndMs = Math.min(hourlyEndMs, civilLightEndMs ?? hourlyEndMs);
  if (clippedEndMs <= clippedStartMs) return null;
  return { ...candidate, forecastAtMs, clippedStartMs, clippedEndMs };
}

function remainsInLeaderBand(
  candidate: RankedCandidate,
  leader: RankedCandidate
): boolean {
  return (
    candidate.surfaceCondition === leader.surfaceCondition &&
    Math.abs(candidate.score - leader.score) <= CANONICAL_RECOMMENDATION_SCORE_BAND
  );
}

/**
 * Selects at most two canonical recommendation windows from hourly facts.
 *
 * Presentation completeness and recommendation eligibility stay independent:
 * elapsed, dark, unscored, and wind-incomplete rows remain in read models but
 * cannot lead or extend a recommendation. The canonical total score ranks
 * candidates first; confidence, earlier opportunity, and stable ID are
 * deterministic tie-breakers.
 * Adjacent eligible hours in the leader's surface tier and five-point score
 * band become one session, clipped to the supplied civil-light boundaries.
 */
export function selectCanonicalRecommendationWindows<
  T extends CanonicalRecommendationCandidate
>(candidates: readonly T[], now: Date): CanonicalRecommendationWindow[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];

  const ranked = candidates
    .flatMap((candidate) => {
      const eligible = eligibleCandidate(candidate, nowMs);
      return eligible ? [eligible] : [];
    })
    .sort(rankCandidates);

  // A malformed input with duplicate identities must not make results depend
  // on insertion order. Ranking already places the canonical version first,
  // so retain only that version.
  const seenWindowIds = new Set<string>();
  const uniqueRanked = ranked.filter((candidate) => {
    if (seenWindowIds.has(candidate.windowId)) return false;
    seenWindowIds.add(candidate.windowId);
    return true;
  });
  const candidateByTime = new Map(
    uniqueRanked.map((candidate) => [candidate.forecastAtMs, candidate])
  );
  const remainingWindowIds = new Set(uniqueRanked.map(({ windowId }) => windowId));
  const selected: CanonicalRecommendationWindow[] = [];

  for (const leader of uniqueRanked) {
    if (!remainingWindowIds.has(leader.windowId)) continue;
    const grouped = [leader];
    for (const direction of [-1, 1] as const) {
      let adjacentTimeMs = leader.forecastAtMs + direction * ONE_HOUR_MS;
      while (true) {
        const adjacent = candidateByTime.get(adjacentTimeMs);
        if (
          !adjacent ||
          !remainingWindowIds.has(adjacent.windowId) ||
          !remainsInLeaderBand(adjacent, leader)
        ) {
          break;
        }
        grouped.push(adjacent);
        adjacentTimeMs += direction * ONE_HOUR_MS;
      }
    }
    grouped.sort(
      (left, right) =>
        left.forecastAtMs - right.forecastAtMs || left.windowId.localeCompare(right.windowId)
    );
    grouped.forEach(({ windowId }) => remainingWindowIds.delete(windowId));
    const groupedStartMs = grouped[0]!.clippedStartMs;
    const groupedEndMs = grouped.at(-1)!.clippedEndMs;
    if (groupedEndMs - groupedStartMs < CANONICAL_RECOMMENDATION_MIN_DURATION_MS) {
      continue;
    }
    selected.push({
      representativeWindowId: leader.windowId,
      constituentWindowIds: grouped.map(({ windowId }) => windowId),
      startAt: new Date(groupedStartMs).toISOString(),
      endAt: new Date(groupedEndMs).toISOString(),
      surfaceCondition: leader.surfaceCondition,
      score: leader.score,
      confidence: leader.confidence
    });
    if (selected.length === 2) break;
  }
  return selected;
}

/**
 * Returns at most two canonical recommendation window IDs.
 *
 * Compatibility wrapper for consumers that have not adopted grouped window
 * boundaries yet. Each ID is the representative hourly candidate for one
 * canonical recommendation window.
 */
export function selectCanonicalRecommendationIds<T extends CanonicalRecommendationCandidate>(
  candidates: readonly T[],
  now: Date
): string[] {
  return selectCanonicalRecommendationWindows(candidates, now).map(
    ({ representativeWindowId }) => representativeWindowId
  );
}
