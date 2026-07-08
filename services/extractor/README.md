# surf extractor

Python package for source extraction work that does not belong inside a
Cloudflare Worker:

- NOAA/NCEP GFSwave GRIB2 subsetting and point extraction.
- CDIP THREDDS/netCDF modeled and observed data.
- NDBC/CDIP historical observations for backtesting.
- Future bathymetry/SWAN/regional transforms.

The bootstrap package only plans requests and validates fixtures. The v1
implementation adds `wgrib2`, ecCodes/cfgrib, xarray, and netCDF processing.

## NOAA GFSwave v1 shell

The current GFSwave path can:

- select the latest complete cycle by validating required forecast-hour
  inventories;
- build NOMADS filter URLs for the NorCal bbox;
- build direct `.idx` inventory URLs under the live GFS product path;
- plan deterministic R2 keys for raw GRIB2 subset artifacts;
- normalize JSON-like point extraction values into typed forecast rows.

Local GRIB point extraction is intentionally blocked until the runtime has
either `wgrib2` or the optional `cfgrib` + `xarray` stack installed. Check the
current machine with:

```bash
uv run --project services/extractor surf-extractor grib-tooling-status
```

```bash
uv run --project services/extractor surf-extractor inspect-fixtures
uv run --project services/extractor surf-extractor validate-gfswave-cycle --forecast-hour 0 --forecast-hour 3
uv run --project services/extractor pytest
```

## Public observation backtest harness

The first calibration harness summarizes public NDBC historical standard
meteorological files. It is intentionally physical-data-only: it does not use
private session labels or proprietary forecast text.

```bash
uv run --project services/extractor surf-extractor backtest-ndbc-history --station-id 46026 --year 2025
```
