import type { SpotId, SpotProfile } from "@surf/contracts";

export type SourceMappingStatus = "verified" | "absent" | "blocked";

export type SourceEvidence = {
  id: string;
  label: string;
  url: string;
  checkedAt: string;
  notes: string;
};

export type GfsWaveSourceMapping = {
  sourceId: "noaa-gfswave-wcoast-0p16";
  provider: "NOAA/NCEP GFSwave";
  capability: "forecast_wave_offshore";
  domain: "wcoast";
  gridResolutionDeg: 0.16;
  referencePoint: {
    lat: number;
    lon: number;
  };
  variables: string[];
  evidence: SourceEvidence[];
  notes: string;
};

export type ObservedWaveSourceMapping = {
  sourceId: string;
  provider: "NDBC" | "CDIP";
  capability: "observed_wave";
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  role: "primary" | "secondary" | "validation";
  evidence: SourceEvidence[];
  notes: string;
};

export type CdipMopSourceMapping = {
  sourceId: "cdip:mop-forecast";
  provider: "CDIP/MOP";
  capability: "forecast_wave_nearshore";
  coverageStatus: SourceMappingStatus;
  dataAccessStatus: SourceMappingStatus;
  modelRegion: "sf" | "nocal";
  modelPoint: {
    id: string;
    lat: number;
    lon: number;
    waterDepthM: number;
    shoreNormalDeg: number;
    forecastAsciiUrl: string;
    forecastDasUrl: string;
    forecastFileUrl: string;
    nearshoreHeightScale: number;
    relationship: "direct_nearshore_point" | "outside_cove_approach_proxy";
  } | null;
  observedStationIds: string[];
  evidence: SourceEvidence[];
  notes: string;
};

export type CoopsTideSourceMapping = {
  capability: "tide";
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  predictionVerified: boolean;
  evidence: SourceEvidence[];
  notes: string;
};

export type NwsPointSourceMapping = {
  capabilities: ["wind", "hazard"];
  office: "MTR";
  gridId: "MTR";
  gridX: number;
  gridY: number;
  pointType: "land" | "marine";
  forecastZone: string;
  forecastGridData: string;
  forecastHourly: string;
  observationStations: string;
  evidence: SourceEvidence[];
  notes: string;
};

export type NwsWaveGridSourceMapping = {
  sourceId: "nws:mtr-grid-wave";
  provider: "NOAA/NWS MTR";
  capability: "forecast_wave_nearshore";
  office: "MTR";
  gridX: number;
  gridY: number;
  lookupPoint: {
    lat: number;
    lon: number;
  };
  forecastZone: "PZZ545";
  forecastGridData: string;
  breakingHeightScale: number;
  evidence: SourceEvidence[];
  notes: string;
};

export type SpotSourceMap = {
  gfsWave: GfsWaveSourceMapping;
  observedWave: ObservedWaveSourceMapping[];
  cdipMop: CdipMopSourceMapping;
  coopsTide: CoopsTideSourceMapping;
  nwsPoint: NwsPointSourceMapping;
  nwsWaveGrid: NwsWaveGridSourceMapping;
};

export type NorcalSpotProfile = SpotProfile & {
  sourceMap: SpotSourceMap;
};

const checkedAt = "2026-07-08";

