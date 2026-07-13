import type {
  ForecastResponse,
  ForecastWindowInput,
  ScoredForecastWindow,
  SourceCapability,
  SpotId
} from "@surf/contracts";
import { scoreSpotWindow } from "../src/scoring";
import { getSpotProfile } from "../src/spot-registry";

export function buildFixtureForecast(spotId: SpotId, now = new Date()): ForecastResponse {
  const spot = getSpotProfile(spotId);
  const activeCapabilities: SourceCapability[] = [
    "forecast_wave_offshore",
    "observed_wave",
    "tide",
    "wind"
  ];
  const windows: ScoredForecastWindow[] = Array.from(
    { length: 25 },
    (_, index) => index * 3
  ).map((hourOffset) => {
    const forecastAt = new Date(now.getTime() + hourOffset * 60 * 60 * 1000).toISOString();
    const input: ForecastWindowInput = {
      spotId,
      forecastAt,
      waveHeightFt: spot.id.startsWith("obsf")
        ? 4.5 + Math.sin(hourOffset / 12)
        : 2.8 + Math.sin(hourOffset / 15) * 0.5,
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
      caveats: ["Test-only fixture forecast."],
      primarySwell: {
        heightFt: input.waveHeightFt,
        periodSec: input.peakPeriodSec,
        directionDeg: input.primaryDirectionDeg
      },
      secondarySwell: null,
      waveProvenance: null
    };
  });

  return {
    spot,
    windows,
    generatedAt: now.toISOString(),
    sourceNote: "Test-only fixture forecast."
  };
}
