# Self-hosting

This guide takes a new checkout to a populated local dashboard, then to an
independent Cloudflare deployment. A fork never needs the maintainer's account
or resource identifiers.

## Prerequisites

- Node.js 24 (see `.node-version`)
- pnpm 11 through Corepack
- For deployment: a Cloudflare Workers Paid account (the project requires the
  Standard usage model), with D1, R2, and Queues, plus a registered
  `workers.dev` subdomain

The forecast feeds used by the reference configuration do not require paid API
keys. Optional Analysis can run on a self-hosted oMLX server; it has no hosted
model API key or per-inference charge. Forecast data continues to work when
Analysis is disabled, pending, or unavailable. Cloudflare usage is the expected
hosting cost. Python 3.12 and
[uv](https://docs.astral.sh/uv/) are needed only for the contributor gate and
optional scientific extractor.

The checked-in Worker configuration deliberately pins a 2,000 ms CPU limit.
Cloudflare supports [configurable runtime limits](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
only with the Standard usage model and currently makes Standard available on
Workers Paid. Workers Free is not a supported deployment target: its 10 ms CPU
budget is below this application's measured forecast-materialization workload.
The config validator rejects removing or changing the limit so a fork cannot
silently fall back to an account- or dashboard-specific CPU cap. Project setup
does not change account usage models, subscriptions, or billing. Verify Workers
Paid in the billing dashboard before first setup and let the operator choose
whether to change plans. Do not use an existing version's `usage_model` field
as billing evidence: a version can report `standard` on a Free account even
though Cloudflare rejects a new custom CPU limit.

## Local setup

```bash
git clone https://github.com/aylee/surf.git
cd surf
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds the app, applies local migrations, seeds the reference
catalog, and starts the full UI/API. Open `http://127.0.0.1:8787`. The initial
database has the reference spots and sources but no current forecast rows. In
a second terminal, run:

```bash
pnpm ingest:local
pnpm smoke:local
```

The ingest uses live public endpoints. Temporary provider failures should be
reported as missing/stale data; rerunning the command is safe.

### Optional local Analysis

The tracked Worker configuration keeps `NARRATIVE_ENABLED=false`, so ordinary
local development makes no model call and the Analysis tab reports its honest
unavailable state. The active model path is an always-on, domain-neutral runner
that pulls a dedicated Cloudflare Queue over HTTPS and calls an
OpenAI-compatible oMLX server on loopback. It is not a Worker Queue consumer
and it does not use Gemini or another hosted model provider.

Set up the Queue/result boundary only after the forecast deployment is healthy.
The [local narrative runner guide](narrative-runner.md) covers model selection,
ignored `0600` environment files, target-map/result credentials, bounded
timeouts, one-shot acceptance, LaunchAgent health, and MacBook-to-Mac-Studio
migration. The current measured baseline is configurable
`Qwen3.5-27B-8bit`; keep model selection in configuration and use the checked
quality fixture before changing the default.

## Deploy to Cloudflare

### 1. Authenticate

For a brand-new Cloudflare account, first open
[Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
and complete its onboarding, including choosing a `workers.dev` subdomain.
The setup command is intentionally non-interactive and cannot answer that
one-time account prompt for you.

```bash
pnpm wrangler -- login
pnpm wrangler -- whoami
```

Wrangler OAuth is the preferred interactive path. CI may use a scoped
`CLOUDFLARE_API_TOKEN`, but do not put a token in the repository or pass it as a
command-line value.

### 2. Choose an instance name

Review `apps/web/wrangler.jsonc` before the first deploy. The Worker `name`, D1
`database_name`, ingest Queue/DLQ, and narrative Queue/DLQ form one instance
namespace. For example, an instance named `surf-dev` uses database `surf-dev`,
Queues `surf-dev-ingest` and `surf-dev-narrative`, and matching `-dlq` names. A
manually provisioned R2 bucket must be named `surf-dev-raw-artifacts`. The
portability check enforces those relationships so one renamed instance cannot
silently attach to another instance's storage. Keep binding names (`DB`,
`RAW_ARTIFACTS`, `INGEST_QUEUE`, and `NARRATIVE_QUEUE`) unchanged unless the
Worker types and code change with them.

`pnpm ops:status` deliberately uses the active Wrangler profile/config plus one
metadata-only D1 query. It does not require a checked-in account ID or a second
Queue analytics token, so the same generation-lag proof works for OAuth-backed
forks and ignored instance overlays. Queue backlog/DLQ and historical CPU
metrics remain account-console or explicitly scoped observability checks; see
the runtime operations guide for that evidence boundary.

Also replace `vars.SURF_USER_AGENT` with an application name and URL or email
that the instance operator monitors. NOAA/NWS asks API clients to identify a
contact; forks should not attribute their traffic only to the upstream repo.

The tracked configuration intentionally omits account-specific D1 and R2
IDs. Current Wrangler versions provision those bindings on deploy. Cloudflare
currently labels this automatic-provisioning path **Beta**. The setup command
ensures the named Queues exist without calling Cloudflare from the Worker.

### 3. Provision and deploy

```bash
pnpm setup:cloudflare
```

The first-install command checks authentication, ensures the named Queues,
builds and validates the Worker, deploys while Wrangler provisions D1/R2,
applies additive D1 migrations, upserts the reference seed, and runs a
structure-only API smoke against the deployed URL. Provisioning and seed steps
are idempotent.

The setup command runs automatic provisioning in non-interactive mode so
instance IDs stay in Cloudflare rather than being written into the tracked
configuration. The config-hygiene check rejects owner-specific IDs. A first
setup cannot use the update deploy's inactive-version capability gate because
neither the Worker nor all bindings exist yet. Confirm Workers Paid first. It
then deploys once before D1 can be migrated, so a plan/config rejection or
migration failure can leave partially created resources or a temporarily
uninitialized Worker. Read the reported error, fix it, and rerun the same
command; do not delete resources to retry. If automatic provisioning is
unavailable for an account, use
[Cloudflare's manual resource setup](https://developers.cloudflare.com/workers/wrangler/configuration/#bindings)
and an ignored instance configuration rather than guessing IDs or committing
account-specific values:

```bash
cp apps/web/wrangler.jsonc apps/web/wrangler.instance.jsonc
export SURF_WRANGLER_CONFIG=wrangler.instance.jsonc
```

Add the D1 `database_id` and the instance-scoped R2 `bucket_name` only to
`wrangler.instance.jsonc`; it is ignored by Git. The setup/deploy helpers pass
that override to every Wrangler command, including Queue inspection,
migrations, seed, deploy, and dry-run validation. Use the documented
`pnpm wrangler -- ...` wrapper for one-off commands so the same active
configuration is applied to secrets and diagnostics too.

Keep the active config's `name` override-addressable: it must start with a
lowercase letter and contain only lowercase letters, digits, and hyphens (for
example, `friends-surf2`). Deployment uses that name in Cloudflare's exact
version-override header and fails before any remote mutation if the name is
not addressable. Do not set `WRANGLER_CI_OVERRIDE_NAME` to a different name;
the deploy helper rejects name drift before provisioning or migration. Keep
`CLOUDFLARE_ENV` unset as well: this project selects self-hosted instances with
`SURF_WRANGLER_CONFIG`, and an ambient Wrangler environment would silently
suffix the deployment target.

### 4. Protect manual production ingest

Scheduled ingestion uses the Queue and does not need an HTTP token. The manual
production endpoint does:

```bash
pnpm wrangler -- secret put INGEST_TOKEN
```

Enter a long random value at the hidden prompt. When invoking the endpoint from
your shell, provide the same value through the ignored environment variable
`SURF_INGEST_TOKEN`; never paste it into a script or GitHub issue.

Keep that variable available for later `pnpm deploy` runs. An update deploy
requires `SURF_BASE_URL` and first reconciles configured Queues, because
Wrangler prechecks them before it will upload a version. It then stages the
exact target as an inactive Worker version. Cloudflare must accept the
configured 2,000 ms CPU guard and the version-detail readback must match before
the command mutates D1. A Free-plan rejection can therefore leave newly created
Queues, but never a D1 migration/seed from that deploy attempt. The command then
prepares storage, rechecks that the original predecessor remains solely active,
activates only the target at 100%, synchronizes triggers, proves the exact
version is callable and ordinary routing has converged, then performs one
unpinned authenticated PATCH with a Worker-enforced version precondition. Any
newly migrated forecast read-model tables are populated before unpinned,
exact-version strict smoke testing and a final 100% control-plane check.
`versions upload` can emit a public preview URL; deployment never substitutes
it for the configured production origin.

### 5. Optional local-oMLX Analysis rollout

The tracked configuration deliberately sets `NARRATIVE_ENABLED=false`. The
authorized `pnpm setup:cloudflare` and `pnpm deploy` workflows call
`ensureQueues()`, which inspects and idempotently provisions every configured
Queue plus the matching narrative DLQ. Do not run an unconditional second
`queues create` after those workflows. If an operator intentionally bypasses
project setup, use the read-before-create manual alternative in
[the runner guide](narrative-runner.md).

After the disabled deployment is healthy:

1. Record the D1 Time Travel bookmark and export D1.
2. Add the narrative Queue's HTTP pull consumer and DLQ with the exact command
   in the runner guide. Do not add a Wrangler Worker consumer entry.
3. Set `NARRATIVE_RESULT_TOKEN` through Wrangler's hidden secret prompt. Put
   the matching value only in the runner's ignored target-specific environment
   variable; keep it separate from the Cloudflare Queue API token.
4. Preflight oMLX and run the runner's config/status checks. Before enablement,
   `once` can prove only Queue authentication and an empty bounded pull; local
   fake-server tests prove the job/result contract without production work.
5. In the ignored instance config, change only `vars.NARRATIVE_ENABLED` to
   `true`, then deploy through the normal version/readiness path.
6. Trigger one fresh authorized ingest so the deployed Worker emits an
   `analysis-signal` and a real narrative job. Run `once` (or start `run run`),
   then require the selected `/brief` response to become `published` and
   confirm the matching D1 ledger row/revision before calling the rollout
   end-to-end complete.

The Worker writes the D1 ledger before Queue send and scheduled reconciliation
repairs ambiguous sends. The runner posts generated or identifiable terminal
results to `/api/internal/narratives/results`; the Worker authenticates before
bounded parsing and accepts only the active attempt and current exact fact
fingerprint.

Rollback is non-destructive: first set `NARRATIVE_ENABLED=false` through the
normal deploy path to stop new production, then remove the HTTP pull consumer
to stop local intake. Let in-flight leases settle before revoking result/Queue
tokens.
Never delete the Queue, DLQ, D1 rows, or dormant Agent namespace as a retry
technique. `ForecastBriefAgent`, `FORECAST_BRIEF_AGENT`, migration 0002, and
`FORECAST_BRIEF_ENABLED=false` remain dormant rollback compatibility only; do
not enable them as the active Analysis path.

### 6. Verify and populate

Set the deployed URL returned by Wrangler, including `https://`:

```bash
export SURF_BASE_URL=https://your-worker.your-subdomain.workers.dev
export SURF_INGEST_TOKEN=<matching-secret-in-your-shell>
pnpm ingest:remote
pnpm smoke:cloudflare
```

The first `pnpm setup:cloudflare` remains structure-only and needs this manual
population step. Subsequent `pnpm deploy` runs perform the same authenticated
Queue ingest and bounded read-model publication check automatically before
their strict smoke; rerunning these commands is a safe explicit verification.

`pnpm ingest:remote` returns after every configured spot's 1-hour and 3-hour
read models expose the exact ingest ID acknowledged by the Worker, report a
generation timestamp at or after that acknowledgement, and were materialized
after the Worker-issued request. The content digest remains part of the stored
generation ID, so a retry that changes assembled facts also changes the ETag.
The command exits nonzero on an invalid Queue acknowledgement, an unexpected
forecast response, an ingest-ID mismatch, or the bounded publication timeout,
which names any missing spot/interval pairs. The post-ingest smoke checks every
configured spot for a five-day horizon and at least one scored window backed by
wave data; it does not accept synthesized unknown windows as a populated
deployment.

Then verify:

- `/api/health` reports `status: ok`;
- `/api/spots` returns the 11 reference spots;
- the dashboard shows current windows after ingest;
- source freshness and low-confidence caveats are visible; and
- the hourly trigger and Queue consumer are present in Cloudflare.

## Customize the forecast catalog

The included data is a NorCal reference, not user preference storage. Spot
geometry and source mappings affect forecast meaning and must be reviewed like
code. Use the catalog synchronization command after changing it:

```bash
pnpm spots:sync
pnpm spots:check
pnpm test
```

A new spot needs a stable ID, coordinates/timezone, break-facing wind geometry,
working tide and buoy references, verified wave-source coverage, attribution,
and mapping tests. Do not copy the nearest CDIP point or coastal-grid scalar
without evidence that it represents the break; an explicit unavailable or
low-confidence mapping is more honest.

## Updating an instance

```bash
git pull --ff-only
pnpm install --frozen-lockfile
```

If this instance uses ignored `apps/web/wrangler.instance.jsonc`, manually
merge newly tracked structural keys and bindings from `apps/web/wrangler.jsonc`
into it before verification, while preserving the instance name, resource IDs,
operator contact, routes, and secrets boundary. Do not overwrite the overlay
with a fresh copy. For this upgrade explicitly reconcile every v3 structural
requirement:

- keep the existing `FORECAST_BRIEF_AGENT` binding/export but set
  `vars.FORECAST_BRIEF_ENABLED` to `false`; it is dormant compatibility only;
- add `vars.NARRATIVE_ENABLED` as `false` until the authorized Queue/runner
  rollout reaches step 5 above;
- keep the instance-scoped `INGEST_QUEUE` producer and add exactly one
  `NARRATIVE_QUEUE` producer targeting `<instance>-narrative`;
- keep only the ingest Queue in `queues.consumers`; narrative HTTP pull remains
  an out-of-band operator step; and
- include the exact version metadata binding:

```jsonc
"version_metadata": {
  "binding": "CF_VERSION_METADATA"
}
```

Select the reconciled overlay again in every fresh shell, then verify and
deploy:

```bash
export SURF_WRANGLER_CONFIG=wrangler.instance.jsonc
pnpm verify
export SURF_INGEST_TOKEN=<matching-secret-in-your-shell>
pnpm deploy
```

Instances that use the tracked canonical configuration can omit the export.

The deploy command reconciles Queues, stages and validates the target, applies
migrations, activates the target, synchronizes triggers, refreshes the
materialized forecast generation, and then runs the strict remote smoke.
Wrangler requires Queues before staging, but a rejected CPU guard stops before
D1; there is no Workers Free fallback. Because Wrangler can activate before a
later observability patch fails, a nonzero activation command is reconciled
against exact control-plane state before the workflow proceeds. Once Wrangler
activates the version, any settings, trigger, readiness, publication, or smoke
failure deliberately leaves it active for a Queue-safe fix-forward: cron, manual
traffic, or backlog processing may already have crossed the Queue schema
boundary. Rolling back requires first proving the Queue quiescent, no consumer
in flight, and every payload predecessor-compatible. Additive D1 schema changes
remain intact. The command fails if any configured spot lacks a five-day
horizon with sourced, scored wave data.

The ingest Queue now carries distinct version-1 `source-batch` and
`analysis-signal` payloads that their predecessors do not understand. A
rollback across either code boundary requires first deploying
`NARRATIVE_ENABLED=false`, then pausing cron and manual ingest, pausing Queue
delivery, waiting for all root/source-batch/materialization/Analysis-signal work
to settle, proving the ingest Queue quiescent, and inspecting the DLQ so neither
payload is replayed into the predecessor. These Queue changes have no D1
migration to reverse; leave normalized rows and R2 evidence in place. While
disabled, exact already-published Analysis revisions remain readable, but a
non-published ledger row is reported unavailable rather than falsely pending.

Back up D1 before a migration that changes or removes data. See
[runtime operations](runtime-operations.md) for export, rollback, retention,
and troubleshooting.