const evidence = {
  nomadsGfswave: {
    id: "nomads-gfswave-filter",
    label: "NOMADS GFSwave filter",
    url: "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl",
    checkedAt,
    notes: "Filter UI exposes /gfs.YYYYMMDD/HH/wave/gridded and wcoast 0p16 GRIB2 files with wave variables."
  },
  ndbc46026: {
    id: "ndbc-46026",
    label: "NDBC 46026 San Francisco",
    url: "https://www.ndbc.noaa.gov/station_page.php?station=46026",
    checkedAt,
    notes: "San Francisco buoy, 18 NM west of San Francisco, reporting wave observations."
  },
  ndbc46013: {
    id: "ndbc-46013",
    label: "NDBC 46013 Bodega Bay",
    url: "https://www.ndbc.noaa.gov/station_page.php?station=46013",
    checkedAt,
    notes: "Bodega Bay buoy, 48 NM northwest of San Francisco, useful north-of-region reference."
  },
  ndbc46012: {
    id: "ndbc-46012",
    label: "NDBC 46012 Half Moon Bay",
    url: "https://www.ndbc.noaa.gov/station_page.php?station=46012",
    checkedAt,
    notes: "Half Moon Bay buoy, 24 NM south-southwest of San Francisco, useful Pacifica/HMB reference."
  },
  cdip142: {
    id: "cdip-142",
    label: "CDIP 142 San Francisco Bar",
    url: "https://cdip.ucsd.edu/m/products/?stn=142p1",
    checkedAt,
    notes: "San Francisco Bar station, CDIP station 142 / NDBC WMO 46237."
  },
  cdip029: {
    id: "cdip-029",
    label: "CDIP 029 Point Reyes",
    url: "https://cdip.ucsd.edu/m/products/?stn=029p1",
    checkedAt,
    notes: "Point Reyes station, CDIP station 029 / NDBC WMO 46214."
  },
  cdipSfModel: {
    id: "cdip-sf-model",
    label: "CDIP San Francisco swell model",
    url: "https://cdip.ucsd.edu/m/nowcast/?lat=38&lon=-123&wave_model=sf&z=9",
    checkedAt,
    notes: "Public model page shows San Francisco regional coverage, but live run listings were stale when checked."
  },
  cdipMopIntro: {
    id: "cdip-mop-intro",
    label: "CDIP MOP introduction",
    url: "https://cdip.ucsd.edu/documents/index/product_docs/mops/mop_intro.html",
    checkedAt,
    notes: "Public MOP docs describe alongshore sea and swell predictions north of Point Conception and say to contact CDIP for model predictions."
  },
  cdipMopForecast: {
    id: "cdip-mop-public-forecast",
    label: "CDIP MOP public per-point forecast",
    url: "https://thredds.cdip.ucsd.edu/thredds/catalog/cdip/model/MOP_alongshore/catalog.html",
    checkedAt: "2026-07-09",
    notes: "Public THREDDS exposes per-point forecast NetCDF files and constrained OPeNDAP ASCII responses. Exact point metadata and five bulk forecast variables were verified live."
  },
  coops9414290: {
    id: "coops-9414290",
    label: "CO-OPS 9414290 San Francisco",
    url: "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290.json",
    checkedAt,
    notes: "San Francisco tide station; public prediction endpoint returned hilo tide predictions."
  },
  coops9414131: {
    id: "coops-9414131",
    label: "CO-OPS 9414131 Pillar Point Harbor",
    url: "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414131.json",
    checkedAt,
    notes: "Pillar Point Harbor tide station; public prediction endpoint returned hilo tide predictions."
  },
  coops9414958: {
    id: "coops-9414958",
    label: "CO-OPS 9414958 Bolinas, Bolinas Lagoon",
    url: "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414958.json",
    checkedAt,
    notes: "Bolinas Lagoon tide station; public prediction endpoint returned hilo tide predictions."
  },
  nwsPoints: {
    id: "nws-points-api",
    label: "NWS points API",
    url: "https://api.weather.gov/points/{lat},{lon}",
    checkedAt,
    notes: "NWS point metadata was queried for each spot with a surf-v1 user agent."
  }
} satisfies Record<string, SourceEvidence>;

function gfsWave(referencePoint: { lat: number; lon: number }, notes: string): GfsWaveSourceMapping {
  return {
    sourceId: "noaa-gfswave-wcoast-0p16",
    provider: "NOAA/NCEP GFSwave",
    capability: "forecast_wave_offshore",
    domain: "wcoast",
    gridResolutionDeg: 0.16,
    referencePoint,
    variables: ["HTSGW", "PERPW", "DIRPW", "SWELL", "SWPER", "SWDIR", "WVHGT", "WVPER", "WVDIR"],
    evidence: [evidence.nomadsGfswave],
    notes
  };
}

