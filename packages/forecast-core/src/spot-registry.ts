import type { SpotId, SpotProfile } from "@surf/contracts";

export const NORCAL_SPOTS: SpotProfile[] = [
  {
    id: "obsf-north",
    name: "Ocean Beach North",
    region: "norcal",
    lat: 37.782,
    lon: -122.514,
    timezone: "America/Los_Angeles",
    shoreNormalDeg: 270,
    bestSwellDeg: { minDeg: 280, maxDeg: 310 },
    workableSwellDeg: { minDeg: 240, maxDeg: 330 },
    bestPeriodSec: { min: 11, max: 18 },
    bestTideFt: { min: 0.5, max: 4.5 },
    offshoreWindFromDeg: { minDeg: 45, maxDeg: 140 },
    maxGoodWindKt: 8,
    maxOkWindKt: 15,
    referenceBuoys: ["46026", "46013"],
    cdipStations: [],
    tideStation: "9414290",
    notes: "Exposed SF beachbreak. Cold-start prior favors clean wind and moderate tides."
  },
  {
    id: "obsf-central",
    name: "Ocean Beach Central",
    region: "norcal",
    lat: 37.759,
    lon: -122.51,
    timezone: "America/Los_Angeles",
    shoreNormalDeg: 270,
    bestSwellDeg: { minDeg: 275, maxDeg: 310 },
    workableSwellDeg: { minDeg: 235, maxDeg: 330 },
    bestPeriodSec: { min: 10, max: 17 },
    bestTideFt: { min: 1.0, max: 5.0 },
    offshoreWindFromDeg: { minDeg: 45, maxDeg: 140 },
    maxGoodWindKt: 8,
    maxOkWindKt: 15,
    referenceBuoys: ["46026", "46013"],
    cdipStations: [],
    tideStation: "9414290",
    notes: "Primary v1 OBSF reference spot."
  },
  {
    id: "obsf-south",
    name: "Ocean Beach South",
    region: "norcal",
    lat: 37.735,
    lon: -122.506,
    timezone: "America/Los_Angeles",
    shoreNormalDeg: 270,
    bestSwellDeg: { minDeg: 275, maxDeg: 315 },
    workableSwellDeg: { minDeg: 235, maxDeg: 335 },
    bestPeriodSec: { min: 10, max: 17 },
    bestTideFt: { min: 1.0, max: 5.0 },
    offshoreWindFromDeg: { minDeg: 45, maxDeg: 145 },
    maxGoodWindKt: 8,
    maxOkWindKt: 15,
    referenceBuoys: ["46026", "46013"],
    cdipStations: [],
    tideStation: "9414290",
    notes: "Exposed beachbreak; needs local calibration for bars and tide sensitivity."
  },
  {
    id: "linda-mar",
    name: "Linda Mar / Pacifica",
    region: "norcal",
    lat: 37.594,
    lon: -122.506,
    timezone: "America/Los_Angeles",
    shoreNormalDeg: 250,
    bestSwellDeg: { minDeg: 250, maxDeg: 295 },
    workableSwellDeg: { minDeg: 210, maxDeg: 320 },
    bestPeriodSec: { min: 8, max: 15 },
    bestTideFt: { min: 0.5, max: 4.0 },
    offshoreWindFromDeg: { minDeg: 45, maxDeg: 145 },
    maxGoodWindKt: 8,
    maxOkWindKt: 14,
    referenceBuoys: ["46026", "46012"],
    cdipStations: [],
    tideStation: "9414290",
    notes: "Protected beginner-friendly beach; smaller swell windows matter."
  },
  {
    id: "stinson",
    name: "Stinson",
    region: "norcal",
    lat: 37.899,
    lon: -122.644,
    timezone: "America/Los_Angeles",
    shoreNormalDeg: 225,
    bestSwellDeg: { minDeg: 210, maxDeg: 285 },
    workableSwellDeg: { minDeg: 190, maxDeg: 310 },
    bestPeriodSec: { min: 8, max: 15 },
    bestTideFt: { min: 1.0, max: 5.0 },
    offshoreWindFromDeg: { minDeg: 45, maxDeg: 135 },
    maxGoodWindKt: 8,
    maxOkWindKt: 14,
    referenceBuoys: ["46026", "46013"],
    cdipStations: [],
    tideStation: "9414290",
    notes: "More sheltered than OBSF; local transform and tide calibration needed."
  },
  {
    id: "bolinas",
    name: "Bolinas",
    region: "norcal",
    lat: 37.909,
    lon: -122.687,
    timezone: "America/Los_Angeles",
    shoreNormalDeg: 215,
    bestSwellDeg: { minDeg: 210, maxDeg: 285 },
    workableSwellDeg: { minDeg: 190, maxDeg: 310 },
    bestPeriodSec: { min: 8, max: 15 },
    bestTideFt: { min: 0.5, max: 4.5 },
    offshoreWindFromDeg: { minDeg: 45, maxDeg: 135 },
    maxGoodWindKt: 8,
    maxOkWindKt: 14,
    referenceBuoys: ["46026", "46013"],
    cdipStations: [],
    tideStation: "9414290",
    notes: "Sheltered longboard-friendly option; exact source mapping is a v1 task."
  }
];

export function getSpotProfile(id: SpotId): SpotProfile {
  const spot = NORCAL_SPOTS.find((candidate) => candidate.id === id);
  if (!spot) {
    throw new Error(`Unknown spot: ${id}`);
  }
  return spot;
}

