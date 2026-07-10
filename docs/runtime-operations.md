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
- Latest-value rows refresh hourly; immutable issued-history capture is sampled
  at 00/06/12/18 UTC plus explicit manual ingests.
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

Issued history is intentionally bounded for a personal D1 database:

- only 6 AM–6 PM local forecast windows are snapshotted;
- spot configurations are content-addressed once in `forecast_configs`;
- shared issue context lives once in `forecast_issues`;
- `forecast_snapshots` retains compact per-window numeric/product facts;
- `wind_forecast_issues` retains compact daylight rows without duplicated raw
  payload JSON (the original response remains checksum-linked in R2);
- snapshots and wind issues older than 400 days are pruned after each sampled
  capture.

This preserves a full annual seasonal comparison set without turning hourly
ingest into unbounded D1 growth. Export older issue sets to R2 before changing
the retention window.

The public dashboard prefers mapped CDIP MOP per-point forecasts for Ocean
Beach, Linda Mar, and Stinson. Bolinas and any unavailable MOP window fall back
to NWS MTR coastal-grid layers with explicit cold-start exposure factors. NOAA
GFSwave remains available in the Python extractor for inventory validation, R2
artifact planning, and future calibration.

Production manual ingest requires an `INGEST_TOKEN` Worker secret and a matching
`SURF_INGEST_TOKEN` environment variable when running `pnpm ingest:once` against
the deployed URL. Loopback development requests remain available without a
token. Scheduled queue ingestion does not use this route.

Apply local D1 schema and seed before local ingest:

```bash
cd apps/web
pnpm exec wrangler d1 execute surf --local --file ../../packages/db/migrations/0000_initial.sql
pnpm exec wrangler d1 execute surf --local --file ../../packages/db/migrations/0001_forecast_history.sql
pnpm exec wrangler d1 execute surf --local --file ../../packages/db/seeds/0000_v1_norcal.sql
```

Apply all additive migrations, then the idempotent seed, before a production
deploy that adds forecast history, sources, or spot mappings:

```bash
cd apps/web
pnpm exec wrangler d1 execute surf --remote --file ../../packages/db/migrations/0001_forecast_history.sql
pnpm exec wrangler d1 execute surf --remote --file ../../packages/db/seeds/0000_v1_norcal.sql
```

## Deployment

Bootstrap Worker URL:

- `https://surf.alex-1ca.workers.dev`

### 2026-07-09 release rollback runbook

The Worker version immediately before this release is
`d7fdfd53-53d3-4314-aae8-590a9ff118fb`. Do not activate that version until the
CDIP compatibility gate below is complete: that Worker predates source-aware
wave-row selection.

Use this order for any rollback of this release.

1. **Stop all ingest writers before changing code or data.** Pause Queue
   delivery first:

   ```bash
   cd apps/web
   pnpm exec wrangler queues pause-delivery surf-ingest
   ```

   Then remove the `17 * * * *` Cron Trigger in Cloudflare under **Workers &
   Pages -> surf -> Triggers**. A Cron Trigger deletion can take up to 15
   minutes to propagate. Do not run `pnpm ingest:once` during the rollback, and
   wait for any in-flight Queue batch to finish. Confirm that `source_runs` has
   stopped advancing before continuing:

   ```bash
   pnpm exec wrangler d1 execute surf --remote --command \
     "select max(started_at) as last_started_at, max(completed_at) as last_completed_at from source_runs"
   ```

   A normal Wrangler deploy from the checked-in configuration can recreate the
   Cron Trigger. Keep `triggers.crons` empty in any temporary rollback deploy
   configuration, and verify the production trigger remains absent before
   proceeding.

2. **Leave migration `0001_forecast_history.sql` in place.** Its
   `wind_forecast_issues`, `forecast_configs`, `forecast_issues`, and
   `forecast_snapshots` tables are additive. Do not drop, truncate, or otherwise
   delete them as part of a code rollback.

3. **Choose one rollback target.**

   - **Preferred temporary source checkpoint: `c862025`.** This checkpoint is
     source-aware, can read databases containing both CDIP and NWS wave rows,
     and remains write-compatible with the additive `0001` schema. No wave-row
     deletion is required. It is temporary only: it captures issued history on
     hourly ingest without this release's 00/06/12/18 UTC sampling and 400-day
     pruning, so leaving hourly ingestion enabled would grow history without a
     bound. Keep ingestion paused while it serves reads, or allow only a short,
     explicitly monitored ingest interval until a forward fix is deployed.

   - **Direct Worker rollback: `d7fdfd53-53d3-4314-aae8-590a9ff118fb`.** This
     version is source-unaware. CDIP rows in `wave_forecasts` can be selected as
     though they were the older NWS product, so remove **only**
     `source_id = 'cdip:mop-forecast'` rows before activating it. First record
     the affected count and export the complete `wave_forecasts` table:

     ```bash
     mkdir -p "$HOME/surf-backups"
     pnpm exec wrangler d1 execute surf --remote --command \
       "select count(*) as cdip_rows from wave_forecasts where source_id = 'cdip:mop-forecast'"
     pnpm exec wrangler d1 export surf --remote --table wave_forecasts --no-schema \
       --output "$HOME/surf-backups/2026-07-09-pre-d7-wave_forecasts.sql"
     test -s "$HOME/surf-backups/2026-07-09-pre-d7-wave_forecasts.sql"
     ```

     **Stop here until Alex explicitly approves the deletion after the export
     path and CDIP row count have been recorded.** With that approval, and only
     after confirming ingest is still stopped, run:

     ```bash
     pnpm exec wrangler d1 execute surf --remote --command \
       "delete from wave_forecasts where source_id = 'cdip:mop-forecast'"
     pnpm exec wrangler d1 execute surf --remote --command \
       "select count(*) as cdip_rows from wave_forecasts where source_id = 'cdip:mop-forecast'"
     pnpm exec wrangler rollback d7fdfd53-53d3-4314-aae8-590a9ff118fb \
       --name surf --message "Rollback 2026-07-09 release after CDIP compatibility gate"
     ```

4. **Smoke the selected target while ingestion remains stopped.**

   ```bash
   pnpm smoke:cloudflare
   ```

   Inspect `/api/forecast/obsf-central` and `/api/forecast/bolinas` as well as
   the standard smoke endpoints. Only after those checks pass may Queue
   delivery be resumed and the exact `17 * * * *` Cron Trigger be restored:

   ```bash
   cd apps/web
   pnpm exec wrangler queues resume-delivery surf-ingest
   ```

   Do not restore unattended hourly ingestion while `c862025` is active; move
   forward to the bounded-history release first.

Never delete forecast history during rollback without explicit approval and a
verified export. D1 Time Travel is not a normal code-rollback mechanism; reserve
it for confirmed database corruption because it restores the database as a
whole and may discard otherwise valid writes made after the restore point.

### Historical rollback note

The following note predates the current release and applies only when rolling
back to a Worker from before the NWS coastal-grid reader. It is **not** the
procedure for version `d7fdfd53-53d3-4314-aae8-590a9ff118fb`. Its deletion is
also subject to the export-and-explicit-approval gate above.

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
uv run --project services/extractor surf-extractor summarize-ndbc-history --station-id 46026 --year 2025
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
