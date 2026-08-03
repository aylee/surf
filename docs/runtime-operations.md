# Runtime operations

This runbook is instance-neutral. Run commands from the repository root. The
`pnpm wrangler -- ...` wrapper honors the ignored `SURF_WRANGLER_CONFIG`
override described in the self-hosting guide, including for remote D1 and
rollback commands.

## Normal cadence

- Cron enqueues one ingest cycle every hour at minute 17.
- Queue retries isolate public-provider failures from the scheduler.
- Latest normalized rows and validated 1-hour/3-hour forecast read models
  refresh each cycle.
- Immutable issued history is sampled at 00/06/12/18 UTC and keeps only the
  6 AM–6 PM local planning horizon.
- The report layer reads the best available normalized rows; it never replaces
  stale inputs with fixture data.
- The optional per-spot daily brief lets Gemini synthesize natural prose from
  role-tagged public facts. Recommendation order, measurements, and hard
  caveats stay code-owned; model prose must pass citation, policy, and quality
  validation. Missing keys, quota, or rejected output falls back to local
  fact-based copy without delaying ingest.

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

The core forecast endpoint is intentionally a cheap read-model lookup. A
retryable `503 forecast_temporarily_unavailable` means no valid materialized
generation is active; it does not mean the spot or provider data is inherently
unavailable. Cloudflare `1102` or an invocation outcome of `exceededCpu` means
request-time work has regressed past the Worker CPU budget and should be fixed
in the read path rather than translated into an unknown surf call.

Successful forecast and brief responses use a one-minute shared-cache TTL with
five minutes of stale-while-revalidate. The Worker cache is version-scoped, so
a deployment cannot serve a response produced by the version it replaced.
Health, errors, ingest responses, and other API responses are explicitly
uncacheable. Treat the cache as request-load protection, not as the source of
truth; D1 read models remain the durable last-good generation.

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
In production the endpoint acknowledges the request with `202`, then the
command polls every configured spot's 1-hour and 3-hour read models until they
were materialized at or after the Worker-issued request timestamp. It does not
hold the HTTP request open for ingest. The polling deadline is bounded and a
timeout reports the exact spot/interval pairs that did not publish.

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

## Forecast read-model failure

Forecast publication happens after normalized persistence. Both 1-hour and
3-hour generations must contain a scored window before either can replace the
active generation. A failed assembly/publish leaves the previous generation in
place and makes the Queue message retry.

Inspect the active rows without printing forecast JSON:

```bash
pnpm wrangler -- d1 execute DB --remote --command \
  "select spot_id, interval, generated_at, materialized_at, length(forecast_json) as json_chars from forecast_read_models order by spot_id, interval"
```

If the tables are empty after a migration or deployment, run one authenticated
manual ingest and then the cloud smoke. Do not insert or hand-edit read-model
JSON. A Gemini credential, quota, or Agent failure cannot remove these rows.

## Daily brief failure

The forecast API remains healthy when Gemini is disabled or unavailable. Check
the brief response status first: `deterministic_fallback` is expected when the
feature flag/key is absent, quota is exhausted, or output fails validation.
Inspect structured Worker logs by spot, fingerprint, attempt, and failure code;
the implementation never logs the API key or full provider request. Retry is
bounded and material fingerprints prevent freshness-only regeneration. The UI
does not expose these internal provider/fallback labels.

The Agent retries network failures, rate limits, and server errors after 5
minutes, 30 minutes, and 2 hours, then marks the transient budget exhausted.
Policy or structured-output rejection receives one delayed regeneration. Bad
credentials, corrupt stored input, unknown defects, and retry-scheduling
failure become terminal instead of looping. The exact failed input stays
suppressed. After a five-minute cooldown, a later ingest with a new full-input
fingerprint may reclaim the same material forecast—this is the recovery path
after fixing credentials or provider configuration without forcing a physical
forecast change.

`generating` is a ten-minute lease rather than a permanent lock. A later
signal reclaims an interrupted generation after that lease and rotates the
generation token, so a delayed callback from the old claim cannot publish.
Each delayed retry carries its attempt number; this keeps the 5m/30m/2h
schedules distinct while still using idempotent callback submission. Queue and
schedule callbacks each have one framework attempt; Surf's explicit state
machine owns recovery and backoff.

## Backup and restore

Before risky schema or retention work, record the current automatically
maintained D1 Time Travel bookmark, then create a dated export outside the
repository:

```bash
pnpm wrangler -- d1 time-travel info DB
mkdir -p "$HOME/surf-backups"
pnpm wrangler -- d1 export DB --remote \
  --output "$HOME/surf-backups/surf-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Copy the bookmark from the command output into the rollout record without
running a restore. Time Travel restore overwrites the remote database in place
and is reserved for confirmed data corruption, with explicit operator
approval. Prefer a forward fix or recovery database for application defects.

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
spot configurations are removed. The active forecast read models are replaced
in place; obsolete per-date fact bundles are removed after the same two-day
operational tail once no active 3-hour generation references them.

Daily-brief retention is intentionally unpruned at the current bounded personal
scale: D1 keeps every published validated brief revision, while each per-spot
Durable Object keeps one coordination job row per local date. Treat pruning,
archival, and retention metrics as follow-up work before materially expanding
the spot catalog or usage; any cleanup must ship with the same D1 backup and
rollback discipline as other retention changes.

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

For additive changes, back up D1 and export the required
`SURF_INGEST_TOKEN`, then use the supported `pnpm deploy` path. Deployment
applies migrations, deploys the Worker, queues one authenticated ingest, waits
for every compatible read-model generation to publish, and finally runs the
strict cloud smoke. A read-model bootstrap or strict-smoke failure triggers an
automatic rollback of the Worker version; additive D1 tables remain in place.
If a later problem is found while the schema remains backward compatible, use
Wrangler's version rollback:

```bash
pnpm wrangler -- versions list
pnpm wrangler -- rollback
```

Do not roll Worker code behind an incompatible schema. For a risky migration,
the pull request and release notes must name a forward-fix or recovery-database
plan before deployment.

The first deployment declaring `ForecastBriefAgent` is a Durable Object class
lifecycle change and cannot be rolled back to a version from before that class
existed. Deploy it with `FORECAST_BRIEF_ENABLED=false`, smoke it, and keep that
disabled post-Agent version as the rollback target for later code/model
versions. Do not remove or tombstone the export during routine rollback.

If ingest must be stopped during recovery, pause Queue delivery and remove the
cron trigger, wait for in-flight work to finish, and confirm `source_runs` has
stopped advancing. Resume both only after the recovered Worker passes a smoke
test.

## Removing an instance

Export any data you want to keep, then delete the Worker and each D1, R2,
and Queue resource from your own Cloudflare account. Deletion is intentionally
not automated by this repository because it is destructive and not reversible.
