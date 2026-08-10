# Local narrative runner

The narrative runner is a domain-neutral, always-on consumer for optional
model-authored explanations. It short-polls Cloudflare Queue only when local
inference capacity is free, calls an OpenAI-compatible oMLX server, posts the
structured result to the job's logical runtime target, and explicitly ACKs or
retries the Queue lease. Forecast numbers, rankings, confidence, and safety
caveats remain deterministic Worker code.

The default deployment is one process at concurrency 1 on the always-on Mac.
The same package and environment contract can later move to a Mac Studio or run
on several homelab workers. Cloudflare Queue delivery is at least once, so the
cloud result endpoint remains the idempotency authority.

This guide describes operator actions. Repository implementation did not
create a Queue, set a secret, install a LaunchAgent, start oMLX, or mutate a
remote Cloudflare resource.

## Runtime boundary

The runner receives a versioned job containing messages, a JSON Schema,
deadline, model capability, and a logical `result.target`. A job cannot supply
a callback URL or credential. The ignored local environment maps each logical
target to an operator-owned HTTPS URL and to the name of a separate token
variable:

```text
Cloudflare Queue -> narrative-runner -> local oMLX /v1/chat/completions
                         |
                         +-> runtime target map -> protected result endpoint
```

`surf.analysis.v3` is the current Surf target. Ski, MTB, and other domains use
the same transport and runner code with their own logical target entries.

## Prerequisites

