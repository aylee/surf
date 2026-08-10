import { describe, expect, it } from "vitest";
import {
  NORCAL_REFERENCE_CONFIG,
  NORCAL_REFERENCE_CONFIG_VERSION,
  NORCAL_SPOTS,
  getOperationalObservedWaveSources,
  getSpotSourceMap,
  isNorcalSpotId
} from "../src/index";

const expectedSpotIds = [
  "obsf-north",
  "obsf-central",
  "obsf-south",
  "linda-mar",
  "stinson",
  "bolinas",
  "rodeo-beach",
  "steamer-lane",
  "pleasure-point",
  "cowells",
  "jacks"
] as const;

describe("NorCal reference source mapping", () => {
  it("publishes one validated, versioned NorCal reference configuration", () => {
    expect(NORCAL_REFERENCE_CONFIG).toMatchObject({
      id: "norcal-reference-v2",
      region: "norcal",
      schemaVersion: NORCAL_REFERENCE_CONFIG_VERSION
    });
    expect(NORCAL_REFERENCE_CONFIG.spots).toBe(NORCAL_SPOTS);
    expect(NORCAL_SPOTS.map((spot) => spot.id)).toEqual(expectedSpotIds);
    expect(new Set(NORCAL_SPOTS.map((spot) => spot.id)).size).toBe(NORCAL_SPOTS.length);
    expect(isNorcalSpotId("bolinas")).toBe(true);
    expect(isNorcalSpotId("not-configured")).toBe(false);
  });

  it("maps every reference spot to explicit public source coverage", () => {
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
      expect(["PZZ535", "PZZ545"]).toContain(sourceMap.nwsWaveGrid.forecastZone);
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
      bolinas: ["46237", "46013", "46026"],
      "rodeo-beach": ["46237", "46026", "46013"],
      "steamer-lane": ["46236", "46042"],
      "pleasure-point": ["46236", "46042"],
      cowells: ["46236", "46042"],
      jacks: ["46236", "46042"]
    });
  });

  it("pins direct CDIP points and transparent shared proxies without inventing a Bolinas mapping", () => {
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
      bolinas: null,
      "rodeo-beach": "MA048",
      "steamer-lane": "SC149",
      "pleasure-point": "SC117",
      cowells: "SC149",
      jacks: "SC117"
    });
    expect(getSpotSourceMap("linda-mar").cdipMop.modelPoint).toMatchObject({
      waterDepthM: 15.01,
      nearshoreHeightScale: 0.6,
      relationship: "outside_cove_approach_proxy"
    });
    expect(getSpotSourceMap("bolinas").cdipMop.coverageStatus).toBe("absent");
    expect(getSpotSourceMap("cowells").cdipMop.modelPoint).toMatchObject({
      id: "SC149",
      nearshoreHeightScale: 0.5,
      relationship: "outside_cove_approach_proxy"
    });
    expect(getSpotSourceMap("jacks").cdipMop.modelPoint).toMatchObject({
      id: "SC117",
      nearshoreHeightScale: 1,
      relationship: "outside_cove_approach_proxy"
    });
  });

  it("pins expanded spot identity, geometry, hazard office, marine zone, tide, and aliases", () => {
    const expandedSpotIds = new Set<string>(expectedSpotIds.slice(6));
    expect(
      Object.fromEntries(
        NORCAL_SPOTS.filter((spot) => expandedSpotIds.has(spot.id)).map((spot) => [
          spot.id,
          {
            name: spot.name,
            aliases: spot.aliases,
            point: [spot.lat, spot.lon],
            timezone: spot.timezone,
            shoreNormalDeg: spot.shoreNormalDeg,
            nws: {
              office: spot.sourceMap.nwsWaveGrid.office,
              marineZone: spot.sourceMap.nwsWaveGrid.forecastZone
            },
            tide: {
              runtimeStation: spot.sourceMap.coopsTide.stationId,
              localSubordinateStation:
                spot.sourceMap.coopsTide.localSubordinateStation?.stationId ?? null
            }
          }
        ])
      )
    ).toEqual({
      "rodeo-beach": {
        name: "Rodeo Beach",
        aliases: ["Fort Cronkhite", "Fort Cronkite", "Rodeo Beach — Fort Cronkhite"],
        point: [37.8305, -122.5376],
        timezone: "America/Los_Angeles",
        shoreNormalDeg: 224,
        nws: { office: "MTR", marineZone: "PZZ545" },
        tide: { runtimeStation: "9414290", localSubordinateStation: null }
      },
      "steamer-lane": {
        name: "Steamer Lane",
        aliases: ["The Lane"],
        point: [36.9511, -122.0264],
        timezone: "America/Los_Angeles",
        shoreNormalDeg: 128,
        nws: { office: "MTR", marineZone: "PZZ535" },
        tide: { runtimeStation: "9413450", localSubordinateStation: "9413745" }
      },
      "pleasure-point": {
        name: "Pleasure Point",
        aliases: ["The Point"],
        point: [36.9545, -121.9725],
        timezone: "America/Los_Angeles",
        shoreNormalDeg: 158,
        nws: { office: "MTR", marineZone: "PZZ535" },
        tide: { runtimeStation: "9413450", localSubordinateStation: "9413745" }
      },
      cowells: {
        name: "Cowell's",
        aliases: ["Cowell Beach", "Cowell's Beach"],
        point: [36.9624, -122.0238],
        timezone: "America/Los_Angeles",
        shoreNormalDeg: 140,
        nws: { office: "MTR", marineZone: "PZZ535" },
        tide: { runtimeStation: "9413450", localSubordinateStation: "9413745" }
      },
      jacks: {
        name: "Jack's",
        aliases: ["38th Ave", "38th Avenue", "Jack's / 38th Ave", "Jacks"],
        point: [36.9616, -121.9662],
        timezone: "America/Los_Angeles",
        shoreNormalDeg: 165,
        nws: { office: "MTR", marineZone: "PZZ535" },
        tide: { runtimeStation: "9413450", localSubordinateStation: "9413745" }
      }
    });
  });
});
