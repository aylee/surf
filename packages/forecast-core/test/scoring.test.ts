import { describe, expect, it } from "vitest";
import { getSpotProfile, scoreSpotWindow } from "../src/index";
import { buildFixtureForecast } from "../test-support";

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

  it("does not downgrade clean conditions solely because the wave is one foot", () => {
    const spot = getSpotProfile("obsf-central");
    const score = scoreSpotWindow(spot, {
      spotId: "obsf-central",
      forecastAt: "2026-07-08T15:00:00.000Z",
      waveHeightFt: 1,
      peakPeriodSec: 14,
      primaryDirectionDeg: 290,
      tideFt: 3,
      windSpeedKt: 3,
      windDirectionDeg: 90,
      sourceFreshnessMinutes: 30,
      activeCapabilities: ["forecast_wave_nearshore", "tide", "wind"]
    });

    expect(score.ratingStatus).toBe("scored");
    expect(score.score).toBeGreaterThanOrEqual(70);
  });

  it("returns an explicit unknown call when sourced wave fields are missing", () => {
    const spot = getSpotProfile("bolinas");
    const score = scoreSpotWindow(spot, {
      spotId: "bolinas",
      forecastAt: "2026-07-08T15:00:00.000Z",
      waveHeightFt: null,
      peakPeriodSec: null,
      primaryDirectionDeg: null,
      tideFt: 3,
      windSpeedKt: 3,
      windDirectionDeg: 90,
      sourceFreshnessMinutes: 30,
      activeCapabilities: ["tide", "wind"]
    });

    expect(score).toMatchObject({
      ratingStatus: "unknown",
      qualityLabel: "unknown",
      score: 0,
      confidence: 0
    });
  });

  it("reduces confidence for cold-start transforms and longer forecast lead", () => {
    const spot = getSpotProfile("bolinas");
    const base = {
      spotId: spot.id,
      forecastAt: "2026-07-10T15:00:00.000Z",
      waveHeightFt: 2.5,
      peakPeriodSec: 12,
      primaryDirectionDeg: 245,
      tideFt: 2,
      windSpeedKt: 5,
      windDirectionDeg: 90,
      sourceFreshnessMinutes: 360,
      usesColdStartTransform: true,
      activeCapabilities: ["forecast_wave_nearshore", "tide", "wind"] as Array<
        "forecast_wave_nearshore" | "tide" | "wind"
      >
    };

    const near = scoreSpotWindow(spot, { ...base, forecastLeadHours: 6 });
    const far = scoreSpotWindow(spot, { ...base, forecastLeadHours: 120 });

    expect(near.confidence).toBeLessThan(75);
    expect(far.confidence).toBeLessThan(near.confidence);
  });

  it("does not apply the cold-start confidence cap to a direct sourced wave state", () => {
    const spot = getSpotProfile("obsf-central");
    const input = {
      spotId: spot.id,
      forecastAt: "2026-07-10T15:00:00.000Z",
      waveHeightFt: 4,
      peakPeriodSec: 12,
      primaryDirectionDeg: 290,
      tideFt: 2.5,
      windSpeedKt: 5,
      windDirectionDeg: 90,
      sourceFreshnessMinutes: 30,
      forecastLeadHours: 3,
      activeCapabilities: ["forecast_wave_nearshore", "observed_wave", "tide", "wind"] as Array<
        "forecast_wave_nearshore" | "observed_wave" | "tide" | "wind"
      >
    };

    const direct = scoreSpotWindow(spot, {
      ...input,
      calibrationStatus: "modeled_uncalibrated"
    });
    const coldStart = scoreSpotWindow(spot, {
      ...input,
      usesColdStartTransform: true,
      calibrationStatus: "cold_start_uncalibrated"
    });

    expect(direct.confidence).toBeGreaterThan(74);
    expect(direct.confidence).toBeLessThanOrEqual(89);
    expect(coldStart.confidence).toBeLessThanOrEqual(74);
  });

  it("scores just-outside wraparound offshore wind without a discontinuity", () => {
    const spot = getSpotProfile("bolinas");
    const input = {
      spotId: spot.id,
      forecastAt: "2026-07-10T15:00:00.000Z",
      waveHeightFt: 2.5,
      peakPeriodSec: 12,
      primaryDirectionDeg: 245,
      tideFt: 2,
      windSpeedKt: 10,
      sourceFreshnessMinutes: 30,
      activeCapabilities: ["forecast_wave_nearshore", "tide", "wind"] as Array<
        "forecast_wave_nearshore" | "tide" | "wind"
      >
    };

    const boundary = scoreSpotWindow(spot, { ...input, windDirectionDeg: 20 });
    const justOutside = scoreSpotWindow(spot, { ...input, windDirectionDeg: 25 });

    expect(boundary.windScore - justOutside.windScore).toBeLessThanOrEqual(10);
    expect(justOutside.windScore).toBeGreaterThan(75);
  });

  it("builds fixture forecasts for the v1 spots", () => {
    const forecast = buildFixtureForecast("bolinas", new Date("2026-07-08T12:00:00.000Z"));
    expect(forecast.windows).toHaveLength(25);
    expect(forecast.spot.id).toBe("bolinas");
    expect(forecast.windows.at(-1)?.forecastAt).toBe("2026-07-11T12:00:00.000Z");
    expect(forecast.windows[0]).toMatchObject({
      activeCapabilities: ["forecast_wave_offshore", "observed_wave", "tide", "wind"],
      sourceRunIds: ["fixture"]
    });
    expect(forecast.windows[0]?.caveats.length).toBeGreaterThan(0);
  });
});
