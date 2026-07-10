const GRAVITY_MS2 = 9.80665;

export const DEFAULT_BREAKER_INDEX = 0.78;

export type BreakingWaveInput = {
  significantHeightM: number;
  peakPeriodSec: number;
  pointDepthM: number;
  waveFromDirectionDeg: number;
  shoreNormalDeg: number;
  exposureScale?: number;
  breakerIndex?: number;
};

export type BreakingWaveEstimate = {
  pointHeightM: number;
  estimatedBreakingHeightM: number;
  breakingDepthM: number;
  incidenceAngleDeg: number;
  exposureScale: number;
  shoalingFactor: number;
  totalHeightFactor: number;
  breakerIndex: number;
  method: "linear-energy-flux-snell-depth-limited";
};

type WaveKinematics = {
  phaseSpeedMs: number;
  groupSpeedMs: number;
};

function finitePositive(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and greater than zero.`);
  }
  return value;
}

function bounded(label: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be finite and between ${min} and ${max}.`);
  }
  return value;
}

function circularDistanceDeg(left: number, right: number): number {
  return Math.abs((((left - right) % 360) + 540) % 360 - 180);
}

/** Solve the linear dispersion relation omega^2 = gk tanh(kh). */
function waveKinematics(periodSec: number, depthM: number): WaveKinematics {
  const angularFrequency = (2 * Math.PI) / periodSec;
  let waveNumber = Math.max((angularFrequency ** 2) / GRAVITY_MS2, 1e-8);
  let converged = false;

  for (let iteration = 0; iteration < 50; iteration += 1) {
    const kh = waveNumber * depthM;
    const tanh = Math.tanh(kh);
    const cosh = Math.cosh(kh);
    const residual = GRAVITY_MS2 * waveNumber * tanh - angularFrequency ** 2;
    const derivative = GRAVITY_MS2 * (tanh + kh / (cosh ** 2));
    if (!Number.isFinite(residual) || !Number.isFinite(derivative) || derivative <= 0) {
      throw new Error("Linear dispersion solver produced invalid intermediate values.");
    }
    const next = Math.max(waveNumber - residual / derivative, 1e-8);
    if (Math.abs(next - waveNumber) < 1e-12) {
      waveNumber = next;
      converged = true;
      break;
    }
    waveNumber = next;
  }

  const finalResidual =
    GRAVITY_MS2 * waveNumber * Math.tanh(waveNumber * depthM) - angularFrequency ** 2;
  if (!converged || !Number.isFinite(finalResidual) || Math.abs(finalResidual) > 1e-9) {
    throw new Error("Linear dispersion solver did not converge.");
  }

  const phaseSpeedMs = angularFrequency / waveNumber;
  const twiceKh = 2 * waveNumber * depthM;
  const finiteDepthTerm = twiceKh > 50 ? 0 : twiceKh / Math.sinh(twiceKh);
  const groupSpeedMs = phaseSpeedMs * 0.5 * (1 + finiteDepthTerm);
  if (
    !Number.isFinite(phaseSpeedMs) ||
    phaseSpeedMs <= 0 ||
    !Number.isFinite(groupSpeedMs) ||
    groupSpeedMs <= 0
  ) {
    throw new Error("Linear dispersion solver returned invalid wave speeds.");
  }
  return { phaseSpeedMs, groupSpeedMs };
}

/**
 * Carry a modeled nearshore Hs to first depth-limited breaking.
 *
 * Assumptions are intentionally narrow and inspectable: locally parallel
 * contours, linear wave dispersion, conserved shore-normal energy flux,
 * Snell refraction, no bottom-friction/dissipation term, and H_b = gamma h_b.
 * Directions are true-compass bearings FROM which waves arrive; shoreNormalDeg
 * is the seaward-facing local normal in the same convention. This is a
 * deterministic bulk-Hs diagnostic, not measured or calibrated surf-face truth.
 */
