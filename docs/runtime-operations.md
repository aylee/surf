# Runtime operations

This runbook is instance-neutral. Run commands from the repository root. The
`pnpm wrangler -- ...` wrapper honors the ignored `SURF_WRANGLER_CONFIG`
override described in the self-hosting guide, including for remote D1 and
rollback commands.

## Normal cadence

- Cron enqueues one ingest cycle every hour at minute 17.
- Queue retries isolate public-provider failures from the scheduler.
- Latest forecast rows refresh each cycle.
- Immutable issued history is sampled at 00/06/12/18 UTC and keeps only the
  6 AM–6 PM local planning horizon.
- The report layer reads the best available normalized rows; it never replaces
  stale inputs with fixture data.

## Health checks

```bash
export SURF_BASE_URL=https://your-worker.your-subdomain.workers.dev
pnpm smoke:cloudflare
```

For deeper inspection:

```bash
pnpm wrangler -- tail
pnpm wrangler -- d1 execute DB --remote --command \
  "select source_id, status, started_at, completed_at, error from source_runs order by started_at desc limit 20"
```

Check the newest run, not only HTTP availability. A healthy dashboard with
stale source rows is a degraded forecast.

## Manual ingest

Production manual ingest requires the Worker `INGEST_TOKEN` secret and a
matching shell-only `SURF_INGEST_TOKEN`:

```bash
export SURF_BASE_URL=https://your-worker.your-subdomain.workers.dev
export SURF_INGEST_TOKEN=<secret>
pnpm ingest:remote
```

Loopback development does not require the token. Do not disable production
authentication to simplify automation; use the scheduled Queue path instead.

## Provider failure

1. Inspect recent `source_runs` and Worker logs.
2. Confirm whether one adapter or the full ingest failed.
3. Check the provider's public endpoint and timestamps without substituting a
   different product under the same source ID.
4. Retry one manual ingest after a transient outage.
5. If the provider contract changed, capture a bounded fixture, update the
   adapter and tests, then deploy. Keep stale/unavailable status visible until
   the new parser is verified.

Raw R2 artifacts and source hashes are the evidence trail for parser and
provider disagreements.

## Backup and restore

Create a dated directory outside the repository and export D1 before risky
schema or retention work:

```bash
mkdir -p "$HOME/surf-backups"
pnpm wrangler -- d1 export DB --remote \
  --output "$HOME/surf-backups/surf-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Treat the export as potentially sensitive operational data. Verify the file is
non-empty and store it according to your own backup policy.

Restore into a new/recovery database first rather than overwriting the active
instance. Bind the recovery database to a temporary Worker, apply the export,
and smoke it before changing the production binding.

R2 is independent of D1 export. Raw-artifact retention or deletion needs its
own explicit lifecycle and recovery plan.

## Retention

Operational tide, wind, and wave tables keep a two-day past troubleshooting
tail plus the current future horizon. Issued history, observations, hazards,
source runs, and artifact metadata keep 400 days. Unreferenced content-addressed
spot configurations are removed.

R2 objects are not deleted by the D1 retention job. This is deliberate: D1
metadata retention must not silently destroy raw evidence.

After ingest, stale operational counts should be zero:

```sql
select 'tide_forecasts' as table_name, count(*) as total,
  coalesce(sum(case when julianday(forecast_at) < julianday('now', '-2 days') then 1 else 0 end), 0) as stale_past
from tide_forecasts
union all
select 'wind_forecasts', count(*),
  coalesce(sum(case when julianday(forecast_at) < julianday('now', '-2 days') then 1 else 0 end), 0)
from wind_forecasts
union all
select 'wave_forecasts', count(*),
  coalesce(sum(case when julianday(forecast_at) < julianday('now', '-2 days') then 1 else 0 end), 0)
from wave_forecasts;
```

## Deploy and rollback

Before deployment:

```bash
pnpm verify
```

That is the same gate CI runs: an isolated fresh D1 migration and seed,
generated artifact checks, TypeScript and Python tests, production build, and
a secretless Wrangler dry-run. It leaves the normal local development database
untouched.

For additive changes, back up D1, use the supported `pnpm deploy` path, then
run the cloud smoke. If the Worker code is bad but the schema remains backward
compatible, use Wrangler's version rollback:

```bash
pnpm wrangler -- versions list
pnpm wrangler -- rollback
```

Do not roll Worker code behind an incompatible schema. For a risky migration,
the pull request and release notes must name a forward-fix or recovery-database
plan before deployment.

If ingest must be stopped during recovery, pause Queue delivery and remove the
cron trigger, wait for in-flight work to finish, and confirm `source_runs` has
stopped advancing. Resume both only after the recovered Worker passes a smoke
test.

## Removing an instance

Export any data you want to keep, then delete the Worker and each D1, R2,
and Queue resource from your own Cloudflare account. Deletion is intentionally
not automated by this repository because it is destructive and not reversible.
