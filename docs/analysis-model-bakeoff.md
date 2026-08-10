# Analysis v5 local model bakeoff

The Analysis bakeoff is a publication-isolated, local-artifact evaluation path
for choosing an oMLX generator before enabling cloud narrative delivery. By
default inference stays on the loopback oMLX server. It reads all 55
current `forecast_fact_bundles` from the local Miniflare D1 file, then builds
the same Analysis snapshot and narrative job used in production. Bundles with
no deterministic recommendation are recorded as `analysis_no_recommendation`
and receive no model call, matching the production producer. A production
snapshot/schema failure is likewise surfaced as `analysis_snapshot_invalid`;
the harness never repairs or synthesizes an input just to make evaluation run.
Generator calls use that job's exact messages, output token limit, temperature, and strict JSON
Schema. No Queue, result callback, remote D1, or publication endpoint is used.
If an operator explicitly configures `allowRemote: true`, forecast prompts and
validated candidate reports are transmitted to that external inference host;
only the database and artifacts remain local.

The deterministic production validator is the absolute gate. A candidate is a
hard pass only when it parses as the production v5 editorial card-selection
plan, passes
`validateSurfAnalysisDraft`, and renders through `renderSurfAnalysisReport`.
Only hard-pass reports are eligible for the optional blinded pairwise judge.
A judge decision is advisory, is evaluated in both A/B orders, and can never
turn a rejected candidate into a pass or publish a report. It scores both
candidates from 1–5 across actionability, evolution clarity, reason/tradeoff,
call distinction, uncertainty, voice, concision, and factual fidelity.

The default `evaluationMode: "full"` requires at least two generators and at
least one judge. `evaluationMode: "generator_only"` is a deliberately explicit
validator-only acceptance lane: it requires exactly one generator and zero
judges, records `completionGate: "hard_validator_only"`, and cannot make a
pairwise quality claim. Use it only when judge calibration has failed or when
the task is to measure one already calibrated generator over the complete
corpus; owner/Codex review remains a separate gate.

## Configure

Copy the tracked shape to the ignored operator file and replace model IDs with
exact IDs returned by the local oMLX `/v1/models` endpoint:

```bash
cp apps/narrative-runner/bakeoff.example.json \
  apps/narrative-runner/bakeoff.local.json
chmod 600 apps/narrative-runner/bakeoff.local.json
```

The example names a bakeoff-dedicated token environment variable, not a token
value. Add that variable to the existing ignored
`apps/narrative-runner/.env`, which is loaded automatically. To prevent an
operator config from reading unrelated ambient secrets, `tokenEnv` must start
with `ANALYSIS_BAKEOFF_OMLX_` and end in `TOKEN`. Omit it only for an
unauthenticated loopback server. A non-loopback endpoint requires HTTPS, a
dedicated token, and explicit `allowRemote: true`; redirects are rejected.
Credentials are used only in request headers and are never written to
artifacts or errors.

`enableThinking` is deliberately locked to `false`. The production structured
card-selection task does not benefit from a hidden reasoning transcript, and oMLX
thinking can consume thousands of output tokens and dominate latency.
The config rejects duplicate endpoint/model pairs within a role and an exact
generator endpoint/model pair reused as a judge. Prefer a
cross-family judges (for example, Gemma judging Qwen candidates and Qwen
judging Gemma candidates), and use two distinct judge models when local
capacity makes that practical. No exact endpoint/model pair may judge itself.
Zero judges are rejected unless `evaluationMode` is explicitly
`generator_only`; that mode also rejects multiple generators.

## Plan before making calls

From the repository root:

```bash
pnpm analysis:bakeoff -- plan \
  --config apps/narrative-runner/bakeoff.local.json
```

`plan` opens D1 read-only, requires the configured bundle count (55 by
default), constructs every eligible current snapshot/job, fingerprints the
production schema, and prints unavailable reason counts plus the maximum call
count. It does not contact oMLX. The default is three generator seeds. With the
tracked three-generator/two-judge shape, 55 eligible cases have an upper bound
of 2,475 inference calls: 495 generator calls plus 1,980 order-swapped judge
calls. The printed plan is authoritative when past dates have no recommendation
or a production snapshot fails; generator pairs grow quadratically. The plan
also prints serialized job p50/p95/max bytes against the shared 60,000-byte
transport limit.

Before inference, `run` makes one authenticated `/v1/models` preflight per
configured endpoint and requires every exact model ID to be present. Each
completion must report the same model ID it was asked to run. The plan shows
both inference-call and total-HTTP-request upper bounds; `--max-calls` governs
the expensive inference calls.

Any `analysis_snapshot_invalid` row is a production-contract defect, not an
evaluation loss. `plan` reports all such rows, and `run` refuses every model
call until they are fixed. Expected `analysis_no_recommendation` rows do not
block the remaining eligible cases.
Judge calls are skipped whenever either candidate fails the absolute gate.
In `generator_only` mode the plan contains one preflight per endpoint, one
generation per selected case/seed, and no pairwise inputs or judge calls. For
the current 55-case, one-seed shape that is exactly 55 inference calls and 56
HTTP requests including model preflight.

