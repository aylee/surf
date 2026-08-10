# Feed Adapters

The project does not pick one marine API. It composes public feeds by role.

## Capability Roles

| Capability | Default source | Live Worker | Notes |
|---|---|---:|---|
| `forecast_wave_offshore` | NOAA/NCEP GFSwave via NOMADS | no | Optional Python research/evaluation path; not an input to the deployed v1 Worker. |
| `forecast_wave_nearshore` | CDIP MOP per-point forecast; NWS coastal grid fallback | yes | Prefer mapped CDIP modeled Hs where a direct or explicitly labeled approach point is verified. Keep NWS as the explicit fallback and for unmapped Bolinas. |
| `observed_wave` | NDBC + CDIP buoys | yes | Offshore/nearshore observation context and physical validation; not breaking-wave truth. |
| `tide` | NOAA CO-OPS | yes | Tide predictions and water levels. |
| `wind` | NWS first, model winds later | yes | Surface quality and hazards. |
| `hazard` | NWS alerts/forecast products | yes | Display context, not scoring alone. |
| `bathymetry` | NOAA ETOPO / regional DEMs | later | For SWAN/custom transforms after v1. |
| `quality_label` | Human/community ratings | later | Surf-quality calibration labels. |
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
  CDIP OPeNDAP ASCII forecast reads, queue orchestration, and the forecast API.
- Python extractor: GRIB2, netCDF, xarray, historical CDIP/THREDDS extraction,
  wgrib2/ecCodes, and future bathymetry transforms.

Live Worker adapters run inside deterministic source batches of at most four
catalog spots. Each adapter receives only the batch profiles; NDBC station
requests are deduplicated from only those spots' operational mappings, and all
normalized persistence (including shared buoy observations) remains scoped to
the same spot set. Exact worst-case request-URL tests cover all five provider
attempts plus CDIP metadata `HEAD` fallback: the checked-in batches use
36/36/25 external requests, each below the Free Worker limit of 50. Catalog or
source-map expansion must re-pass this budget; silently growing a monolithic
Worker ingest is not supported.

Every horizon-truncating adapter receives the same exclusive display boundary:
the midnight after the fifth complete local forecast date. CO-OPS requests end
at that exact instant, NWS expands only local-clock slots before it, and CDIP
filters its samples through it. The resulting whole-hour ceiling is 120 hours
on a normal five-date window, 119 across spring-forward, and 121 across
fall-back when ingest starts at `00:17`; regression fixtures cover all three so
the final date and its official tide extrema are never clipped.

## v1 Adapter Status

| Adapter | Runtime | Status | Notes |
|---|---|---|---|
| NOAA GFSwave inventory/artifact planning | Python | research tooling | Validates `wcoast.0p16` `.idx` inventories for f000-f072 and plans R2 keys. It is not a deployed v1 input; numeric extraction requires `wgrib2` or `cfgrib` + `xarray`. |
| NOAA CO-OPS tide predictions | Worker | live ingest | Fetches hourly MLLW predictions plus official `hilo` extrema for mapped v1 stations. Hourly samples write to `tide_forecasts`; source-provided high/low events write additively to `tide_events`. |
| NWS point forecast and alerts | Worker | live ingest | Resolves spot point forecasts, hourly wind periods, and active alerts; writes `wind_forecasts` and `hazard_events`. |
| NWS MTR coastal grid waves | Worker | live ingest | Reads official `forecastGridData` wave/swell layers for 11 spot mappings across nine verified marine cells in PZZ545 and PZZ535. Shared cells and every cold-start scale remain explicit. The adapter expands ISO-8601 value intervals onto five days of local-clock 3-hour slots, preserves raw significant height, and writes a separately identified breaking-height estimate to `wave_forecasts`. |
| CDIP/MOP nearshore forecast | Worker | live preferred ingest | Reads only `waveTime`, `waveHs`, `waveTp`, `waveDp`, and `waveDm` from constrained public per-point OPeNDAP ASCII responses. Direct mappings are SF043/SF029/SF015 for Ocean Beach, MA122 for Stinson, MA048 for Rodeo, SC149 for Steamer Lane, and SC117 for Pleasure Point. Linda Mar, Cowell's, and Jack's use visible approach proxies; Bolinas intentionally has no MOP mapping. |
| NDBC realtime observations | Worker | live ingest | Parses bounded `realtime2` standard-meteorological feeds for 46237, 46026, 46013, 46012, 46236, and 46042; stores the newest valid wave/period/direction/water-temperature rows in `wave_observations` and exposes the preferred fresh regional buoy per spot. |
| NDBC history backtest | Python | harness | Parses public historical stdmet files and reports observation-summary metrics for calibration. |

