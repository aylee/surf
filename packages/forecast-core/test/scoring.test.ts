import { describe, expect, it } from "vitest";
import { buildFixtureForecast, getSpotProfile, scoreSpotWindow } from "../src/index";

describe("scoreSpotWindow", () => {
  it("scores a clean OBSF window as good or better", () => {
    const spot = getSpotProfile("obsf-central");
    const score = scoreSpotWindow(spot, {
      spotId: "obsf-central",
      forecastAt: "2026-07-08T15:00:00.000Z",
      waveHeightFt: 5,
      peakPeriodSec: 14,
      primaryDirectionDeg: 290,
      tideFt: 3,
      windSpeedKt: 6,
      windDirectionDeg: 90,
      sourceFreshnessMinutes: 30,
      activeCapabilities: ["forecast_wave_offshore", "observed_wave", "tide", "wind"]
    });

    expect(score.score).toBeGreaterThanOrEqual(70);
    expect(["good", "excellent"]).toContain(score.qualityLabel);
  });

  it("builds fixture forecasts for the v1 spots", () => {
    const forecast = buildFixtureForecast("bolinas", new Date("2026-07-08T12:00:00.000Z"));
    expect(forecast.windows).toHaveLength(4);
    expect(forecast.spot.id).toBe("bolinas");
  });
});

