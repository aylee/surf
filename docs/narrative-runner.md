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
local-primary Queue -> narrative-runner -> local oMLX /v1/chat/completions
                              |
                              +-> runtime target map -> protected result endpoint

delayed watchdog Queue -> Worker -> bounded Gemini fallback -> same validator/CAS
```

`surf.analysis.v5` is the current Surf target. Ski, MTB, and other domains use
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
`surf-narrative`, `surf-narrative-dlq`, and `surf-narrative-fallback` for the
canonical instance. Do not
duplicate those create calls in the normal operator path.

Manual alternative only when the operator intentionally does not use either
project workflow: inspect first, then create only names absent from the JSON
result. This read-before-create sequence is the idempotency boundary:

```bash
pnpm wrangler -- queues list
# Run each create only when that exact instance-scoped name is absent.
pnpm wrangler -- queues create surf-narrative
pnpm wrangler -- queues create surf-narrative-dlq
pnpm wrangler -- queues create surf-narrative-fallback
```

Do not run these create commands unconditionally, and substitute the exact
active instance names before any authorized remote change.

Use current Wrangler's Queue-specific reads to bind the runtime ID to the
intended topology (`queues list` has no JSON flag):

```bash
pnpm wrangler -- queues info surf-narrative
pnpm wrangler -- queues consumer http list surf-narrative --json
```

Copy the `queue_id` belonging to that exact instance-scoped narrative Queue
into `NARRATIVE_RUNNER_CF_QUEUE_ID`, set
`NARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative`, and set
`NARRATIVE_RUNNER_CF_DLQ_NAME=surf-narrative-dlq`; do not use the display name
or the ingest/DLQ ID as the primary ID.

After that authorized workflow has provisioned both Queues and the local-primary
DLQ, HTTP pull registration remains an explicit operator step:

```bash
pnpm wrangler -- queues consumer http add surf-narrative \
  --batch-size 1 \
  --message-retries 0 \
  --dead-letter-queue surf-narrative-dlq \
  --retry-delay-secs 30 \
  --visibility-timeout-secs 900
```

Immediately repeat `queues info` and `queues consumer http list ... --json`.
There must be exactly one consumer and it must be `http_pull`, with no Worker
consumer, `batch_size=1`, `max_retries=0`, `visibility_timeout_ms=900000`,
`retry_delay=30`, and `dead_letter_queue=surf-narrative-dlq`. The runner's
read-only startup preflight proves the same ID/name/consumer/settings contract
before any pull or settlement call; missing or mismatched topology is a
persistent halt, not a best-effort warning.

The v5 runner is not a legacy-target drain tool. Before its first pull, require
zero `surf.analysis.v4` jobs in `enqueueing`, `enqueue_failed`, or `pending`
state and use Cloudflare Queue metrics to prove the narrative primary, DLQ, and
fallback Queues have zero available, delayed, leased, or retrying messages.
Consumer-list output alone is not backlog evidence. A nonzero result requires
the compatible predecessor to drain/settle it while v5 remains disabled.

The at-most-once paid-fallback invariant locks `--message-retries 0`; current
Wrangler forwards that numeric value as the HTTP consumer's `max_retries`.
The runner first makes one short in-process retry inside the same lease when
deadline and cumulative visibility budgets still fit. Cloud D1 ledger
reconciliation, not Queue redelivery, is the later bounded retry layer for an
unobserved or ambiguous narrative send.

An instance renamed from `surf` uses `<instance>-narrative` and
`<instance>-narrative-dlq`; put those exact values in its runner environment
instead of aiming the runner at the reference names by assumption. Only after both Queues, the DLQ,
HTTP pull consumer, callback/Gemini secrets, runner target map, and rollback checkpoint all
exist should an ignored instance config enable `NARRATIVE_ENABLED` and follow
the repository's authorized deploy workflow.

The named rollback first deploys `NARRATIVE_ENABLED=false` through the normal
version/readiness path so no new jobs are admitted. The flag does not stop an
already-running runner: it can keep HTTP-pulling and its callback can still
publish. Immediately unload the LaunchAgent so launchd cannot restart it;
`bootout` delivers `SIGTERM`, the runner stops new pulls, drains its in-flight
lease, writes `state: "stopped"`, and exits. Substitute the installed label if
the instance uses a different one:

```bash
set -euo pipefail
domain="gui/${UID}"
runner_label="ai.alex.narrative-runner"
wait_label_unloaded() {
  local label="$1" max_seconds="$2" attempt
  for ((attempt = 0; attempt < max_seconds; attempt += 1)); do
    if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not unload inside ${max_seconds}s" >&2
  return 1
}