CO-OPS extrema are kept distinct from sampled hourly predictions. The API uses
the official high/low event rows for labels and keeps the hourly series for the
tide curve and per-window trend. It does not infer every extremum from sparse
samples, and both products retain their station, source run, and validity time.
Santa Cruz spots share runtime station 9413450 (Monterey), which supplies the
hourly curve and high/low MLLW series. The closer official subordinate station
9413745 (Santa Cruz) currently supplies only high/low predictions; its
reference relationship is recorded, but the adapter does not splice those
extrema into a fabricated local hourly curve.

Alert reconciliation treats a successful NWS active-alert response as the
authoritative set for that spot. A successful empty response withdraws stored
alerts, including alerts without an `ends_at`; a failed or malformed alerts
request preserves the last good set and is recorded as unavailable. Wind
forecast success is tracked independently, so an alert endpoint failure cannot
erase alerts or discard usable wind rows.

## Expanded Reference Spot Source Map

All five additions use `America/Los_Angeles` and NWS Weather Forecast Office
MTR for wind/hazard context. Coordinates and break-facing bearings are catalog
points and cold-start geometry, not surveyed takeoff positions.

| Spot | Catalog point / facing | CDIP/MOP mapping | NWS marine fallback | CO-OPS tide | Regional observed-wave context |
|---|---|---|---|---|---|
| Rodeo Beach | `37.8305,-122.5376` / `224°` | MA048, direct 15 m point, `×1.00` | MTR `81,108`, PZZ545, `×1.00` | 9414290 San Francisco | 46237 primary; 46026 and 46013 regional |
| Steamer Lane | `36.9511,-122.0264` / `128°` | SC149, named direct 15 m point, `×1.00` | MTR `91,66`, PZZ535, `×1.00` | 9413450 Monterey reference | 46236 primary; 46042 regional; inactive 46269 validation-only |
| Pleasure Point | `36.9545,-121.9725` / `158°` | SC117, named direct 15 m point, `×1.00` | MTR `93,66`, PZZ535, `×1.00` | 9413450 Monterey reference | same regional Santa Cruz inputs |
| Cowell's | `36.9624,-122.0238` / `140°` | shared SC149 approach proxy, uncalibrated `×0.50` | shared MTR `91,66`, PZZ535, uncalibrated `×0.50` | 9413450 Monterey reference | same regional Santa Cruz inputs |
| Jack's | `36.9616,-121.9662` / `165°` | shared SC117 approach proxy, `×1.00` with no invented attenuation | shared MTR `93,66`, PZZ535, `×1.00` | 9413450 Monterey reference | same regional Santa Cruz inputs |

