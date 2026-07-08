import { describe, expect, it } from "vitest";
import { buildDeterministicReport, buildFixtureForecast } from "../src/index";

describe("buildDeterministicReport", () => {
  it("summarizes scored facts and source caveats without inventing new fields", () => {
    const forecast = buildFixtureForecast("obsf-central", new Date("2026-07-08T12:00:00.000Z"));
    const report = buildDeterministicReport([forecast], new Date("2026-07-08T13:00:00.000Z"));

    expect(report).toContain("NorCal Surf Report");
    expect(report).toContain("Ocean Beach Central");
    expect(report).toContain("confidence");
    expect(report).toContain("Fixture forecast");
    expect(report).toContain("does not create numeric wave, wind, tide, or score values");
  });
});