const observedSources = {
  ndbc46026: {
    sourceId: "ndbc-46026",
    provider: "NDBC",
    capability: "observed_wave",
    stationId: "46026",
    name: "San Francisco",
    lat: 37.75,
    lon: -122.838,
    role: "primary",
    evidence: [evidence.ndbc46026],
    notes: "Closest deep-water NDBC buoy for the San Francisco bar and Ocean Beach."
  },
  ndbc46013: {
    sourceId: "ndbc-46013",
    provider: "NDBC",
    capability: "observed_wave",
    stationId: "46013",
    name: "Bodega Bay",
    lat: 38.235,
    lon: -123.317,
    role: "secondary",
    evidence: [evidence.ndbc46013],
    notes: "Northwest offshore reference for regional swell validation."
  },
  ndbc46012: {
    sourceId: "ndbc-46012",
    provider: "NDBC",
    capability: "observed_wave",
    stationId: "46012",
    name: "Half Moon Bay",
    lat: 37.356,
    lon: -122.881,
    role: "secondary",
    evidence: [evidence.ndbc46012],
    notes: "South-of-SF offshore reference, especially useful for Pacifica."
  },
  cdip142: {
    sourceId: "cdip-142",
    provider: "CDIP",
    capability: "observed_wave",
    stationId: "142",
    name: "San Francisco Bar",
    lat: 37.788,
    lon: -122.6318,
    role: "primary",
    evidence: [evidence.cdip142],
    notes: "Nearshore/bar observation station for Ocean Beach, Pacifica, and the Golden Gate approach."
  },
  cdip029: {
    sourceId: "cdip-029",
    provider: "CDIP",
    capability: "observed_wave",
    stationId: "029",
    name: "Point Reyes",
    lat: 37.9415,
    lon: -123.4645,
    role: "secondary",
    evidence: [evidence.cdip029],
    notes: "Deep offshore Point Reyes reference for Marin and north swell validation."
  }
} satisfies Record<string, ObservedWaveSourceMapping>;

const CDIP_MOP_BASE = "https://thredds.cdip.ucsd.edu/thredds";

function cdipMop(
  modelRegion: "sf" | "nocal",
  observedStationIds: string[],
  modelPoint: Omit<
    NonNullable<CdipMopSourceMapping["modelPoint"]>,
    "forecastAsciiUrl" | "forecastDasUrl" | "forecastFileUrl"
  > | null,
  notes: string
): CdipMopSourceMapping {
  const pointWithUrls = modelPoint
    ? {
        ...modelPoint,
        forecastAsciiUrl: `${CDIP_MOP_BASE}/dodsC/cdip/model/MOP_alongshore/${modelPoint.id}_forecast.nc.ascii?waveTime,waveHs,waveTp,waveDp,waveDm`,
        forecastDasUrl: `${CDIP_MOP_BASE}/dodsC/cdip/model/MOP_alongshore/${modelPoint.id}_forecast.nc.das`,
        forecastFileUrl: `${CDIP_MOP_BASE}/fileServer/cdip/model/MOP_alongshore/${modelPoint.id}_forecast.nc`
      }
    : null;
  return {
    sourceId: "cdip:mop-forecast",
    provider: "CDIP/MOP",
    capability: "forecast_wave_nearshore",
    coverageStatus: pointWithUrls ? "verified" : "absent",
    dataAccessStatus: "verified",
    modelRegion,
    modelPoint: pointWithUrls,
    observedStationIds,
    evidence: [evidence.cdipSfModel, evidence.cdipMopIntro, evidence.cdipMopForecast],
    notes
  };
}

const coopsTideStations = {
  sanFrancisco: {
    capability: "tide",
    stationId: "9414290",
    name: "San Francisco",
    lat: 37.806305,
    lon: -122.46589,
    predictionVerified: true,
    evidence: [evidence.coops9414290],
    notes: "Primary tide-prediction station for Ocean Beach; live hilo predictions verified."
  },
  pillarPoint: {
    capability: "tide",
    stationId: "9414131",
    name: "Pillar Point Harbor",
    lat: 37.5025,
    lon: -122.48217,
    predictionVerified: true,
    evidence: [evidence.coops9414131],
    notes: "Closest verified public tide-prediction station for Linda Mar / Pacifica."
  },
  bolinasLagoon: {
    capability: "tide",
    stationId: "9414958",
    name: "Bolinas, Bolinas Lagoon",
    lat: 37.908,
    lon: -122.6785,
    predictionVerified: true,
    evidence: [evidence.coops9414958],
    notes: "Closest verified public tide-prediction station for Stinson and Bolinas."
  }
} satisfies Record<string, CoopsTideSourceMapping>;

function nwsPoint(input: Omit<NwsPointSourceMapping, "capabilities" | "office" | "gridId" | "evidence">): NwsPointSourceMapping {
  return {
    capabilities: ["wind", "hazard"],
    office: "MTR",
    gridId: "MTR",
    evidence: [evidence.nwsPoints],
    ...input
  };
}

function nwsWaveGrid(
  input: Omit<
    NwsWaveGridSourceMapping,
    "sourceId" | "provider" | "capability" | "office" | "forecastZone" | "forecastGridData" | "evidence"
  >
): NwsWaveGridSourceMapping {
  return {
    sourceId: "nws:mtr-grid-wave",
    provider: "NOAA/NWS MTR",
    capability: "forecast_wave_nearshore",
    office: "MTR",
    forecastZone: "PZZ545",
    forecastGridData: `https://api.weather.gov/gridpoints/MTR/${input.gridX},${input.gridY}`,
    evidence: [evidence.nwsPoints],
    ...input
  };
}