if launchctl print "$domain/$runner_label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$runner_label"
fi
# bootout is asynchronous. The 960-second bound covers the rendered 930-second
# ExitTimeOut plus a small launchd scheduling margin.
wait_label_unloaded "$runner_label" 960

status_json="$(mktemp)"
release_path="/Users/alex/Services/surf/releases/REPLACE_WITH_ACTIVE_SHA"
record="/Users/alex/Services/surf/launch-agents/REPLACE/activation-record.json"
if node "$release_path/apps/narrative-runner/scripts/run-verified-runner.mjs" \
  --record "$record" --command status \
  > "$status_json"; then
  echo "runner unexpectedly still healthy" >&2
  exit 1
fi
jq -e '.heartbeat.state == "stopped" and (.pidAlive | not) and (.healthy | not)' \
  "$status_json"
```

Do not use a bare `kill` as the rollback control because a loaded `KeepAlive`
job can restart after an unsuccessful exit. Only after the stopped heartbeat,
dead PID, and unloaded launchd label are all proven should the operator remove
the HTTP pull consumer, which preserves unleased queued work:

```bash
pnpm wrangler -- queues consumer http remove surf-narrative
```

Record Cloudflare Queue metrics immediately before and after removal. The
local-primary Queue may retain **available** messages for recovery, but it must
show no active HTTP consumer and no leased or retrying message before a
predecessor is activated; record its available count and the DLQ count rather
than pulling either Queue to inspect it. The disabled current Worker must stay
active while its fallback consumer acknowledges already-delayed watchdogs.
Wait at least the configured watchdog delay, then use Queue metrics to prove
`surf-narrative-fallback` has zero available, delayed, leased, and retrying
messages. Only then may a predecessor that does not understand that payload be
activated. See the runtime guide's Queue-metrics boundary; `wrangler queues
list`/consumer shape does not prove backlog or lease state.

After the process is stopped and both lease proofs are recorded, result and
Queue credentials may be revoked. Do not delete either Queue, the DLQ, or D1
rows as rollback. Migration 0005 is additive; leave its revision provenance
columns and fallback-attempt ledger in place. Record their pre-change state and
exact instance names before any remote mutation.

Run oMLX on loopback when it shares the Mac with the runner. The configuration
rejects plaintext HTTP to a non-loopback host. If a future runner and model
server are on different hosts, put the model endpoint behind authenticated
HTTPS rather than exposing an unauthenticated LAN listener.

## Configure without committing secrets

For local development only, the package scripts may load the ignored package
`.env` from the repository root:

```bash
cp apps/narrative-runner/.env.example apps/narrative-runner/.env
chmod 600 apps/narrative-runner/.env
```

Fill the ignored file. Keep the target map free of secret values:

```dotenv
NARRATIVE_RUNNER_RELEASE_SHA=<exact-merged-40-character-sha>
NARRATIVE_RUNNER_STATUS_HMAC_KEY=<separate-high-entropy-secret>
NARRATIVE_RUNNER_STATUS_FILE=/Users/alex/Services/surf/state/narrative-runner-status.json
NARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative
NARRATIVE_RUNNER_CF_DLQ_NAME=surf-narrative-dlq
NARRATIVE_RUNNER_TARGET_MAP_JSON={"surf.analysis.v5":{"url":"https://your-worker.example/api/internal/narratives/results","tokenEnv":"SURF_NARRATIVE_RESULT_TOKEN"}}
SURF_NARRATIVE_RESULT_TOKEN=<stored-only-in-this-ignored-file>
```

For an enabled deployment, create a private Worker-secret source outside every
checkout from `apps/web/.worker-secrets.example`, set mode `0600`, and point
`SURF_WORKER_SECRETS_FILE` at it. Set
`SURF_WORKER_SECRETS_SNAPSHOT` to a new absolute `.json` path inside the
versioned external activation directory; the staging command creates it
exclusively and deploy passes only that snapshot to Wrangler. Point
`SURF_NARRATIVE_RUNNER_ENV_FILE` at a mode-0600, non-symlink dotenv runner
environment outside every release worktree; a JSON runner file is rejected
because the strict service guard loads dotenv syntax. Duplicate/malformed
assignments and unquoted `#` values are rejected so deployment and the service
guard see exactly the same value; quote a legitimate value containing `#`. Generate one random
result token in a password manager and paste it into
`NARRATIVE_RESULT_TOKEN` in the Worker file and
`SURF_NARRATIVE_RESULT_TOKEN` in the runner file; do not place it in a command
argument, stdout, clipboard log, or shell history. The staged deploy validates
the two values with a timing-safe comparison, verifies both files are
non-symlink mode-0600 files, requires the current Surf target to use that exact
token environment and the production `SURF_BASE_URL` callback path, matches
the runner's Queue and DLQ names to the active Wrangler instance, confirms the
Queue token is distinct, creates an HMAC receipt without logging secret bytes,
and passes the private activation snapshot to `wrangler versions upload
--secrets-file`. It rechecks that snapshot and the runner environment before
every Wrangler command. This attaches
both `NARRATIVE_RESULT_TOKEN` and `GEMINI_API_KEY` to the exact staged version
without a separate `wrangler secret put` deployment.

