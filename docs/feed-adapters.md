# Feed Adapters

The project does not pick one marine API. It composes public feeds by role.

## Capability Roles

| Capability | Default source | Required for v1 | Notes |
|---|---|---:|---|
| `forecast_wave_offshore` | NOAA/NCEP GFSwave via NOMADS | yes | GRIB2 subset/extract in Python. |
| `forecast_wave_nearshore` | CDIP modeled data / MOP | yes where available | California shortcut to nearshore transform. |
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

- Worker/TypeScript: JSON APIs, lightweight NOAA/NWS/CO-OPS fetches, queue
  orchestration, scoring API, report API.
- Python extractor: GRIB2, netCDF, xarray, CDIP THREDDS, wgrib2/ecCodes, future
  bathymetry transforms.

