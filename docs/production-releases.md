# Production releases

Production releases are owned by one fail-closed command:

```bash
pnpm release:prod
```

The command fetches `origin/main`, prepares a clean detached checkout, runs
`pnpm verify`, builds deterministic Worker/client/runner identities, compares
them with the trusted active receipt, prints every planned mutation, and asks
once for confirmation. It never offers `--ui-only` or `--skip-*` switches.
A private single-host lock covers verification through final journaling, so two
operators cannot concurrently prepare D1 or runner state. A dead owner's lock
is retained under `stale-locks/` before an exact resume acquires a new lock.

The first managed release is deliberately conservative. No separate adoption
command is required. A Worker created by the current `pnpm setup:cloudflare`
flow already carries a nonzero exact Git source revision plus Worker/client
build identities, so that live source binding establishes its predecessor
lineage. An older Worker without managed source bindings is accepted only when
the installed legacy v3 runner record supplies the exact source revision from
the former guarded equal-SHA release path. The command records the live
Worker/deployment as an external predecessor and captures the D1 rollback pair
when storage changes. If Analysis is enabled, it transitions that legacy
runner to activation-record v4 before the Worker cutover. A disabled baseline
may leave the dormant v3 runner installed; the first later release that enables
Analysis is forced to activate v4 before its Worker cutover. The v4 runner record is built
from runner-owned artifacts only; it does not inherit a Wrangler snapshot or a
Worker-secret snapshot from the legacy deployment. Once that release
completes, later UI-only changes can use the proven assets-only lane.
An unmanaged Worker with neither the setup-produced source binding nor exact
legacy coupled-lineage evidence fails closed and requires a separately
designed, audited adoption ceremony.

## One-time profile

Copy [`production-profile.example.json`](production-profile.example.json) to
an external path such as `~/Services/surf/production-profile.json`, replace
every placeholder with a canonical absolute path, then make the profile and
all four referenced input files private:

```bash
chmod 600 ~/Services/surf/production-profile.json
chmod 600 /absolute/path/to/wrangler.source.jsonc
chmod 600 /absolute/path/to/worker-secrets.env
chmod 600 /absolute/path/to/runner-source.env
chmod 600 /absolute/path/to/operator.env
```

The profile contains paths and origins, not secret values. Its referenced
files have distinct roles:

- Wrangler source: the production resource/config overlay. Release-specific
  paths and build identity are repinned automatically.
- Worker secrets: exactly `GEMINI_API_KEY` and `NARRATIVE_RESULT_TOKEN`.
- Runner source environment: the existing strict runner environment. The
  release tool creates a new release-bound snapshot only when runner activation
  is required. Changes to bounded non-secret tunables activate a new runner;
  model/executable replacement and every secret rotation remain explicit
  coordinated operations.
- Operator environment: Cloudflare credentials and `SURF_INGEST_TOKEN`.

Set `SURF_PRODUCTION_PROFILE` only if the profile is not at the default path.
The release tool writes immutable snapshots, journals, and HMAC fingerprints;
it never writes secret values into a journal or log.

## Everyday workflow

Inspect a read-only, fail-closed preview:

```bash
pnpm release:prod --plan
```

The preview performs the same target-owned preparation needed for an exact
decision: it fetches and resolves `origin/main`, creates or reuses the clean
detached release checkout, installs from the frozen lockfile, runs `pnpm
verify`, builds the deterministic Worker/client/runner identities, copies the
release state into private temporary storage, and inspects the live Worker and
deployment plus the trusted release/runner evidence read-only. It then prints
the exact proven lane and planned mutations. It does not acquire the production
mutation lock, write the durable production journal, or mutate Cloudflare, D1,
Queues, triggers, secrets, or LaunchAgents.

Release freshly fetched `origin/main`:

```bash
pnpm release:prod
```

For unattended use, pin the exact commit explicitly:

```bash
pnpm release:prod --yes --sha 0123456789abcdef0123456789abcdef01234567
```

`--yes` is rejected without an exact SHA. `--force-full` may make a release
more conservative; no option can make it less conservative.

Check durable state without contacting Cloudflare:

```bash
pnpm release:status
```