Use `caseLimit` for a deliberately small smoke bakeoff before the full 55-case
run. The active corpus is ordered by local date and then spot, so `caseLimit: 11`
deterministically spans all 11 spots for the earliest date instead of sampling
several dates from one alphabetically first spot. Repeated generator and judge
seeds are recorded. Generator pairs grow quadratically, so inspect the plan
whenever adding models.

The synthetic/adversarial hard gate is the checked-in deterministic Analysis
validator suite: wrong-placement/unknown/duplicate card IDs, recommendation
rank and call-mode violations, semantic duplication, mutated card/value
provenance, and prose-shaped plan payloads run without paying for
model-generated synthetic prose.
It is not represented as 24 additional oMLX generations. The production runner
has no output-repair protocol, so the bakeoff records first-pass failure and
does not give a model a harness-only repair advantage.

## Run with an explicit call ceiling

```bash
pnpm analysis:bakeoff -- run \
  --config apps/narrative-runner/bakeoff.local.json \
  --runner-isolation stopped \
  --max-calls 2475
```

`run` refuses to start without an explicit isolation choice. Use
`--runner-isolation stopped` only after booting out the production runner and
proving its stopped heartbeat, dead PID, and unloaded LaunchAgent label. Use
`dedicated-endpoint` only when every bakeoff endpoint is separate from the
server used by production leases. Never saturate the single-concurrency
production oMLX endpoint with a bakeoff: doing so can expire a leased job and
spend Gemini fallback quota.

The run is rejected before any model request if its calculated upper bound
exceeds `--max-calls`. Each HTTP request is individually bounded by the
configured timeout and response byte limit; concurrency is capped at four.
Requests are also capped at 128 KiB. There are no inference retries, so
reported parse, validation, latency, and token metrics are first-pass results.
The current oMLX call is non-streaming, so time-to-first-token is unavailable;
the summary separates all-attempt wall latency from completed-response latency
and estimates sequential outputs per hour only from completed responses. Token
totals are explicitly labeled as observed totals with reported-call coverage,
so partial provider usage telemetry cannot look complete.

`SIGINT`/`SIGTERM` stops scheduling new calls, lets the current bounded
inference boundary settle, and atomically changes `manifest.json` to
`interrupted` with completed call counts. It never persists a rejected raw
payload. Resume by starting a new fingerprinted run; do not relabel an
interrupted artifact complete.

Artifacts are written with private file modes beneath the ignored
`.analysis-bakeoff/<timestamp>-<fingerprint>/` directory. The config may select
a subdirectory beneath `.analysis-bakeoff`, but the CLI rejects artifact paths
outside that ignored root. A run contains:

- `manifest.json`: redacted configuration, exact prompt/schema versions, call
  budget, source database, and run status.
- `inputs.ndjson`: exact production validation snapshots and narrative jobs.
- `candidate-results.ndjson`: output hashes/byte counts, hard-gate stages,
  sanitized rendered hard-pass reports, latency, and provider token usage when
  available. Rejected model payloads are never retained.
- `judge-inputs.ndjson`: randomized A/B messages with no generator/model
  identity, plus the authoritative call mode, recommendation order, all
  code-owned values/facts, all card previews/templates/evidence, judge schema,
  and thinking setting.
- `pairwise-map.ndjson`: the local-only mapping from blind comparisons back to
  candidate and generator IDs.
- `judge-results.ndjson`: advisory structured decisions, per-candidate 1–5
  rubric scores, output hashes, and judge metrics. The validator requires one
  top-level object, unique reason codes, `tie_equivalent` if and only if the
  winner is `tie`, and a complete punctuated rationale; invalid raw judge
  payloads are not retained.
- `summary.json`: per-generator hard-pass rates, semantic plan diversity,
  dominant-signature rate, seed stability, cross-case input sensitivity,
  latency percentiles, token coverage, rubric averages from order-consistent comparisons only,
  swapped-order consistency, strict cross-judge consensus, failure codes, and
  order-consistent pairwise wins/ties.

The judge and pairwise-map files are absent in `generator_only` mode. Its
summary still reports hard-pass rate, plan diversity, latency, and usage
telemetry, with empty advisory-judge sections and `judgeCanPublish: false`.

Do not commit the local config or artifacts. To compare two runs, match the
manifest's run fingerprint, fact fingerprints, prompt/schema versions, model
IDs, seeds, and thinking setting before interpreting score changes.

Before a full run, calibrate every judge on the same fixed cases with swapped
order. Schema-valid output is not enough: reject a judge that invents
differences between byte-identical reports, truncates rationales, contradicts
its own winner/reason codes, or misses the order-consistency gate. Do not count
those calls as advisory wins or silently drop them from the denominator.
