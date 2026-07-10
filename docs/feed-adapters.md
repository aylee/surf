# Feed Adapters

The project does not pick one marine API. It composes public feeds by role.

## Capability Roles

| Capability | Default source | Required for v1 | Notes |
|---|---|---:|---|
| `forecast_wave_offshore` | NOAA/NCEP GFSwave via NOMADS | yes | GRIB2 subset/extract in Python. |
| `forecast_wave_nearshore` | CDIP MOP per-point forecast; NWS coastal grid fallback | yes | Prefer mapped CDIP modeled Hs at Ocean Beach, Linda Mar, and Stinson. Keep NWS as the explicit fallback and for unmapped Bolinas. |
| `observed_wave` | NDBC + CDIP buoys | yes | Ground truth for nowcast and bias checks. |
| `tide` | NOAA CO-OPS | yes | Tide predictions and water levels. |
| `wind` | NWS first, model winds later | yes | Surface quality and hazards. |
| `hazard` | NWS alerts/forecast products | yes | Display context, not scoring alone. |
| `bathymetry` | NOAA ETOPO / regional DEMs | later | For SWAN/custom transforms after v1. |
| `quality_label` | Alex/community ratings | later | Surf-quality calibration labels. |
| `comparison_forecast` | Open-Meteo/manual comparison | optional | Eval oracle only, not source of truth. |

## Adapter Contract

Each adapter must declare:

- provider and public documentation URL;
- capabilities;
- geography/coverage;
- format and parser runtime;
- freshness cadence;
- attribution/license note;
- fixture strategy;
- failure modes and retry policy.

Adapters should normalize into shared contracts before data reaches scoring.
Raw source payloads should be stored in R2 when they are expensive to refetch or
needed for audit/backtesting.

## Runtime Split

- Worker/TypeScript: JSON APIs, lightweight NOAA/NWS/CO-OPS fetches, bounded
  CDIP OPeNDAP ASCII forecast reads, queue orchestration, scoring API, report API.
- Python extractor: GRIB2, netCDF, xarray, historical CDIP/THREDDS extraction,
  wgrib2/ecCodes, and future bathymetry transforms.

## v1 Adapter Status

| Adapter | Runtime | Status | Notes |
|---|---|---|---|
| NOAA GFSwave inventory/artifact planning | Python | live inventory validation | Validates `wcoast.0p16` `.idx` inventories for f000-f072 and plans R2 keys. Numeric GRIB extraction waits on `wgrib2` or `cfgrib` + `xarray`. |
| NOAA CO-OPS tide predictions | Worker | live ingest | Fetches hourly MLLW predictions for mapped v1 stations and writes `tide_forecasts`. |
| NWS point forecast and alerts | Worker | live ingest | Resolves spot point forecasts, hourly wind periods, and active alerts; writes `wind_forecasts` and `hazard_events`. |
| NWS MTR coastal grid waves | Worker | live ingest | Reads official `forecastGridData` wave/swell layers at six verified PZZ545 marine cells, expands ISO-8601 value intervals onto five days of local-clock 3-hour slots, preserves raw significant height, and writes a separately identified cold-start breaking-height estimate to `wave_forecasts`. |
| CDIP/MOP nearshore forecast | Worker | live preferred ingest | Reads only `waveTime`, `waveHs`, `waveTp`, `waveDp`, and `waveDm` from constrained public per-point OPeNDAP ASCII responses. Exact mappings are SF043/SF029/SF015 for Ocean Beach, SM371 for Linda Mar, and MA122 for Stinson. Bolinas intentionally has no MOP mapping. |
| NDBC realtime observations | Worker | live ingest | Parses bounded `realtime2` standard-meteorological feeds for 46237, 46026, 46013, and 46012; stores the newest valid wave/period/direction/water-temperature rows in `wave_observations` and exposes the preferred fresh buoy per spot. |
| NDBC history backtest | Python | harness | Parses public historical stdmet files and reports observation-summary metrics for calibration. |

## CDIP MOP Forecast Semantics