The heartbeat stores the exact release SHA and an HMAC of the effective Queue,
model, target URLs, operational settings, and credential values—not the
credentials themselves. `status` recomputes that fingerprint from the current
external file and refuses to call an old-release or old-secret daemon healthy.
Use a distinct high-entropy HMAC key, rotate/version the external env file with
every credential change, and boot out/bootstrap the service; editing a loaded
environment file in place never updates the daemon.
An enabled Worker deploy must run from that same clean detached worktree; the
deploy boundary derives checkout `HEAD`, rejects a branch or dirty tree, and
requires it to equal `NARRATIVE_RUNNER_RELEASE_SHA`. This prevents a Worker
contract from SHA A being activated with a runner binary/environment from SHA
B.

The Queue token belongs only in `NARRATIVE_RUNNER_CF_API_TOKEN`. Do not put a
token in the JSON target map, tracked plist, shell history, issue, test fixture,
or job payload. Logs contain bounded event codes and identifiers, never prompt
text, outputs, provider response bodies, URLs, or bearer values.

Important timing relationships:

- `NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS` covers the maximum inference and
  result timeout, Queue settlement timeout, and at least five seconds. This
  cumulative bound keeps a worst-case ACK inside its lease.
- `NARRATIVE_RUNNER_QUEUE_TIMEOUT_MS` independently bounds Queue metadata,
  pull, ACK, and retry HTTP requests. Metadata must prove the exact configured
  Queue name and single HTTP-pull consumer contract before any message read.
- `NARRATIVE_RUNNER_OMLX_ENABLE_THINKING=false` sends oMLX
  `chat_template_kwargs.enable_thinking=false`. This structured template task
  should not spend hidden reasoning tokens; enabling it is an explicit model
  experiment, not the production default.
- Before inference the runner reserves the entire result timeout plus five
  seconds. It rejects an unsafe deadline budget and caps inference to the
  remaining safe window.
- Empty short polls use jittered exponential backoff up to the two-minute
  `NARRATIVE_RUNNER_IDLE_MAX_MS`; work resets that idle backoff. Empty pulls
  are billed Queue reads, so changing this default still requires a combined
  account projection. The two-minute cap keeps a healthy cold runner well ahead
  of the ten-minute cloud watchdog while remaining inside the Workers Paid
  Queue inclusion proven below. Track paid claims alongside runner pull and
  inference timestamps; a healthy host should not routinely lose this race.
- In-flight work writes a periodic heartbeat, so a valid long local inference
  is not mistaken for a dead runner.

## Commands and expected effects

Local development may use the package `.env` convenience scripts:

```bash
export NARRATIVE_EXPECTED_RELEASE_SHA="$(git rev-parse HEAD)"
pnpm --filter @surf/narrative-runner config:check
pnpm --filter @surf/narrative-runner status
pnpm --filter @surf/narrative-runner once
pnpm --filter @surf/narrative-runner run run
```

