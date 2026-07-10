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

- Worker cron enqueues ingest cycles hourly at minute 17.
- Queue consumer fans out source/spot extraction work.
- Python extractor processes GRIB2/netCDF/CDIP work that does not belong inside
  a Worker.
- Report generation is gated by `REPORT_AGENT_ENABLED=true` and provider key
  availability.

## v1 Ingest Behavior

`POST /api/ingest/once` runs the NorCal ingest coordinator immediately. It
fetches live NOAA CO-OPS tide predictions, NWS point forecasts/alerts and
coastal-grid wave guidance, plus current NDBC buoy observations for all six v1
spots. It writes `source_runs` and persists normalized tide, wind, hazard, wave
forecast, and buoy-observation rows in D1.

The public dashboard uses NWS MTR coastal-grid wave layers with explicit,
visible cold-start spot exposure factors. NOAA GFSwave remains available in the
Python extractor for inventory validation, R2 artifact planning, and future
calibration.

Production manual ingest requires an `INGEST_TOKEN` Worker secret and a matching
`SURF_INGEST_TOKEN` environment variable when running `pnpm ingest:once` against
the deployed URL. Loopback development requests remain available without a
token. Scheduled queue ingestion does not use this route.

Apply local D1 schema and seed before local ingest:

```bash
cd apps/web
pnpm exec wrangler d1 execute surf --local --file ../../packages/db/migrations/0000_initial.sql
pnpm exec wrangler d1 execute surf --local --file ../../packages/db/seeds/0000_v1_norcal.sql
```

Apply the same idempotent seed before a production deploy that adds sources or
spot mappings:

```bash
cd apps/web
pnpm exec wrangler d1 execute surf --remote --file ../../packages/db/seeds/0000_v1_norcal.sql
```

## Deployment

Bootstrap Worker URL:

- `https://surf.alex-1ca.workers.dev`

Rollback to a Worker version from before the NWS coastal-grid reader requires
removing the new rows first; the older reader cannot disclose their cold-start
derivation:

```bash
cd apps/web
pnpm exec wrangler d1 execute surf --remote --command \
  "delete from wave_forecasts where source_id = 'nws:mtr-grid-wave'"
# Then redeploy the prior Worker version.
```

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

Raw upstream responses are archived under `raw/<source>/<date>/<run>/` in R2.
Each source run points to a checksum-bearing manifest and corresponding
`source_artifacts` rows in D1; normalized writes finalize the run only after
artifact persistence succeeds.

## Remaining Clickops

- Choose custom domain or keep `workers.dev`.
- Configure Cloudflare Access if the app should be private behind identity.
- Set `OPENAI_API_KEY` and `REPORT_AGENT_ENABLED=true` only when narrative
  report generation should run.
