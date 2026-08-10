# Runtime operations

This runbook is instance-neutral. Run commands from the repository root. The
Every operational `pnpm wrangler -- ...` call requires and hash-verifies the
absolute external `SURF_WRANGLER_CONFIG` activation snapshot and its
`SURF_WRANGLER_CONFIG_SHA256` described in the self-hosting guide, including
remote D1 and rollback commands. The sole exception is the exact local,
secretless wrapper check `pnpm wrangler -- --version`. Operational calls also
reject unsafe ambient Wrangler environment variables before spawning. Never
point one at the editable source or the obsolete relative ignored overlay.

## Normal cadence

- Cron enqueues one ingest cycle every hour at minute 17.
- Queue retries isolate public-provider failures from the scheduler.
- A root `source-ingest` invocation dispatches three deterministic, versioned
  `source-batch` messages of at most four spots. Each batch attempts all five
  providers for only those spots, persists only that scoped input set, then
  fans out one materialization message per batch spot. Queue batch size and
  concurrency stay at one so every source batch and spot receives a fresh
  Worker budget.
- Latest normalized rows and validated 1-hour/3-hour forecast read models
  refresh each cycle.
- Immutable issued history is sampled at 00/06/12/18 UTC and keeps only the
  6 AM–6 PM local planning horizon.
- The report layer reads the best available normalized rows; it never replaces
  stale inputs with fixture data.
- When optional Analysis is enabled, a published spot generation emits one
  versioned `analysis-signal` message through the ingest Queue. Its separate
  invocation reloads all current local-date fact bundles, ledgers each exact
  Analysis job, sends a ten-minute delayed watchdog first, and then sends the
  local-primary job to a dedicated narrative Queue. An out-of-band runner
  HTTP-pulls available work, calls local oMLX, and posts a bounded result to the
  authenticated Worker endpoint. If the Mac/runner is offline or its output
  fails validation, the separate Worker-consumed watchdog Queue can make one
  budget-claimed Gemini call through the same validator/publication CAS. Code owns all values and recommendation
  semantics; the cloud validates connective prose and derives provenance from
  used slots. Failure never delays forecast publication and never creates a
  pseudo-report: the UI reports published, pending, or unavailable honestly.

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

### Worker CPU budget

The canonical and instance Worker configurations pin `limits.cpu_ms` to 2,000
ms. This is a per-invocation ceiling, not reserved or prepaid CPU: Cloudflare
bills actual CPU used. The limit applies to HTTP, scheduled, Queue, and Durable
Object invocations in the Worker and is enforced only on Cloudflare's network.
Local development does not prove it.

