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

## Archived NDFD -> CDIP MOP evaluation

`evaluate-ndfd-mop-history` makes the current scalar transform test
reproducible against NOAA's public `noaa-ndfd-pds` archive. It discovers the
high-resolution CONUS wave-height WMO objects `YKUZ98_KWBN` (approximately
0-72 hours) and `YKUZ97_KWBN` (approximately 72-144 hours), extracts the
nearest finite grid value, applies the supplied current scale, and compares it
with a CDIP MOP nowcast proxy through the same physical evaluator.

Install the optional decoder stack; the base extractor install remains light:

```bash
uv sync --project services/extractor --extra grib
```

The mapping is deliberately operator-supplied. An exact MOP point must be
chosen before treating the comparison as relevant to a spot:

```json
{
  "spot_id": "bolinas",
  "target_latitude": 37.909,
  "target_longitude": -122.730,
  "cdip_point_id": "M0000",
  "cdip_nowcast_url": "https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/model/MOP_alongshore/M0000_nowcast.nc",
  "current_height_scale": 0.65,
  "max_grid_distance_km": 5.0
}
```

Each `--issue-at` is an exact UTC **as-of** snapshot, not a request to pick any
file from that calendar day. Selection uses the latest object whose WMO issue
time and S3 `LastModified` are both at or before the snapshot. Inputs must be
strictly chronological and are capped at 100 snapshots. The train cutoff is
also an issue timestamp; later forecasts are reported separately as holdout.

```bash
uv run --project services/extractor --extra grib \
  surf-extractor evaluate-ndfd-mop-history \
  --mapping-json bolinas-ndfd-mop.json \
  --issue-at 2025-04-01T12:00:00Z \
  --issue-at 2025-07-01T12:00:00Z \
  --issue-at 2025-10-01T12:00:00Z \
  --train-cutoff 2025-07-31T23:59:59Z \
  --output-json results/bolinas-ndfd-mop.json \
  --samples-jsonl results/bolinas-ndfd-mop.samples.jsonl
```

Safety and interpretation:

- A WMO object is never used before either its issue or S3 availability time.
- `issued_at`, `valid_at`, and lead are UTC and retained per sample.
- Both train and holdout must contain issued forecasts; the command does not
  tune the scale or leak holdout results into a fitted value.
- Grid coordinates stay paired with decoded values. Missing cells are skipped,
  and extraction fails when the nearest finite cell exceeds the mapping's
  distance guard.
- The command scans only explicit WMO prefixes, bounds object size and MOP time
  axis length, and stores keys, ETags, SHA-256 values, grid coordinates, and
  distances in its JSON artifact. It does not retain large GRIB files.
- CDIP MOP nowcast remains a modeled 10 m-ish nearshore proxy, not an observed
  breaking-wave or surf-height label.

### Dated scan-order cross-check

NDFD documentation warns that some Python decoders can mishandle grid scanning.
On 2026-07-10, the coordinate/value association used here was checked for
`wmo/waveh/2026/07/10/YKUZ98_KWBN_202607100407` against the live NWS grid API:

| Target | Nearest finite grid cell | 05:00Z cfgrib `shww` | NWS grid/API wave height | Difference |
|---|---|---:|---:|---:|
| Bolinas 37.909,-122.730 | 37.901718,-122.730899 (~0.81 km) | 1.5 m | MTR/75,113: 1.524 m | 0.024 m |
| OBSF Central 37.759,-122.530 | 37.754432,-122.519796 (~1.03 km) | 0.9 m | MTR/81,105: 0.9144 m | 0.0144 m |

The NWS grid update was `2026-07-10T03:46:36Z`. The small differences are
consistent with source-unit rounding. This dated two-cell check validates the
association for those coastal cells; it is not a general proof for every NDFD
grid. The exact evidence is retained in
`tests/fixtures/ndfd_scan_order_cross_check.json`.
