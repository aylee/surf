import { describe, expect, it } from "vitest";
import {
  CANONICAL_RECOMMENDATION_MIN_DURATION_MS,
  CANONICAL_RECOMMENDATION_SCORE_BAND,
  intervalOverlapsCivilLight,
  intervalOverlapsRange,
  selectCanonicalRecommendationIds,
  selectCanonicalRecommendationWindows,
  type CanonicalRecommendationCandidate
} from "../src/index";

const NOW = new Date("2026-08-02T14:00:00.000Z");

describe("intervalOverlapsCivilLight", () => {
  const firstLight = "2026-08-02T14:22:00.000Z";
  const lastLight = "2026-08-03T00:19:00.000Z";

  it("includes partial first- and last-light intervals with exclusive boundaries", () => {
    expect(
      intervalOverlapsCivilLight(
        "2026-08-02T14:00:00.000Z",
        "2026-08-02T15:00:00.000Z",
        firstLight,
        lastLight
      )
    ).toBe(true);
    expect(
      intervalOverlapsCivilLight(
        "2026-08-03T00:00:00.000Z",
        "2026-08-03T01:00:00.000Z",
        firstLight,
        lastLight
      )
    ).toBe(true);
    expect(
      intervalOverlapsCivilLight(
        "2026-08-02T13:00:00.000Z",
        firstLight,
        firstLight,
        lastLight
      )
    ).toBe(false);
    expect(
      intervalOverlapsCivilLight(
        lastLight,
        "2026-08-03T01:19:00.000Z",
        firstLight,
        lastLight
      )
    ).toBe(false);
  });

  it("rejects invalid and inverted intervals", () => {
    expect(intervalOverlapsCivilLight("invalid", lastLight, firstLight, lastLight)).toBe(false);
    expect(intervalOverlapsCivilLight(lastLight, firstLight, firstLight, lastLight)).toBe(false);
    expect(intervalOverlapsCivilLight(firstLight, lastLight, lastLight, firstLight)).toBe(false);
  });
});

