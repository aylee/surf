import { describe, expect, it } from "vitest";
import { ForecastHazardSchema } from "../src/index";

const hazard = {
  headline: "Beach Hazards Statement",
  startsAt: "2026-08-02T11:30:00.000-07:00",
  endsAt: "2026-08-02T13:30:00.000-07:00",
  sourceId: "nws:point-forecast-alerts",
  sourceRunId: "hazard-run"
};

describe("ForecastHazardSchema", () => {
  it("accepts bounded or open-ended typed hazard provenance", () => {
    expect(ForecastHazardSchema.safeParse(hazard).success).toBe(true);
    expect(
      ForecastHazardSchema.safeParse({ ...hazard, startsAt: null, endsAt: null }).success
    ).toBe(true);
  });

  it.each([
    ["offset-less start", { startsAt: "2026-08-02T11:30:00" }],
    ["empty headline", { headline: "" }],
    ["empty source", { sourceId: "" }],
    ["reversed interval", { startsAt: hazard.endsAt, endsAt: hazard.startsAt }],
    ["zero-width interval", { endsAt: hazard.startsAt }]
  ])("rejects %s", (_label, override) => {
    expect(ForecastHazardSchema.safeParse({ ...hazard, ...override }).success).toBe(false);
  });
});
