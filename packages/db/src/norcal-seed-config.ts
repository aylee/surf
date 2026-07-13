export type SourceSeedRow = {
  id: string;
  name: string;
  type: string;
  provider: string;
  externalId: string | null;
  url: string;
  format: string;
  parserRuntime: "python" | "worker";
  attribution: string;
  licenseNote: string;
  refreshMinutes: number;
  active: boolean;
  metadata: Record<string, unknown>;
};

type NorcalSeedConfig = {
  schemaVersion: 1;
  referenceConfigVersion: 1;
  sources: SourceSeedRow[];
};

const ndbcLicense = "Public NOAA/NDBC observations; retain station and observation time.";
const ndbcStationLicense = "Public NOAA/NDBC observations; retain station attribution.";
const coopsLicense = "Public NOAA CO-OPS tide and water-level data; retain station attribution.";
const nwsLicense = "Public NWS API data; provide User-Agent and retain attribution.";

/**
 * Persistence-only source metadata for the NorCal reference deployment.
 * Spot geometry, scoring priors, and per-spot source points live in
 * @surf/forecast-core and are never duplicated here.
 */
export const NORCAL_SEED_CONFIG: NorcalSeedConfig = {
  schemaVersion: 1,
  referenceConfigVersion: 1,
  sources: [
    {
      id: "cdip:mop-forecast",
      name: "CDIP MOP public per-point nearshore forecast",
      type: "forecast_wave_nearshore",
      provider: "CDIP/MOP",
      externalId: "MOP_alongshore",
      url: "https://thredds.cdip.ucsd.edu/thredds/catalog/cdip/model/MOP_alongshore/catalog.html",
      format: "opendap_ascii",
      parserRuntime: "worker",
      attribution: "Coastal Data Information Program MOP modeled wave forecasts",
      licenseNote:
        "Public CDIP model output. Retain point ID, raw Hs, depth, Last-Modified source update, deterministic transform inputs, and the distinction from observed surf-face truth.",
      refreshMinutes: 180,
      active: true,
      metadata: {
        adapter: "fetchCdipMopForecastsForSpots",
        variables: ["waveTime", "waveHs", "waveTp", "waveDp", "waveDm"],
        sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle",
        heightSemantics: "modeled_significant_wave_height_not_breaking_face_height",
        experimentalTransform: "bulk-hs-linear-shoaling-v1",
        experimentalTransformAffectsDisplay: false,
        breakerIndex: 0.78
      }
    },
    {
      id: "ndbc:realtime2-standard-meteorological",
      name: "NDBC realtime wave observation adapter",
      type: "observed_wave",
      provider: "NOAA/NDBC",
      externalId: "realtime2",
      url: "https://www.ndbc.noaa.gov/data/realtime2/",
      format: "ndbc_text",
      parserRuntime: "worker",
      attribution: "NOAA National Data Buoy Center realtime2 observations",
      licenseNote: ndbcLicense,
      refreshMinutes: 30,
      active: true,
      metadata: {
        adapter: "fetchNdbcRealtimeObservationsForStations"
      }
    },
    {
      id: "ndbc-46237",
      name: "NDBC 46237 San Francisco Bar buoy",
      type: "observed_wave",
      provider: "NOAA/NDBC",
      externalId: "46237",
      url: "https://www.ndbc.noaa.gov/station_page.php?station=46237",
      format: "ndbc_text",
      parserRuntime: "worker",
      attribution: "NOAA/NDBC Station 46237 / CDIP 142",
      licenseNote: ndbcStationLicense,
      refreshMinutes: 30,
      active: true,
      metadata: {
        station: "46237",
        cdipStation: "142",
        notes: "Nearshore San Francisco Bar reference used by the surf nowcast."
      }
    },
    {
      id: "ndbc-46026",
      name: "NDBC 46026 San Francisco buoy",
      type: "observed_wave",
      provider: "NOAA/NDBC",
      externalId: "46026",
      url: "https://www.ndbc.noaa.gov/station_page.php?station=46026",
      format: "ndbc_text",
      parserRuntime: "worker",
      attribution: "NOAA/NDBC Station 46026",
      licenseNote: ndbcStationLicense,
      refreshMinutes: 60,
      active: true,
      metadata: {
        station: "46026",
        notes: "Primary observed-wave reference for Ocean Beach and broader SF approaches."
      }
    },
    {
      id: "ndbc-46013",
      name: "NDBC 46013 Bodega Bay buoy",
      type: "observed_wave",
      provider: "NOAA/NDBC",
      externalId: "46013",
      url: "https://www.ndbc.noaa.gov/station_page.php?station=46013",
      format: "ndbc_text",
      parserRuntime: "worker",
      attribution: "NOAA/NDBC Station 46013",
      licenseNote: ndbcStationLicense,
      refreshMinutes: 60,
      active: true,
      metadata: {
        station: "46013",
        notes: "Secondary north-coast observed-wave reference for Marin/SF."
      }
    },
    {
      id: "ndbc-46012",
      name: "NDBC 46012 Half Moon Bay buoy",
      type: "observed_wave",
      provider: "NOAA/NDBC",
      externalId: "46012",
      url: "https://www.ndbc.noaa.gov/station_page.php?station=46012",
      format: "ndbc_text",
      parserRuntime: "worker",
      attribution: "NOAA/NDBC Station 46012",
      licenseNote: ndbcStationLicense,
      refreshMinutes: 60,
      active: true,
      metadata: {
        station: "46012",
        notes: "Southern reference buoy for Linda Mar/Pacifica."
      }
    },
    {
      id: "coops-9414290",
      name: "NOAA CO-OPS San Francisco tide station",
      type: "tide",
      provider: "NOAA CO-OPS",
      externalId: "9414290",
      url: "https://api.tidesandcurrents.noaa.gov/api/prod/",
      format: "json",
      parserRuntime: "worker",
      attribution: "NOAA CO-OPS Station 9414290",
      licenseNote: coopsLicense,
      refreshMinutes: 360,
      active: true,
      metadata: {
        station: "9414290",
        datum: "MLLW",
        units: "english",
        notes: "Shared reference tide station for Ocean Beach."
      }
    },
    {
      id: "coops-9414131",
      name: "NOAA CO-OPS Pillar Point Harbor tide station",
      type: "tide",
      provider: "NOAA CO-OPS",
      externalId: "9414131",
      url: "https://api.tidesandcurrents.noaa.gov/api/prod/",
      format: "json",
      parserRuntime: "worker",
      attribution: "NOAA CO-OPS Station 9414131",
      licenseNote: coopsLicense,
      refreshMinutes: 360,
      active: true,
      metadata: {
        station: "9414131",
        datum: "MLLW",
        units: "english",
        notes: "Linda Mar / Pacifica reference tide station."
      }
    },
    {
      id: "coops-9414958",
      name: "NOAA CO-OPS Bolinas Lagoon tide station",
      type: "tide",
      provider: "NOAA CO-OPS",
      externalId: "9414958",
      url: "https://api.tidesandcurrents.noaa.gov/api/prod/",
      format: "json",
      parserRuntime: "worker",
      attribution: "NOAA CO-OPS Station 9414958",
      licenseNote: coopsLicense,
      refreshMinutes: 360,
      active: true,
      metadata: {
        station: "9414958",
        datum: "MLLW",
        units: "english",
        notes: "Stinson and Bolinas reference tide station."
      }
    },
    {
      id: "coops:tide-predictions",
      name: "NOAA CO-OPS tide prediction adapter",
      type: "tide",
      provider: "NOAA CO-OPS",
      externalId: "predictions",
      url: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter",
      format: "json",
      parserRuntime: "worker",
      attribution: "NOAA CO-OPS predictions API",
      licenseNote: coopsLicense,
      refreshMinutes: 360,
      active: true,
      metadata: {
        adapter: "fetchCoopsTidePredictionsForSpots"
      }
    },
    {
      id: "nws:mtr-grid-wave",
      name: "NWS MTR coastal marine grid wave forecast",
      type: "forecast_wave_nearshore",
      provider: "NOAA/NWS MTR",
      externalId: "MTR-grid-wave",
      url: "https://api.weather.gov/gridpoints/MTR/",
      format: "geojson",
      parserRuntime: "worker",
      attribution: "NOAA/NWS MTR raw 2.5 km coastal marine grid forecast",
      licenseNote:
        "Public National Weather Service forecast data; retain source grid, model update time, and derivation.",
      refreshMinutes: 60,
      active: true,
      metadata: {
        adapter: "fetchNwsGridWaveForSpots",
        fields: [
          "waveHeight",
          "wavePeriod",
          "wavePeriod2",
          "primarySwellHeight",
          "primarySwellDirection",
          "secondarySwellHeight",
          "secondarySwellDirection",
          "windWaveHeight"
        ],
        derivation: "raw significant height multiplied by explicit per-spot cold-start scale"
      }
    },
    {
      id: "nws:point-forecast-alerts",
      name: "NWS point forecast and alerts adapter",
      type: "wind",
      provider: "NWS",
      externalId: "points-alerts",
      url: "https://api.weather.gov/",
      format: "json",
      parserRuntime: "worker",
      attribution: "National Weather Service points, grid forecast, and active alerts APIs",
      licenseNote: nwsLicense,
      refreshMinutes: 60,
      active: true,
      metadata: {
        adapter: "fetchNwsContextForSpots",
        capabilities: ["wind", "hazard"]
      }
    }
  ]
};
