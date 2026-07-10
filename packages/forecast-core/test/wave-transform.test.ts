import { describe, expect, it } from "vitest";
import { estimateBreakingWaveHeight } from "../src/wave-transform";

describe("deterministic breaking-wave transform", () => {
  it("shoals a Stinson MOP wave to first depth-limited breaking", () => {
    const result = estimateBreakingWaveHeight({
      significantHeightM: 0.759,
      peakPeriodSec: 15.4,
      pointDepthM: 15,
      waveFromDirectionDeg: 212,
      shoreNormalDeg: 221.52
    });

    expect(result.method).toBe("linear-energy-flux-snell-depth-limited");
    expect(result.incidenceAngleDeg).toBeCloseTo(9.52, 6);
    expect(result.breakerIndex).toBe(0.78);
    expect(result.breakingDepthM).toBeCloseTo(1.598, 3);
    expect(result.estimatedBreakingHeightM).toBeCloseTo(1.246, 3);
    expect(result.shoalingFactor).toBeCloseTo(1.642, 3);
  });

  it("applies an explicit cove exposure scale before shoaling", () => {
    const raw = estimateBreakingWaveHeight({
      significantHeightM: 1.567,
      peakPeriodSec: 8.3,
      pointDepthM: 15,
      waveFromDirectionDeg: 294,
      shoreNormalDeg: 296
    });
    const sheltered = estimateBreakingWaveHeight({
      significantHeightM: 1.567,
      peakPeriodSec: 8.3,
      pointDepthM: 15,
      waveFromDirectionDeg: 294,
      shoreNormalDeg: 296,
      exposureScale: 0.6
    });

    expect(sheltered.pointHeightM).toBeCloseTo(0.9402, 4);
    expect(sheltered.estimatedBreakingHeightM).toBeCloseTo(1.327, 3);
    expect(sheltered.estimatedBreakingHeightM).toBeLessThan(raw.estimatedBreakingHeightM);
    expect(sheltered.totalHeightFactor).toBeCloseTo(0.847, 3);
  });

  it("rejects an input already beyond the depth-limited threshold", () => {
    expect(() =>
      estimateBreakingWaveHeight({
        significantHeightM: 1,
        peakPeriodSec: 10,
        pointDepthM: 1.2,
        waveFromDirectionDeg: 270,
        shoreNormalDeg: 270
      })
    ).toThrow(/already depth-limited/);
  });

  it("handles true-north wraparound and symmetric incidence consistently", () => {
    const westOfNormal = estimateBreakingWaveHeight({
      significantHeightM: 1,
      peakPeriodSec: 12,
      pointDepthM: 10,
      waveFromDirectionDeg: 350,
      shoreNormalDeg: 0
    });
    const eastOfNormal = estimateBreakingWaveHeight({
      significantHeightM: 1,
      peakPeriodSec: 12,
      pointDepthM: 10,
      waveFromDirectionDeg: 10,
      shoreNormalDeg: 360
    });

    expect(westOfNormal.incidenceAngleDeg).toBe(10);
    expect(eastOfNormal.incidenceAngleDeg).toBe(10);
    expect(westOfNormal.estimatedBreakingHeightM).toBeCloseTo(
      eastOfNormal.estimatedBreakingHeightM,
      10
    );
  });

  it("rejects finite values outside source-appropriate physical bounds", () => {
    expect(() =>
      estimateBreakingWaveHeight({
        significantHeightM: 1,
        peakPeriodSec: 80,
        pointDepthM: 10,
        waveFromDirectionDeg: 270,
        shoreNormalDeg: 270
      })
    ).toThrow(/peakPeriodSec/);
  });

  it("fails closed for directions too oblique for the approximation", () => {
    expect(() =>
      estimateBreakingWaveHeight({
        significantHeightM: 1,
        peakPeriodSec: 12,
        pointDepthM: 10,
        waveFromDirectionDeg: 5,
        shoreNormalDeg: 270
      })
    ).toThrow(/not valid/);
  });
});