export function estimateBreakingWaveHeight(input: BreakingWaveInput): BreakingWaveEstimate {
  const significantHeightM = bounded("significantHeightM", input.significantHeightM, 0.01, 50);
  const peakPeriodSec = bounded("peakPeriodSec", input.peakPeriodSec, 1, 40);
  const pointDepthM = bounded("pointDepthM", input.pointDepthM, 0.05, 2_000);
  const exposureScale = bounded("exposureScale", input.exposureScale ?? 1, 0.01, 2);
  const breakerIndex = finitePositive("breakerIndex", input.breakerIndex ?? DEFAULT_BREAKER_INDEX);
  if (breakerIndex < 0.5 || breakerIndex > 1) {
    throw new RangeError("breakerIndex must be between 0.5 and 1.");
  }
  bounded("waveFromDirectionDeg", input.waveFromDirectionDeg, 0, 360);
  bounded("shoreNormalDeg", input.shoreNormalDeg, 0, 360);

  const incidenceAngleDeg = circularDistanceDeg(
    input.waveFromDirectionDeg,
    input.shoreNormalDeg
  );
  if (incidenceAngleDeg >= 85) {
    throw new RangeError(
      `Wave direction is ${incidenceAngleDeg.toFixed(1)} degrees from shore normal; ` +
        "the parallel-contour shoaling estimate is not valid for this window."
    );
  }

  const pointHeightM = significantHeightM * exposureScale;
  if (!Number.isFinite(pointHeightM)) {
    throw new RangeError("Exposure-adjusted point height must be finite.");
  }
  const incidenceAngleRad = (incidenceAngleDeg * Math.PI) / 180;
  const pointKinematics = waveKinematics(peakPeriodSec, pointDepthM);
  const snellInvariant = Math.sin(incidenceAngleRad) / pointKinematics.phaseSpeedMs;
  const pointNormalFlux = pointKinematics.groupSpeedMs * Math.cos(incidenceAngleRad);

  const heightAtDepth = (depthM: number): number => {
    const kinematics = waveKinematics(peakPeriodSec, depthM);
    const sine = Math.max(
      -0.999999,
      Math.min(0.999999, snellInvariant * kinematics.phaseSpeedMs)
    );
    const angle = Math.asin(sine);
    const normalFlux = kinematics.groupSpeedMs * Math.cos(angle);
    const heightM = pointHeightM * Math.sqrt(pointNormalFlux / normalFlux);
    if (!Number.isFinite(normalFlux) || normalFlux <= 0 || !Number.isFinite(heightM) || heightM <= 0) {
      throw new Error("Bulk shoaling diagnostic produced invalid energy-flux values.");
    }
    return heightM;
  };

  if (pointHeightM >= breakerIndex * pointDepthM) {
    throw new RangeError(
      "The exposure-adjusted input is already depth-limited at the model point; first breaking cannot be reconstructed shoreward."
    );
  }

  const minimumDepthM = Math.min(0.05, pointDepthM / 10);
  let deeperDepthM = pointDepthM;
  let deeperGap = heightAtDepth(deeperDepthM) - breakerIndex * deeperDepthM;
  let shallowerDepthM: number | null = null;

  for (let index = 1; index <= 1200; index += 1) {
    const depthM = pointDepthM - ((pointDepthM - minimumDepthM) * index) / 1200;
    const gap = heightAtDepth(depthM) - breakerIndex * depthM;
    if (gap >= 0 && deeperGap < 0) {
      shallowerDepthM = depthM;
      break;
    }
    deeperDepthM = depthM;
    deeperGap = gap;
  }

  if (shallowerDepthM === null) {
    throw new Error("No depth-limited breaking intersection was found.");
  }

  let lowerDepthM = shallowerDepthM;
  let upperDepthM = deeperDepthM;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const depthM = (lowerDepthM + upperDepthM) / 2;
    const gap = heightAtDepth(depthM) - breakerIndex * depthM;
    if (gap >= 0) lowerDepthM = depthM;
    else upperDepthM = depthM;
  }

  const breakingDepthM = (lowerDepthM + upperDepthM) / 2;
  const estimatedBreakingHeightM = heightAtDepth(breakingDepthM);
  const result: BreakingWaveEstimate = {
    pointHeightM,
    estimatedBreakingHeightM,
    breakingDepthM,
    incidenceAngleDeg,
    exposureScale,
    shoalingFactor: estimatedBreakingHeightM / pointHeightM,
    totalHeightFactor: estimatedBreakingHeightM / significantHeightM,
    breakerIndex,
    method: "linear-energy-flux-snell-depth-limited"
  };
  if (
    Object.entries(result).some(
      ([key, value]) => key !== "method" && (typeof value !== "number" || !Number.isFinite(value))
    )
  ) {
    throw new Error("Bulk shoaling diagnostic returned non-finite output.");
  }
  return result;
}
