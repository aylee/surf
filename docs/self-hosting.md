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
keys. Optional Analysis uses a self-hosted oMLX server as primary and a bounded
Gemini API fallback when the whole local host/runner is unavailable or output
fails the deterministic validator. Forecast data continues to work when
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
OpenAI-compatible oMLX server on loopback. A separate delayed Queue is consumed
by the Worker and uses Gemini only after an atomic D1 claim. The tracked caps
are four calls per rolling 24 hours and 100 per rolling 31 days; the API key is
a Wrangler secret and successful raw output is stored before validation so a
publish replay cannot call the provider twice.

Set up the Queue/result boundary only after the forecast deployment is healthy.
The [local narrative runner guide](narrative-runner.md) covers model selection,
ignored `0600` environment files, target-map/result credentials, bounded
timeouts, one-shot acceptance, LaunchAgent health, and MacBook-to-Mac-Studio
migration. No local model or quantization is yet an accepted production lane.
Keep model selection in configuration and require the Analysis v5 full-corpus
gate, a rubric average of at least 4, and owner/Codex calibration before naming
a default.

## Deploy to Cloudflare

### 1. Authenticate

For a brand-new Cloudflare account, first open
[Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
and complete its onboarding, including choosing a `workers.dev` subdomain.
The setup command is intentionally non-interactive and cannot answer that
one-time account prompt for you.

```bash
pnpm --filter @surf/web exec wrangler login
pnpm --filter @surf/web exec wrangler whoami
```

Wrangler OAuth is the preferred interactive path. CI may use a scoped
`CLOUDFLARE_API_TOKEN`, but do not put a token in the repository or pass it as a
command-line value.

### 2. Choose an instance name

Review `apps/web/wrangler.jsonc` before the first deploy. The Worker `name`, D1
`database_name`, ingest Queue/DLQ, local-primary narrative Queue/DLQ, and
fallback Queue form one instance
namespace. For example, an instance named `surf-dev` uses database `surf-dev`,
Queues `surf-dev-ingest`, `surf-dev-narrative`, and
`surf-dev-narrative-fallback`, with matching DLQ names where configured. A
manually provisioned R2 bucket must be named `surf-dev-raw-artifacts`. The
portability check enforces those relationships so one renamed instance cannot
silently attach to another instance's storage. Keep binding names (`DB`,
`RAW_ARTIFACTS`, `INGEST_QUEUE`, `NARRATIVE_QUEUE`, and
`NARRATIVE_FALLBACK_QUEUE`) unchanged unless the
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

This is a bootstrap-only command for an instance that does not yet have a
Worker and all required bindings. Do not use it to update or adopt an existing
production instance; after the first healthy deployment, configure the
production profile and use `pnpm release:prod` for every managed release.

The first-install command checks authentication, ensures the named Queues,
requires a clean Git worktree, builds and validates the Worker twice, deploys
while Wrangler provisions D1/R2, applies additive D1 migrations, upserts the
reference seed, and runs a structure-only API smoke against the deployed URL.
The two builds prove that pinning the final release identity did not alter the
Worker runtime digest. Provisioning and seed steps are idempotent.