Production status, preflight, one-shot, and daemon commands must instead run
through the release-pinned guard and exact activation record. The guard verifies
the installed service and reconstructs a sanitized environment from the file
that the deploy boundary and plist renderer validated:

```bash
record="/Users/alex/Services/surf/launch-agents/REPLACE/activation-record.json"
node "$release_path/apps/narrative-runner/scripts/run-verified-runner.mjs" \
  --record "$record" --command check
node "$release_path/apps/narrative-runner/scripts/run-verified-runner.mjs" \
  --record "$record" --command status
node "$release_path/apps/narrative-runner/scripts/run-verified-runner.mjs" \
  --record "$record" --command once
```

The expected SHA remains a separate child-process argument, never another
dotenv-derived claim. The verified guard derives it from the activation record.
This prevents editing a versioned external environment after render from
making release-A code claim to be release B, and prevents a standalone
production command from bypassing the immutable checkout identity.

- `config:check` validates that required settings and named secret values are
  present and well-formed, preflights `GET /v1/models`, and performs a bounded,
  read-only Cloudflare `GET /accounts/{account}/queues/{id}`. It succeeds only
  when the ID reports the configured Queue name plus exactly one HTTP-pull
  consumer with the expected DLQ, zero redeliveries, retry delay, and lease
  visibility. It does not pull, acknowledge, or contact the result callback.
- `status` repeats Queue and model preflight and reads the local atomic heartbeat. It
  exits nonzero for a missing, stale, starting, backing-off, halted, stopped,
  error-bearing, or dead local process, or when the configured model is
  unavailable or the Queue identity/topology proof fails. Only fresh error-free `idle` and `processing` states are
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
| Expired/unsafe-deadline job | Terminal callback (one bounded same-lease retry if transient), then ACK | Continue only after cloud records the terminal disposition |
| Terminal local inference/output error | ACK primary message; leave D1 job nonterminal | Delayed cloud watchdog remains eligible without another local retry |
| Result network, 429, or 5xx | One short same-lease retry; if it fails again, request Queue retry/DLQ | Open a bounded intake circuit only after the local retry is exhausted |
| Result 401/403, terminal 4xx, mismatched identity, or invalid 200 schema | Retry with exponential lease delay | Persistently halt intake; operator fixes configuration/contract and restarts the process |
| oMLX `/models` or chat 401/403 | No pull, or retry the already leased message | Persistently halt intake without reporting the narrative terminal; operator fixes model authentication and restarts explicitly |
| Queue metadata auth, ID/name, consumer type, DLQ, retry, or visibility mismatch | No pull | Persistently halt intake; operator fixes the exact Queue binding/topology and restarts explicitly |
| oMLX network, transient HTTP, or malformed/oversized successful response | One short same-lease retry; if it fails again, request Queue retry/DLQ | Invalidate cached readiness, open intake circuit, and require a new model preflight only after local exhaustion |
| Queue settlement network, 429, or 5xx | Leave lease unsettled | Open a bounded intake circuit; do not immediately pull more work |
| Queue settlement 401/403 or other terminal 4xx | Leave lease unsettled | Persistently halt intake; never churn past an unrecorded ACK/retry |
| Queue pull 401/403 | No lease acquired | Persistently halt intake; operator fixes the Queue credential and restarts explicitly |
| Queue pull network, 429, or 5xx | No lease acquired | Back off before the next pull |

Cloudflare's HTTP pull API identifies the message type in
`metadata["CF-Content-Type"]`. A production wire probe observed `json` bodies
as plain serialized JSON, while `bytes` bodies use RFC 4648 base64. The runner
accepts that live JSON shape, retains base64-JSON compatibility for older or
alternate deliveries, and validates the decoded shared schema and 60,000-byte
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
after 12 hours, before the conservative 24-hour retention floor can remove an
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
`config:check` can re-prove local shape, model availability, Queue
authentication, and exact read-only Queue topology. `once` additionally proves
the HTTP pull endpoint only when it actually pulls; it proves the callback only
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
roughly 1.6% of the Paid plan's included 5 GB D1 storage before core forecast
storage. Alert when narrative storage reaches 500 MB or the whole D1 database
reaches 3.5 GB; shorten retention or
reduce admission before either threshold grows. An additional domain must use
its own capacity model and should not silently share the Surf D1 database.

