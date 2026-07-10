import { describe, expect, it } from "vitest";
import {
  NORCAL_REFERENCE_CONFIG,
  NORCAL_REFERENCE_CONFIG_VERSION,
  NORCAL_SPOTS,
  getOperationalObservedWaveSources,
  getSpotSourceMap,
  isNorcalSpotId
} from "../src/index";

describe("v1 source mapping", () => {
  it("publishes one validated, versioned NorCal reference configuration", () => {
    expect(NORCAL_REFERENCE_CONFIG).toMatchObject({
      id: "norcal-reference-v1",
      region: "norcal",
      schemaVersion: NORCAL_REFERENCE_CONFIG_VERSION
    });
    expect(NORCAL_REFERENCE_CONFIG.spots).toBe(NORCAL_SPOTS);
    expect(new Set(NORCAL_SPOTS.map((spot) => spot.id)).size).toBe(NORCAL_SPOTS.length);
    expect(isNorcalSpotId("bolinas")).toBe(true);
    expect(isNorcalSpotId("not-configured")).toBe(false);
  });

  it("maps every v1 spot to explicit public source coverage", () => {
    expect(NORCAL_SPOTS).toHaveLength(6);

    for (const spot of NORCAL_SPOTS) {
      const sourceMap = getSpotSourceMap(spot.id);

      expect(sourceMap.observedWave.length).toBeGreaterThan(0);
      expect(sourceMap.observedWave.map((source) => source.capability)).toContain("observed_wave");
      const operationalStations = getOperationalObservedWaveSources(spot).map(
        (source) => source.stationId
      );
      expect(operationalStations.length).toBeGreaterThan(0);
      expect(new Set(operationalStations).size).toBe(operationalStations.length);

      expect(sourceMap.cdipMop.capability).toBe("forecast_wave_nearshore");
      expect(sourceMap.cdipMop.sourceId).toBe("cdip:mop-forecast");
      expect(sourceMap.cdipMop.dataAccessStatus).toBe("verified");
      expect(["verified", "absent", "blocked"]).toContain(sourceMap.cdipMop.coverageStatus);
      expect(sourceMap.cdipMop.notes.length).toBeGreaterThan(0);

      expect(sourceMap.coopsTide.capability).toBe("tide");
      expect(sourceMap.coopsTide.stationId).toMatch(/^941/);
      expect(sourceMap.coopsTide.predictionVerified).toBe(true);

      expect(sourceMap.nwsWaveGrid.sourceId).toBe("nws:mtr-grid-wave");
      expect(sourceMap.nwsWaveGrid.capability).toBe("forecast_wave_nearshore");
      expect(sourceMap.nwsWaveGrid.forecastZone).toBe("PZZ545");
      expect(sourceMap.nwsWaveGrid.forecastGridData).toContain("api.weather.gov/gridpoints/MTR/");
      expect(sourceMap.nwsWaveGrid.breakingHeightScale).toBeGreaterThan(0);
    }

    expect(
      Object.fromEntries(
        NORCAL_SPOTS.map((spot) => [
          spot.id,
          getOperationalObservedWaveSources(spot).map((source) => source.stationId)
        ])
      )
    ).toEqual({
      "obsf-north": ["46237", "46026", "46013"],
      "obsf-central": ["46237", "46026", "46013"],
      "obsf-south": ["46237", "46026", "46013"],
      "linda-mar": ["46012", "46237", "46026"],
      stinson: ["46237", "46013", "46026"],
      bolinas: ["46237", "46013", "46026"]
    });
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
