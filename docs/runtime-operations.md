# Runtime Operations

## Cloudflare Resources

Provisioned in Alex's Cloudflare account on 2026-07-08:

| Resource | Name | Binding | ID |
|---|---|---|---|
| D1 | `surf` | `DB` | `a3e856fe-9ce3-4e71-ba60-f33ca3a15d4e` |
| R2 | `surf-raw` | `RAW_ARTIFACTS` | bucket name only |
| KV | `surf-cache` | `CACHE` | `392b927b791d406bbd662be3844b1b2a` |
| Queue | `surf-ingest` | `INGEST_QUEUE` | `6cca6e2cfb2541e5afcd2898e96094c7` |
| Queue | `surf-ingest-dlq` | dead letter queue | `5e1876faf4d14f5a84b23bcea315a2eb` |

## Jobs

- Worker cron enqueues ingest cycles.
- Queue consumer fans out source/spot extraction work.
- Python extractor processes GRIB2/netCDF/CDIP work that does not belong inside
  a Worker.
- Report generation is gated by `REPORT_AGENT_ENABLED=true` and provider key
  availability.

## v1 Ingest Behavior

`POST /api/ingest/once` runs the NorCal ingest coordinator immediately. It
fetches live NOAA CO-OPS tide predictions and NWS point forecasts/alerts for all
six v1 spots, writes `source_runs`, and persists normalized `tide_forecasts`,
`wind_forecasts`, and `hazard_events` rows in D1.

NOAA GFSwave is validated in the Python extractor today: it selects complete
cycles, validates NOMADS `.idx` inventories, and plans deterministic R2 keys for
raw GRIB2 subsets. Numeric GRIB point extraction remains blocked until the
runtime includes `wgrib2` or `cfgrib` + `xarray`; forecast confidence is lowered
and caveats are exposed while that layer falls back.

Apply local D1 schema and seed before local ingest:

```bash
cd apps/web
pnpm exec wrangler d1 execute surf --local --file ../../packages/db/migrations/0000_initial.sql
pnpm exec wrangler d1 execute surf --local --file ../../packages/db/seeds/0000_v1_norcal.sql
```

## Deployment

Bootstrap Worker URL:

- `https://surf.alex-1ca.workers.dev`

## Checks

```bash
pnpm check
pnpm test
uv run --project services/extractor pytest
pnpm ingest:once
pnpm cf:provision
pnpm smoke:local
pnpm smoke:cloudflare
```

`pnpm smoke:local` and `pnpm smoke:cloudflare` verify `/api/health`,
`/api/spots`, `/api/forecast/obsf-central`, and `/api/reports/today`.

Run the public-observation calibration harness with:

```bash
uv run --project services/extractor surf-extractor backtest-ndbc-history --station-id 46026 --year 2025
```

## Secrets

Local personal/dev secrets:

```bash
~/.config/env/surf.env
```

Do not read or print existing secret files in agent sessions. Deployed runtime
secrets should be set with Cloudflare Worker secrets.

## Remaining Clickops

- Choose custom domain or keep `workers.dev`.
- Configure Cloudflare Access if the app should be private behind identity.
- Set `OPENAI_API_KEY` and `REPORT_AGENT_ENABLED=true` only when narrative
  report generation should run.