- Node.js 24 and pnpm 11, matching the repository.
- A running [oMLX OpenAI-compatible server](https://github.com/jundot/omlx)
  whose `GET /v1/models` response contains the configured exact model ID.
- A pre-existing Cloudflare Queue configured for HTTP pull consumers. The
  scoped API token needs Queue read and write access because pull, ACK, and
  retry all mutate message leases. See Cloudflare's
  [pull-consumer guide](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
  and [Queue message API](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/pull/).
- One callback bearer token per protected result origin. Keep it distinct from
  the Cloudflare Queue API token.

### Remote setup is a stop-and-ask operation

The tracked `NARRATIVE_QUEUE` producer binding only lets the Worker send to the
named Queue. It does **not** enable HTTP pull delivery. Current Wrangler does
not support a config-file `type = "http_pull"` consumer; the operator registers
that consumer out of band.

The following steps mutate remote Cloudflare state. Do not run them from an
agent session without explicit operator authorization, a current D1 backup or
Time Travel bookmark, the exact instance Queue names, and the rollback command
recorded first. The authorized `pnpm setup:cloudflare` and `pnpm deploy`
workflows already call `ensureQueues()`: they inspect every Queue named by the
active instance config and create only missing resources, including
`surf-narrative` and `surf-narrative-dlq` for the canonical instance. Do not
duplicate those create calls in the normal operator path.

Manual alternative only when the operator intentionally does not use either
project workflow: inspect first, then create only names absent from the JSON
result. This read-before-create sequence is the idempotency boundary:

```bash
pnpm wrangler -- queues list --json
# Run either create only when that exact instance-scoped name is absent.
pnpm wrangler -- queues create surf-narrative
pnpm wrangler -- queues create surf-narrative-dlq
```

Do not run those two create commands unconditionally, and substitute the exact
active instance names before any authorized remote change.

From the JSON list output, copy the `queue_id` belonging to that exact
instance-scoped narrative Queue into `NARRATIVE_RUNNER_CF_QUEUE_ID`; do not use
the display name or the ingest/DLQ ID.

After that authorized workflow has provisioned the Queue and DLQ, HTTP pull
registration and the callback secret remain explicit operator steps:

```bash
pnpm wrangler -- queues consumer http add surf-narrative \
  --message-retries 0 \
  --dead-letter-queue surf-narrative-dlq \
  --retry-delay-secs 30 \
  --visibility-timeout-secs 900
pnpm wrangler -- secret put NARRATIVE_RESULT_TOKEN
```

The checked Free-plan capacity invariant locks `--message-retries 0`; current
Wrangler forwards that numeric value as the HTTP consumer's `max_retries`.
The runner first makes one short in-process retry inside the same lease when
deadline and cumulative visibility budgets still fit. Cloud D1 ledger
reconciliation, not Queue redelivery, is the later bounded retry layer for an
unobserved or ambiguous narrative send.

Wrangler secret entry uses its hidden prompt. An instance renamed from `surf`
uses `<instance>-narrative` and `<instance>-narrative-dlq`; never aim the
runner at the reference names by assumption. Only after the Queue, DLQ, HTTP
pull consumer, callback secret, runner target map, and rollback checkpoint all
exist should an ignored instance config enable `NARRATIVE_ENABLED` and follow
the repository's authorized deploy workflow.

The named rollback first deploys `NARRATIVE_ENABLED=false` through the normal
version/readiness path so no new jobs are admitted. Let the active lease
settle, then stop pulls without deleting queued work:

```bash
pnpm wrangler -- queues consumer http remove surf-narrative
```

Do not delete the Queue, DLQ, or D1 rows as rollback. Record their pre-change
state and exact instance names before any remote mutation.

Run oMLX on loopback when it shares the Mac with the runner. The configuration
rejects plaintext HTTP to a non-loopback host. If a future runner and model
server are on different hosts, put the model endpoint behind authenticated
HTTPS rather than exposing an unauthenticated LAN listener.

## Configure without committing secrets

From the repository root:

```bash
cp apps/narrative-runner/.env.example apps/narrative-runner/.env
chmod 600 apps/narrative-runner/.env
```

Fill the ignored file. Keep the target map free of secret values:

```dotenv
NARRATIVE_RUNNER_TARGET_MAP_JSON={"surf.analysis.v3":{"url":"https://your-worker.example/api/internal/narratives/results","tokenEnv":"SURF_NARRATIVE_RESULT_TOKEN"}}
SURF_NARRATIVE_RESULT_TOKEN=<stored-only-in-this-ignored-file>
```

The Queue token belongs only in `NARRATIVE_RUNNER_CF_API_TOKEN`. Do not put a
token in the JSON target map, tracked plist, shell history, issue, test fixture,
or job payload. Logs contain bounded event codes and identifiers, never prompt
text, outputs, provider response bodies, URLs, or bearer values.

Important timing relationships:

- `NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS` covers the maximum inference and
  result timeout, Queue settlement timeout, and at least five seconds. This
  cumulative bound keeps a worst-case ACK inside its lease.
- `NARRATIVE_RUNNER_QUEUE_TIMEOUT_MS` independently bounds pull, ACK, and retry
  HTTP requests.
- Before inference the runner reserves the entire result timeout plus five
  seconds. It rejects an unsafe deadline budget and caps inference to the
  remaining safe window.
- Empty short polls use jittered exponential backoff up to the ten-minute
  `NARRATIVE_RUNNER_IDLE_MAX_MS`; work resets that idle backoff. Empty pulls
  are billed Queue reads, so reducing this default needs a new account-wide
  operation budget. That cap trades up to ten minutes of cold-idle pickup
  latency for Free-plan headroom; operators needing lower latency must fund it
  in the combined Queue projection.
- In-flight work writes a periodic heartbeat, so a valid long local inference
  is not mistaken for a dead runner.

## Commands and expected effects

```bash
pnpm --filter @surf/narrative-runner config:check
pnpm --filter @surf/narrative-runner status
pnpm --filter @surf/narrative-runner once
pnpm --filter @surf/narrative-runner run run
```

- `config:check` validates that required settings and named secret values are
  present and well-formed, then preflights `GET /v1/models`. It does not contact
  Cloudflare Queue or the result callback, so it does not prove either token is
  authorized.
- `status` repeats model preflight and reads the local atomic heartbeat. It
  exits nonzero for a missing, stale, starting, backing-off, halted, stopped,
  error-bearing, or dead local process, or when the configured model is
  unavailable. Only fresh error-free `idle` and `processing` states are
  healthy. Freshness includes the maximum idle backoff interval.
- `once` preflights, makes at most one capacity-bounded short pull, processes
  that batch, and exits. It can ACK or retry real Queue messages.
- `run run` invokes the package's `run` script and stays active until `SIGINT`
  or `SIGTERM`, then stops pulling and drains
  work already in flight before writing `stopped` status.

Use `config:check` first. Run `once` only when consuming work from the named
Queue is intended. The default concurrency is 1; raise it only after the model
server has measured free capacity and result submission remains comfortably
inside the lease and job deadlines.

## Delivery and recovery behavior

| Condition | Queue action | Intake behavior |
| --- | --- | --- |
| Published, duplicate, rejected, expired, or superseded 200 result | ACK | Continue |
| Malformed/oversized job or unsupported `CF-Content-Type` | ACK | Continue; cloud deadline reconciliation closes any identifiable stale ledger row |
| Expired/unsafe-deadline job or terminal local inference error | Terminal callback (one bounded same-lease retry if transient), then ACK | Continue only after cloud records the terminal disposition |
| Result network, 429, or 5xx | One short same-lease retry; if it fails again, request Queue retry/DLQ | Open a bounded intake circuit only after the local retry is exhausted |
| Result 401/403, terminal 4xx, mismatched identity, or invalid 200 schema | Retry with exponential lease delay | Persistently halt intake; operator fixes configuration/contract and restarts the process |
| oMLX `/models` or chat 401/403 | No pull, or retry the already leased message | Persistently halt intake without reporting the narrative terminal; operator fixes model authentication and restarts explicitly |
| oMLX network, transient HTTP, or malformed/oversized successful response | One short same-lease retry; if it fails again, request Queue retry/DLQ | Invalidate cached readiness, open intake circuit, and require a new model preflight only after local exhaustion |
| Queue settlement network, 429, or 5xx | Leave lease unsettled | Open a bounded intake circuit; do not immediately pull more work |
| Queue settlement 401/403 or other terminal 4xx | Leave lease unsettled | Persistently halt intake; never churn past an unrecorded ACK/retry |
| Queue pull 401/403 | No lease acquired | Persistently halt intake; operator fixes the Queue credential and restarts explicitly |
| Queue pull network, 429, or 5xx | No lease acquired | Back off before the next pull |

Cloudflare's HTTP pull API sends JSON and byte message bodies as RFC 4648
base64 and identifies the encoding in `metadata["CF-Content-Type"]`. The
runner decodes that field before validating the shared schema and 60,000-byte
serialized-size limit. It settles messages with `lease_id`, never message ID.
Successful pull, settlement, result, model-list, and completion response bodies
are byte-bounded before JSON parsing. A pull returning more messages than the
requested batch is rejected, and oversized encoded jobs are rejected before
base64 decoding. A settlement counts only when Cloudflare reports exactly one
intended ACK or retry and no lease warning; a generic `success: true` cannot
hide an unsettled message.
Decoded terminal work with a known runtime target is reported through the same
protected result endpoint before Queue ACK. Undecodable work has no trustworthy
job/submission identity, and an unknown logical target has no trusted callback
route; the former is ACKed locally, while the latter is retried. The Worker's
scheduled reconciliation also reissues an authoritative `pending` envelope
after 12 hours, before the Free-plan 24-hour Queue retention can remove an
unpulled message. It keeps the same job and submission IDs, makes at most three
Queue sends per active submission, and expires an exhausted delivery only
after the final 24-hour
retention window or the earlier inference deadline. A delayed original and its
replacement therefore converge through the same cloud publication CAS. An
exhausted delivery may use the existing single bounded fresh-submission rearm
when a later materialization renews the same facts and deadline; its
per-submission send counter restarts without accepting callbacks from the old
submission. If unpublished facts move A-to-B-to-A, the superseded A generation
reactivates with a fresh submission ID but keeps its accumulated three-send
ceiling; an exhausted A cannot supersede the still-active B generation. An
unknown target also persistently halts intake until the operator fixes the
runtime map and restarts the process.

A persistent halt keeps the process alive and its heartbeat in the unhealthy
`halted` state; it does not exit into a LaunchAgent restart loop. Inspect the
bounded `lastErrorCode`, correct the Queue credential, model credential, target
credential, URL, or callback contract, stop the process cleanly, and restart
it explicitly.
`config:check` can re-prove local shape and model availability. `once` proves
Queue authentication only when it actually pulls; it proves the callback only
when a real job exists. End-to-end production acceptance therefore requires an
authorized enabled deploy, one fresh ingest/job, runner consumption, and the
matching published API/ledger revision.

## Capacity and retention

The NorCal reference horizon can represent 11 spots across five local dates,
or up to 55 spot-date candidates. That is the planning envelope, not a promise
of 55 new model calls every cycle: stable exact-fact generation identity
deduplicates unchanged output-visible work before delivery. Surf's Cloud D1
keeps the idempotent ledger and revisions for seven days, pruning revisions
before their parent jobs so foreign keys remain valid. At the observed planning
size of about 12.3 KB per complete generation, the cadence-capped
616-generation/day envelope is about 53 MB of row payload over seven days.
Reserving another 50% for indexes and SQLite overhead models about 80 MB,
roughly 16% of a 500 MB
Free database before core forecast storage. Alert when narrative storage
reaches 175 MB or the whole D1 database reaches 250 MB; shorten retention or
reduce admission before either threshold grows. An additional domain must use
its own capacity model and should not silently share the Surf D1 database.

Cloudflare [Queues Free pricing](https://developers.cloudflare.com/queues/platform/pricing/)
allows 10,000 operations per day for the account. Writes, reads, and deletes
are billed in decimal 64,000-byte chunks, and Cloudflare message metadata adds
roughly 100 bytes. The shared application envelope is therefore capped at
60,000 serialized bytes so every narrative job remains one billing chunk.

Admission is account-wide, not narrative-only. The current hourly topology is
26 small ingest messages (one root, three source batches, 11 materializations,
and 11 Analysis signals), or 1,872 write/read/delete operations per day. The
11 advisory Analysis signals always ACK after recording a failure, including a
malformed or version-skewed envelope recognized at the raw Queue boundary; the next
generation and hourly ledger reconciliation recover work without consuming
the ingest consumer's retry/DLQ budget, and an equal-generation materialization
skip does not emit another signal. The other 15 ingest messages retain the
configured three retries for source reliability, but a degraded source batch
ACKs after its complete usable child set is accepted; provider refresh waits
for the next hourly root instead of multiplying materialization children on
Queue redelivery. If every retryable message instead exhausts before a
complete child handoff, the account reserves 1,080 extra reads plus 720
ingest-DLQ write/retention-delete operations.

Narrative admission is deliberately slower than deterministic forecast
publication. Each spot's earliest recommendation-bearing date refreshes
hourly; its four later dates refresh on a three-hour spot-local cadence. That
caps initial Surf narrative sends at 616/day. The reconciler may reissue at
most 15 stale ledger jobs/hour, another 360/day. The Free reference config allows
no Queue-level delivery retry and relies on the cloud ledger's bounded reissue
for recovery. If every first delivery instead transfers to the DLQ, the source
write/read/delete plus DLQ write and eventual retention delete cost five
operations per send: 4,880 for all 976 admitted initial and reconciliation
sends. A ten-minute idle cap is about 144 empty
reads/day at steady state; the checked invariant conservatively resets the
jittered backoff hourly and reserves 336. The configured account envelope is
therefore 1,872 + 1,080 + 720 + 4,880 + 336 = 8,888 operations/day, below
10,000 with 1,112 operations of headroom.

Treat 8,000 projected or observed account operations as an early warning that
requires an operator capacity review. Stop new narrative admission before the
projected end-of-day total reaches 9,500. Do not add HTTP message retries,
lower the idle cap, admit another region/domain, manually drain the DLQ, or add
another Queue on Free unless a new measured combined projection stays below
10,000. The hourly cloud reconciler processes
at most 15 jobs, a maximum of 47 D1 statements including its expiry/list base
queries, below [D1 Free's 50-query invocation limit](https://developers.cloudflare.com/d1/platform/limits/).
Separate Queues and runner
processes isolate Surf, ski, MTB, and other failure domains, but they do not
multiply the account-wide Free operation allowance.

If the projection can no longer remain below 10,000, stop admission before the
limit: deploy `NARRATIVE_ENABLED=false`, let the active lease settle, then stop
the runner so empty pulls cease. Forecast publication remains available. Do
not compensate by manually draining the DLQ, which adds billed operations.

Start the always-on Mac at concurrency 1. Compare observed job arrival rate,
oMLX latency, deadline expirations, and Queue depth before raising capacity.
Long inference does not stall deterministic forecast publication; work that
cannot finish with a protected result-submission window is recorded terminal
or expires through cloud reconciliation. A later Mac Studio can add measured
concurrency or additional pull processes without adding Surf-specific runner
branches.

The current local acceptance baseline is Qwen3.5-27B-8bit on oMLX: at
concurrency 1 it passed the production-shaped JSON Schema and downstream
validator in about 12 seconds. That is evidence, not a required default. The
model ID stays runtime-configurable, and every operator must preflight the
exact ID exposed by their own `/v1/models` endpoint.

A single process intentionally stops all intake when any configured callback
trust boundary has a persistent credential or contract failure. If Surf, ski,
MTB, or another target must fail independently, give each trust/failure domain
its own Queue and runner process with a separate environment and status file.
The binary and narrative contract stay domain-neutral; isolation belongs in
Queue, credential, and process topology rather than domain branches in runner
code. Apply the account-wide admission estimate above before provisioning any
additional domain Queue.

## LaunchAgent example

The tracked
[`ai.alex.narrative-runner.plist.example`](../apps/narrative-runner/examples/ai.alex.narrative-runner.plist.example)
contains no secrets and is not installed. Copy it outside the repository,
replace every placeholder with an absolute path, and validate the rendered
file with `plutil -lint` before an operator loads it. `PNPM_ABSOLUTE_PATH`
should be the stable Corepack/pnpm executable returned by `command -v pnpm` in
the intended Node 24 environment. Also run `command -v node` and set
`NODE_BIN_ABSOLUTE_DIRECTORY` to that executable's containing directory. This
explicit non-secret `PATH` is required because Corepack/NVM pnpm shims commonly
use `/usr/bin/env node`, while launchd starts with a minimal environment. A
version-manager path can change during an upgrade, so repeat both checks after
Node changes.

The process reads secrets from `apps/narrative-runner/.env`, not from the
plist. Keep that file mode `0600`, keep the log directory private, and configure
log rotation outside the repository. Create the absolute log directory and set
it mode `0700` before bootstrap; launchd does not create parent directories for
`StandardOutPath` or `StandardErrorPath`. The example uses `RunAtLoad`, restarts
only after an unsuccessful exit, and lets the runner handle `SIGTERM` drain.

Do not have two LaunchAgents with the same label. Before activation, record the
old plist path and checkout revision as the rollback path. After activation,
run `status`, verify a fresh heartbeat and exact model ID, then inspect only
secret-safe event codes in the log.

## MacBook to Mac Studio migration

1. Leave the current MacBook runner operating while preparing a clean checkout
   and matching Node/pnpm versions on the Studio.
2. Install and preflight oMLX on the Studio. Copy model weights through the
   model server's documented mechanism; no model or cache belongs in this
   repository.
3. Create a new ignored `.env` from the example. Transfer tokens through the
   password manager or another approved secret channel rather than copying
   shell history or the tracked plist. Give the Studio a distinct runner ID.
4. Run `config:check` on the Studio. This proves model/config readiness without
   touching the Queue.
5. Stop the MacBook process with `SIGTERM` and wait for its status/log to show
   that in-flight work drained. Unacknowledged leases remain recoverable.
6. Activate the rendered Studio LaunchAgent, then require `status` to pass and
   observe a bounded Queue/result cycle.
7. Keep the stopped MacBook checkout, ignored config, and plist available for
   the initial rollback window. Rollback is to stop/drain the Studio and
   reactivate the MacBook; never delete the Queue or D1 rows to recover.

For later horizontal scale, give every host a distinct runner ID and its own
runtime secrets, keep the same logical target IDs, and set per-host concurrency
from measured oMLX capacity. Multiple pull consumers are supported; duplicate
delivery remains safe only because submission IDs and cloud publication are
idempotent.
