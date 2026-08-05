import { describe, expect, it } from "vitest";
import {
  freshnessVerdict,
  sourceFreshnessVerdict,
  SourceFreshnessSchema,
  type SourceFreshness
} from "../src/index.js";

function entry(overrides: Partial<SourceFreshness> = {}): SourceFreshness {
  return SourceFreshnessSchema.parse({
    capability: "observed_wave",
    sourceId: "ndbc-46237",
    sourceRunId: "run-1",
    updatedAt: "2026-08-05T01:00:00.000Z",
    freshnessMinutes: 30,
    status: "fresh",
    expectedCadenceMinutes: 60,
    graceMinutes: 60,
    ...overrides
  });
}

describe("freshnessVerdict", () => {
  it("classifies the cadence matrix for model-cycle sources", () => {
    // CDIP-style: cadence 360, grace 180.
    const cdip = (ageMinutes: number | null) =>
      freshnessVerdict({ ageMinutes, expectedCadenceMinutes: 360, graceMinutes: 180 });
    expect(cdip(0)).toBe("fresh");
    expect(cdip(359)).toBe("fresh");
    expect(cdip(360)).toBe("fresh"); // inclusive boundary
    expect(cdip(361)).toBe("aging");
    expect(cdip(540)).toBe("aging"); // inclusive boundary
    expect(cdip(541)).toBe("late");
    expect(cdip(100_000)).toBe("late");
  });

  it("classifies hourly buoys with generous grace", () => {
    const ndbc = (ageMinutes: number) =>
      freshnessVerdict({ ageMinutes, expectedCadenceMinutes: 60, graceMinutes: 60 });
    expect(ndbc(45)).toBe("fresh");
    expect(ndbc(60)).toBe("fresh");
    expect(ndbc(90)).toBe("aging");
    expect(ndbc(120)).toBe("aging");
    expect(ndbc(121)).toBe("late"); // matches the historical 120-minute stale line
  });

  it("classifies daily tide predictions as fetch-recency", () => {
    const tide = (ageMinutes: number) =>
      freshnessVerdict({ ageMinutes, expectedCadenceMinutes: 1440, graceMinutes: 360 });
    expect(tide(600)).toBe("fresh");
    expect(tide(1500)).toBe("aging");
    expect(tide(1801)).toBe("late");
  });

  it("is total: null, undefined, and non-finite ages are explicitly late", () => {
    expect(freshnessVerdict({ ageMinutes: null, expectedCadenceMinutes: 60, graceMinutes: 0 })).toBe("late");
    expect(freshnessVerdict({ ageMinutes: undefined, expectedCadenceMinutes: 60, graceMinutes: 0 })).toBe("late");
    expect(freshnessVerdict({ ageMinutes: Number.NaN, expectedCadenceMinutes: 60, graceMinutes: 0 })).toBe("late");
    expect(
      freshnessVerdict({ ageMinutes: Number.POSITIVE_INFINITY, expectedCadenceMinutes: 60, graceMinutes: 0 })
    ).toBe("late");
  });

  it("is total: invalid cadence or grace never yields NaN or a throw", () => {
    expect(freshnessVerdict({ ageMinutes: 10, expectedCadenceMinutes: null, graceMinutes: 0 })).toBe("late");
    expect(freshnessVerdict({ ageMinutes: 10, expectedCadenceMinutes: undefined })).toBe("late");
    expect(freshnessVerdict({ ageMinutes: 10, expectedCadenceMinutes: 0, graceMinutes: 0 })).toBe("late");
    expect(freshnessVerdict({ ageMinutes: 10, expectedCadenceMinutes: -60, graceMinutes: 0 })).toBe("late");
    expect(freshnessVerdict({ ageMinutes: 10, expectedCadenceMinutes: Number.NaN, graceMinutes: 0 })).toBe("late");
    // Invalid grace degrades to zero grace, not NaN.
    expect(freshnessVerdict({ ageMinutes: 61, expectedCadenceMinutes: 60, graceMinutes: Number.NaN })).toBe("late");
    expect(freshnessVerdict({ ageMinutes: 61, expectedCadenceMinutes: 60, graceMinutes: -5 })).toBe("late");
    expect(freshnessVerdict({ ageMinutes: 60, expectedCadenceMinutes: 60, graceMinutes: null })).toBe("fresh");
  });

  it("clamps negative clock-skew ages to zero", () => {
    expect(freshnessVerdict({ ageMinutes: -30, expectedCadenceMinutes: 60, graceMinutes: 0 })).toBe("fresh");
  });
});

describe("sourceFreshnessVerdict", () => {
  it("derives the verdict from the entry's own shipped cadence", () => {
    expect(sourceFreshnessVerdict(entry({ freshnessMinutes: 30 }))).toBe("fresh");
    expect(sourceFreshnessVerdict(entry({ freshnessMinutes: 90 }))).toBe("aging");
    expect(sourceFreshnessVerdict(entry({ freshnessMinutes: 500, status: "stale" }))).toBe("late");
  });

  it("returns null for pre-cadence entries so callers keep the shipped status", () => {
    const legacy = SourceFreshnessSchema.parse({
      capability: "tide",
      sourceId: "coops:tide-predictions",
      sourceRunId: null,
      updatedAt: null,
      freshnessMinutes: 45,
      status: "fresh"
    });
    expect(sourceFreshnessVerdict(legacy)).toBeNull();
    expect(sourceFreshnessVerdict(entry({ expectedCadenceMinutes: null }))).toBeNull();
  });

  it("treats a missing age on a cadence-bearing entry as late", () => {
    expect(sourceFreshnessVerdict(entry({ freshnessMinutes: null, status: "missing" }))).toBe("late");
  });
});

describe("SourceFreshnessSchema cadence fields", () => {
  it("stays additive: entries without cadence fields still parse", () => {
    const parsed = SourceFreshnessSchema.parse({
      capability: "wind",
      sourceId: "nws:point-forecast-alerts",
      sourceRunId: null,
      updatedAt: null,
      freshnessMinutes: null,
      status: "missing"
    });
    expect(parsed.expectedCadenceMinutes).toBeUndefined();
    expect(parsed.graceMinutes).toBeUndefined();
  });

  it("rejects nonpositive cadence and negative grace", () => {
    expect(SourceFreshnessSchema.safeParse({ ...entry(), expectedCadenceMinutes: 0 }).success).toBe(false);
    expect(SourceFreshnessSchema.safeParse({ ...entry(), graceMinutes: -1 }).success).toBe(false);
  });
});
