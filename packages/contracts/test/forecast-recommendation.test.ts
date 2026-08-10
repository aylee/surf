import { describe, expect, it } from "vitest";
import {
  ForecastRecommendationWindowSchema,
  ForecastResponseSchema,
  type ForecastRecommendationWindow,
  type ScoredForecastWindow,
  type SpotProfile
} from "../src/index";

const representativeAt = "2026-08-02T14:00:00.000Z";

const representative: ScoredForecastWindow = {
  spotId: "bolinas",
  forecastAt: representativeAt,
  ratingStatus: "scored",
  qualityLabel: "good",
  score: 80,
  confidence: 75,
  waveScore: 80,
  windScore: 80,
  tideScore: 80,
  sourceScore: 60,
  explanation: "Test recommendation.",
  waveHeightFt: 3,
  peakPeriodSec: 12,
  primaryDirectionDeg: 270,
  tideFt: 2,
  windSpeedKt: 5,
  windDirectionDeg: 300,
  sourceFreshnessMinutes: 20,
  activeCapabilities: ["forecast_wave_nearshore", "tide", "wind"],
  sourceRunIds: ["run"],
  caveats: [],
  primarySwell: null,
  secondarySwell: null,
  waveProvenance: null
};

const recommendation: ForecastRecommendationWindow = {
  localDate: "2026-08-02",
  representative,
  constituentWindowIds: [representativeAt, "2026-08-02T15:00:00.000Z"],
  startAt: "2026-08-02T14:22:00.000Z",
  endAt: "2026-08-02T16:00:00.000Z"
};

const spot: SpotProfile = {
  id: "bolinas",
  name: "Bolinas",
  aliases: [],
  region: "norcal",
  lat: 37.9,
  lon: -122.7,
  timezone: "America/Los_Angeles",
  shoreNormalDeg: 220,
  bestSwellDeg: { minDeg: 180, maxDeg: 300 },
  workableSwellDeg: { minDeg: 150, maxDeg: 330 },
  bestPeriodSec: { min: 10, max: 18 },
  bestTideFt: { min: 1, max: 5 },
  offshoreWindFromDeg: { minDeg: 270, maxDeg: 60 },
  maxGoodWindKt: 8,
  maxOkWindKt: 14,
  notes: "Test spot."
};

describe("ForecastRecommendationWindowSchema", () => {
  it("accepts a bounded, ordered recommendation projection", () => {
    expect(ForecastRecommendationWindowSchema.safeParse(recommendation).success).toBe(true);
  });

  it.each([
    ["offset-less timestamp", { startAt: "2026-08-02T14:22:00" }],
    ["duplicate constituents", { constituentWindowIds: [representativeAt, representativeAt] }],
    ["missing representative", { constituentWindowIds: ["2026-08-02T15:00:00.000Z"] }],
    ["reversed boundary", { startAt: recommendation.endAt, endAt: recommendation.startAt }],
    [
      "more than 24 constituents",
      {
        constituentWindowIds: Array.from({ length: 25 }, (_, index) =>
          new Date(Date.parse(representativeAt) + index * 60 * 60 * 1000).toISOString()
        )
      }
    ]
  ])("rejects %s", (_label, override) => {
    expect(
      ForecastRecommendationWindowSchema.safeParse({ ...recommendation, ...override }).success
    ).toBe(false);
  });

  it("rejects a recommendation whose timestamps do not match the spot-local date", () => {
    expect(
      ForecastResponseSchema.safeParse({
        spot,
        windows: [],
        generatedAt: "2026-08-02T13:00:00.000Z",
        sourceNote: "Test.",
        recommendations: [{ ...recommendation, localDate: "2026-08-03" }]
      }).success
    ).toBe(false);
  });

  it("rejects a recommendation whose end crosses into another spot-local date", () => {
    expect(
      ForecastResponseSchema.safeParse({
        spot,
        windows: [],
        generatedAt: "2026-08-02T13:00:00.000Z",
        sourceNote: "Test.",
        recommendations: [{ ...recommendation, endAt: "2026-08-03T08:00:00.000Z" }]
      }).success
    ).toBe(false);
  });

  it("accepts a persisted pre-alias forecast payload and defaults aliases to empty", () => {
    const { aliases: _aliases, ...legacySpot } = spot;
    const parsed = ForecastResponseSchema.parse({
      spot: legacySpot,
      windows: [],
      generatedAt: "2026-08-02T13:00:00.000Z",
      sourceNote: "Persisted before spot aliases were added."
    });

    expect(parsed.spot.aliases).toEqual([]);
  });
});