Primary mapping evidence is the [NPS Rodeo Beach page](https://www.nps.gov/places/000/rodeo-beach.htm),
the [NWS MTR marine-zone table](https://www.weather.gov/marine/mtrmz), the
[CDIP Marin](https://cdip.ucsd.edu/mops/?xitem=countymap&moplist=Marin_County)
and [Santa Cruz](https://cdip.ucsd.edu/mops/?xitem=mlmap&moplist=Santa_Cruz_County)
MOP maps plus the [public MOP forecast catalog](https://thredds.cdip.ucsd.edu/thredds/catalog/cdip/model/MOP_alongshore/catalog.html),
and official CO-OPS metadata for [Monterey 9413450](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9413450.json)
and [Santa Cruz 9413745](https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9413745.json).
Regional wave context comes from active NDBC stations
[46236](https://www.ndbc.noaa.gov/station_page.php?station=46236) and
[46042](https://www.ndbc.noaa.gov/station_page.php?station=46042). The closer
[46269](https://www.ndbc.noaa.gov/station_page.php?station=46269) reports no
current observations and therefore remains validation-only. Santa Cruz County's
[surf-school use map](https://parks.santacruzcountyca.gov/Portals/12/pdfs/Surf%20schools/Surf%20School%20Permit%20Terms%20and%20Conditions%20of%20Use.pdf)
supports the 38th Avenue alias; it is not evidence for a distinct model point.

## Declared Freshness Cadence

The Adapter Contract above requires each adapter to declare a freshness
cadence. The declarations live as exported constants beside each adapter's
source ID, flow into every materialized payload source entry
(`expectedCadenceMinutes` + `graceMinutes`), and feed the single pure
`freshnessVerdict` in `@surf/contracts` (`fresh` ≤ cadence < `aging` ≤
cadence + grace < `late`). No other module may define a freshness threshold.

| Adapter | Cadence (min) | Grace (min) | Justification |
|---|---|---|---|
| NOAA CO-OPS tide predictions | 1440 | 360 | Predictions are precomputed astronomical tables — the data does not change between fetches, so cadence tracks fetch recency (ingest health). Scheduled ingest is hourly (observed `source_runs` gap ≈ 56 min); a missed day of fetches plus grace marks the feed late. |
| NWS point forecast and alerts | 360 | 180 | Point forecasts refresh with each office forecast package — issued at least twice daily and amended between packages, in practice every 2–6 h. `updateTime` on the hourly product is the observed update signal, persisted as `wind_forecasts.model_cycle_at`. |
| NWS MTR coastal grid waves | 720 | 240 | Grid `properties.updateTime` advances with office grid refreshes, observed every several hours; as the fallback wave source it is declared late only well past a full package cycle. |
| CDIP/MOP nearshore forecast | 360 | 180 | MOP forecast files are rewritten with each model run, several times daily. The cadence applies to the source-file update timestamp (HTTP `Last-Modified`, retained as `http_last_modified_source_update_not_model_cycle`); the physics `model_cycle_at` remains the lead-hour authority and is never re-judged as freshness. |
| NDBC realtime observations | 60 | 60 | Standard meteorological buoys report roughly hourly; grace tolerates one missed report. Cadence + grace equals the existing `NDBC_STALE_AFTER_MINUTES` (120) fresh-buoy preference boundary by construction. |

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

Ocean Beach, Stinson, Rodeo Beach, Steamer Lane, and Pleasure Point start from
their direct mapped point Hs. Linda Mar uses SM371 outside its cove and applies
the visible cold-start `0.60` final exposure factor. Cowell's shares SC149 with
an uncalibrated `0.50` factor; Jack's shares SC117 at `1.00` because no
supported break-specific attenuation is known. Both are explicitly labeled
approach proxies, never local observations. A diagnostic outside its validity
bounds is recorded as unavailable without dropping the primary MOP Hs row.
There is no safe direct MOP point for Bolinas, so it remains uncalibrated on the
NWS coastal-grid fallback rather than borrowing a nearby point.

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
`1.00`, Linda Mar `0.60`, Stinson `0.55`, Bolinas `0.65`, Rodeo Beach `1.00`,
Steamer Lane `1.00`, Pleasure Point `1.00`, Cowell's `0.50`, and Jack's `1.00`.
Cowell's shares Steamer Lane's SC149-area cell and Jack's shares Pleasure
Point's SC117-area cell; the catalog does not imply break-scale grid precision.
The API returns the raw value, scale, derived value, grid URL, and source-update
time together. Missing or all-zero marine wave layers produce an `unknown`
surf call; fixture values are never substituted in production.
