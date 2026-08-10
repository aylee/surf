import { describe, expect, it } from "vitest";
import { ForecastResponseSchema, type ApiSpot } from "@surf/contracts";
import { getSpotProfile } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { adaptForecastResponse, type WorkbenchWindow } from "./forecast-adapter";
import {
  buildForecastChartData,
  chartCivilLightBounds,
  forecastAtForChartKey,
  forecastGraphSelectionSummary
} from "./ForecastGraph";
import { expectedForecastSlotCount } from "./workbench-time";

const profile = getSpotProfile("bolinas");
const spot = {
  ...profile,
  sourceMap: {
    nwsWaveGrid: {
      provider: "NOAA/NWS MTR",
      forecastGridData: "https://api.weather.gov/gridpoints/MTR/85,105",
      breakingHeightScale: 1,
      notes: "Test source"
    },
    observedWave: [{ provider: "NDBC", stationId: "46237", name: "San Francisco Bar" }],
    coopsTide: { stationId: "9414958", name: "Bolinas Lagoon" }
  }
} satisfies ApiSpot;

function baseWindow(): WorkbenchWindow {
  const forecast = ForecastResponseSchema.parse(buildFixtureForecast("bolinas"));
  return adaptForecastResponse(forecast, spot, "3h").windows[0]!;
}

function localRow(hour: number): WorkbenchWindow {
  const source = baseWindow();
  return {
    ...source,
    forecastAt: new Date(Date.UTC(2026, 7, 2, 7 + hour)).toISOString(),
    localDateKey: "2026-08-02",
    localHour: hour,
    isDaylight: hour >= 6 && hour <= 20,
    confidence: 70 + (hour % 10),
    windRelation: hour < 12 ? "Offshore" : "Onshore"
  };
}

function rowsForUtcRange(start: string, end: string, localDateKey: string): WorkbenchWindow[] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: spot.timezone
  });
  const rows: WorkbenchWindow[] = [];
  for (
    let timestamp = new Date(start).getTime();
    timestamp < new Date(end).getTime();
    timestamp += 60 * 60 * 1000
  ) {
    const localHour = Number(
      formatter.formatToParts(new Date(timestamp)).find((part) => part.type === "hour")?.value
    );
    rows.push({
      ...baseWindow(),
      forecastAt: new Date(timestamp).toISOString(),
      localDateKey,
      localHour,
      isDaylight: localHour >= 6 && localHour < 18
    });
  }
  return rows;
}