The [CDIP MOP documentation](https://cdip.ucsd.edu/documents/index/product_docs/mops/mop_intro.html)
describes the nearshore model, and the public THREDDS catalog exposes compact
per-point forecast files. The Worker makes a constrained `.ascii` request for
the five bulk arrays only and enforces a 64 KiB response ceiling before
buffering. Successful raw ASCII responses are retained in R2 with the source
URL and checksum.

The OPeNDAP ASCII response does not expose either file-update or runtime-cycle
metadata. A bounded `.das` request parses the single `NC_GLOBAL.history`
runtime argument `-s YYYYMMDDHHMM` as the true UTC model cycle; that value and
the resulting lead hour populate `wave_forecasts.model_cycle_at` and
`wave_forecasts.lead_hour`. Missing, malformed, or ambiguous runtime-cycle
metadata fails closed. When all fetched points share a cycle it is also written
to `source_runs.cycle_at`; per-spot cycles always remain in source-run metadata.

A separate metadata `HEAD` request to the corresponding NetCDF file supplies
HTTP `Last-Modified`. That value is stored and displayed only as the
**source-file update time**, explicitly not as an underlying model cycle. The
normalized payload retains
`http_last_modified_source_update_not_model_cycle` so consumers cannot silently
reinterpret it as a physics-model cycle. Raw R2 capture retains both the five-
array ASCII payload and the DAS metadata used to establish the cycle.

`waveHs` is modeled significant wave height at the mapped 10 m or 15 m point.
It is neither an observation nor breaking-wave face-height truth. The
exposure-adjusted MOP Hs drives the displayed central estimate because that is
the quantity supported by the current issued-forecast evaluation. It remains
confidence-capped and must not be described as measured surf-face height.

For future break-level evaluation, the Worker also records an experimental
bulk-Hs diagnostic that carries point Hs to first depth-limited breaking using
linear dispersion, Snell refraction, conserved shore-normal energy flux, and
the explicit engineering assumption `H_b = 0.78 h_b`. It has no fitted vendor
weight and no LLM step, but it treats total Hs as one peak-period/direction
component and omits bottom friction, nonlinear dissipation, and local sandbars.
The diagnostic does **not** affect displayed height, scoring, or rankings.

Ocean Beach and Stinson start from the mapped point Hs. Linda Mar uses SM371, a
15.01 m point outside the cove, and applies the visible cold-start `0.60` final
cove exposure factor. A diagnostic outside its validity bounds is recorded as
unavailable without dropping the primary MOP Hs row. There is no safe direct
MOP point for Bolinas, so it remains uncalibrated on the NWS coastal-grid
fallback rather than borrowing a nearby point.

Attribution: Coastal Data Information Program (CDIP), Scripps Institution of
Oceanography, UC San Diego. Preserve the MOP point ID, point depth, raw Hs,
exposure and diagnostic shoaling factors, breaker index/depth, transform
version, source URL, and source-file update time in downstream forecast
provenance.

## NWS Coastal-Grid Wave Derivation

The [NWS API documentation](https://www.weather.gov/documentation/services-web-api)
documents `forecastGridData` as raw forecast data for an
approximately 2.5 km grid and notes that coastal marine grids are available
through this property. The adapter consumes `waveHeight`, `wavePeriod`,
`wavePeriod2`, primary and secondary swell height/direction, and
`windWaveHeight`. Values retain their NWS `updateTime`, source URL, units, and
raw significant height. The API's `properties.updateTime` is retained as the
source-update timestamp; it is not labeled as an underlying model cycle.

`nearshore_height_m` is an estimated breaking height, not a second source
measurement. It is deterministically derived as raw NWS significant height
times the explicit cold-start spot scale: Ocean Beach North/Central/South
`1.00`, Linda Mar `0.60`, Stinson `0.55`, and Bolinas `0.65`. The API returns
the raw value, scale, derived value, grid URL, and source-update time together. Missing
or all-zero marine wave layers produce an `unknown` surf call; fixture values
are never substituted in production.
