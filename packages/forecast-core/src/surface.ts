import type { SpotProfile } from "@surf/contracts";

export type SurfaceCondition = "clean" | "fair" | "choppy" | "unknown";

export function circularDistanceDeg(left: number, right: number): number {
  return Math.abs((((left - right) % 360) + 540) % 360 - 180);
}

export function directionInCircularWindow(value: number, min: number, max: number): boolean {
  return min <= max ? value >= min && value <= max : value >= min || value <= max;
}

export function circularWindowCenterDeg(min: number, max: number): number {
  return min <= max ? (min + max) / 2 : (min + (max + 360 - min) / 2) % 360;
}

export function distanceToCircularWindowDeg(value: number, min: number, max: number): number {
  if (directionInCircularWindow(value, min, max)) return 0;
  return Math.min(circularDistanceDeg(value, min), circularDistanceDeg(value, max));
}

export function surfaceConditionForWind(
  spot: SpotProfile,
  window: { windSpeedKt: number | null; windDirectionDeg: number | null }
): SurfaceCondition {
  const speed = window.windSpeedKt;
  const direction = window.windDirectionDeg;
  if (speed === null || direction === null) return "unknown";
  if (speed <= 3) return "clean";
  if (
    directionInCircularWindow(
      direction,
      spot.offshoreWindFromDeg.minDeg,
      spot.offshoreWindFromDeg.maxDeg
    ) &&
    speed <= spot.maxOkWindKt
  ) {
    return "clean";
  }
  if (speed <= spot.maxGoodWindKt) return "fair";

  const offshoreCenter = circularWindowCenterDeg(
    spot.offshoreWindFromDeg.minDeg,
    spot.offshoreWindFromDeg.maxDeg
  );
  const onshoreCenter = (offshoreCenter + 180) % 360;
  return circularDistanceDeg(direction, onshoreCenter) <= 75 ? "choppy" : "fair";
}
