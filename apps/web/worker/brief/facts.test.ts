import { describe, expect, it } from "vitest";
import { buildForecastFactBundle, isMaterialBriefChange } from "./facts";
import { briefForecastFixture } from "./test-helpers";

describe("forecast brief fact bundle", () => {
  it("builds stable public facts and daylight-only deterministic recommendations", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());

    expect(bundle.input.localDate).toBe("2026-08-02");
    expect(bundle.input.recommendationWindowIds).toHaveLength(2);
    for (const windowId of bundle.input.recommendationWindowIds) {
      expect(bundle.input.windows.find((window) => window.windowId === windowId)?.isDaylight).toBe(true);
    }
    expect(bundle.facts.some((fact) => fact.statement.includes("not an observed breaking-wave face height"))).toBe(true);
    expect(bundle.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.materialFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores freshness-only drift in the material fingerprint", async () => {
    const original = briefForecastFixture();
    const changed = structuredClone(original);
    changed.windows = changed.windows.map((window) => ({
      ...window,
      sourceFreshnessMinutes: window.sourceFreshnessMinutes + 30,
      sourceFreshness: window.sourceFreshness?.map((source) => ({
        ...source,
        freshnessMinutes: (source.freshnessMinutes ?? 0) + 30
      }))
    }));

    const [before, after] = await Promise.all([
      buildForecastFactBundle(original),
      buildForecastFactBundle(changed)
    ]);
    expect(after.inputFingerprint).not.toBe(before.inputFingerprint);
    expect(after.materialFingerprint).toBe(before.materialFingerprint);
    expect(isMaterialBriefChange(before, after)).toBe(false);
  });

  it.each(["missing", "stale"] as const)(
    "keeps required sources fresh when the optional buoy observation is %s",
    async (observationStatus) => {
      const forecast = briefForecastFixture();
      if (observationStatus === "missing") forecast.observation = null;
      forecast.windows = forecast.windows.map((window) => ({
        ...window,
        sourceFreshness: [
          {
            capability: "forecast_wave_nearshore" as const,
            sourceId: "cdip-mop",
            sourceRunId: "wave-fixture",
            updatedAt: "2026-08-02T12:15:00.000Z",
            freshnessMinutes: 45,
            status: "fresh" as const
          },
          {
            capability: "wind" as const,
            sourceId: "nws:point-forecast-alerts",
            sourceRunId: "wind-fixture",
            updatedAt: "2026-08-02T12:30:00.000Z",
            freshnessMinutes: 30,
            status: "fresh" as const
          },
          {
            capability: "tide" as const,
            sourceId: "coops:tide-predictions",
            sourceRunId: "tide-fixture",
            updatedAt: "2026-08-02T12:20:00.000Z",
            freshnessMinutes: 40,
            status: "fresh" as const
          },
          {
            capability: "observed_wave" as const,
            sourceId: "ndbc-46237",
            sourceRunId: observationStatus === "missing" ? null : "observation-fixture",
            updatedAt: observationStatus === "missing" ? null : "2026-08-01T12:45:00.000Z",
            freshnessMinutes: observationStatus === "missing" ? null : 24 * 60,
            status: observationStatus
          }
        ]
      }));

      const bundle = await buildForecastFactBundle(forecast);

      expect(bundle.input.windows.every((window) => window.requiredSourceStatus === "fresh")).toBe(
        true
      );
      expect(
        bundle.input.sourceHealth.find((source) => source.sourceId === "ndbc-46237:observed_wave")
      ).toMatchObject({ status: observationStatus });
      expect(
        bundle.facts
          .filter((fact) => fact.id.endsWith(":freshness"))
          .every((fact) => fact.statement.includes("required-source status fresh"))
      ).toBe(true);
    }
  );

  it("detects a displayed condition-band change as material", async () => {
    const original = briefForecastFixture();
    const changed = structuredClone(original);
    changed.windows[0] = { ...changed.windows[0]!, qualityLabel: "poor" };

    const [before, after] = await Promise.all([
      buildForecastFactBundle(original),
      buildForecastFactBundle(changed)
    ]);
    expect(after.materialFingerprint).not.toBe(before.materialFingerprint);
    expect(isMaterialBriefChange(before, after)).toBe(true);
  });

  it("treats the actual surface condition as material instead of calling a score label a condition", async () => {
    const original = briefForecastFixture();
    const changed = structuredClone(original);
    changed.windows[0] = { ...changed.windows[0]!, surfaceCondition: "choppy" };

    const [before, after] = await Promise.all([
      buildForecastFactBundle(original),
      buildForecastFactBundle(changed)
    ]);
    expect(before.facts.find((fact) => fact.id === "window:w0:condition")?.statement).toContain(
      "surface condition clean"
    );
    expect(after.materialFingerprint).not.toBe(before.materialFingerprint);
  });

  it("keeps every model-visible fact represented by the material fingerprint", async () => {
    const original = briefForecastFixture();
    const changed = structuredClone(original);
    changed.windows[0] = {
      ...changed.windows[0]!,
      windDirectionDeg: 270,
      tideTrend: "falling",
      peakPeriodSec: 16
    };

    const [before, after] = await Promise.all([
      buildForecastFactBundle(original),
      buildForecastFactBundle(changed)
    ]);
    expect(after.materialFingerprint).not.toBe(before.materialFingerprint);
    expect(after.facts.filter((fact) => fact.material).every((fact) => !/\bage\s+\d+/i.test(fact.statement))).toBe(true);
  });

  it("does not let a later forecast date change the current date source-health brief", async () => {
    const original = briefForecastFixture();
    const changed = structuredClone(original);
    const later = changed.windows.findIndex(
      (window) =>
        new Date(window.forecastAt).getTime() >= new Date("2026-08-03T07:00:00.000Z").getTime()
    );
    expect(later).toBeGreaterThanOrEqual(0);
    changed.windows[later] = {
      ...changed.windows[later]!,
      sourceFreshness: changed.windows[later]!.sourceFreshness?.map((source) => ({
        ...source,
        status: "missing",
        freshnessMinutes: null
      }))
    };

    const [before, after] = await Promise.all([
      buildForecastFactBundle(original, { localDate: "2026-08-02" }),
      buildForecastFactBundle(changed, { localDate: "2026-08-02" })
    ]);
    expect(after.materialFingerprint).toBe(before.materialFingerprint);
  });

  it("rejects a recommendation ID that is not in the forecast", async () => {
    await expect(
      buildForecastFactBundle(briefForecastFixture(), {
        recommendationWindowIds: ["not-a-window"]
      })
    ).rejects.toThrow(/not present in windows/i);
  });

  it("moves to the first forecast date when a late-night issue has no remaining local-day windows", async () => {
    const forecast = briefForecastFixture();
    forecast.generatedAt = "2026-08-03T05:00:00.000Z";
    forecast.windows = forecast.windows.filter(
      (window) => new Date(window.forecastAt).getTime() >= new Date("2026-08-03T07:00:00.000Z").getTime()
    );

    const bundle = await buildForecastFactBundle(forecast);

    expect(bundle.input.localDate).toBe("2026-08-03");
  });
});
