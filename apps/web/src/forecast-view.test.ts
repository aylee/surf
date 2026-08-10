import { describe, expect, it } from "vitest";
import { getSpotProfile, scoreSpotWindow } from "@surf/forecast-core";
import type { ScoredForecastWindow } from "@surf/contracts";
import {
  availableDisplayLocalDateKeys,
  availableLocalDateKeys,
  bestWindow,
  bestWindowSelection,
  cardinalDirection,
  earliestAvailableLocalDateKey,
  formatWindowSpan,
  isPlanningWindow,
  selectedSpotIdFromSearch,
  surfHeightRange,
  surfaceCondition
} from "./forecast-view";

const spot = getSpotProfile("bolinas");

function windowAt(
  forecastAt: string,
  overrides: Partial<ScoredForecastWindow> = {}
): ScoredForecastWindow {
  const scored = scoreSpotWindow(spot, {
    spotId: spot.id,
    forecastAt,
    waveHeightFt: 2.7,
    peakPeriodSec: 14,
    primaryDirectionDeg: 245,
    tideFt: 2.5,
    windSpeedKt: 5,
    windDirectionDeg: 300,
    sourceFreshnessMinutes: 20,
    activeCapabilities: ["forecast_wave_nearshore", "observed_wave", "tide", "wind"]
  });
  return {
    ...scored,
    waveHeightFt: 2.7,
    peakPeriodSec: 14,
    primaryDirectionDeg: 245,
    tideFt: 2.5,
    windSpeedKt: 5,
    windDirectionDeg: 300,
    sourceFreshnessMinutes: 20,
    activeCapabilities: ["forecast_wave_nearshore", "observed_wave", "tide", "wind"],
    sourceRunIds: ["run"],
    caveats: [],
    primarySwell: { heightFt: 2.2, periodSec: 14, directionDeg: 245 },
    secondarySwell: null,
    waveProvenance: null,
    ...overrides
  };
}