export const NORCAL_SPOTS: NorcalSpotProfile[] = [
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
    referenceBuoys: ["46237", "46026", "46013"],
    cdipStations: ["142"],
    tideStation: "9414290",
    notes: "Exposed SF beachbreak. Cold-start prior favors clean wind and moderate tides.",
    sourceMap: {
      gfsWave: gfsWave(
        { lat: 37.76, lon: -122.88 },
        "Nearest offshore wcoast 0p16 point west of Ocean Beach and close to NDBC 46026."
      ),
      observedWave: [
        observedSources.ndbc46026,
        observedSources.cdip142,
        observedSources.ndbc46013,
        observedSources.ndbc46012
      ],
      cdipMop: cdipMop(
        "sf",
        ["142"],
        {
          id: "SF043",
          lat: 37.7839,
          lon: -122.51468,
          waterDepthM: 10,
          shoreNormalDeg: 305.41,
          nearshoreHeightScale: 1,
          relationship: "direct_nearshore_point"
        },
        "SF043 is the verified public 10 m MOP point at Ocean Beach North. Its Hs is modeled nearshore significant wave height, not breaking-wave face height."
      ),
      coopsTide: coopsTideStations.sanFrancisco,
      nwsPoint: nwsPoint({
        gridX: 81,
        gridY: 106,
        pointType: "marine",
        forecastZone: "PZZ545",
        forecastGridData: "https://api.weather.gov/gridpoints/MTR/81,106",
        forecastHourly: "https://api.weather.gov/gridpoints/MTR/81,106/forecast/hourly",
        observationStations: "https://api.weather.gov/gridpoints/MTR/81,106/stations",
        notes: "Live NWS point metadata returned a marine point on forecast zone PZZ545."
      }),
      nwsWaveGrid: nwsWaveGrid({
        gridX: 81,
        gridY: 106,
        lookupPoint: { lat: 37.782, lon: -122.514 },
        breakingHeightScale: 1,
        notes: "Verified coastal-marine grid at the Ocean Beach North point; raw significant height is used without a spot reduction."
      })
    }
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
    referenceBuoys: ["46237", "46026", "46013"],
    cdipStations: ["142"],
    tideStation: "9414290",
    notes: "Primary v1 OBSF reference spot.",
    sourceMap: {
      gfsWave: gfsWave(
        { lat: 37.76, lon: -122.88 },
        "Nearest offshore wcoast 0p16 point west of the central Ocean Beach reference coordinate."
      ),
      observedWave: [
        observedSources.ndbc46026,
        observedSources.cdip142,
        observedSources.ndbc46013,
        observedSources.ndbc46012
      ],
      cdipMop: cdipMop(
        "sf",
        ["142"],
        {
          id: "SF029",
          lat: 37.75892,
          lon: -122.52074,
          waterDepthM: 10.01,
          shoreNormalDeg: 265,
          nearshoreHeightScale: 1,
          relationship: "direct_nearshore_point"
        },
        "SF029 is the verified public 10.01 m MOP point at Ocean Beach Central. Its Hs is modeled nearshore significant wave height, not breaking-wave face height."
      ),
      coopsTide: coopsTideStations.sanFrancisco,
      nwsPoint: nwsPoint({
        gridX: 81,
        gridY: 105,
        pointType: "land",
        forecastZone: "CAZ006",
        forecastGridData: "https://api.weather.gov/gridpoints/MTR/81,105",
        forecastHourly: "https://api.weather.gov/gridpoints/MTR/81,105/forecast/hourly",
        observationStations: "https://api.weather.gov/gridpoints/MTR/81,105/stations",
        notes: "Live NWS point metadata returned MTR grid 81,105 on San Francisco forecast zone CAZ006."
      }),
      nwsWaveGrid: nwsWaveGrid({
        gridX: 81,
        gridY: 105,
        lookupPoint: { lat: 37.759, lon: -122.53 },
        breakingHeightScale: 1,
        notes: "Verified by an adjacent coastal-marine lookup point on PZZ545; raw significant height is used without a spot reduction."
      })
    }
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
    referenceBuoys: ["46237", "46026", "46013"],
    cdipStations: ["142"],
    tideStation: "9414290",
    notes: "Exposed beachbreak; needs local calibration for bars and tide sensitivity.",
    sourceMap: {
      gfsWave: gfsWave(
        { lat: 37.76, lon: -122.88 },
        "Nearest offshore wcoast 0p16 point west of southern Ocean Beach; same offshore point as OBSF central at this grid resolution."
      ),
      observedWave: [
        observedSources.ndbc46026,
        observedSources.cdip142,
        observedSources.ndbc46013,
        observedSources.ndbc46012
      ],
      cdipMop: cdipMop(
        "sf",
        ["142"],
        {
          id: "SF015",
          lat: 37.73442,
          lon: -122.51637,
          waterDepthM: 10.01,
          shoreNormalDeg: 268.53,
          nearshoreHeightScale: 1,
          relationship: "direct_nearshore_point"
        },
        "SF015 is the verified public 10.01 m MOP point at Ocean Beach South. Its Hs is modeled nearshore significant wave height, not breaking-wave face height."
      ),
      coopsTide: coopsTideStations.sanFrancisco,
      nwsPoint: nwsPoint({
        gridX: 81,
        gridY: 104,
        pointType: "land",
        forecastZone: "CAZ006",
        forecastGridData: "https://api.weather.gov/gridpoints/MTR/81,104",
        forecastHourly: "https://api.weather.gov/gridpoints/MTR/81,104/forecast/hourly",
        observationStations: "https://api.weather.gov/gridpoints/MTR/81,104/stations",
        notes: "Live NWS point metadata returned MTR grid 81,104 on San Francisco forecast zone CAZ006."
      }),
      nwsWaveGrid: nwsWaveGrid({
        gridX: 80,
        gridY: 104,
        lookupPoint: { lat: 37.735, lon: -122.53 },
        breakingHeightScale: 1,
        notes: "Verified adjacent PZZ545 marine cell for Ocean Beach South; raw significant height is used without a spot reduction."
      })
    }
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
    referenceBuoys: ["46012", "46237", "46026"],
    cdipStations: ["142"],
    tideStation: "9414131",
    notes: "Protected beginner-friendly beach; smaller swell windows matter.",
    sourceMap: {
      gfsWave: gfsWave(
        { lat: 37.6, lon: -122.88 },
        "Nearest offshore wcoast 0p16 point west of Pacifica; validate against Half Moon Bay buoy 46012."
      ),
      observedWave: [
        { ...observedSources.ndbc46012, role: "primary" },
        observedSources.ndbc46026,
        observedSources.cdip142
      ],
      cdipMop: cdipMop(
        "sf",
        ["142"],
        {
          id: "SM371",
          lat: 37.59555,
          lon: -122.52342,
          waterDepthM: 15.01,
          shoreNormalDeg: 295.98,
          nearshoreHeightScale: 0.6,
          relationship: "outside_cove_approach_proxy"
        },
        "SM371 is a verified public 15.01 m approach point outside Linda Mar's cove. The explicit 0.60 final cove scale remains a cold-start proxy and must stay visible."
      ),
      coopsTide: coopsTideStations.pillarPoint,
      nwsPoint: nwsPoint({
        gridX: 80,
        gridY: 98,
        pointType: "land",
        forecastZone: "CAZ509",
        forecastGridData: "https://api.weather.gov/gridpoints/MTR/80,98",
        forecastHourly: "https://api.weather.gov/gridpoints/MTR/80,98/forecast/hourly",
        observationStations: "https://api.weather.gov/gridpoints/MTR/80,98/stations",
        notes: "Live NWS point metadata returned MTR grid 80,98 for Pacifica forecast zone CAZ509."
      }),
      nwsWaveGrid: nwsWaveGrid({
        gridX: 79,
        gridY: 98,
        lookupPoint: { lat: 37.594, lon: -122.53 },
        breakingHeightScale: 0.6,
        notes: "Verified adjacent PZZ545 marine cell; cold-start 0.60 scale estimates Linda Mar breaking height from raw coastal-grid height."
      })
    }
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
    referenceBuoys: ["46237", "46013", "46026"],
    cdipStations: ["142", "029"],
    tideStation: "9414958",
    notes: "More sheltered than OBSF; local transform and tide calibration needed.",
    sourceMap: {
      gfsWave: gfsWave(
        { lat: 37.92, lon: -123.04 },
        "Nearest offshore wcoast 0p16 point outside the Golden Gate for Marin; GFSwave cannot resolve Stinson's nearshore sheltering."
      ),
      observedWave: [
        observedSources.ndbc46026,
        observedSources.cdip142,
        observedSources.cdip029,
        observedSources.ndbc46013
      ],
      cdipMop: cdipMop(
        "sf",
        ["142", "029"],
        {
          id: "MA122",
          lat: 37.88907,
          lon: -122.64715,
          waterDepthM: 15,
          shoreNormalDeg: 221.52,
          nearshoreHeightScale: 1,
          relationship: "direct_nearshore_point"
        },
        "MA122 is the verified public 15 m MOP point nearest Stinson. Its Hs is modeled nearshore significant wave height, not breaking-wave face height."
      ),
      coopsTide: coopsTideStations.bolinasLagoon,
      nwsPoint: nwsPoint({
        gridX: 78,
        gridY: 112,
        pointType: "marine",
        forecastZone: "PZZ545",
        forecastGridData: "https://api.weather.gov/gridpoints/MTR/78,112",
        forecastHourly: "https://api.weather.gov/gridpoints/MTR/78,112/forecast/hourly",
        observationStations: "https://api.weather.gov/gridpoints/MTR/78,112/stations",
        notes: "Live NWS point metadata returned a marine point on forecast zone PZZ545."
      }),
      nwsWaveGrid: nwsWaveGrid({
        gridX: 78,
        gridY: 112,
        lookupPoint: { lat: 37.899, lon: -122.644 },
        breakingHeightScale: 0.55,
        notes: "Verified PZZ545 coastal-marine grid; cold-start 0.55 scale represents Stinson sheltering."
      })
    }
  },
  {
    id: "bolinas",
    name: "Bolinas — Wharf/Brighton",
    region: "norcal",
    lat: 37.909,
    lon: -122.687,
    timezone: "America/Los_Angeles",
    shoreNormalDeg: 215,
    bestSwellDeg: { minDeg: 210, maxDeg: 285 },
    workableSwellDeg: { minDeg: 190, maxDeg: 310 },
    bestPeriodSec: { min: 8, max: 15 },
    bestTideFt: { min: 0.5, max: 4.5 },
    offshoreWindFromDeg: { minDeg: 270, maxDeg: 20 },
    maxGoodWindKt: 8,
    maxOkWindKt: 14,
    referenceBuoys: ["46237", "46013", "46026"],
    cdipStations: ["142", "029"],
    tideStation: "9414958",
    notes: "Regional Wharf/Brighton-facing Bolinas report. NW/WNW is offshore for the southeast-facing beach; keep wave-height confidence low until a direct nearshore source is resolved.",
    sourceMap: {
      gfsWave: gfsWave(
        { lat: 37.92, lon: -123.04 },
        "Nearest offshore wcoast 0p16 point west of Bolinas Lagoon; requires CDIP/local transform before confident nearshore sizing."
      ),
      observedWave: [
        observedSources.ndbc46026,
        observedSources.cdip142,
        observedSources.cdip029,
        observedSources.ndbc46013
      ],
      cdipMop: cdipMop(
        "sf",
        ["142", "029"],
        null,
        "No safe direct MOP point is mapped for Bolinas. Keep the spot uncalibrated on the NWS coastal-grid fallback rather than borrowing Stinson or an offshore Marin point."
      ),
      coopsTide: coopsTideStations.bolinasLagoon,
      nwsPoint: nwsPoint({
        gridX: 77,
        gridY: 113,
        pointType: "land",
        forecastZone: "CAZ505",
        forecastGridData: "https://api.weather.gov/gridpoints/MTR/77,113",
        forecastHourly: "https://api.weather.gov/gridpoints/MTR/77,113/forecast/hourly",
        observationStations: "https://api.weather.gov/gridpoints/MTR/77,113/stations",
        notes: "Live NWS point metadata returned MTR grid 77,113 for coastal Marin forecast zone CAZ505."
      }),
      nwsWaveGrid: nwsWaveGrid({
        gridX: 75,
        gridY: 113,
        lookupPoint: { lat: 37.909, lon: -122.73 },
        breakingHeightScale: 0.65,
        notes: "First verified PZZ545 marine cell west of Bolinas; land cells 77,113 and 76,113 returned all-zero wave layers. Cold-start scale is 0.65."
      })
    }
  }
];

export function getSpotProfile(id: SpotId): NorcalSpotProfile {
  const spot = NORCAL_SPOTS.find((candidate) => candidate.id === id);
  if (!spot) {
    throw new Error(`Unknown spot: ${id}`);
  }
  return spot;
}

export function getSpotSourceMap(id: SpotId): SpotSourceMap {
  return getSpotProfile(id).sourceMap;
}
