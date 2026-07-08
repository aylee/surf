import type {
  ForecastResponse,
  ForecastWindowInput,
  QualityLabel,
  ScoredForecastWindow,
  SourceCapability,
  SpotId,
  SpotProfile,
  SurfScore
} from "@surf/contracts";
import { getSpotProfile } from "./spot-registry";

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function circularDistance(a: number, b: number): number {
  const diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return diff;
}

function withinWindow(value: number, min: number, max: number): boolean {
  if (min <= max) return value >= min && value <= max;
  return value >= min || value <= max;
}

function directionWindowScore(value: number, bestMin: number, bestMax: number, fallbackCenter: number): number {
  if (withinWindow(value, bestMin, bestMax)) return 100;
  return clampScore(100 - circularDistance(value, fallbackCenter) * 2.2);
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

function sourceScore(activeCapabilities: SourceCapability[], freshnessMinutes: number): number {
  const required: SourceCapability[] = [
    "forecast_wave_offshore",
    "observed_wave",
    "tide",
    "wind"
  ];
  const coverage = required.filter((capability) => activeCapabilities.includes(capability)).length / required.length;
  const freshnessPenalty = Math.min(35, freshnessMinutes / 12);
  return clampScore(coverage * 100 - freshnessPenalty);
}

export function scoreSpotWindow(spot: SpotProfile, input: ForecastWindowInput): SurfScore {
  const waveDirectionScore = directionWindowScore(
    input.primaryDirectionDeg,
    spot.bestSwellDeg.minDeg,
    spot.bestSwellDeg.maxDeg,
    spot.shoreNormalDeg
  );
  const periodScore = rangeScore(input.peakPeriodSec, spot.bestPeriodSec.min, spot.bestPeriodSec.max);
  const heightScore = rangeScore(input.waveHeightFt, 2, spot.id.startsWith("obsf") ? 8 : 5);
  const waveScore = clampScore(waveDirectionScore * 0.45 + periodScore * 0.35 + heightScore * 0.2);

  const windDirectionScore = directionWindowScore(
    input.windDirectionDeg,
    spot.offshoreWindFromDeg.minDeg,
    spot.offshoreWindFromDeg.maxDeg,
    (spot.offshoreWindFromDeg.minDeg + spot.offshoreWindFromDeg.maxDeg) / 2
  );
  const windSpeedScore =
    input.windSpeedKt <= spot.maxGoodWindKt
      ? 100
      : input.windSpeedKt <= spot.maxOkWindKt
        ? 70
        : clampScore(70 - (input.windSpeedKt - spot.maxOkWindKt) * 8);
  const windScore = clampScore(windDirectionScore * 0.55 + windSpeedScore * 0.45);

  const tideScore = rangeScore(input.tideFt, spot.bestTideFt.min, spot.bestTideFt.max);
  const source = sourceScore(input.activeCapabilities, input.sourceFreshnessMinutes);

  const score = clampScore(waveScore * 0.42 + windScore * 0.28 + tideScore * 0.18 + source * 0.12);
  const confidence = clampScore(source * 0.75 + Math.min(100, input.activeCapabilities.length * 12.5) * 0.25);

  return {
    spotId: spot.id,
    forecastAt: input.forecastAt,
    qualityLabel: qualityLabel(score),
    score,
    confidence,
    waveScore,
    windScore,
    tideScore,
    sourceScore: source,
    explanation: `Cold-start deterministic score: wave ${waveScore}, wind ${windScore}, tide ${tideScore}, source ${source}.`
  };
}

export function buildFixtureForecast(spotId: SpotId, now = new Date()): ForecastResponse {
  const spot = getSpotProfile(spotId);
  const activeCapabilities: SourceCapability[] = [
    "forecast_wave_offshore",
    "observed_wave",
    "tide",
    "wind"
  ];

  const windows: ScoredForecastWindow[] = Array.from({ length: 25 }, (_, index) => index * 3).map((hourOffset) => {
    const forecastAt = new Date(now.getTime() + hourOffset * 60 * 60 * 1000).toISOString();
    const input: ForecastWindowInput = {
      spotId,
      forecastAt,
      waveHeightFt: spot.id.startsWith("obsf") ? 4.5 + Math.sin(hourOffset / 12) : 2.8 + Math.sin(hourOffset / 15) * 0.5,
      peakPeriodSec: 12 + Math.cos(hourOffset / 18),
      primaryDirectionDeg: spot.bestSwellDeg.minDeg + 12,
      tideFt: spot.bestTideFt.min + 1.5 + Math.sin(hourOffset / 6),
      windSpeedKt: 7 + Math.max(0, Math.sin(hourOffset / 9) * 5),
      windDirectionDeg: spot.offshoreWindFromDeg.minDeg + 20,
      sourceFreshnessMinutes: 45,
      activeCapabilities
    };
    return {
      ...scoreSpotWindow(spot, input),
      waveHeightFt: input.waveHeightFt,
      peakPeriodSec: input.peakPeriodSec,
      primaryDirectionDeg: input.primaryDirectionDeg,
      tideFt: input.tideFt,
      windSpeedKt: input.windSpeedKt,
      windDirectionDeg: input.windDirectionDeg,
      sourceFreshnessMinutes: input.sourceFreshnessMinutes,
      activeCapabilities,
      sourceRunIds: ["fixture"],
      caveats: ["Fixture forecast. Live source rows have not been loaded for this window."]
    };
  });

  return {
    spot,
    windows,
    generatedAt: now.toISOString(),
    sourceNote: "Fixture forecast. Replace with live NOAA/CDIP/NDBC/CO-OPS/NWS ingest in v1."
  };
}
