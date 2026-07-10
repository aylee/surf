import { getSpotProfile, NORCAL_SPOTS } from "@surf/forecast-core";
import { describe, expect, it } from "vitest";
import { stableThreeHourForecastTimes } from "../time";
import {
  fetchNwsGridWaveForSpots,
  nwsGridLayerValueAt,
  parseNwsValidTime
} from "./nws-grid-wave";
import type { SourceFetch } from "./types";

function layer(uom: string, value: number, validTime = "2026-07-09T14:00:00+00:00/P7DT11H") {
  return { uom, values: [{ validTime, value }] };
}

function gridPayload(waveHeight = 1.2) {
  return {
    properties: {
      updateTime: "2026-07-09T20:26:07+00:00",
      validTimes: "2026-07-09T14:00:00+00:00/P7DT11H",
      waveHeight: layer("wmoUnit:m", waveHeight),
      wavePeriod: layer("nwsUnit:s", 9),
      wavePeriod2: layer("nwsUnit:s", 16),
      primarySwellHeight: layer("wmoUnit:m", 1.1),
      primarySwellDirection: layer("wmoUnit:degree_(angle)", 300),
      secondarySwellHeight: layer("wmoUnit:m", 0.4),
      secondarySwellDirection: layer("wmoUnit:degree_(angle)", 210),
      windWaveHeight: layer("wmoUnit:m", 0.3)
    }
  };
}

describe("NWS coastal-grid wave adapter", () => {
  it("parses all supported NWS ISO-8601 interval shapes and respects end boundaries", () => {
    expect(parseNwsValidTime("2026-07-10T00:00:00Z/PT10H")).toEqual({
      startMs: Date.parse("2026-07-10T00:00:00Z"),
      endMs: Date.parse("2026-07-10T10:00:00Z")
    });
    expect(parseNwsValidTime("P1DT12H/2026-07-11T12:00:00Z")).toEqual({
      startMs: Date.parse("2026-07-10T00:00:00Z"),
      endMs: Date.parse("2026-07-11T12:00:00Z")
    });
    expect(parseNwsValidTime("2026-07-10T00:00:00Z/2026-07-10T03:00:00Z")).toEqual({
      startMs: Date.parse("2026-07-10T00:00:00Z"),
      endMs: Date.parse("2026-07-10T03:00:00Z")
    });

    const testLayer = layer("wmoUnit:m", 1.5, "2026-07-10T00:00:00Z/PT3H");
    expect(nwsGridLayerValueAt(testLayer, "2026-07-10T02:59:59Z")).toBe(1.5);
    expect(nwsGridLayerValueAt(testLayer, "2026-07-10T03:00:00Z")).toBeNull();
  });

  it("aligns five days to local 3-hour clock boundaries, including the DST fall-back fold", () => {
    const times = stableThreeHourForecastTimes(new Date("2026-07-10T02:53:07Z"), 120, "America/Los_Angeles");
    expect(times).toHaveLength(41);
    expect(times[0]).toBe("2026-07-10T04:00:00.000Z");
    const localHour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      hourCycle: "h23"
    });
    expect(times.every((time) => Number(localHour.format(new Date(time))) % 3 === 0)).toBe(true);

    const fallBack = stableThreeHourForecastTimes(
      new Date("2026-11-01T06:30:00Z"),
      6,
      "America/Los_Angeles"
    );
    expect(fallBack.slice(0, 2)).toEqual(["2026-11-01T07:00:00.000Z", "2026-11-01T11:00:00.000Z"]);
  });

  it("locks all six verified PZZ545 marine-grid mappings and cold-start scales", () => {
    expect(
      Object.fromEntries(
        NORCAL_SPOTS.map((spot) => [
          spot.id,
          {
            grid: `${spot.sourceMap.nwsWaveGrid.office}/${spot.sourceMap.nwsWaveGrid.gridX},${spot.sourceMap.nwsWaveGrid.gridY}`,
            zone: spot.sourceMap.nwsWaveGrid.forecastZone,
            scale: spot.sourceMap.nwsWaveGrid.breakingHeightScale
          }
        ])
      )
    ).toEqual({
      "obsf-north": { grid: "MTR/81,106", zone: "PZZ545", scale: 1 },
      "obsf-central": { grid: "MTR/81,105", zone: "PZZ545", scale: 1 },
      "obsf-south": { grid: "MTR/80,104", zone: "PZZ545", scale: 1 },
      "linda-mar": { grid: "MTR/79,98", zone: "PZZ545", scale: 0.6 },
      stinson: { grid: "MTR/78,112", zone: "PZZ545", scale: 0.55 },
      bolinas: { grid: "MTR/75,113", zone: "PZZ545", scale: 0.65 }
    });
  });

  it("expands typed wave and swell layers and preserves raw versus scaled height", async () => {
    const fetcher: SourceFetch = async () => Response.json(gridPayload());
    const outcome = await fetchNwsGridWaveForSpots([getSpotProfile("bolinas")], {
      fetcher,
      now: new Date("2026-07-10T02:53:07Z"),
      horizonHours: 6
    });

    expect(outcome.status).toBe("success");
    expect(outcome.rows).toHaveLength(3);
    expect(outcome.rows[0]).toMatchObject({
      spotId: "bolinas",
      forecastAt: "2026-07-10T04:00:00.000Z",
      modelCycleAt: "2026-07-09T20:26:07.000Z",
      significantHeightM: 1.2,
      estimatedBreakingHeightM: 0.78,
      breakingHeightScale: 0.65,
      primarySwellHeightM: 1.1,
      primarySwellPeriodS: 9,
      primarySwellDirectionDeg: 300,
      secondarySwellHeightM: 0.4,
      secondarySwellPeriodS: 16,
      secondarySwellDirectionDeg: 210,
      windWaveHeightM: 0.3
    });
  });

  it("rejects an all-zero marine mapping instead of manufacturing a wave forecast", async () => {
    const fetcher: SourceFetch = async () => Response.json(gridPayload(0));
    const outcome = await fetchNwsGridWaveForSpots([getSpotProfile("bolinas")], {
      fetcher,
      now: new Date("2026-07-10T02:53:07Z"),
      horizonHours: 6
    });

    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toEqual([]);
    expect(outcome.caveats).toContainEqual(
      expect.objectContaining({ code: "nws_grid_wave_all_zero" })
    );
  });

  it("fails closed when NWS changes a declared wave-layer unit", async () => {
    const payload = gridPayload();
    payload.properties.waveHeight.uom = "wmoUnit:ft";
    const fetcher: SourceFetch = async () => Response.json(payload);
    const outcome = await fetchNwsGridWaveForSpots([getSpotProfile("bolinas")], {
      fetcher,
      now: new Date("2026-07-10T02:53:07Z"),
      horizonHours: 6
    });

    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toEqual([]);
    expect(outcome.caveats).toContainEqual(
      expect.objectContaining({ code: "nws_grid_wave_unit_mismatch" })
    );
  });
});
