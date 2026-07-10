import { describe, expect, it } from "vitest";
import { NORCAL_SPOTS, getSpotSourceMap } from "../src/index";

describe("v1 source mapping", () => {
  it("maps every v1 spot to explicit public source coverage", () => {
    expect(NORCAL_SPOTS).toHaveLength(6);

    for (const spot of NORCAL_SPOTS) {
      const sourceMap = getSpotSourceMap(spot.id);

      expect(sourceMap.gfsWave.sourceId).toBe("noaa-gfswave-wcoast-0p16");
      expect(sourceMap.gfsWave.referencePoint.lat).toEqual(expect.any(Number));
      expect(sourceMap.gfsWave.referencePoint.lon).toEqual(expect.any(Number));
      expect(sourceMap.gfsWave.variables).toEqual(expect.arrayContaining(["HTSGW", "PERPW", "DIRPW"]));

      expect(sourceMap.observedWave.length).toBeGreaterThan(0);
      expect(sourceMap.observedWave.map((source) => source.capability)).toContain("observed_wave");

      expect(sourceMap.cdipMop.capability).toBe("forecast_wave_nearshore");
      expect(sourceMap.cdipMop.sourceId).toBe("cdip:mop-forecast");
      expect(sourceMap.cdipMop.dataAccessStatus).toBe("verified");
      expect(["verified", "absent", "blocked"]).toContain(sourceMap.cdipMop.coverageStatus);
      expect(sourceMap.cdipMop.notes.length).toBeGreaterThan(0);

      expect(sourceMap.coopsTide.capability).toBe("tide");
      expect(sourceMap.coopsTide.stationId).toMatch(/^941/);
      expect(sourceMap.coopsTide.predictionVerified).toBe(true);

      expect(sourceMap.nwsPoint.capabilities).toEqual(["wind", "hazard"]);
      expect(sourceMap.nwsPoint.office).toBe("MTR");
      expect(sourceMap.nwsPoint.forecastHourly).toContain("api.weather.gov");

      expect(sourceMap.nwsWaveGrid.sourceId).toBe("nws:mtr-grid-wave");
      expect(sourceMap.nwsWaveGrid.capability).toBe("forecast_wave_nearshore");
      expect(sourceMap.nwsWaveGrid.forecastZone).toBe("PZZ545");
      expect(sourceMap.nwsWaveGrid.forecastGridData).toContain("api.weather.gov/gridpoints/MTR/");
      expect(sourceMap.nwsWaveGrid.breakingHeightScale).toBeGreaterThan(0);
    }
  });

  it("pins direct CDIP points without inventing a Bolinas mapping", () => {
    expect(
      Object.fromEntries(
        NORCAL_SPOTS.map((spot) => [spot.id, spot.sourceMap.cdipMop.modelPoint?.id ?? null])
      )
    ).toEqual({
      "obsf-north": "SF043",
      "obsf-central": "SF029",
      "obsf-south": "SF015",
      "linda-mar": "SM371",
      stinson: "MA122",
      bolinas: null
    });
    expect(getSpotSourceMap("linda-mar").cdipMop.modelPoint).toMatchObject({
      waterDepthM: 15.01,
      nearshoreHeightScale: 0.6,
      relationship: "outside_cove_approach_proxy"
    });
    expect(getSpotSourceMap("bolinas").cdipMop.coverageStatus).toBe("absent");
  });
});