describe("forecast presentation", () => {
  it("accepts any spot returned by the runtime catalog", () => {
    expect(selectedSpotIdFromSearch("?spot=new-break", ["bolinas", "new-break"])).toBe(
      "new-break"
    );
    expect(selectedSpotIdFromSearch("?spot=not-loaded", ["bolinas", "new-break"])).toBeNull();
  });

  it("keeps planning recommendations inside the configured 6am–6pm local window", () => {
    const now = new Date("2026-07-10T00:00:00Z");
    expect(isPlanningWindow(windowAt("2026-07-10T13:00:00Z"), spot.timezone, now)).toBe(true);
    expect(isPlanningWindow(windowAt("2026-07-10T12:00:00Z"), spot.timezone, now)).toBe(false);
    expect(isPlanningWindow(windowAt("2026-07-11T00:00:00Z"), spot.timezone, now)).toBe(true);
    expect(isPlanningWindow(windowAt("2026-07-11T01:00:00Z"), spot.timezone, now)).toBe(false);
    expect(isPlanningWindow(windowAt("2026-07-11T02:00:00Z"), spot.timezone, now)).toBe(false);
  });

  it("never selects an unknown or past window as the daily best", () => {
    const now = new Date("2026-07-10T12:30:00Z");
    const past = windowAt("2026-07-10T12:00:00Z", { score: 99 });
    const unknown = windowAt("2026-07-10T16:00:00Z", {
      ratingStatus: "unknown",
      qualityLabel: "unknown",
      score: 100
    });
    const ready = windowAt("2026-07-10T19:00:00Z", { score: 61 });
    expect(bestWindow(spot, [past, unknown, ready], now)?.forecastAt).toBe(ready.forecastAt);
  });

  it("moves the report to the next daylight day after the 6pm planning window", () => {
    const now = new Date("2026-07-11T03:00:00Z"); // Jul 10, 8pm PDT
    const tonight = windowAt("2026-07-11T04:00:00Z", { score: 99 });
    const tomorrowMorning = windowAt("2026-07-11T13:00:00Z", { score: 60 });

    expect(availableLocalDateKeys(spot, [tonight, tomorrowMorning], now)).toEqual([
      "2026-07-11"
    ]);
    expect(availableDisplayLocalDateKeys(spot, [tonight, tomorrowMorning])).toEqual([
      "2026-07-10",
      "2026-07-11"
    ]);
    expect(bestWindow(spot, [tonight, tomorrowMorning], now, "2026-07-11")?.forecastAt).toBe(
      tomorrowMorning.forecastAt
    );
  });

  it("moves to the next day when today's daylight rows are all unknown", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const unknownToday = windowAt("2026-07-10T16:00:00Z", {
      ratingStatus: "unknown",
      qualityLabel: "unknown"
    });
    const readyTomorrow = windowAt("2026-07-11T16:00:00Z");

    expect(
      earliestAvailableLocalDateKey([{ spot, windows: [unknownToday, readyTomorrow] }], now)
    ).toBe("2026-07-11");
  });

  it("keeps a regional report date when one spot has no forecast windows", () => {
    const now = new Date("2026-07-11T03:00:00Z");
    const tomorrowMorning = windowAt("2026-07-11T13:00:00Z");

    expect(
      earliestAvailableLocalDateKey(
        [
          { spot, windows: [] },
          { spot, windows: [tomorrowMorning] }
        ],
        now
      )
    ).toBe("2026-07-11");
  });

  it("translates wind into surf-language surface conditions", () => {
    expect(surfaceCondition(spot, { windSpeedKt: 2, windDirectionDeg: 270 })).toBe("clean");
    expect(surfaceCondition(spot, { windSpeedKt: 7, windDirectionDeg: 300 })).toBe("clean");
    expect(surfaceCondition(spot, { windSpeedKt: 13, windDirectionDeg: 145 })).toBe("choppy");
    expect(surfaceCondition(spot, { windSpeedKt: null, windDirectionDeg: null })).toBe("unknown");
  });

  it("formats surf ranges, compass headings, and three-hour windows", () => {
    expect(surfHeightRange(0.6)).toBe("0–1 ft");
    expect(surfHeightRange(2.7)).toBe("2–3 ft");
    expect(surfHeightRange(3)).toBe("2–3 ft");
    expect(cardinalDirection(292)).toBe("WNW");
    expect(formatWindowSpan("2026-07-10T13:00:00Z", spot.timezone)).toBe("6 AM–9 AM");
    expect(
      formatWindowSpan(
        "2026-07-10T13:22:00Z",
        spot.timezone,
        "2026-07-10T15:30:00Z"
      )
    ).toBe("6:22 AM–8:30 AM");
  });

  it("uses published hourly recommendation boundaries with a coarser display payload", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const displayed = windowAt("2026-07-10T12:00:00Z");
    const representative = windowAt("2026-07-10T14:00:00Z", { score: 84 });
    const selection = bestWindowSelection(
      spot,
      [displayed],
      now,
      "2026-07-10",
      undefined,
      [{
        localDate: "2026-07-10",
        representative,
        constituentWindowIds: [representative.forecastAt],
        startAt: "2026-07-10T13:22:00Z",
        endAt: "2026-07-10T15:30:00Z"
      }]
    );

    expect(selection?.window.forecastAt).toBe(representative.forecastAt);
    expect(selection?.startAt).toBe("2026-07-10T13:22:00Z");
    expect(selection?.endAt).toBe("2026-07-10T15:30:00Z");
  });

  it("treats a published empty recommendation set as authoritative", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const displayed = windowAt("2026-07-10T15:00:00Z", { score: 90 });

    expect(
      bestWindowSelection(
        spot,
        [displayed],
        now,
        "2026-07-10",
        undefined,
        []
      )
    ).toBeUndefined();
  });

  it("keeps each legacy three-hour span on its own DST-safe local boundary", () => {
    const now = new Date("2026-03-08T12:00:00Z");
    const rows = [
      windowAt("2026-03-08T08:00:00Z", { score: 20 }), // 12 AM PST
      windowAt("2026-03-08T10:00:00Z", { score: 20 }), // 3 AM PDT
      windowAt("2026-03-08T13:00:00Z", { score: 90 }), // 6 AM PDT
      windowAt("2026-03-08T16:00:00Z", { score: 20 })  // 9 AM PDT
    ];

    const selection = bestWindowSelection(
      spot,
      rows,
      now,
      "2026-03-08"
    );

    expect(selection?.startAt).toBe("2026-03-08T13:00:00.000Z");
    expect(selection?.endAt).toBe("2026-03-08T16:00:00.000Z");
    expect(formatWindowSpan(selection!.startAt, spot.timezone, selection!.endAt)).toBe(
      "6 AM–9 AM"
    );
  });
});
