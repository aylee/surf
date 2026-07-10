import type {
  ForecastWindowInput,
  QualityLabel,
  SourceCapability,
  SpotProfile,
  SurfScore
} from "@surf/contracts";
import {
  circularDistanceDeg,
  distanceToCircularWindowDeg,
  directionInCircularWindow
} from "./surface";

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function directionWindowScore(value: number, bestMin: number, bestMax: number): number {
  return clampScore(100 - distanceToCircularWindowDeg(value, bestMin, bestMax) * 2.2);
}

function swellDirectionScore(spot: SpotProfile, value: number): number {
  if (directionInCircularWindow(value, spot.bestSwellDeg.minDeg, spot.bestSwellDeg.maxDeg)) return 100;
  if (directionInCircularWindow(value, spot.workableSwellDeg.minDeg, spot.workableSwellDeg.maxDeg)) return 65;
  return clampScore(45 - circularDistanceDeg(value, spot.shoreNormalDeg));
}

function rangeScore(value: number, min: number, max: number): number {
  if (value >= min && value <= max) return 100;
  const distance = value < min ? min - value : value - max;
  return clampScore(100 - distance * 22);
}

function qualityLabel(score: number): QualityLabel {
  if (score >= 86) return "excellent";
  if (score >= 72) return "good";
  if (score >= 56) return "fun";
  if (score >= 38) return "fair";
  return "poor";
}

function sourceScore(
  activeCapabilities: SourceCapability[],
  freshnessMinutes: number,
  forecastLeadHours = 0,
  usesColdStartTransform = false
): number {
  const hasWave =
    activeCapabilities.includes("forecast_wave_nearshore") ||
    activeCapabilities.includes("forecast_wave_offshore");
  const coverage =
    (hasWave ? 45 : 0) +
    (activeCapabilities.includes("wind") ? 25 : 0) +
    (activeCapabilities.includes("tide") ? 20 : 0) +
    (activeCapabilities.includes("observed_wave") ? 10 : 0);
  const freshnessPenalty = Math.min(15, freshnessMinutes / 120);
  const leadPenalty = Math.min(25, forecastLeadHours / 5);
  const transformPenalty = usesColdStartTransform ? 15 : 0;
  const score = clampScore(coverage - freshnessPenalty - leadPenalty - transformPenalty);
  return usesColdStartTransform ? Math.min(74, score) : score;
}

export function scoreSpotWindow(spot: SpotProfile, input: ForecastWindowInput): SurfScore {
  const source = sourceScore(
    input.activeCapabilities,
    input.sourceFreshnessMinutes,
    input.forecastLeadHours,
    input.usesColdStartTransform
  );
  const hasWave =
    input.waveHeightFt !== null && input.peakPeriodSec !== null && input.primaryDirectionDeg !== null;
  if (!hasWave) {
    return {
      spotId: spot.id,
      forecastAt: input.forecastAt,
      ratingStatus: "unknown",
      qualityLabel: "unknown",
      score: 0,
      confidence: 0,
      waveScore: 0,
      windScore: 0,
      tideScore: 0,
      sourceScore: source,
      explanation: "No surf call: a sourced wave height, period, and direction are required."
    };
  }

  const waveDirectionScore = swellDirectionScore(spot, input.primaryDirectionDeg!);
  const periodScore = rangeScore(input.peakPeriodSec!, spot.bestPeriodSec.min, spot.bestPeriodSec.max);
  // Size is reported separately. A clean one-foot wave is not downgraded merely for being small.
  const waveScore = clampScore(waveDirectionScore * 0.6 + periodScore * 0.4);

  let weightedScore = waveScore * 0.5;
  let scoreWeight = 0.5;
  let windScore = 0;
  if (input.windSpeedKt !== null && input.windDirectionDeg !== null) {
    const windDirectionScore = directionWindowScore(
      input.windDirectionDeg,
      spot.offshoreWindFromDeg.minDeg,
      spot.offshoreWindFromDeg.maxDeg
    );
    const windSpeedScore =
      input.windSpeedKt <= spot.maxGoodWindKt
        ? 100
        : input.windSpeedKt <= spot.maxOkWindKt
          ? 70
          : clampScore(70 - (input.windSpeedKt - spot.maxOkWindKt) * 8);
    windScore = clampScore(windDirectionScore * 0.55 + windSpeedScore * 0.45);
    weightedScore += windScore * 0.3;
    scoreWeight += 0.3;
  }

  let tideScore = 0;
  if (input.tideFt !== null) {
    tideScore = rangeScore(input.tideFt, spot.bestTideFt.min, spot.bestTideFt.max);
    weightedScore += tideScore * 0.2;
    scoreWeight += 0.2;
  }

  const score = clampScore(weightedScore / scoreWeight);
  const confidence = source;

  return {
    spotId: spot.id,
    forecastAt: input.forecastAt,
    ratingStatus: "scored",
    qualityLabel: qualityLabel(score),
    score,
    confidence,
    waveScore,
    windScore,
    tideScore,
    sourceScore: source,
    explanation: `Objective condition score: swell organization ${waveScore}, wind ${windScore}, tide ${tideScore}; size is reported separately. Source confidence ${source}.`
  };
}