The value is intentionally bounded. A fixed Logfire sample selected
`span_name = 'queue'`, `cloudflare.outcome = 'ok'`, and
`start_timestamp >= '2026-08-05T00:00:00Z' AND start_timestamp <
'2026-08-10T14:40:00Z'`. Across its 912 successful Queue invocations,
`cpu_time_ms` measured 887 ms at p99 and 1,149 ms at the maximum. Two seconds
is 2.25 times that p99 and 74% above the observed maximum.
At the current forecast-only cadence—one root, three source batches, and 11 spot
materializations per hour—the nominal no-retry Queue load is capped at 21.6
million CPU-ms in a 30-day month if every one of those jobs consumes the entire
allowance. That remains below
[Standard's included 30 million CPU-ms](https://developers.cloudflare.com/workers/platform/pricing/#workers).
If optional Analysis also emits 11 `analysis-signal` messages every hour, the
deliberately pessimistic ceiling becomes 37.44 million CPU-ms, an overage of
about $0.15/month at current pricing. These figures are not an account billing
ceiling: scheduled, HTTP, Durable Object, retry, and Cloudflare limit-flexibility
usage is outside this nominal calculation. Normal usage is materially lower
because the limit is not a reservation. Increasing the guard is not the default
response to renewed `exceededCpu`: first inspect CPU traces and D1 rows read,
then optimize or split the work.

D1 `rows_read` bounds database work and cost; it is not a Worker CPU proxy.
Database-query wait is excluded from Worker CPU, while returned fallback rows
are still merged in JavaScript, so runtime traces remain the CPU authority.

This deployment contract requires the Standard usage model. Cloudflare
documents [configurable limits as Standard-only](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
and currently prices Standard under Workers Paid; Workers Free's 10 ms
per-invocation budget cannot run the measured materialization path. The
pre-deploy config validator rejects a missing or different CPU limit. Project
automation never changes account usage models, subscriptions, or billing. An
existing version's `resources.script_runtime.usage_model = standard` is not
proof of current account entitlement: a Worker on a Free account can still
report that version metadata while rejecting a new custom CPU limit. For an
existing Worker, `pnpm deploy` first idempotently reconciles configured Queues
because Wrangler refuses `versions upload` when any referenced Queue is
missing. It then stages the exact target. Acceptance by that upload API is the
capability proof and gates every D1 migration/seed; Cloudflare error `100328`
means the account does not support the 2,000 ms limit, and the command stops
without a Free fallback. Missing Queues may therefore have been created before
an entitlement rejection, but D1 is untouched. For first-time setup, verify
Workers Paid in the Cloudflare billing dashboard before authorizing
provisioning; a Worker version cannot be staged before the Worker and its
bindings exist.

Before deploying a CPU-limit change, record the active Worker version and a D1
Time Travel bookmark. Run `pnpm check:cloudflare`, then deploy through the
supported `pnpm deploy` path. That path uploads an inactive version, parses
Wrangler's exact `Worker Version ID`, and verifies the staged version reports
the configured runtime guard before preparing D1. Queue reconciliation happens
first because it is a Wrangler upload precondition. It activates only that ID
at 100% after storage preparation succeeds and an immediate control-plane
recheck proves the original predecessor is still active. From the returned
exact version ID, verify:

```bash
pnpm wrangler -- versions view <version-id> --json
```

Require `resources.script_runtime.usage_model` to be `standard`, one active
deployment at 100%, a complete exact-lineage ingest, and zero `exceededCpu`
Queue outcomes for that cycle. Compare `cpu_time_ms` with the 2,000 ms guard;
do not treat Cloudflare's occasional limit flexibility as headroom.

Treat Worker activation as the rollback boundary and fix forward by default.
The CPU-limit edit itself changes neither D1 nor Queue contracts, but a release
containing it may also include additive D1/query work, and PR 35's version-1
`source-batch` and `analysis-signal` messages are not understood by the active
pre-35 predecessor. Do not use that predecessor as a routine rollback target.
Follow the global version-1 rollback gate in [Deploy and
rollback](#deploy-and-rollback): first prove Queue quiescence, no consumer in
flight, DLQ and retry state, and predecessor payload compatibility. Additive D1
indexes can remain in place, but that does not make a Worker rollback
Queue-safe. Returning to the Free-plan 10 ms budget—or relying on its
non-guaranteed over-limit flexibility—also restores the known stale-report
failure mode; failed historical deliveries clustered around 50–85 ms.

Successful forecast responses use a one-minute shared-cache TTL with five
minutes of stale-while-revalidate. `/brief` is always `Cache-Control: no-store`
because its stable date URL must never serve an exact-value report after the
underlying fact or Analysis-contract identity changes. The forecast Worker
cache is version-scoped, so a deployment cannot serve a response produced by
the version it replaced. Health, errors, ingest responses, and other API
responses are explicitly uncacheable. Treat the forecast cache as request-load
protection, not as the source of truth; D1 read models remain the durable
last-good generation.

### Local missing-read-model proof

Run this local-only degraded-path check before readying an observability change.
It removes one regenerable row from the local D1 database; it never targets a
remote binding. The recovery path is a normal local ingest.

1. Start `pnpm dev` and retain its output, then in a second terminal run
   `pnpm ingest:local` followed by `pnpm smoke:local` to establish a healthy
   baseline. In the dev output, take the `ingestId` from the one
   `source_ingest_dispatched` terminal object. Require exactly three healthy
   `source_ingest_published` terminal objects with that same ID, one distinct
   configured `batchKey` each and 11 total `spotCount`. Then require exactly one
   `forecast_materialization_published` terminal object with that same
   `ingestId` for every configured spot × `1h|3h` pair (22 for the current
   catalog), each with a nonempty
   `generationId`, `outcome: "publish"`, and a stable `reasonCode`. Started
   events and optional-brief diagnostics are not terminal objects; do not count
   them. Require exactly one `publish` terminal per spot/interval. An
   at-least-once redelivery may add a nonretryable
   `forecast_materialization_skipped` terminal with
   `reasonCode: "forecast_generation_already_active"` and the same generation;
   do not count that idempotent skip as a second publication. Any missing or
   duplicate publication, different skip reason, or retryable skip fails this
   proof.
2. Stop the dev process so the local D1 file has no listener holding it, then
   delete exactly the `obsf-central` 3-hour row:

   ```bash
   pnpm --filter @surf/web exec wrangler d1 execute DB --local --yes --command \
     "delete from forecast_read_models where spot_id = 'obsf-central' and interval = '3h'"
   ```

3. Restart `pnpm dev` and request the missing interval:

   ```bash
   curl -i "http://127.0.0.1:8787/api/forecast/obsf-central?interval=3h"
   ```

   Require HTTP `503`, `Retry-After: 300`, and this bounded JSON log in the dev
   terminal (field order is not significant):

   ```json
   {"event":"forecast_read_model_missing","message":"forecast read model missing","spotId":"obsf-central","interval":"3h","reasonCode":"read_model_missing"}
   ```

4. Recover the row and prove the full healthy state again:

   ```bash
   pnpm ingest:local
   pnpm smoke:local
   ```

   Apply the same one-dispatch/three-source-batch/22-interval terminal-set
   assertion to this recovery ingest, using its new `ingestId`.

If the check is interrupted after deletion, step 4 is the rollback. Do not
substitute a remote D1 command for this procedure.

## Post-merge routine

Use the supported path in this order after a merge. Set `SURF_BASE_URL` to the
bare HTTPS origin being checked; `SURF_WRANGLER_CONFIG` and
`SURF_WRANGLER_CONFIG_SHA256` must select the preserved external activation
snapshot. `ops:status` is strictly read-only and verifies that same snapshot
before any health or Wrangler probe.

```bash
pnpm verify
pnpm deploy
pnpm ops:status
pnpm smoke:cloudflare
```

Expected results:

- `pnpm verify` completes the fresh-D1, test, build, and secretless bundle
  gates before production changes.
- `pnpm deploy` reconciles configured Queues, stages and verifies one inactive
  target version, then prepares D1, rechecks the predecessor, activates only
  the target, synchronizes triggers, publishes one complete generation, and
  finishes its strict smoke. A staging or runtime-proof failure happens before
  D1 mutation, although Queue creation may already have occurred. After Worker
  activation, recover a failed settings patch, trigger, readiness, or
  publication check by fixing forward; rollback still requires explicit Queue
  quiescence and payload-compatibility proof.
- `pnpm ops:status` prints four compact `PASS` rows: HTTPS health and the exact
  serving Worker version; one active deployment at 100%; one ingest consumer
  with batch/concurrency `1/1` and the configured DLQ; and one ready read-model
  row for each active spot/interval pair (`22/22` for the current 11-spot
  catalog). The active D1 spot IDs must exactly equal the checked-in NorCal
  catalog; a stale six-spot database cannot pass by reporting `12/12`. The
  models are checked against the latest completed source-generation watermark.
  The hourly policy allows one prior generation only during the first 10
  minutes while serialized Queue work drains. After that settle window every
  spot/interval must equal the watermark. The watermark itself may be at most
  70 minutes old (one hourly cadence plus the same settle budget). The row also
  reports bounded completed/failed/partial source-run counts without printing
  provider errors or forecast payloads. Any missing proof exits
  nonzero. It performs one health GET
  plus exactly three read-only Wrangler operations and never triggers ingest,
  prints forecast JSON, or changes D1/Queue state.
- `pnpm smoke:cloudflare` reports 11 spots, 22 ready read models, zero pending,
  and scored forecasts. Run it once with the custom hostname and once with the
  emitted `workers.dev` origin when both are part of the deployment.
- At the next actual `:17` cycle, inspect Logfire for the cron, source job, 11
  serialized spot jobs, and 22 publication outcomes, with the same structured
  `ingestId`/spot/generation evidence and no `exceededCpu`/1102 outcome.

The Queue status row proves consumer serialization and DLQ wiring, not queue
quiescence, backlog depth, DLQ emptiness, retries, or historical Worker CPU
outcomes. Wrangler 4 does not expose those as one finite structured status
command. `wrangler tail` is a live stream, and pulling a DLQ message leases it,
reveals its body, and changes delivery state. For causal diagnosis, use
[Cloudflare Queue metrics](https://developers.cloudflare.com/queues/observability/metrics/)
for bounded backlog/operation evidence and
[Workers Observability](https://developers.cloudflare.com/workers/observability/errors/)
or Logfire for `exceededCpu`/1102 outcomes. Keep those operator
checks separate from `ops:status`; direct Queue REST/GraphQL metrics require an
account identifier and additional token scopes that are not available to every
Wrangler OAuth or self-hosted instance. A generation-watermark failure proves
publication degradation downstream of the Queue, but does not by itself assign
the cause to Queue delivery, provider input, or Worker CPU.

For the authoritative answer to “what is live,” use:

```bash
pnpm wrangler -- deployments status --json
```

The active deployment must contain exactly one version at 100%. `pnpm wrangler
-- versions list` is supporting upload history only; it does not identify the
version receiving production traffic.

### Logfire OTLP destinations

In the Cloudflare account dashboard, open **Workers Observability**, choose
**Add destination**, and create these two destinations:

| Destination | Type | OTLP endpoint |
|---|---|---|
| `surf-logfire-traces` | Traces | `https://logfire-us.pydantic.dev/v1/traces` |
| `surf-logfire-logs` | Logs | `https://logfire-us.pydantic.dev/v1/logs` |

Give each destination a custom `Authorization` header whose value is the
Logfire project write token. Enter that token only in the Cloudflare
destination; never put it in this repository, the ignored instance config, a
command line, or captured shell output. For a Logfire EU project, substitute
the matching `logfire-eu.pydantic.dev` endpoints.

The tracked `wrangler.jsonc` remains destination-neutral. After the operator
creates both account-level destinations, add only their names to the matching
logs/traces `destinations` arrays in the private Wrangler source, stage a new
mode-`0600` activation snapshot/hash, run the normal config/verify gates, and
deploy through the supported path. See the
[Cloudflare Workers OTLP export documentation](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
and [Logfire OTLP documentation](https://logfire.pydantic.dev/docs/how-to-guides/alternative-clients/).

Automatic Cron-to-Queue trace continuity is not a documented guarantee. Verify
the one-correlated-trace criterion on a real `:17` production cycle. If
Cloudflare emits separate traces, `ingestId` is the explicit cross-trace
correlation fallback and evidence for the limitation—not permission to rewrite
the one-trace acceptance criterion silently.

Rollback is configuration-only and does not mutate forecast data: disable or
delete the two Cloudflare destinations and remove their names from the private
source before staging the rollback snapshot.

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
The same bounded handoff samples fresh affinity sessions. Each session creates
one random `Cloudflare-Workers-Version-Key` and sends one `GET /api/spots`.
Before target identity is established, stale or missing identity and
transport/body failures discard that key and back off before a new session
because Cloudflare deterministically keeps one key on one assigned version;
polling a stale key cannot converge. Once exact-target response headers are
observed, any non-2xx response or unreadable/invalid catalog is a target defect
and the deploy fails fast instead of rotating. No authenticated PATCH occurs
before one exact-target valid, unique catalog succeeds.

That winning catalog key is frozen for exactly one unpinned
`PATCH /api/ingest/once` route probe. It must return `401`,
`WWW-Authenticate: Bearer`, and that exact Worker version. The probe carries no
credentials or body, so stale non-2xx and transport/body failures discard the
entire read-only session, back off, and restart with a fresh keyed catalog
without consuming an authenticated attempt.
Any unauthenticated 2xx is terminal because it violates the auth-first
invariant; an expected-version response with any contract other than exact 401
Bearer is also terminal. Worker tests lock auth before Queue access.

One `Cloudflare-Workers-Version-Key` covers only a successful candidate's
catalog, route probe, and authenticated PATCH so
[Cloudflare version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/)
keeps that trio together when possible. Fresh keys sample assignments; callers
cannot use a key to choose the target version. Affinity remains a liveness aid,
never the mutation-safety proof. The
authenticated PATCH carries `X-Surf-Expected-Worker-Version`; the Worker
compares it with immutable `CF_VERSION_METADATA.id` before
`INGEST_QUEUE.send`. A stale PATCH-capable Worker returns an exact typed 409
before mutation. Only that fully validated response may discard the used key
and start another complete affinity session. One global 60-session cap and
60-second deadline bound all read-only rotations; at most three authenticated
attempts can occur inside them. Successful output includes
`versionAffinitySessions` and `authenticatedAttempts` so recovered convergence
is visible without exposing keys.
After credentials are sent, any 202, transport/body ambiguity, malformed
evidence, or other status is terminal, and the client never falls back to
POST.

Historical bootstrap note (retired): the one production Worker deployed before
PATCH existed had a one-recovery exception. Its invocation shape was:

```bash
SURF_LEGACY_PATCHLESS_WORKER_VERSION=<immutable-legacy-version-uuid> pnpm deploy
```

That exception was consumed during PR #20 and must not be set for current or
future deployments. The retained client escape hatch permits retry only when
that exact UUID returns Hono's exact no-route fingerprint (`404`,
`text/plain; charset=UTF-8`, `404 Not Found`). Never commit the UUID or add it
to Wrangler. Keep deploy PATCH permanently version-preconditioned. Its
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
one. Each source batch attempts all five providers and completes scoped raw and
normalized persistence in one invocation. Its configured worst-case external
request count is locked at 36, 36, or 25 (including CDIP metadata `HEAD`
fallbacks), below the Free Worker ceiling of 50; any spot/source-map change
must update and pass that exact URL-budget test. Normalized provider rows and
source-artifact metadata fan out inside bounded JSON-backed SQL, not through
one D1 statement per row. The production-shaped real-D1 regression contains
nonempty 120/121-hour inputs and locks the source pipeline at 31 statements;
the full Queue child uses 32 after its generation-fence read, below D1 Free's
50-query invocation ceiling. Each spot's history capture, synchronized
1-hour/3-hour assembly, and fact generation then share a separate child
invocation with a fresh Worker CPU budget. The conservative instrumented
materialization fixture uses 17 D1 statements and emits only one versioned
Analysis signal. That signal gets a separate ingest-Queue invocation;
reloading five active bundles and ledgering all five narrative jobs uses 36
statements. Both budgets are independently below D1 Free's 50-query ceiling,
and a partial-date failure is recorded and ACKed as advisory. The next exact
generation signal or hourly ledger reconciliation recovers it while stable
ledger identity deduplicates dates already created. Source-ingest delivery
remains at-least-once
and unordered; canonical batch keys/suffixes, stable root ingest IDs, indexed
logical-generation checks, and idempotent writes make duplicate or superseded
jobs safe. A normalized-data or source-run persistence failure does not fan out
that batch's children; retained rows cannot be relabeled as a fresh ingest.
NWS active-alert withdrawals reconcile only after a successful alerts response;
a successful empty set removes the prior active rows, while a failed response
preserves the last good alert state.

Inspect all expected spot/interval pairs without printing forecast JSON:

```bash
pnpm wrangler -- d1 execute DB --remote --command \
  "with intervals(interval) as (values ('1h'), ('3h')) select s.id as spot_id, i.interval, case when r.spot_id is null then 'missing' else 'ready' end as state, r.generated_at, r.materialized_at, length(r.forecast_json) as json_chars from spots s cross join intervals i left join forecast_read_models r on r.spot_id=s.id and r.interval=i.interval where s.active=1 order by s.id,i.interval"
```

The NorCal reference configuration should return 22 `ready` rows. If any pair
is missing, tail structured Worker logs, run one authenticated
`pnpm ingest:remote` (it waits and names every missing pair), rerun the query,
then run `pnpm smoke:cloudflare`. Inspect `forecast materialization failed for
<spot>` and the configured `<instance>-ingest-dlq` before retrying again. Do not
insert or hand-edit read-model JSON. A narrative Queue, runner, oMLX, or result
validation failure cannot remove these rows.

## Analysis failure

Start with the public response for one spot/date. `/brief` v3 is always
`Cache-Control: no-store` and returns exactly one lifecycle:

- `published` means the revision matches the current exact Analysis fact
  fingerprint;
- `pending` means an active matching job exists before its inference deadline;
- `unavailable` means generation is disabled, no matching report/job exists,
  work expired or was rejected, or the underlying bundle is unavailable.

Never replace `pending` or `unavailable` with local deterministic prose. The
Forecast tab remains the authoritative fallback product surface. While visible,
the UI polls a pending report every three seconds for the first 20 requests,
then every 30 seconds through a hard 40-minute wall-clock bound. Reaching that
bound keeps the honest pending presentation and exposes **Check again**; it does
not rewrite an active job as unavailable or poll forever in the background.

Inspect only bounded ledger metadata, not stored prompts or snapshots:

```bash
pnpm wrangler -- d1 execute DB --remote --command \
  "select status, count(*) as jobs from narrative_jobs group by status order by status"
pnpm wrangler -- d1 execute DB --remote --command \
  "select entity_id, local_date, status, enqueue_attempts, deadline_at, last_reason_code, updated_at from narrative_jobs order by updated_at desc limit 30"
```

Then check the runner without printing credentials or job payloads:

```bash
export NARRATIVE_EXPECTED_RELEASE_SHA="$(git rev-parse HEAD)"
pnpm --filter @surf/narrative-runner config:check
pnpm --filter @surf/narrative-runner status
```

The Worker inserts the ledger before Queue send. A send failure or expired
enqueue lease remains recoverable: the scheduled path claims it with a lease
token and resends the authoritative stored envelope. Queue and result delivery
are at least once. Stable generation identity deduplicates unchanged exact
facts, while each bounded rearm gets a new submission ID; delayed generated or
terminal callbacks from an older attempt cannot mutate the active attempt.
Generated output is published only while job ID, active submission ID,
deadline, and current exact fact fingerprint all match.

If unpublished exact facts move A-to-B-to-A, the superseded A ledger row is
reactivated with a fresh submission ID while retaining its accumulated
three-send ceiling. Delayed A or B callbacks cannot mutate that active attempt,
and an A row that exhausted its ceiling cannot supersede the still-active B
row.

A successfully enqueued row that stays pending for 12 hours is also reissued
before the deliberately conservative 24-hour Queue retention floor. Delivery reissues keep the
same job/submission identity, use a lease-token CAS, and stop after three sends
per active submission. A delayed original and replacement can both infer, but only one revision
publishes; the other result is duplicate. When the final delivery has itself
aged through 24 hours, reconciliation records
`queue_delivery_attempts_exhausted` instead of claiming work still exists.
If a later materialization renews the same exact facts and deadline, the one
bounded inference rearm gets a fresh submission ID and its own three-send
delivery budget; callbacks from the exhausted submission then fail the active
submission CAS.
Reconciliation is capped at 15 jobs: two base D1 statements plus at most three
per job is 47, leaving ample headroom below
[D1 Paid's 1,000-query invocation limit](https://developers.cloudflare.com/d1/platform/limits/).

Runner inference and callback network/429/5xx failures receive one short local
retry inside the same lease only when the remaining job deadline and cumulative
visibility budgets fit. A second failure requests Queue retry, which the
reference zero-retry consumer sends to DLQ before bounded D1-ledger reissue.
Malformed generated output is ACKed as an identifiable nonterminal local
failure so the already-accepted delayed fallback remains eligible. Persistent
request/config/auth failures halt intake and retry the lease instead of spending
fallback quota. Expired or deadline-starved jobs are reported as terminal when identity is trustworthy.
An undecodable message cannot supply a trustworthy callback identity, so it is
ACKed locally and the cloud deadline reconciler expires its ledger row. Inspect
the instance narrative DLQ, runner status error code, D1 reason code, and oMLX
health before a deliberate one-shot retry. Logs contain identifiers and bounded
reason codes, never tokens, full prompts, snapshots, or model payloads.

### Narrative rollback quiescence

For rollout/quiescence, follow [local narrative runner](narrative-runner.md).
Install both production LaunchAgents only from a detached, clean release
worktree whose `HEAD` equals the recorded merged SHA after a frozen install.
Render both plists by executing that release's renderer, then use its supported
installer/controller to place byte-attested mode-0600 copies in the current
user's `~/Library/LaunchAgents`. The automatic runner guard reconstructs its
environment only from the activation-record-bound runner file. Retain the
prior release directory, activation record, and rendered plists as the
rollback target. A
mutable developer checkout is not a production service path.
Stop new production by deploying `NARRATIVE_ENABLED=false`, then boot out the
runner LaunchAgent. Because `launchctl bootout` is asynchronous, use the
runner guide's fail-closed bounded poll through `ExitTimeOut` rather than a
single immediate `launchctl print`. Prove its graceful drain completed
(`state: "stopped"`, dead PID, and unloaded launchd label) before removing the HTTP pull consumer.
Record that the local-primary Queue has no leased/retrying work; preserve and
record any available backlog and DLQ rather than pulling or deleting it. Keep
the disabled current Worker active for at least the fallback delay and prove
the fallback Queue has zero available, delayed, leased, and retrying messages
before activating a payload-incompatible predecessor. Revoke result or Queue
credentials only after these proofs. Do not delete Queue/DLQ or D1 ledger rows
as recovery.

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

Narrative jobs and revisions keep a seven-day terminal/report history. The ingest
retention pass deletes old `narrative_revisions` first, then deletes their
unreferenced terminal `narrative_jobs`, preserving foreign-key order. It never
deletes current/future local dates, and active pending/enqueue work is preserved
until its deadline; an old active row is eligible only after both its deadline
and retention cutoff have passed. The owner of this constant is
`NARRATIVE_RETENTION_DAYS` in `apps/web/worker/ingest/retention.ts`.

The current 11-spot, five-date planning envelope is 55 exact-fact generations
per materially changed forecast issue; identical hourly materializations
deduplicate rather than enqueueing another 55. The
[Workers Paid Queue inclusion](https://developers.cloudflare.com/queues/platform/pricing/)
is 1,000,000 account-wide operations/month. Cloudflare bills reads, writes, and
deletes per decimal 64,000-byte chunk and adds roughly 100 bytes of message
metadata, so the shared application envelope is capped at 60,000 serialized
bytes to remain one chunk.

The current ingest topology adds 26 small messages/hour, or 1,872 operations
per day. Its 11 hourly Analysis signals are advisory and ACK even after a
recorded signaling failure; raw malformed or version-skewed Analysis envelopes
also ACK without redelivery, and an equal-generation materialization skip does
not emit a second signal. The other 15 messages retain three source-ingest
retries, but a degraded source batch ACKs after its complete usable
materialization child set is accepted; the next hourly root retries providers
without multiplying those children. The envelope reserves another 1,080
reads/day plus 720 ingest-DLQ write/retention deletes for failures before a
complete child handoff. The earliest
recommendation-bearing local date refreshes hourly, while four later dates
refresh on a three-hour spot-local cadence: at most 616 initial narrative
sends/day. Hourly reconciliation admits at most another 360 stale-ledger
reissues. The local-primary consumer allows zero Queue-level delivery
retries and relies on bounded D1-ledger reissue for recovery. If every first
delivery transfers to the DLQ, its source write/read/delete, DLQ write, and
eventual retention delete cost five operations, or 4,880 across all 976
initial and reconciliation sends. Every job also writes, delivers, and deletes
one delayed cloud watchdog, reserving another 2,928 operations/day even though
most watchdogs observe a published primary and make no Gemini call. A transient
fact read before the paid claim may enqueue exactly one replacement watchdog;
reserving that failure for every job adds another 2,928 operations/day. The
local callback can also enqueue one immediate `fallback_requested` watchdog
when its output fails the cloud validator; reserving that path for every job
adds another 2,928 operations/day. The
two-minute idle cap conservatively reserves 1,008 empty reads/day across hourly
backoff resets and fastest jitter. The configured worst-case envelope is
therefore 1,872 + 1,080 + 720 + 4,880 + 2,928 + 2,928 + 2,928 + 1,008 = 18,344
operations/day, or 568,664 in a 31-day month. That is 56.9% of the included
1,000,000 operations; ordinary successful delivery is materially lower.

The Gemini claim caps intentionally provide partial host-outage coverage, not
a cloud copy of all 55 spot-dates. Earliest recommendation dates become
eligible first, future dates are tiered five minutes apart, and a stable
spot/date offset rotates which current spots can reach the global four-call
rolling-day cap first instead of preserving catalog order.

Treat 700,000 projected month-end operations as an early warning and review the
measured breakdown. Stop new narrative admission before the projection reaches
900,000. Do not add retries, lower polling further, drain a DLQ, or admit
another region/domain unless a new combined projection remains below the
included allowance with this reserve. Per-domain Queues and runner processes
isolate credentials and failures, not the account quota. If the projection
cannot remain below the chosen admission stop, deploy
`NARRATIVE_ENABLED=false`, boot out the runner LaunchAgent, prove its active
lease drained and process stopped, then remove its HTTP consumer so empty pulls
cease; deterministic Forecast remains available. Do not manually
drain the DLQ as a quota workaround because that adds billed reads/deletes.

At the observed complete-generation storage size of about 12.3 KB, the
cadence-capped 616-generation/day envelope retains about 53 MB of row payload
over seven days. A 50% reserve for indexes and SQLite overhead models about
80 MB, roughly 1.6% of D1 Paid's 5 GB database before core forecast data.
Alert at 500 MB of narrative storage or 4 GB total D1 size and shorten the
horizon or reduce admission before either threshold grows. The cutoff-leading
`narrative_revisions(published_at, local_date)` and
`narrative_jobs(updated_at, local_date, status, deadline_at)` indexes keep the
hourly FK-ordered retention pass from full-scanning the ledgers; monitor rows
read as well as rows deleted.

Before adding ski, another surf region, or MTB, measure serialized job chunks,
Queue operations/depth/retries/DLQ rate, terminal job rate, average stored
job/snapshot bytes, revision bytes, rejection/expiry rate, and the seven-day D1
total. Change the horizon only with a capacity estimate, fresh-D1 retention
tests, and the same backup/rollback discipline as other data retention changes.
Do not place another domain's ledger in the Surf D1 database without its own
explicit capacity decision; separate Queues alone do not isolate D1 storage.

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
`SURF_INGEST_TOKEN`, set `SURF_BASE_URL` to the bare HTTPS production origin,
then use the supported `pnpm deploy` path. Deployment first proves the
predecessor is one version at 100% and reconciles configured Queues. Wrangler
prechecks those Queues before `versions upload`, so Queue creation is the one
allowed mutation before account capability is proven. Deployment then stages
the exact target, parses Wrangler's `Worker Version ID`, and reads that inactive
version back to require Standard plus `limits.cpu_ms = 2000`. Only then does it
apply D1 migrations/seed. Immediately before activation it proves the original
predecessor remains the sole 100% version, refusing to overwrite a concurrent
deployment. It activates the target ID at 100% with `wrangler versions deploy`,
synchronizes workers.dev, cron, and Queue-consumer triggers, proves the version
is reachable with an exact override, and then requires
three consecutive cache-busted, unpinned version-matched health responses
before requiring the active deployment JSON to contain exactly that one version
at 100%. It samples bounded fresh affinity sessions; a session freezes one key
only after an exact-target valid catalog, then uses that key for one unpinned
unauthenticated PATCH probe and at most one authenticated PATCH. Read-only skew
or failure before exact-target identity rotates the whole session; a defect
after target identity fails fast. A typed stale-version 409 proves that
invocation did not mutate and may start a fresh session inside the
60-session/three-authenticated-attempt/60-second bounds; any accepted or
ambiguous outcome cannot repeat. It waits for every
unpinned read model from the one accepted lineage to publish; any response from
a non-target or unidentified Worker remains pending before its status/body is
interpreted. It then runs an
unpinned, exact-version strict cloud smoke. Transient identity skew restarts
the entire ordinary-routing smoke within its two-minute bound; only one full
all-target round passes, and `versionConvergenceRounds` records recovery when
more than one round was needed. It then
rechecks the one-version/100% control-plane state. A callable 0%-traffic version
therefore cannot cross the initial gate. These control-plane reads are strong
before/immediately-before/after checkpoints, not an atomic deployment lock: a
concurrent split can begin between them. The Worker UUID precondition is the
mutation-safety boundary—it guarantees the PATCH can enqueue only on the
expected version—and the final checkpoint detects a split that remains after
smoke.

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

Wrangler creates a version deployment before patching non-versioned
observability settings, so `versions deploy` can exit nonzero after the target
is already active. On any activation-command error, automation immediately
reads deployment status. It continues trigger synchronization and readiness
only if the staged target is the sole version at 100%, emitting an explicit
active/fix-forward event. Any different, split, or unreadable status is treated
as ambiguous activation: enqueue is stopped and the operator must inspect the
deployment before retrying or rolling back.

Wrangler's staged upload may leave an inactive, callable preview version when a
later D1, predecessor-recheck, or activation step fails. It receives no
ordinary production traffic and must not be mistaken for an active rollback
boundary. Diagnose and
retry the supported deploy; do not activate the orphan manually. A failure
after `versions deploy` is different: the new Worker is active even if trigger
synchronization or later verification fails, so fix forward under the Queue
safety rules below.

The version-1 `source-batch` and `analysis-signal` payloads are intentionally
distinct and are not understood by their predecessors. Before rolling back
across either boundary, first deploy `NARRATIVE_ENABLED=false`, then pause cron
and manual ingest, pause Queue delivery, wait for every root, source-batch,
materialization, and Analysis-signal job to settle, and prove the ingest Queue
has no available, delayed, leased, or retrying messages. Inspect the ingest DLQ
as well; do not replay a `source-batch` or `analysis-signal` message into the
predecessor. No D1 schema migration is coupled to these Queue payloads, so
rollback leaves D1 and R2 data intact once Queue quiescence is established.
With `NARRATIVE_ENABLED=false`, the public read path still serves an exact
published revision but reports every non-published ledger row unavailable; it
never promises that stopped work is still being prepared.

Narrative rollback has an additional out-of-band intake boundary. After the
disabled deploy, boot out and use the runner guide's bounded fail-closed poll
to gracefully drain the local runner **before**
removing its HTTP pull consumer; otherwise the process continues polling and
can publish callbacks while the feature flag is false. Prove the stopped
heartbeat/dead PID/unloaded label, no leased or retrying primary work, and a
fully drained delayed fallback Queue before activating a predecessor. Preserve
available primary messages, the DLQ, fallback ledger, and additive migration
0005 for recovery.

If a later problem is found while the schema remains backward compatible, use
Wrangler's version rollback:

```bash
pnpm wrangler -- versions list
pnpm wrangler -- rollback
```

Do not roll Worker code behind an incompatible schema. For a risky migration,
the pull request and release notes must name a forward-fix or recovery-database
plan before deployment.

Historical compatibility boundary: `ForecastBriefAgent`, its Durable Object
binding, and migration 0002 were declared by an earlier architecture, so the
export remains present and a rollback target must stay post-class. The active
ingest path does not signal it and `FORECAST_BRIEF_ENABLED` stays false. Do not
enable, remove, or tombstone that dormant compatibility surface during routine
Analysis rollout or rollback.

If ingest must be stopped during recovery, pause Queue delivery and remove the
cron trigger, wait for in-flight work to finish, and confirm `source_runs` has
stopped advancing. Resume both only after the recovered Worker passes a smoke
test.

## Removing an instance

Export any data you want to keep, then delete the Worker and each D1, R2,
and Queue resource from your own Cloudflare account. Deletion is intentionally
not automated by this repository because it is destructive and not reversible.