describe("forecast graph normalization", () => {
  it("uses exact civil-light bounds for gap context and chart shading", () => {
    const civilLight = {
      firstLight: "2026-08-02T14:22:00.000Z",
      lastLight: "2026-08-03T00:19:00.000Z"
    };
    const data = buildForecastChartData([localRow(0)], "1h", spot.timezone, civilLight);
    const domainStart = Date.parse("2026-08-02T07:00:00.000Z");
    const domainEnd = Date.parse("2026-08-03T07:00:00.000Z");

    expect(data[6]?.isDaylight).toBe(false);
    expect(data[7]).toMatchObject({ isGap: true, isDaylight: true });
    expect(data[17]).toMatchObject({ isGap: true, isDaylight: true });
    expect(data[18]?.isDaylight).toBe(false);
    expect(chartCivilLightBounds(civilLight, domainStart, domainEnd)).toEqual({
      start: Date.parse(civilLight.firstLight),
      end: Date.parse(civilLight.lastLight)
    });
  });

  it.each([
    [0.6, "0–1 ft"],
    [3, "2–3 ft"],
    [3.4, "3–4 ft"],
    [10.4, "10 ft+"],
    [null, "Size unavailable"]
  ])("uses the shared surf-size range for graph data at %s", (height, expected) => {
    const row = localRow(7);
    row.raw = { ...row.raw, waveHeightFt: height };
    const datum = buildForecastChartData([row], "1h", spot.timezone)[7];
    expect(datum?.surfSizeLabel).toBe(expected);
  });

  it("creates an explicit 24-hour domain and leaves an omitted hour null", () => {
    const rows = [0, 1, 3, 6, 12, 18, 23].map(localRow);
    const data = buildForecastChartData(rows, "1h", spot.timezone);

    expect(data).toHaveLength(24);
    expect(data[2]).toMatchObject({
      forecastAt: null,
      isGap: true,
      modeledHeightFt: null,
      windRelation: null,
      confidence: null
    });
    expect(data[3]!.timestamp - data[2]!.timestamp).toBe(60 * 60 * 1000);
    expect(data[6]?.isDaylight).toBe(true);
    expect(data[23]?.isDaylight).toBe(false);
  });

  it("moves keyboard inspection across available points, skipping gaps", () => {
    const data = buildForecastChartData([0, 1, 3, 6].map(localRow), "1h", spot.timezone);
    const midnight = data[0]!.forecastAt;
    const oneAm = data[1]!.forecastAt;
    const threeAm = data[3]!.forecastAt;
    const sixAm = data[6]!.forecastAt;

    expect(forecastAtForChartKey(data, midnight, "ArrowRight")).toBe(oneAm);
    expect(forecastAtForChartKey(data, oneAm, "ArrowRight")).toBe(threeAm);
    expect(forecastAtForChartKey(data, threeAm, "ArrowLeft")).toBe(oneAm);
    expect(forecastAtForChartKey(data, threeAm, "Home")).toBe(midnight);
    expect(forecastAtForChartKey(data, threeAm, "End")).toBe(sixAm);
    expect(forecastAtForChartKey(data, null, "ArrowLeft")).toBe(sixAm);
    expect(forecastAtForChartKey(data, midnight, "PageDown")).toBeNull();
  });

  it("builds a persistent accessible readout for the selected chart time", () => {
    const data = buildForecastChartData([localRow(7)], "1h", spot.timezone);
    const selectedAt = data[7]!.forecastAt;
    const summary = forecastGraphSelectionSummary(data, selectedAt, spot.timezone);

    expect(summary).toContain("selected");
    expect(summary).toContain(data[7]!.surfSizeLabel);
    expect(summary).toContain("Wind");
    expect(summary).toContain("Tide");
    expect(summary).toContain("Confidence");
    expect(forecastGraphSelectionSummary(data, null, spot.timezone)).toContain("Use Left and Right Arrow");
  });

  it("creates eight three-hour slots instead of compressing a missing window", () => {
    const rows = [0, 6, 9, 12, 15, 18, 21].map(localRow);
    const data = buildForecastChartData(rows, "3h", spot.timezone);

    expect(data).toHaveLength(8);
    expect(data.map((datum) => datum.isGap)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false
    ]);
    expect(data[2]?.windRelation).toBe("Offshore");
    expect(data[4]?.confidence).toBe(72);
  });

  it("counts only current-day slots at or after the live forecast horizon", () => {
    const fiveThirtyPm = new Date("2026-08-03T00:30:00.000Z").getTime();

    expect(expectedForecastSlotCount("2026-08-02", "3h", spot.timezone, fiveThirtyPm)).toBe(2);
    expect(expectedForecastSlotCount("2026-08-02", "1h", spot.timezone, fiveThirtyPm)).toBe(6);
  });

  it("uses 23 real instants on the Los Angeles spring-forward day without fabricating 2 AM", () => {
    const rows = rowsForUtcRange(
      "2026-03-08T08:00:00.000Z",
      "2026-03-09T07:00:00.000Z",
      "2026-03-08"
    );
    const data = buildForecastChartData(rows, "1h", spot.timezone);
    const localHours = data.map((datum) => Number(new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: spot.timezone
    }).formatToParts(new Date(datum.timestamp)).find((part) => part.type === "hour")?.value));

    expect(expectedForecastSlotCount("2026-03-08", "1h", spot.timezone)).toBe(23);
    expect(expectedForecastSlotCount("2026-03-08", "3h", spot.timezone)).toBe(8);
    expect(data).toHaveLength(23);
    expect(new Set(data.map((datum) => datum.timestamp)).size).toBe(23);
    expect(data.map((datum) => datum.forecastAt)).toEqual(rows.map((row) => row.forecastAt));
    expect(localHours).not.toContain(2);
    expect(data.every((datum) => !datum.isGap)).toBe(true);
  });

  it("uses 25 real instants on the Los Angeles fall-back day and preserves both 1 AM rows", () => {
    const rows = rowsForUtcRange(
      "2026-11-01T07:00:00.000Z",
      "2026-11-02T08:00:00.000Z",
      "2026-11-01"
    );
    const data = buildForecastChartData(rows, "1h", spot.timezone);
    const oneAmRows = data.filter((datum) => Number(new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: spot.timezone
    }).formatToParts(new Date(datum.timestamp)).find((part) => part.type === "hour")?.value) === 1);

    expect(expectedForecastSlotCount("2026-11-01", "1h", spot.timezone)).toBe(25);
    expect(expectedForecastSlotCount("2026-11-01", "3h", spot.timezone)).toBe(8);
    expect(data).toHaveLength(25);
    expect(new Set(data.map((datum) => datum.timestamp)).size).toBe(25);
    expect(oneAmRows.map((datum) => datum.forecastAt)).toEqual([
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T09:00:00.000Z"
    ]);
    expect(data.every((datum) => !datum.isGap)).toBe(true);
  });
});