describe("intervalOverlapsRange", () => {
  it("uses half-open boundaries for bounded hazard intervals", () => {
    expect(
      intervalOverlapsRange(
        "2026-08-02T04:00:00.000Z",
        "2026-08-02T05:00:00.000Z",
        "2026-08-02T04:30:00.000Z",
        "2026-08-02T06:30:00.000Z"
      )
    ).toBe(true);
    expect(
      intervalOverlapsRange(
        "2026-08-02T03:00:00.000Z",
        "2026-08-02T04:30:00.000Z",
        "2026-08-02T04:30:00.000Z",
        "2026-08-02T06:30:00.000Z"
      )
    ).toBe(false);
    expect(
      intervalOverlapsRange(
        "2026-08-02T06:30:00.000Z",
        "2026-08-02T07:00:00.000Z",
        "2026-08-02T04:30:00.000Z",
        "2026-08-02T06:30:00.000Z"
      )
    ).toBe(false);
  });

  it("supports open hazard bounds and rejects malformed supplied bounds", () => {
    expect(
      intervalOverlapsRange(
        "2026-08-02T04:00:00.000Z",
        "2026-08-02T05:00:00.000Z",
        null,
        null
      )
    ).toBe(true);
    expect(
      intervalOverlapsRange(
        "2026-08-02T04:00:00.000Z",
        "2026-08-02T05:00:00.000Z",
        "invalid",
        null
      )
    ).toBe(false);
  });
});

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
  it("excludes elapsed, non-daylight, unscored, and unknown-surface windows before ranking", () => {
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

    expect(ids).toEqual(["choppy-high-score", "fair"]);
  });

  it("prefers a lower complete surface and returns no call when every surface is unknown", () => {
    expect(selectCanonicalRecommendationIds([
      candidate("unknown-surface", { surfaceCondition: "unknown", score: 100 }),
      candidate("choppy", { surfaceCondition: "choppy", score: 1 })
    ], NOW)).toEqual(["choppy"]);
    expect(selectCanonicalRecommendationIds([
      candidate("unknown-a", { surfaceCondition: "unknown", score: 100 }),
      candidate("unknown-b", {
        surfaceCondition: "unknown",
        score: 90,
        forecastAt: "2026-08-02T16:00:00.000Z"
      })
    ], NOW)).toEqual([]);
  });

  it("ranks total score, confidence, and earlier time without redefining quality as surface", () => {
    const ids = selectCanonicalRecommendationIds([
      candidate("lower-score", {
        score: 88,
        confidence: 100,
        surfaceCondition: "clean",
        forecastAt: "2026-08-02T15:00:00.000Z"
      }),
      candidate("higher-score", {
        score: 90,
        confidence: 1,
        surfaceCondition: "choppy",
        forecastAt: "2026-08-02T17:00:00.000Z"
      }),
      candidate("earliest-low-confidence", {
        score: 89,
        confidence: 80,
        forecastAt: "2026-08-02T19:00:00.000Z"
      }),
      candidate("later", {
        score: 89,
        confidence: 90,
        forecastAt: "2026-08-02T23:00:00.000Z"
      }),
      candidate("earlier", {
        score: 89,
        confidence: 90,
        forecastAt: "2026-08-02T21:00:00.000Z"
      })
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

describe("selectCanonicalRecommendationWindows", () => {
  it("groups adjacent viable hours around the leader and clips both civil-light edges", () => {
    const civilLight = {
      civilLightStartAt: "2026-08-02T14:30:00.000Z",
      civilLightEndAt: "2026-08-02T16:40:00.000Z"
    };
    const windows = selectCanonicalRecommendationWindows([
      candidate("before", {
        ...civilLight,
        forecastAt: "2026-08-02T14:00:00.000Z",
        score: 77
      }),
      candidate("leader", {
        ...civilLight,
        forecastAt: "2026-08-02T15:00:00.000Z",
        score: 80
      }),
      candidate("after-at-band-edge", {
        ...civilLight,
        forecastAt: "2026-08-02T16:00:00.000Z",
        score: 80 - CANONICAL_RECOMMENDATION_SCORE_BAND
      }),
      candidate("outside-civil-light", {
        ...civilLight,
        forecastAt: "2026-08-02T17:00:00.000Z",
        score: 80
      }),
      candidate("backup", {
        forecastAt: "2026-08-03T16:00:00.000Z",
        score: 70
      })
    ], NOW);

    expect(windows[0]).toEqual({
      representativeWindowId: "leader",
      constituentWindowIds: ["before", "leader", "after-at-band-edge"],
      startAt: "2026-08-02T14:30:00.000Z",
      endAt: "2026-08-02T16:40:00.000Z",
      surfaceCondition: "fair",
      score: 80,
      confidence: 70
    });
    expect(windows[1]?.representativeWindowId).toBe("backup");
  });

  it("stops a group when the adjacent hour changes surface tier or leaves the score band", () => {
    const windows = selectCanonicalRecommendationWindows([
      candidate("leader", { forecastAt: "2026-08-02T16:00:00.000Z", score: 90 }),
      candidate("different-surface", {
        forecastAt: "2026-08-02T15:00:00.000Z",
        score: 89,
        surfaceCondition: "clean"
      }),
      candidate("outside-band", {
        forecastAt: "2026-08-02T17:00:00.000Z",
        score: 90 - CANONICAL_RECOMMENDATION_SCORE_BAND - 1
      })
    ], NOW);

    expect(windows[0]?.constituentWindowIds).toEqual(["leader"]);
    expect(windows.map(({ representativeWindowId }) => representativeWindowId)).toEqual([
      "leader",
      "different-surface"
    ]);
  });

  it("clips a winter group at last light instead of adding a blind three hours", () => {
    const civilLight = {
      civilLightStartAt: "2026-12-21T15:22:00.000Z",
      civilLightEndAt: "2026-12-22T01:05:00.000Z"
    };
    const windows = selectCanonicalRecommendationWindows([
      candidate("3pm", {
        ...civilLight,
        forecastAt: "2026-12-21T23:00:00.000Z",
        score: 82
      }),
      candidate("4pm", {
        ...civilLight,
        forecastAt: "2026-12-22T00:00:00.000Z",
        score: 84
      }),
      candidate("5pm-edge", {
        ...civilLight,
        forecastAt: "2026-12-22T01:00:00.000Z",
        score: 81
      })
    ], new Date("2026-12-21T22:00:00.000Z"));

    expect(windows[0]).toMatchObject({
      representativeWindowId: "4pm",
      constituentWindowIds: ["3pm", "4pm", "5pm-edge"],
      startAt: "2026-12-21T23:00:00.000Z",
      endAt: "2026-12-22T01:05:00.000Z"
    });
  });

  it("rejects standalone civil-light slivers while keeping a partial edge joined to a real session", () => {
    const windows = selectCanonicalRecommendationWindows([
      candidate("seven-minute-dawn", {
        forecastAt: "2026-08-02T14:00:00.000Z",
        civilLightStartAt: "2026-08-02T14:53:00.000Z",
        civilLightEndAt: "2026-08-03T00:35:00.000Z",
        score: 100
      }),
      candidate("thirty-five-minute-sunset", {
        forecastAt: "2026-08-03T00:00:00.000Z",
        civilLightStartAt: "2026-08-02T14:53:00.000Z",
        civilLightEndAt: "2026-08-03T00:35:00.000Z",
        score: 99,
        surfaceCondition: "clean"
      }),
      candidate("partial-edge", {
        forecastAt: "2026-08-02T15:00:00.000Z",
        civilLightStartAt: "2026-08-02T15:52:00.000Z",
        civilLightEndAt: "2026-08-03T00:35:00.000Z",
        score: 80
      }),
      candidate("full-adjacent-hour", {
        forecastAt: "2026-08-02T16:00:00.000Z",
        civilLightStartAt: "2026-08-02T15:52:00.000Z",
        civilLightEndAt: "2026-08-03T00:35:00.000Z",
        score: 80
      })
    ], NOW);

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      representativeWindowId: "partial-edge",
      constituentWindowIds: ["partial-edge", "full-adjacent-hour"],
      startAt: "2026-08-02T15:52:00.000Z",
      endAt: "2026-08-02T17:00:00.000Z"
    });
  });

  it("accepts a session exactly at the minimum practical duration", () => {
    const [window] = selectCanonicalRecommendationWindows([
      candidate("forty-five-minutes", {
        forecastAt: "2026-08-02T15:00:00.000Z",
        civilLightStartAt: "2026-08-02T15:15:00.000Z",
        civilLightEndAt: "2026-08-03T00:00:00.000Z"
      })
    ], NOW);

    expect(new Date(window!.endAt).getTime() - new Date(window!.startAt).getTime()).toBe(
      CANONICAL_RECOMMENDATION_MIN_DURATION_MS
    );
  });

  it("allows spot-specific deterministic scores to produce different leaders", () => {
    const leaderFor = (morningScore: number, afternoonScore: number) =>
      selectCanonicalRecommendationWindows([
        candidate("morning", { forecastAt: "2026-08-02T15:00:00.000Z", score: morningScore }),
        candidate("afternoon", { forecastAt: "2026-08-02T18:00:00.000Z", score: afternoonScore })
      ], NOW)[0]?.representativeWindowId;

    expect(leaderFor(86, 70)).toBe("morning");
    expect(leaderFor(68, 83)).toBe("afternoon");
  });

  it("fails closed when supplied civil-light boundaries are invalid or do not overlap", () => {
    expect(selectCanonicalRecommendationWindows([
      candidate("invalid-boundary", { civilLightEndAt: "not-a-time" }),
      candidate("after-last-light", {
        forecastAt: "2026-08-02T18:00:00.000Z",
        civilLightEndAt: "2026-08-02T17:30:00.000Z"
      })
    ], NOW)).toEqual([]);
  });
});
