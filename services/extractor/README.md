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

## Physical evaluation

An NDBC annual file is observation history, not a forecast backtest. The
descriptive command is named accordingly and uses the file's declared header
(older no-minute layouts are supported) plus circular direction statistics:

```bash
uv run --project services/extractor surf-extractor summarize-ndbc-history --station-id 46026 --year 2025
```

Accuracy evaluation requires immutable, issued forecasts and time-aligned
observations. Both inputs are JSONL. Forecast rows require `source_id`,
`issued_at`, and `valid_at`; observation rows require `source_id` and
`observed_at`. Optional physical fields are `wave_height_m`, `peak_period_s`,
and `direction_deg`. Timestamps must include a UTC offset.

```bash
uv run --project services/extractor surf-extractor evaluate-jsonl \
  --forecast-jsonl issued-forecasts.jsonl \
  --observation-jsonl observations.jsonl \
  --match-tolerance-minutes 30 \
  --output-json evaluation.json \
  --samples-jsonl matched-samples.jsonl
```

The evaluator defaults to no-lookahead observation matching, preserves
unmatched forecasts, and reports coverage plus MAE, RMSE, bias, median absolute
error, and within-tolerance rate. Direction errors use the shortest circular
angle. Metrics are repeated for `0-12h`, `12-24h`, `24-48h`, `48-72h`,
`72-120h`, and `120h+` lead buckets. These artifacts measure physical fields;
they do not establish whether waves were clean, surfable, or breaking at a
particular peak.

## CDIP MOP nearshore proxy

The public CDIP THREDDS OPeNDAP adapter can read bounded `waveTime`, `waveHs`,
`waveTp`, and `waveDp` slices without adding netCDF dependencies. An operator
must supply the exact MOP mapping and fixed height scale being tested:

```json
{
  "spot_id": "bolinas",
  "cdip_point_id": "M0000",
  "dataset_url": "https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore/M0000_nowcast.nc",
  "height_scale": 0.65
}
```

```bash
uv run --project services/extractor surf-extractor evaluate-cdip-transform \
  --mapping-json bolinas-cdip.json \
  --forecast-jsonl issued-offshore-forecasts.jsonl \
  --start-index 0 --stop-index 500 \
  --output-json bolinas-transform-evaluation.json
```

CDIP MOP output is labeled `modeled_nearshore_proxy` in the result. It is
valuable for testing a crude fixed offshore-to-nearshore scale, but it is not
an observed breaking-wave-height truth label and is never represented as one.