## What the two lanes do

| Lane | Required proof | Mutations |
|---|---|---|
| Assets only | Every changed path is a production UI path; Worker runtime, config, secrets, storage, topology, protocol, runner, lockfile, shared workspace, and release-tool fingerprints exactly match the complete active receipt | Inactive Worker upload, runtime proof, predecessor recheck, exact 100% activation, dual-origin API/static verification |
| Conservative full | Missing/stale receipt, unknown path, shared/runtime/config/storage/topology/runner/contract input, or operator escalation | The same exact Worker activation/verification, plus only the Queue, D1, runner, trigger, and generation operations selected by the attested impact vector; unknown inputs select every operation |

The assets-only command trace is tested to contain no D1 backup, migration,
seed, Queue reconciliation, trigger synchronization, ingest, or LaunchAgent
operation. Within the full lane, migrations and seed changes are the only
reasons to back up D1. A change to either Queue-consumer or cron topology
discovers every account Queue, removes only stale top-level consumers owned by
the exact target Worker, runs Wrangler's combined trigger deployment, and then
re-attests both Queue and cron surfaces. Runner activation follows the runner
artifact; and the cron-safe
exact-lineage generation runs only for materialization or seed/catalog changes.
A trusted docs- or test-only release still uses the
conservative Worker lane but performs none of those stateful component
operations. Missing trust evidence remains all-true.

## Interruption and recovery

Every attempt has a mode-`0600` current journal plus an immutable retained file
for every hash-linked revision. The prepared checkpoint records the exact
profile, materialized Wrangler snapshot, and HMAC-pinned Worker-secret
snapshot. `active` advances as soon as Cloudflare proves the target is the sole
version at 100%; `last-complete` advances only after post-deploy verification.

Before Worker activation, continue the exact journal:

```bash
pnpm release:prod --resume RELEASE_ID
```

The command reuses recorded upload and D1 receipts and will not silently
change the target. If production already runs a failed target, either resume
the same journal or merge a repair and link it explicitly:

```bash
pnpm release:prod --fix-forward FAILED_RELEASE_ID
```

If an attempt failed from `planned` before recording any receipt, and repairing
an external input requires a new commit, replace that attempt explicitly:

```bash
pnpm release:prod --replace-pre-mutation FAILED_RELEASE_ID
```

This is rejected after verification advances or any receipt exists. After the
normal preview and confirmation, the old journal becomes a terminal `replaced`
record linked to the exact new release ID and Git SHA. The replacement journal
hash-links back to it while retaining the same live Worker, deployment, and
runner predecessor. Neither the old journal nor this link advances a production
pointer. If interrupted between the terminal link and replacement-journal
creation, rerun the same command; it remains pinned to the linked target.

There is no automatic production rollback after Worker activation. A Queue,
schema, or protocol boundary may already have been crossed; follow the
quiescence procedure in [Runtime operations](runtime-operations.md) before any
manual rollback. When a release mutates D1, its rollback unit is the journaled
Time Travel bookmark plus the exact mode-`0600` SQL export under the service
rollback directory. Releases without migration or seed impact do not create a
D1 backup.

## Release identities

- `/build.json` identifies the exact source revision and canonical client
  inputs. Static smoke compares every referenced JS/CSS asset byte-for-byte
  with the local build on both the custom domain and `workers.dev`.
- `/api/health` reports source revision, Worker runtime digest, client digest,
  and narrative protocol fingerprint.
- The narrative runner is a deterministic bundled artifact. Activation record
  v4 and status v3 attest its independent source, artifact, runtime
  environment, model/executables, status identity, installed/loaded plist
  identity, and accepted protocols. The Worker release separately proves the
  Queue, DLQ, callback, result target, and result-token binding compatibility;
  the runner record contains no Wrangler or Worker-secret snapshot. Worker and
  runner Git SHAs no longer need to match.
- Migration and seed inputs, runner artifact and runtime configuration, Worker
  and operator secrets, Queue/trigger topology, and release tooling all have
  separate fingerprints. Any mismatch prevents the assets-only lane.

Breaking narrative protocols, destructive migrations, and secret rotations
remain explicit coordinated operations outside the routine command.
