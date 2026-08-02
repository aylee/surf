import { describe, expect, it } from "vitest";
import {
  selectCanonicalRecommendationIds,
  type CanonicalRecommendationCandidate
} from "../src/index";

const NOW = new Date("2026-08-02T14:00:00.000Z");

function candidate(
  windowId: string,
  overrides: Partial<CanonicalRecommendationCandidate> = {}
): CanonicalRecommendationCandidate {
  return {
    windowId,
    forecastAt: "2026-08-02T15:00:00.000Z",
    isDaylight: true,
    ratingStatus: "scored",
    surfaceCondition: "fair",
    score: 70,
    confidence: 70,
    ...overrides
  };
}

describe("selectCanonicalRecommendationIds", () => {
  it("excludes elapsed, non-daylight, and unscored windows before ranking", () => {
    const ids = selectCanonicalRecommendationIds([
      candidate("elapsed", {
        forecastAt: "2026-08-02T13:59:59.999Z",
        surfaceCondition: "clean",
        score: 100
      }),
      candidate("night", { isDaylight: false, surfaceCondition: "clean", score: 100 }),
      candidate("unknown-call", { ratingStatus: "unknown", surfaceCondition: "clean", score: 100 }),
      candidate("unknown-surface", { surfaceCondition: "unknown", score: 100 }),
      candidate("choppy-high-score", { surfaceCondition: "choppy", score: 100 }),
      candidate("fair", { surfaceCondition: "fair", score: 60 }),
      candidate("clean-low-score", { surfaceCondition: "clean", score: 10 })
    ], NOW);

    expect(ids).toEqual(["clean-low-score", "fair"]);
    expect(selectCanonicalRecommendationIds([
      candidate("unknown-surface", { surfaceCondition: "unknown", score: 100 }),
      candidate("choppy", { surfaceCondition: "choppy", score: 1 })
    ], NOW)).toEqual(["choppy", "unknown-surface"]);
  });

  it("ranks score, confidence, and earlier time within one surface condition", () => {
    const ids = selectCanonicalRecommendationIds([
      candidate("lower-score", { score: 88, confidence: 100 }),
      candidate("higher-score", { score: 90, confidence: 1, forecastAt: "2026-08-02T18:00:00.000Z" }),
      candidate("earliest-low-confidence", { score: 89, confidence: 80, forecastAt: "2026-08-02T15:00:00.000Z" }),
      candidate("later", { score: 89, confidence: 90, forecastAt: "2026-08-02T17:00:00.000Z" }),
      candidate("earlier", { score: 89, confidence: 90, forecastAt: "2026-08-02T16:00:00.000Z" })
    ], NOW);

    expect(ids).toEqual(["higher-score", "earlier"]);
  });

  it("uses stable IDs as the final tie-breaker and returns each ID once", () => {
    const candidates = [candidate("window-b"), candidate("window-a"), candidate("window-a")];
    const originalOrder = candidates.map(({ windowId }) => windowId);

    expect(selectCanonicalRecommendationIds(candidates, NOW)).toEqual(["window-a", "window-b"]);
    expect(candidates.map(({ windowId }) => windowId)).toEqual(originalOrder);
  });

  it("fails closed for invalid times or non-finite ranking values", () => {
    expect(selectCanonicalRecommendationIds([
      candidate("invalid-time", { forecastAt: "not-a-time" }),
      candidate("invalid-score", { score: Number.NaN }),
      candidate("invalid-confidence", { confidence: Number.POSITIVE_INFINITY })
    ], NOW)).toEqual([]);
    expect(selectCanonicalRecommendationIds([candidate("valid")], new Date("invalid"))).toEqual([]);
  });
});
