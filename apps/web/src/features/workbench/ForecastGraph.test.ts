import { describe, expect, it } from "vitest";
import { ForecastResponseSchema, type ApiSpot } from "@surf/contracts";
import { getSpotProfile } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { adaptForecastResponse, type WorkbenchWindow } from "./forecast-adapter";
import { buildForecastChartData } from "./ForecastGraph";
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
