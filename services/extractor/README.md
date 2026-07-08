# surf extractor

Python package for source extraction work that does not belong inside a
Cloudflare Worker:

- NOAA/NCEP GFSwave GRIB2 subsetting and point extraction.
- CDIP THREDDS/netCDF modeled and observed data.
- NDBC/CDIP historical observations for backtesting.
- Future bathymetry/SWAN/regional transforms.

The bootstrap package only plans requests and validates fixtures. The v1
implementation adds `wgrib2`, ecCodes/cfgrib, xarray, and netCDF processing.

```bash
uv run --project services/extractor surf-extractor inspect-fixtures
uv run --project services/extractor pytest
```

