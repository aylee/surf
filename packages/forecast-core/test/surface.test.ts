import { describe, expect, it } from "vitest";
import {
  circularWindowCenterDeg,
  distanceToCircularWindowDeg,
  getSpotProfile,
  surfaceConditionForWind
} from "../src/index";

describe("surface conditions", () => {
  it("handles offshore windows that wrap through true north", () => {
    const spot = getSpotProfile("bolinas");

    expect(circularWindowCenterDeg(270, 20)).toBe(325);
    expect(distanceToCircularWindowDeg(25, 270, 20)).toBe(5);
    expect(surfaceConditionForWind(spot, { windSpeedKt: 10, windDirectionDeg: 300 })).toBe(
      "clean"
    );
    expect(surfaceConditionForWind(spot, { windSpeedKt: 10, windDirectionDeg: 145 })).toBe(
      "choppy"
    );
  });
});
