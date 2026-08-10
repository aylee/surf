import { describe, expect, it } from "vitest";
import {
  FORECAST_BRIEF_GENERATION_CONTRACT,
  buildForecastFactBundle,
  forecastBriefLockedFacts,
  isMaterialBriefChange
} from "./facts";
import { briefForecastFixture } from "./test-helpers";

describe("forecast brief fact bundle", () => {
  it("keeps first- and last-light overlap eligible independently of wave-source validity", async () => {
    const forecast = briefForecastFixture();
    const morning = {
      ...forecast.windows[0]!,
      forecastAt: "2026-08-02T14:00:00.000Z",
      waveHeightFt: 3,
      waveState: {
        ...forecast.windows[0]!.waveState!,
        validFrom: "2026-08-02T13:00:00.000Z",
        validTo: "2026-08-02T14:00:00.000Z"
      }
    };
    const evening = {
      ...forecast.windows[0]!,
      forecastAt: "2026-08-03T00:00:00.000Z",
      waveState: {
        ...forecast.windows[0]!.waveState!,
        validFrom: "2026-08-02T23:00:00.000Z",
        validTo: "2026-08-03T00:00:00.000Z"
      }
    };
    forecast.interval = "1h";
    forecast.windows = [morning, evening];
    forecast.sunPhases = [{
      localDate: "2026-08-02",
      firstLight: "2026-08-02T14:22:00.000Z",
      sunrise: "2026-08-02T14:50:00.000Z",
      sunset: "2026-08-02T23:50:00.000Z",
      lastLight: "2026-08-03T00:19:00.000Z"
    }];
    forecast.recommendations = [
      {
        localDate: "2026-08-02",
        representative: morning,
        constituentWindowIds: [morning.forecastAt],
        startAt: "2026-08-02T14:22:00.000Z",
        endAt: "2026-08-02T15:00:00.000Z"
      },
      {
        localDate: "2026-08-02",
        representative: evening,
        constituentWindowIds: [evening.forecastAt],
        startAt: evening.forecastAt,
        endAt: "2026-08-03T00:19:00.000Z"
      }
    ];

    const bundle = await buildForecastFactBundle(forecast, { localDate: "2026-08-02" });

    expect(bundle.input.windows.map(({ isDaylight }) => isDaylight)).toEqual([true, true]);
    expect(bundle.input.windows[0]?.surfSizeLabel).toBe("2–3 ft");
  });

  it("builds stable public facts and daylight-only deterministic recommendations", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());

    expect(bundle.input.localDate).toBe("2026-08-02");
    expect(bundle.input.recommendationWindowIds).toHaveLength(2);
    for (const windowId of bundle.input.recommendationWindowIds) {
      expect(bundle.input.windows.find((window) => window.windowId === windowId)?.isDaylight).toBe(true);
    }
    expect(bundle.facts.some((fact) => fact.statement.includes("not an observed breaking-wave face height"))).toBe(true);
    expect(bundle.schemaVersion).toBe(1);
    expect(FORECAST_BRIEF_GENERATION_CONTRACT).toEqual({
      briefSchemaVersion: 2,
      promptVersion: "surf-brief-v2",
      qualityPolicyVersion: "surf-brief-quality-v2",
      modelId: "gemini-3.6-flash",
      thinkingLevel: "low"
    });
    expect(bundle.facts.some((fact) => fact.role === "support")).toBe(true);
    expect(bundle.facts.some((fact) => fact.role === "tradeoff")).toBe(true);
    expect(forecastBriefLockedFacts(bundle).length).toBeGreaterThan(0);
    expect(bundle.facts.find((fact) => fact.id === "observation:latest")?.role).toBe("context");
    expect(forecastBriefLockedFacts(bundle).some((fact) => fact.kind === "observation")).toBe(
      false
    );
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
          .every((fact) => fact.statement.includes("required forecast sources are fresh"))
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

  it("treats presentation metadata as material to code-owned labels", async () => {
    const original = briefForecastFixture();
    const renamed = structuredClone(original);
    renamed.spot = { ...renamed.spot, name: "Linda Mar renamed" };

    const [before, after] = await Promise.all([
      buildForecastFactBundle(original),
      buildForecastFactBundle(renamed)
    ]);
    expect(after.materialFingerprint).not.toBe(before.materialFingerprint);
  });

  it("keeps provider and measurement caveats out of model-authored tradeoffs", async () => {
    const forecast = briefForecastFixture();
    forecast.windows = forecast.windows.map((window) => ({
      ...window,
      caveats: [
        "CDIP model point is not observed breaking-wave face height.",
        "A wind shift could weaken the surface-quality read."
      ]
    }));

    const bundle = await buildForecastFactBundle(forecast);
    expect(
      bundle.facts.some(
        (fact) => fact.role === "tradeoff" && /cdip|breaking-wave/i.test(fact.statement)
      )
    ).toBe(false);
    expect(
      bundle.facts.some(
        (fact) => fact.role === "tradeoff" && /wind shift/i.test(fact.statement)
      )
    ).toBe(true);
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
      "Surface conditions are clean"
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
