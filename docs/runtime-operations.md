# Runtime operations

This runbook is instance-neutral. Run commands from the repository root. The
`pnpm wrangler -- ...` wrapper honors the ignored `SURF_WRANGLER_CONFIG`
override described in the self-hosting guide, including for remote D1 and
rollback commands.

## Normal cadence

- Cron enqueues one ingest cycle every hour at minute 17.
- Queue retries isolate public-provider failures from the scheduler.
- A source-ingest invocation persists public inputs, then fans out one
  materialization message per configured spot. Queue batch size and concurrency
  stay at one so every spot receives a fresh Worker CPU budget.
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
timeout reports the exact spot/interval pairs that did not publish. During a
deployment, the command requires `X-Surf-Worker-Version` to match the exact
version emitted by Wrangler while exercising ordinary production routing.
Before authenticating, it sends one unpinned `PATCH /api/ingest/once` route
probe that must return `401`, `WWW-Authenticate: Bearer`, and that exact Worker
version. It then sends exactly one authenticated PATCH with
`X-Surf-Expected-Worker-Version`; the Worker compares it with immutable
`CF_VERSION_METADATA.id` before `INGEST_QUEUE.send`. The PATCH method is
intentionally absent from every predecessor before this invariant, so fallback
during the first rollout returns 404 before Queue mutation. Keep deploy PATCH
permanently version-preconditioned and never retry or fall back to POST. Its
logical ingest identity derives from immutable version metadata, while its
generation timestamp is captured at the authenticated Worker request; an
accidental replay therefore stays on one stable lineage without inheriting an
older upload timestamp. The legacy POST on the same
path remains the manual/local operator route. Forecast polling is sequential so
the verification client cannot recreate a burst of expensive requests. Exact
override reachability is a separate read-only gate; mutation, lineage polling,
and smoke stay unpinned because Cloudflare may ignore an unavailable override.

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

Forecast publication happens after normalized persistence and is atomic per
spot. That spot's 1-hour and 3-hour generations must both contain a scored
window before either can replace its active generation. A failed spot job
leaves that spot's previous generation in place and retries independently;
other healthy spots continue advancing. A typed retryable 503 appears only
when that spot has never published a valid generation.

Do not raise the ingest consumer's `max_batch_size` or `max_concurrency` above
one. Source fetching and normalized persistence run in one invocation. Each
spot's history capture, synchronized 1-hour/3-hour assembly, and fact generation
then share a separate child invocation with a fresh Worker CPU budget. Queue
delivery is at-least-once and unordered; stable ingest IDs, indexed
logical-generation checks, and idempotent writes make duplicate or superseded
jobs safe. A normalized-data or source-run persistence failure does not fan out
children; retained rows cannot be relabeled as a fresh ingest.

Inspect all expected spot/interval pairs without printing forecast JSON:

```bash
pnpm wrangler -- d1 execute DB --remote --command \
  "with intervals(interval) as (values ('1h'), ('3h')) select s.id as spot_id, i.interval, case when r.spot_id is null then 'missing' else 'ready' end as state, r.generated_at, r.materialized_at, length(r.forecast_json) as json_chars from spots s cross join intervals i left join forecast_read_models r on r.spot_id=s.id and r.interval=i.interval where s.active=1 order by s.id,i.interval"
```

The NorCal reference configuration should return 12 `ready` rows. If any pair
is missing, tail structured Worker logs, run one authenticated
`pnpm ingest:remote` (it waits and names every missing pair), rerun the query,
then run `pnpm smoke:cloudflare`. Inspect `forecast materialization failed for
<spot>` and the configured `<instance>-ingest-dlq` before retrying again. Do not
insert or hand-edit read-model JSON. A Gemini credential, quota, or Agent
failure cannot remove these rows.

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
applies migrations, deploys the Worker, parses Wrangler's exact version ID,
proves that version is reachable with an exact override, and then requires
three consecutive cache-busted, unpinned version-matched health responses
before requiring the active deployment JSON to contain exactly that one version
at 100%. It probes the unpinned PATCH route without credentials, queues exactly
one authenticated ingest, waits for every unpinned read model from that lineage
to publish, and runs an unpinned, exact-version strict cloud smoke. It then
rechecks the one-version/100% control-plane state. A callable 0%-traffic version
therefore cannot cross the initial gate. These control-plane reads are strong
before/after checkpoints, not an atomic deployment lock: a concurrent split can
begin between them. The Worker UUID precondition is the mutation-safety
boundary—it guarantees the PATCH can enqueue only on the expected version—and
the final checkpoint detects a split that remains after smoke.

Worker activation is the rollback safety boundary, not the deploy command's
own ingest handoff. Cron, authenticated traffic, or an existing backlog can
produce or consume Queue messages as soon as Wrangler activates the version.
The HTTP version precondition proves the producer invocation; Cloudflare does
not pin the later Queue consumer to that same version. A payload-incompatible
consumer change therefore must preserve predecessor handling or add an explicit
message-level consumer-version fence before shipping; the deploy harness alone
is not that fence.
Consequently, any readiness, publication, or smoke failure leaves the new
Worker active and must be treated as an urgent fix-forward. Only roll back
after independently proving the Queue is quiescent, no consumer is in flight,
and every queued payload is compatible with the predecessor. Additive D1
tables remain in place.

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
