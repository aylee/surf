# Self-hosting

This guide takes a new checkout to a populated local dashboard, then to an
independent Cloudflare deployment. A fork never needs the maintainer's account
or resource identifiers.

## Prerequisites

- Node.js 24 (see `.node-version`)
- pnpm 11 through Corepack
- For deployment: a Cloudflare account with Workers, D1, R2, and Queues,
  plus a registered `workers.dev` subdomain

The forecast feeds used by the reference configuration do not require paid API
keys. The optional daily explanation can use a Gemini API key; deterministic
forecast data and fallback copy continue to work without it. Cloudflare usage
is the expected hosting cost. Python 3.12 and
[uv](https://docs.astral.sh/uv/) are needed only for the contributor gate and
optional scientific extractor.

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

### Optional local Gemini brief

Create a key in [Google AI Studio](https://aistudio.google.com/app/apikey) in a
project with billing disabled. Under the [Gemini API pricing
terms](https://ai.google.dev/gemini-api/docs/pricing), free-tier submitted
content may be used to improve Google products; review the [Gemini API
terms](https://ai.google.dev/gemini-api/terms) before enabling it. Surf
therefore sends only public NOAA/CDIP/CO-OPS facts and no user prompt,
identity, session history, IP-derived context, or private data. Keeping billing
disabled makes quota exhaustion fail closed instead of creating spend.

The repository includes a secret-free example. The local file is ignored:

```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
chmod 600 apps/web/.dev.vars
```

Edit `apps/web/.dev.vars` and replace only the value after
`GEMINI_API_KEY=`. Never paste the key into a command, issue, screenshot, test
fixture, or tracked file. `FORECAST_BRIEF_ENABLED=true` enables local model
generation; an invalid/missing key fails closed to deterministic copy.

An opt-in evaluation makes exactly one provider call, validates the structured
result against the same fact policy used by the Worker, and prints a safe
record containing either validated public prose plus quality metadata or a
sanitized rejection category (never the request, key, fact IDs, or provider
payload):

Gemini synthesizes natural explanatory prose from role-tagged public facts; it
does not calculate forecast values, choose new windows, or write unrestricted
marine claims. Every model-authored field carries sentence-scoped fact
references and must pass independent policy and quality validation. Code adds
the authoritative time labels, measurements, recommendation order, and hard
measurement or hazard caveats after validation.

```bash
cd apps/web
SURF_LIVE_GEMINI=1 node --env-file=.dev.vars \
  ./node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  worker/brief/gemini.live.test.ts
```

Ordinary unit and CI runs skip this test and never require a Gemini key.

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
`database_name`, ingest Queue, and dead-letter Queue form one instance
namespace. For example, an instance named `surf-dev` must use database
`surf-dev`, Queue `surf-dev-ingest`, and dead-letter Queue
`surf-dev-ingest-dlq`. A manually provisioned R2 bucket must be named
`surf-dev-raw-artifacts`. The portability check enforces those relationships so
one renamed instance cannot silently attach to another instance's storage.
Keep binding names (`DB`, `RAW_ARTIFACTS`, and `INGEST_QUEUE`) unchanged unless
the Worker types and code change with them.

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
setup deploys once before D1 can be migrated, so a migration failure can leave
a temporarily uninitialized Worker and partially created resources. Read the
reported error, fix it, and rerun the same command; do not delete resources to
retry. If automatic provisioning is unavailable for an account, use
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
first proves the exact Wrangler-emitted Worker version is serving consistently,
then performs one authenticated ingest so any newly migrated forecast
read-model tables are populated before version-pinned strict smoke testing.

### 5. Optional Gemini production rollout

The tracked configuration deliberately sets `FORECAST_BRIEF_ENABLED=false`.
This makes the first deployment that creates `ForecastBriefAgent` a
deterministic-only lifecycle deploy. After that deployment is healthy, set the
key through Wrangler's hidden prompt:

```bash
pnpm wrangler -- secret put GEMINI_API_KEY
pnpm wrangler -- secret list
```

`secret list` verifies the binding name without revealing its value. To enable
generation in a separate Worker version, copy the tracked config to the
ignored instance config (if needed), change only
`vars.FORECAST_BRIEF_ENABLED` to `"true"`, select that config, and deploy:

```bash
cp apps/web/wrangler.jsonc apps/web/wrangler.instance.jsonc
export SURF_WRANGLER_CONFIG=wrangler.instance.jsonc
pnpm deploy
```

Record the current D1 Time Travel bookmark and export D1 before the
migration/deploy, then smoke the disabled version before enabling the model.
A first Durable Object class lifecycle change cannot be
rolled back to a pre-class Worker version; the operational rollback target is
the disabled post-Agent version. Do not delete the Agent export/namespace as a
rollback technique.

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
- `/api/spots` returns the six reference spots;
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
operator contact, routes, secrets boundary, and intentional feature flags. Do
not overwrite the overlay with a fresh copy. For this upgrade the overlay must
include:

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

The deploy command applies migrations, deploys, refreshes the materialized
forecast generation, and then runs the strict remote smoke. Once Wrangler
activates the version, any readiness, publication, or smoke failure
deliberately leaves it active for a Queue-safe fix-forward: cron, manual
traffic, or backlog processing may already have crossed the Queue schema
boundary. Rolling back requires first proving the Queue quiescent, no consumer
in flight, and every payload predecessor-compatible. Additive D1 schema changes
remain intact. The command fails if any configured spot lacks a five-day
horizon with sourced, scored wave data.

Back up D1 before a migration that changes or removes data. See
[runtime operations](runtime-operations.md) for export, rollback, retention,
and troubleshooting.