Cloudflare [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
includes one million operations/month on Workers Paid. Writes, reads, and
deletes are billed in decimal 64,000-byte chunks, and Cloudflare message
metadata adds roughly 100 bytes. The shared application envelope remains
capped at 60,000 serialized bytes so every narrative job is one billing chunk.

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
most 15 stale ledger jobs/hour, another 360/day. The reference config allows
no Queue-level delivery retry and relies on the cloud ledger's bounded reissue
for recovery. If every first delivery instead transfers to the DLQ, the source
write/read/delete plus DLQ write and eventual retention delete cost five
operations per send: 4,880 for all 976 admitted initial and reconciliation
sends. Each admission also creates one delayed watchdog whose
write/read/delete costs three operations, at most another 2,928/day. The
two-minute local idle cap reserves 1,008 reads/day under the same conservative
jitter bound used by the executable capacity test. Normal operation plus every
delivery taking its DLQ path is therefore 12,488 operations/day. Reserving one
additional watchdog write/read/delete for a transient pre-claim fact-read
failure on every admitted job adds 2,928/day. A validator-rejected primary
callback can also enqueue one immediate `fallback_requested` watchdog; reserve
another three operations for every admitted job, or 2,928/day. The absolute
checked envelope is therefore 18,344/day or 568,664 in a 31-day month—56.9% of
the Paid one-million-operation inclusion.

Review capacity at 700,000 projected or observed monthly Queue operations and
stop new narrative admission before the projection reaches 900,000. Do not add
HTTP message retries, lower the idle cap, admit another region/domain, or
manually drain the DLQ without a new account-wide projection. The hourly cloud reconciler processes
at most 15 jobs, a maximum of 47 D1 statements including its expiry/list base
queries, below [D1 Paid's 1,000-query invocation limit](https://developers.cloudflare.com/d1/platform/limits/).
Separate Queues and runner processes isolate Surf, ski, MTB, and other failure
domains, but they share the account-wide inclusion.

The model-provider budget is independent of Queue usage. The atomic D1 claim
allows at most four Gemini attempts in a rolling 24 hours and 100 in a rolling
31-day window, with one claim per job/submission. Successful raw output is
persisted before validation/publication and replays without another provider
call. This is deliberately a partial host-outage fallback, not a cloud replica
of all 55 spot-dates. Current/earliest recommendation dates become eligible
first; later dates are tiered five minutes apart. A stable spot/date offset
rotates the first eligible spots from day to day so the global four-call cap
does not chronically favor catalog order. If the projection or model bill is unacceptable, deploy
`NARRATIVE_ENABLED=false`, boot out the runner LaunchAgent and prove its
in-flight lease drained and stopped heartbeat, then remove the HTTP consumer;
forecast publication remains available.

Start the always-on Mac at concurrency 1. Compare observed job arrival rate,
oMLX latency, deadline expirations, and Queue depth before raising capacity.
Long inference does not stall deterministic forecast publication; work that
cannot finish with a protected result-submission window is recorded terminal
or expires through cloud reconciliation. A later Mac Studio can add measured
concurrency or additional pull processes without adding Surf-specific runner
branches.

The accepted local Analysis v5 generator lane is `Qwen3.6-27B-4bit`. Its
generator-only full-corpus gate was 55/55 first-pass hard-valid, produced 18
semantic plan signatures with the dominant signature used for 8/55 cases, and
averaged about 10.05 seconds per non-streaming completion. Direct Codex review
of one rendered report for each of all 18 signatures passed; the only observed
issue was nonblocking copy repetition. The attempted local automated judges
were rejected as uncalibrated, so this evidence makes no automated quality-score
claim and their artifacts remain negative calibration evidence. A prior
thinking-on probe took roughly 105 seconds and reported 3,182 output tokens for
a tiny structured draft, which is why thinking remains disabled by default.
The model ID stays runtime-configurable, and every operator must preflight the
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

The tracked narrative-runner and oMLX-server plist templates contain no secrets
and are not installed automatically. Production must run from a dedicated,
detached release worktree at the exact merged SHA, never from
`/Users/alex/code/surf` or another mutable developer checkout. Use a new path
for every SHA; do not pull, switch, or edit an activated release:

```bash
release_sha=REPLACE_WITH_EXACT_MERGED_40_CHARACTER_SHA
release_path="/Users/alex/Services/surf/releases/${release_sha}"
activation_id="${release_sha}-r1"
launch_agents_path="/Users/alex/Services/surf/launch-agents/${activation_id}"
runner_env_path="/Users/alex/Services/surf/secrets/${activation_id}.env"
config_source="/Users/alex/Services/surf/config/wrangler.source.jsonc"
config_snapshot="$launch_agents_path/wrangler.instance.jsonc"
worker_secrets_source="/Users/alex/Services/surf/secrets/worker-secrets.source.env"
worker_secrets_snapshot="$launch_agents_path/worker-secrets.json"
model_id="REPLACE_WITH_ACCEPTED_EXACT_OMLX_MODEL_ID"
model_artifact_path="$(realpath "/Users/alex/.omlx/models/${model_id}")"

git worktree add --detach "$release_path" "$release_sha"
test "$(git -C "$release_path" rev-parse HEAD)" = "$release_sha"
test -z "$(git -C "$release_path" status --porcelain --untracked-files=all)"
if git -C "$release_path" symbolic-ref -q HEAD; then
  echo "release checkout is not detached" >&2
  exit 1
fi
corepack pnpm --dir "$release_path" install --frozen-lockfile
test -z "$(git -C "$release_path" status --porcelain --untracked-files=all)"
install -d -m 0700 "$launch_agents_path"
```

Before rendering, stage the private Wrangler source and Worker-secret source
into this activation directory. The staging commands emit paths, hashes, and
HMAC fingerprints only—never secret bytes. Pass the exact same files to the
renderer and later deploy; both paths are reverified before each Wrangler
command:

```bash
set -euo pipefail
test "$(stat -f '%Lp' "$config_source")" = "600"
test "$(stat -f '%Lp' "$worker_secrets_source")" = "600"
test "$(stat -f '%Lp' "$runner_env_path")" = "600"
snapshot_json="$(pnpm --dir "$release_path" wrangler:snapshot \
  --source "$config_source" --output "$config_snapshot")"
export SURF_WRANGLER_CONFIG="$(printf '%s' "$snapshot_json" | jq -er .path)"
export SURF_WRANGLER_CONFIG_SHA256="$(printf '%s' "$snapshot_json" | jq -er .sha256)"
export SURF_WORKER_SECRETS_FILE="$worker_secrets_source"
export SURF_WORKER_SECRETS_SNAPSHOT="$worker_secrets_snapshot"
export SURF_NARRATIVE_RUNNER_ENV_FILE="$runner_env_path"
pnpm --dir "$release_path" narrative:stage-deploy-inputs

pnpm --dir "$release_path" --filter @surf/narrative-runner \
  launch-agents:render \
  --outputDir "$launch_agents_path" \
  --repositoryPath "$release_path" \
  --releaseSha "$release_sha" \
  --runnerEnvPath "$SURF_NARRATIVE_RUNNER_ENV_FILE" \
  --launchAgentsDir "$HOME/Library/LaunchAgents" \
  --runnerExitTimeoutSeconds 930 \
  --pnpmPath "$(realpath "$(command -v pnpm)")" \
  --nodeBinPath "$(dirname "$(realpath "$(command -v node)")")" \
  --omlxPath "$(realpath "$(command -v omlx)")" \
  --omlxDataPath "/Users/alex/.omlx" \
  --modelArtifactPath "$model_artifact_path" \
  --wranglerConfigPath "$SURF_WRANGLER_CONFIG" \
  --wranglerConfigSha256 "$SURF_WRANGLER_CONFIG_SHA256" \
  --workerSecretsPath "$SURF_WORKER_SECRETS_SNAPSHOT" \
  --logDir "/Users/alex/Services/surf/logs"
plutil -lint "$launch_agents_path/ai.alex.narrative-runner.plist"
plutil -lint "$launch_agents_path/ai.alex.omlx-server.plist"
```

The renderer creates the private log directory, writes the plist files mode
`0600`, writes a secret-safe activation record with canonical executable,
supervisor, plist, exact Wrangler snapshot, and exact model-artifact tree
SHA-256 digests; HMAC fingerprints of the effective runner environment and
Worker-secret snapshot; and the exact model ID. It fails on
unresolved placeholders. It must itself execute from `repositoryPath`, proves
that path is the clean detached `releaseSha`, and requires the output, logs,
runner environment, Wrangler/Worker snapshots, and absolute heartbeat path to
remain outside the release.
Existing activation artifacts are accepted only when byte-identical; a secret
rotation or tool change gets a new `activation_id`, never an in-place rewrite.
`PNPM_ABSOLUTE_PATH`
must be the canonical realpath of the Corepack/pnpm executable in
the intended Node 24 environment. Also run `command -v node` and set
`NODE_BIN_ABSOLUTE_DIRECTORY` to that executable's containing directory. This
explicit non-secret `PATH` is required because Corepack/NVM pnpm shims commonly
use `/usr/bin/env node`, while launchd starts with a minimal environment. A
version-manager or Homebrew alias can retarget during an upgrade, so the
renderer rejects final-component symlinks. Its `--verifyRecord` mode recomputes
every executable/plist/config hash, the full selected model-tree hash,
Worker-secret and environment HMACs, release checkout, and model ID; it fails
before bootstrap if anything drifted. Preserve the activation record, exact
Wrangler and Worker-secret snapshots, exact selected model directory, the
exact IDs returned by `/v1/models`, and the prior activation directory as one
rollback unit. Retain accepted model artifacts by exact activation rather than
letting model-cache cleanup silently remove a rollback target.

The runner plist invokes the release-pinned verification wrapper; the plist
itself remains secret-free. It starts Node through `/usr/bin/env -i` with only
the recorded home and pinned executable path, so launchd-global variables
cannot affect the verifier before it sanitizes the runner child. The wrapper verifies the installed plist copies,
release, executables, model tree, Wrangler snapshot, Worker-secret fingerprint,
and exact runner-environment fingerprint on every automatic launch. It then
starts the runner with an environment reconstructed from the attested mode-0600
file, excluding ambient variables that could otherwise override the file.
Keep that file mode `0600`, keep the log
directory private, and configure log rotation outside the repository. Create
the absolute log directory and set
it mode `0700` before bootstrap; launchd does not create parent directories for
`StandardOutPath` or `StandardErrorPath`. The narrative runner uses `RunAtLoad`,
restarts after an unsuccessful exit, and handles `SIGTERM` drain. Its finite
`ExitTimeOut` must be at least the configured visibility timeout in seconds
plus 30 seconds (930 for the tracked 900-second lease); zero/infinite is not
accepted. That gives an in-flight oMLX/result/Queue settlement path time to
finish before launchd can escalate to `SIGKILL`, while keeping a bounded
rollback. The oMLX
plist keeps one long-running, secret-free shell supervisor around the actual
model-server child and pins its own finite 60-second `ExitTimeOut` so launchd
does not apply the observed five-second system default while the supervisor is
forwarding termination to a loaded model. Its plist also uses `/usr/bin/env -i`
with an explicit home/path/restart delay. That supervisor waits 15 seconds after a child crash before
starting a new child, re-verifies the full activation before every child
restart, and forwards termination to the active child. This is
intentional: a live crash drill on the always-on Mac showed launchd deferring
one-shot `KeepAlive` and `StartInterval` jobs, while the long-running supervisor
recovered a killed oMLX child and restored the authenticated loopback endpoint
in 21 seconds. After bootstrap in an already-running GUI session, explicitly
`kickstart` both labels and verify the runner status and `/v1/models`; do not
infer activation from a successful `bootstrap` command alone.

Install byte-attested copies at the exact conventional per-user paths under
`~/Library/LaunchAgents`. Arbitrary-path `launchctl bootstrap` state does not
survive every login/reboot; these persistent copies do. The installer writes
each copy atomically at mode `0600`, verifies its SHA-256 against the activation
record, and is idempotent when the exact bytes are already installed. It never
copies secrets. To prepare the persistent files without starting services:

```bash
set -euo pipefail
record="$launch_agents_path/activation-record.json"
pnpm --dir "$release_path" --filter @surf/narrative-runner \
  launch-agents:install "$record"
pnpm --dir "$release_path" --filter @surf/narrative-runner \
  launch-agents:verify-installed "$record"
plutil -lint "$HOME/Library/LaunchAgents/ai.alex.narrative-runner.plist"
plutil -lint "$HOME/Library/LaunchAgents/ai.alex.omlx-server.plist"
```

The standalone installer accepts only an empty destination or byte-identical
copies. It refuses to replace a different installed activation; use the
bounded controller below for every switch or rollback.

Use the supported controller for initial activation and every release switch.
It verifies the target before mutation; requires an explicit prior record if a
label is loaded; verifies the currently installed plist bytes and requires
`launchctl print` to bind every loaded label to that prior record's exact
persistent path before mutation; boots out the runner first; allows 960 seconds for its bounded
lease drain and requires `state: "stopped"` plus a dead PID; then boots out
oMLX and requires both an unloaded label and closed loopback port within 90
seconds. It installs the persistent target copies, starts oMLX first, and
requires `check` and `status` within separate 120-second monotonic wall-clock
deadlines. Each subprocess and TCP probe is bounded by the remaining deadline,
so network time counts rather than only sleeps:

```bash
# Initial activation (no labels loaded).
pnpm --dir "$release_path" --filter @surf/narrative-runner \
  launch-agents:activate --record "$record"

# Release switch. The prior record is mandatory rollback/drain evidence.
pnpm --dir "$release_path" --filter @surf/narrative-runner \
  launch-agents:activate \
  --record "$record" \
  --prior-record "$prior_activation_record"
```

If an initial activation fails after installing the target and starting only
oMLX (or before the runner becomes healthy), the persistent copies already
belong to the target. Retry with the same target record as both `--record` and
`--prior-record`; the controller will attest and stop that partial activation
before restarting the bounded sequence. Do not boot out or overwrite files by
hand to recover a partial activation.

Record the current and prior release paths, activation directories, external
environment paths, model artifacts, and activation records before switching.
Rollback runs the identical bounded controller from the prior immutable
release, reinstalling the prior byte-attested persistent copies before
bootstrap:

```bash
pnpm --dir "$prior_release_path" --filter @surf/narrative-runner \
  launch-agents:rollback \
  --record "$prior_activation_record" \
  --prior-record "$current_activation_record"
```

Never mutate an activation directory or run two same-label services. Before a
payload-incompatible Worker rollback, also follow the Queue-quiescence gate in
[Runtime operations](runtime-operations.md#narrative-rollback-quiescence):
disable admission first, preserve primary/DLQ backlog, wait through the
watchdog delay, and prove the fallback Queue has zero available, delayed,
leased, and retrying messages. Local service readiness is not Queue
quiescence.

## MacBook to Mac Studio migration

1. Leave the current MacBook runner operating while preparing a detached,
   immutable release worktree at the exact merged SHA and matching Node/pnpm
   versions on the Studio.
2. Install and preflight oMLX on the Studio. Copy model weights through the
   model server's documented mechanism; no model or cache belongs in this
   repository.
3. Create a new external mode-0600 environment file from the example. Transfer tokens through the
   password manager or another approved secret channel rather than copying
   shell history or the tracked plist. Give the Studio a distinct runner ID.
4. Run `config:check` on the Studio. This proves model/config readiness and
   performs one bounded read-only Queue metadata/auth/topology request; it does
   not pull or settle a message.
5. Boot out the MacBook LaunchAgent so it cannot restart, then wait for its
   stopped heartbeat/dead PID proof above; its `SIGTERM` path drains in-flight
   work. Unacknowledged leases remain recoverable.
6. Activate the rendered Studio LaunchAgent, then require `status` to pass and
   observe a bounded Queue/result cycle.
7. Keep the stopped MacBook immutable release, external config, and plist available for
   the initial rollback window. Rollback is to stop/drain the Studio and
   reactivate the MacBook; never delete the Queue or D1 rows to recover.

For later horizontal scale, give every host a distinct Queue, runner ID,
runtime secrets, and status path, keep the same logical target IDs, and set
per-host concurrency from measured oMLX capacity. The current fail-closed
topology requires exactly one HTTP-pull consumer per Queue; multi-consumer
sharing requires a separately reviewed contract change. Duplicate
delivery remains safe only because submission IDs and cloud publication are
idempotent.