The setup command runs automatic provisioning in non-interactive mode so
instance IDs stay in Cloudflare rather than being written into the tracked
configuration. The config-hygiene check rejects owner-specific IDs. Initial
setup is fail-closed unless `NARRATIVE_ENABLED=false`; finish storage and the
out-of-band runner/HTTP-pull-consumer activation, then enable Analysis only
through the component-aware release path. A first setup cannot use the managed
release's inactive-version capability gate because
neither the Worker nor all bindings exist yet. Confirm Workers Paid first. It
then deploys once before D1 can be migrated, so a plan/config rejection or
migration failure can leave partially created resources or a temporarily
uninitialized Worker. If the Worker was created, do not rerun bootstrap:
preserve the printed identity snapshot receipt, configure the production
profile, and use `pnpm release:prod` to adopt and fix forward. If the failure
happened before the Worker was created, fix the reported error and rerun the
bootstrap command. Do not delete resources to retry. If automatic provisioning
is unavailable for an account, use
[Cloudflare's manual resource setup](https://developers.cloudflare.com/workers/wrangler/configuration/#bindings)
and a private external instance source plus activation snapshot rather than
guessing IDs or committing account-specific values.

Keep the editable instance source outside the repository and private, then
stage a new release-bound snapshot. Never deploy directly from the source or
the old ignored `apps/web/wrangler.instance.jsonc` path:

```bash
set -euo pipefail
config_root="/Users/alex/Services/surf/config"
activation_id="$(date -u +%Y%m%dT%H%M%SZ)-setup"
config_source="$config_root/wrangler.source.jsonc"
config_snapshot="$config_root/activations/$activation_id/wrangler.instance.jsonc"
install -d -m 0700 "$config_root" "$(dirname "$config_snapshot")"
install -m 0600 apps/web/wrangler.jsonc "$config_source"
# Edit only the private source: add instance resource IDs/destinations and keep
# vars.NARRATIVE_ENABLED=false for initial setup.
${EDITOR:-vi} "$config_source"
snapshot_json="$(pnpm wrangler:snapshot \
  --source "$config_source" --output "$config_snapshot")"
export SURF_WRANGLER_CONFIG="$(printf '%s' "$snapshot_json" | jq -er .path)"
export SURF_WRANGLER_CONFIG_SHA256="$(printf '%s' "$snapshot_json" | jq -er .sha256)"
test "$(stat -f '%Lp' "$SURF_WRANGLER_CONFIG")" = "600"
```

Add the D1 `database_id` and the instance-scoped R2 `bucket_name` only to the
private source. `wrangler:snapshot` writes a mode-`0600`, non-symlink,
single-activation file outside the checkout, pins every code/assets/migrations
path to the exact checkout, and fails if that output path already contains
different bytes. The bootstrap helper and one-off Wrangler wrapper require its
absolute path and exact SHA-256, and recheck both before every Wrangler
command. During `setup:cloudflare`, the helper writes a second durable
mode-`0600` snapshot beside this input. Its filename and contents bind the
nonzero exact Git source revision plus the canonical client and Worker runtime
digests; the helper repins that snapshot before the first Queue, D1, or Worker
mutation and prints its path/hash receipt. Preserve both snapshots, both hashes,
and the source revision as one bootstrap evidence unit. Use the documented
`pnpm wrangler -- ...` wrapper for one-off commands so the same pinned
configuration is applied to secrets and diagnostics too.

Keep the active config's `name` override-addressable: it must start with a
lowercase letter and contain only lowercase letters, digits, and hyphens (for
example, `friends-surf2`). Deployment uses that name in Cloudflare's exact
version-override header and fails before any remote mutation if the name is
not addressable. Do not set `WRANGLER_CI_OVERRIDE_NAME` to a different name;
the deploy helper rejects name drift before provisioning or migration. Keep
`CLOUDFLARE_ENV` unset as well: this project selects self-hosted instances with
the `SURF_WRANGLER_CONFIG` / `SURF_WRANGLER_CONFIG_SHA256` snapshot pair, and
an ambient Wrangler environment would silently suffix the deployment target.

### 4. Protect manual production ingest

Scheduled ingestion uses the Queue and does not need an HTTP token. The manual
production endpoint does:

```bash
pnpm wrangler -- secret put INGEST_TOKEN
```

Enter a long random value at the hidden prompt. When invoking the endpoint from
your shell, provide the same value through the ignored environment variable
`SURF_INGEST_TOKEN`; never paste it into a script or GitHub issue.

Keep that variable in the private operator-environment file referenced by the
[production profile](production-releases.md#one-time-profile). `pnpm
release:prod` classifies the exact target before asking for confirmation. A
proven assets-only release stages and activates the exact Worker without
touching Queues, D1, triggers, ingest, or the runner. A conservative full
release stages the target and requires Cloudflare to accept and read back the
configured 2,000 ms CPU guard. It then performs only the component work selected
by the attested impact vector: Queue reconciliation for Queue topology, a D1
rollback pair plus storage work for migration/seed changes, runner verification
or activation when Analysis compatibility is affected, trigger synchronization
for trigger topology, and generation publication for materialization or catalog
changes. Every lane rechecks the predecessor, activates only the target at
100%, and performs exact-version smoke and final control-plane checks. `versions upload`
can emit a public preview URL; release verification never substitutes it for a
configured production origin.

### 5. Optional local-oMLX Analysis rollout

The tracked configuration deliberately sets `NARRATIVE_ENABLED=false`. The
bootstrap-only `pnpm setup:cloudflare` command and conservative `pnpm
release:prod` lane call `ensureQueues()`, which inspects and idempotently
provisions every configured Queue plus the matching narrative DLQ. Do not run
an unconditional second `queues create` after those workflows. If an operator
intentionally bypasses project setup, use the read-before-create manual
alternative in [the runner guide](narrative-runner.md).

After the disabled deployment is healthy:

1. Record the D1 Time Travel bookmark and export D1.
2. Add the narrative Queue's HTTP pull consumer and DLQ with the exact command
   in the runner guide. Do not add a Worker consumer to the local-primary
   Queue; the tracked Worker consumer belongs only to the fallback Queue.
3. Create the external mode-`0600` Wrangler source, Worker-secret source,
   runner-environment source, and operator environment described by the
   production profile. Put one password-manager-generated result token in both
   named result-token fields and keep the Queue API token separate. Do not
   pre-stage a release-specific Wrangler or Worker-secret snapshot; `pnpm
   release:prod` owns those snapshots, HMAC-pins their inputs, and supplies the
   exact Worker-secret snapshot to the inactive Worker upload.
4. Create a detached, clean release worktree at the exact merged SHA, run the
   frozen install there, and render both LaunchAgents by executing the renderer
   from that release path. The initial activation record owns the runner
   bundle/manifest, runner environment and status path, accepted protocols,
   model/executables, and rendered/installed plist identities. It must not
   contain a Wrangler or Worker-secret snapshot. Install and activate only
   through the runner guide's supported controller, which installs attested
   copies under `~/Library/LaunchAgents` so login/reboot reloads them. Never run
   a production LaunchAgent from the developer checkout. Subsequent compatible
   runner changes are activated by `pnpm release:prod`; an unchanged compatible
   runner remains running.
5. Preflight oMLX and run the runner's config/status checks through the
   immutable release's activation-record verifier as shown in the runner guide.
   It excludes ambient overrides and supplies the recorded release SHA to the
   child. `config:check` performs one bounded, read-only Queue
   ID/name/consumer-settings proof without pulling. Before enablement, `once`
   can additionally prove an empty bounded pull; local
   fake-server tests prove the job/result contract without production work.
   Before starting this v5-only runner, execute the read-only D1 query below
   and require `active_v4_jobs=0`:

   ```bash
   pnpm wrangler -- d1 execute DB --remote --command \
     "select count(*) as active_v4_jobs from narrative_jobs where result_target='surf.analysis.v4' and status in ('enqueueing','enqueue_failed','pending')"
   ```

   Separately record Cloudflare Queue metrics and require the narrative
   primary, DLQ, and fallback Queues to have zero available, delayed, leased,
   or retrying messages. Consumer-list output is not a backlog proof. If either
   legacy gate is nonzero, leave v5 disabled and drain with the compatible
   predecessor; never let a v5-only runner ACK an old target.
6. In the private Wrangler source, change only `vars.NARRATIVE_ENABLED` to
   `true`, then deploy through `pnpm release:prod`. The command creates the
   clean detached Worker release itself. The runner retains its own immutable
   source revision; activation requires the exact narrative protocol and
   Queue/callback/result-token binding proof rather than matching Worker and
   runner Git SHAs.
7. Trigger one fresh authorized ingest so the deployed Worker emits an
   `analysis-signal` and a real narrative job. Run `once` (or start `run run`),
   then require the selected `/brief` response to become `published` and
   confirm the matching D1 ledger row/revision before calling the rollout
   end-to-end complete.

The Worker writes the D1 ledger before Queue send, accepts the delayed watchdog
before the local-primary send, and scheduled reconciliation repairs ambiguous
sends. The runner posts generated or identifiable terminal
results to `/api/internal/narratives/results`; the Worker authenticates before
bounded parsing and accepts only the active attempt and current exact fact
fingerprint.

Rollback is non-destructive: first deploy `NARRATIVE_ENABLED=false` to stop new
admission, then boot out the runner LaunchAgent so `SIGTERM` stops new pulls,
drains the active lease, and cannot be undone by `KeepAlive`. `bootout` is
asynchronous, so use the runner guide's bounded fail-closed label poll. Prove the stopped
heartbeat, dead PID, and unloaded label before removing the HTTP pull consumer;
preserve available primary backlog. Keep the disabled current Worker active
for at least the watchdog delay and prove the fallback Queue has no available,
delayed, leased, or retrying messages before activating a predecessor. Revoke
result/Queue tokens only after those proofs.
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
population step. Later releases perform the authenticated Queue ingest and
bounded read-model publication check only when materialization or catalog/seed
inputs changed. Proven assets-only and unrelated component releases omit that
stateful work.

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

If this instance uses a private external Wrangler source, manually merge newly
tracked structural keys and bindings from `apps/web/wrangler.jsonc` into that
source before verification, while preserving the instance name, resource IDs,
operator contact, routes, and secrets boundary. Do not overwrite the source
with a fresh copy. For this upgrade explicitly reconcile every v5 structural
requirement:

- keep the existing `FORECAST_BRIEF_AGENT` binding/export but set
  `vars.FORECAST_BRIEF_ENABLED` to `false`; it is dormant compatibility only;
- add `vars.NARRATIVE_ENABLED` as `false` until the authorized Queue/runner
  rollout reaches the enablement step above;
- keep the instance-scoped `INGEST_QUEUE` producer and add exactly one
  `NARRATIVE_QUEUE` producer targeting `<instance>-narrative` plus one
  `NARRATIVE_FALLBACK_QUEUE` producer targeting
  `<instance>-narrative-fallback`;
- keep the ingest consumer and add exactly one serialized fallback Worker
  consumer with `max_concurrency = 1` and `max_retries = 0`; do not add the
  local-primary narrative Queue to `queues.consumers` because its HTTP pull
  consumer remains an out-of-band operator step; and
- include the exact version metadata binding:

```jsonc
"version_metadata": {
  "binding": "CF_VERSION_METADATA"
}
```

Put the reconciled source and required secret/environment sources in the
mode-`0600` production profile, then preview and release:

```bash
export SURF_PRODUCTION_PROFILE=/absolute/path/to/production-profile.json
pnpm release:prod --plan
pnpm release:prod
```

The preview performs exact target-owned read-only preparation: it fetches
`origin/main`, creates or reuses the detached checkout, installs from the
frozen lockfile, runs `pnpm verify`, builds all component identities, and
inspects the live Worker/deployment plus trusted release/runner evidence before
printing the proven lane and mutations. It writes no production journal and
makes no Cloudflare, D1, Queue, secret, trigger, or LaunchAgent mutation.

The release command creates and pins the release-specific config and secret
snapshots internally. If no trusted active receipt exists, the first managed
release takes the conservative full lane, records the live Worker/deployment as
its external predecessor, and discovers the installed runner through its exact
plist. Adoption does not require matching Worker and runner Git SHAs or adding
Wrangler/Worker-secret artifacts to activation record v4. Direct operational
`pnpm wrangler -- ...` and legacy
`pnpm ops:status` calls still require the exact external snapshot path/hash
pair recorded by the release journal. The exact local, secretless wrapper check
`pnpm wrangler -- --version` is the only command that may omit that pair.

The release command always stages and validates the inactive target, rechecks
the predecessor, activates the exact target, and runs strict remote smoke. It
reconciles Queues and triggers, backs up or mutates D1, activates the runner,
and refreshes materialized forecasts only when their attested component
fingerprints require that work; missing trust evidence selects every guarded
step. Wrangler requires referenced Queues before staging, but a rejected CPU
guard stops before D1; there is no Workers Free fallback. Because Wrangler can
activate before a
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
