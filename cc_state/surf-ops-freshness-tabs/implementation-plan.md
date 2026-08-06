---
status: active
type: implementation-plan
created: 2026-08-03
verified_at: HEAD 334c907 + PR-A branch diff
---

# Implementation Plan: Surf Ops, Freshness & Tabs

**Owner:** Alex Lee
**Status:** `APPROVED — executing one-shot (ledger OI-1 resolved 2026-08-03)`
**Last Updated:** 2026-08-04
**Source Spec:** approved runtime plan `~/.claude/plans/goal-i-want-to-graceful-cocoa.md`
(spec of record; its RCA evidence and locked decisions are reproduced here — this plan is
self-contained and executable without it)
**Resources:** `WORKSTREAM.md` (ledger OI/OD IDs cited throughout) · `AGENTS.md` ·
`docs/runtime-operations.md` · `docs/feed-adapters.md`

---

## Intent

After the read-model incident (PR #16), I want to trust this app in three ways. First, I want
to *see* it run: I'm fluent in Logfire traces and spans, this is my first Cloudflare project,
and right now its most visible failure mode (a missing read-model row) emits no telemetry at
all. Second, when data is late I want the UI to tell me the truth without crying wolf — today
a banner fires for any fetch hiccup while the header chip says everything is fine, because two
different surfaces judge freshness two different ways. Third, the spot page should lead with
the deterministic forecast I actually plan around; the AI analysis is valuable but it belongs
behind a tab, Surfline-style, not in the hero.

**Priority signals:** When in doubt, optimize for honesty and operability over polish, and
polish over speed. Protect deterministic numeric authority and the AGENTS.md remote-mutation
boundary at all costs. Steady state should be *quiet* — a chip, no banner, no prose about
infrastructure.

## Scope

Three sequential PRs, each live-verified before the next starts (OD-5), preceded by a
read-only production diagnostic: **PR-A** observability + ops foundation, **PR-B**
cadence-aware freshness with a single verdict authority, **PR-C** Forecast | Analysis spot-page
tabs. Everything ships against the existing schema.

**Not in scope (OD-7, owner-confirmed deferrals):**

- Push alerting / Logfire alert rules — revisit after PR-A lands.
- Brief "stale"-status semantics polish.
- Analysis-tab growth (issued-forecast history, accuracy evals).
- Retention/pruning work.
- Any new D1 migration, spot-catalog change, or paid data source.
  *(Amended 2026-08-04 by OD-11: the owner added a spot-catalog expansion as its own
  sequential Phase D / PR-D leg strictly after PR-C — the exclusion still holds inside
  PRs A–C, and the no-paid-source rule is unchanged. Phase D tasks reconcile into this plan
  via x-impl before that leg starts.)*

## Mental Model

After this ships: every hour at :17, cron enqueues one source-ingest job that persists public
inputs, then fans out one materialization job per spot (queue batch size and concurrency stay
1). Each stage emits exactly one structured log line — publish, skip, supersede, or failure —
carrying `ingestId`, `spotId`, `interval`, `generationId`. Workers automatic tracing (beta)
spans the whole cycle and native OTLP export delivers traces + logs to Logfire, so one hourly
cycle reads as one correlated trace: cron → source job → 6 spot jobs → 12 publishes.

Each forecast payload's per-source freshness entries carry the adapter's declared
`expectedCadenceMinutes` (+ grace). One pure function in `packages/contracts` turns
(age, cadence, grace) into `fresh | aging | late` — the worker computes nothing else, the web
re-judges nothing. The header chip is always visible and honest (the min≠max formatting bug is
fixed). A banner appears only for actionable causes and names them: real unavailability
("OB North + 2 others are refreshing — showing data from 4:22 PM") or a `late` source ("Buoy
observations 3.1h old; expected hourly"). `fresh` and `aging` render no banner.

The spot page has two tabs. **Forecast** (default): a slim deterministic header — spot name,
one-line call, freshness badge — then the day picker and workbench (Table | Graph) first.
**Analysis**: the Daily Forecaster prose, tradeoffs, "What could change the call", data gaps,
and the provenance/confidence accordion. A forecaster with no reliable call collapses to one
quiet line. The daily-report page keeps its hero.

## Architecture Decisions

- **AD-1 (= OD-1): One freshness authority.** A pure contracts function computes
  `fresh | aging | late` from adapter-declared cadence shipped in the payload; every surface
  (chip, banner, workbench) consumes the same verdict. *Rejected: client-side re-judgment —
  two authorities disagreeing is exactly today's "API says fresh / UI says delayed" bug.*
- **AD-2 (= OD-2): Deterministic-first spot page via tabs.** Radix tabs already in the repo
  (`src/components/ui/tabs.tsx`); AI prose moves whole to Analysis. *Rejected: AI hero with
  better empty states — the hero position itself was the complaint; and removing AI content —
  it's useful, just not lead material.*
- **AD-3 (= OD-3): CF-native telemetry, Logfire as pane of glass.** Keep Workers Logs, enable
  automatic-tracing beta, use native OTLP export for traces + logs. *Rejected: hand-rolled
  OTel SDK in the Worker — native export is zero-config, spans runtime bindings (fetch, D1,
  Queues), and adds no bundle or CPU cost to a budget we just ran out of.*
- **AD-4 (= OD-4): Codified remote boundary.** Pre-authorized: read-only diagnostics
  (`pnpm wrangler -- tail`, `versions list`, D1 SELECTs) and the supported `pnpm deploy` at
  ship time. Everything else remote — secrets, dashboard config including the OTLP
  destination/token, backfills, any D1 write — stops and asks with a named recovery/rollback
  plan. Worker activation is the Queue-schema boundary: later failures fix forward on the
  active version unless Queue quiescence, no in-flight consumer, and predecessor-compatible
  payloads are independently proved.
- **AD-5 (= OD-5): Three sequential PRs, each verified live before the next.** Observability
  first so PR-B/C land on an instrumented system. *Rejected: one omnibus PR — un-reviewable
  and un-rollback-able.*
- **AD-6 (= OD-6): Ultracode execution.** Substantive phases run as orchestrated workflows
  with an adversarial review gate before each PR (protocol in Execution Notes). Mechanical
  edits exempt.

## Safeguards

- **S-1:** Numeric wave/tide/wind/condition/confidence/score values stay deterministic and
  testable; no LLM touches them (repo invariant).
- **S-2:** Source attribution, issue/valid times, freshness, and uncertainty surfaces are
  never deleted — restructured yes, removed never (repo invariant; PR-B/C move surfaces, they
  must not drop them).
- **S-3:** No new D1 migration in any PR. Additive schema remains untouched on failure.
  `pnpm wrangler -- rollback` is conditional on Queue quiescence, no in-flight consumer, and
  predecessor-compatible payloads; otherwise fix forward on the active Worker.
- **S-4:** No secrets in the repo, ever. The Logfire token lives in Cloudflare
  dashboard/account config only; CI stays secretless (`pnpm verify` must keep passing without
  any key).
- **S-5:** The ingest queue consumer keeps `max_batch_size: 1` and `max_concurrency: 1`, and
  the forecast read path stays a cheap indexed read-model lookup — the #16 CPU lesson.
- **S-6:** The web client never computes its own freshness verdict once AD-1 lands; it renders
  what the payload proves.

## Reconciliation & Verified Anchors

- **Reconciled at:** HEAD `87f45dc` (clean `main`, 2026-08-03) — same commit the planning
  session verified. Re-verify these anchors at today's HEAD before fan-out; they are recorded
  **by symbol** because lines drift.
- **Verified anchors:**
  - `/api/forecast/:spotId` GET handler in `apps/web/worker/index.ts` — the
    `if (!materialized)` branch returns the typed retryable 503
    (`error: "forecast_temporarily_unavailable"`, `Retry-After: 300`) **with no log line**;
    only the `catch` branch logs, via
    `console.error(JSON.stringify({ message: "forecast read model lookup failed", spotId, interval, ... }))`
    — that call is the repo's structured-log convention to follow.
  - `getMaterializedForecastJson`, `persistForecastMaterialization`,
    `materializeForecastReadModels`, `materializeForecastReadModelForSpot`,
    `FORECAST_READ_MODEL_SCHEMA_VERSION = 1` (unchanged since PR #15 — cross-version
    incompatibility is NOT a live failure mode) in `apps/web/worker/forecast-read-model.ts`.
  - `formatSourceAgeRange` in `apps/web/src/App.tsx` — chip formatter. Bug: compares raw
    `minimum === maximum` minutes, then formats each side, so distinct values that round to
    the same label render "Sources 3h–3h old". Empty input renders "Source ages unavailable".
  - `loadDashboard` in `apps/web/src/App.tsx` — the banner (`notice`) ternary is
    **availability**-driven (any spot fetch failure), with retained-last-good vs unavailable
    copy variants; `acceptRecoveredForecast` clears the notice when delayed spots recover.
  - `SourceFreshnessSchema` / `SourceFreshness` in `packages/contracts/src/index.ts` —
    per-source entries already carry nullable `freshnessMinutes`; cadence fields and the
    verdict function land here.
  - `forecast-health.ts` (+ `.test.ts`) in `apps/web/src/features/workbench/` — the existing
    client-side data-health judgment PR-B must subordinate to the contracts verdict.
  - `apps/web/wrangler.jsonc` — `observability.logs` already enabled
    (`head_sampling_rate: 1`, `invocation_logs: true`); `cache.cross_version_cache: false`;
    cron `17 * * * *`; queue consumer batch/concurrency 1; DLQ `surf-ingest-dlq`.
    `FORECAST_BRIEF_ENABLED=false` is the checked-in default; production overrides via the
    gitignored `apps/web/wrangler.instance.jsonc` overlay (`SURF_WRANGLER_CONFIG`, wrapper
    `scripts/wrangler.mjs`).
  - Script conventions: plain-node `.mjs` under `scripts/` (`cf-deploy.mjs`, `wrangler.mjs`,
    `smoke-local.mjs`) with `node --test` tests in `scripts/test/*.test.mjs`, wired as root
    `package.json` scripts.
  - Canonical ops queries live in `docs/runtime-operations.md` §"Forecast read-model failure"
    (the 12-row query, reproduced in T-0.1) and §"Health checks" (`source_runs` recency).
- **Known-current external facts (verified Aug 2026, re-check at implementation):** Workers
  automatic tracing is open beta (zero-config spans for handlers + fetch/KV/R2/DO/Queues
  bindings); native OTLP export of traces + logs to any OTLP endpoint requires Workers Paid
  (already on it — Queues require Paid). Sources:
  https://blog.cloudflare.com/workers-tracing-now-in-open-beta/ ·
  https://developers.cloudflare.com/workers/observability/
- **Access constraint:** local ambient credentials **cannot** read remote D1 (API error 7403
  on `d1 execute --remote`). Remote diagnostics run in the operator's authenticated shell —
  suggest `!`-prefixed commands for Alex to run in-session.

## Incident Context (why Phase 0 exists)

Documented RCA from the planning session — do not re-litigate; do close OI-2:

- PR #16 (merged 2026-08-03T23:01Z) fixed the original incident: all-spots-in-one-invocation
  materialization exhausted the Queue consumer's CPU; source writes succeeded, zero read-model
  rows published, prod rolled back, `forecast_read_models` left empty. #16 introduced per-spot
  fan-out.
- Owner's screenshots (23:04–23:06Z) show the truthful "no materialized generation" window,
  3 minutes post-merge, before recovery.
- The app self-recovered on the :17 cron (forecast 200s, brief regenerated 23:17:37Z). But at
  23:23Z a browser session got typed 503s on 4/6 spots (`obsf-north`, `obsf-south`,
  `linda-mar`, `bolinas`; `obsf-central` + `stinson` fine), clearing by 23:29Z. **That
  flapping cause is unpinned (OI-2).** Candidates: (a) transient D1 read errors — would have
  logged `"forecast read model lookup failed"`; (b) missing rows — currently UNLOGGED, hence
  invisible; (c) deploy/version churn — owner doesn't know whether/when a deploy ran
  post-merge.

## Task Overview

| Phase | Task | Deliverable | Size | Status | Dependencies |
|-------|------|-------------|------|--------|--------------|
| 0 | T-0.1: Production state snapshot | Deploy timeline, 12-row read-model state, DLQ depth (evidence in Log) | S | done | OI-1 approval |
| 0 | T-0.2: Pin the 23:23Z flapping cause | OI-2 verdict + chosen smallest corrective for PR-A | S | done | T-0.1 |
| A | T-A.1: Structured pipeline logging | Silent 503 logged; one line per publish/skip/supersede/failure; corrective folded in | M | done — healthy/degraded/recovery local proofs complete (2026-08-04 Log) | T-0.2 |
| A | T-A.2: Tracing beta + OTLP → Logfire | wrangler config + operator-assisted destination/token; correlated traces visible | M | done — traces+logs live in Logfire; OI-6 closed as documented split-trace limitation with ingestId correlation | T-0.2 |
| A | T-A.3: `pnpm ops:status` + post-merge runbook | Read-only status script + tests + `docs/runtime-operations.md` routine | M | done — final review DRY | — (parallel-safe with T-A.1/A.2) |
| A | T-A.4: PR-A gate | Adversarial review clean, `pnpm verify` green, ready PR | M | done — PR #23 merged `284b25f` (2026-08-05) | T-A.1–A.3 |
| A | T-A.5: Ship + live-verify PR-A | Deployed; one full hourly cycle as one Logfire trace; `ops:status` all-ready | S | done — Worker `53084465…` @100%; 02:17Z cycle verified (1 source + 12 publishes, ingestId-correlated traces); ops 4/4; dual-origin smoke; browser clean. OI-8 deploy-window fault recorded | T-A.4 |
| B | T-B.1: Contracts cadence + verdict | `expectedCadenceMinutes`/grace fields + pure verdict fn + matrix tests | M | done — 11-test matrix, new contracts vitest harness | T-A.5 |
| B | T-B.2: Adapters declare cadence | Documented cadence flows into payload source entries at materialization | M | done — constants beside source IDs; feed-adapters cadence table | T-B.1 |
| B | T-B.3: Web consumes one verdict | Chip fix + banner rework + workbench/`forecast-health` subordination + tests | M | done — all client thresholds deleted; OD-9 mobile chip | T-B.2 |
| B | T-B.4: PR-B gate | Adversarial review clean, `pnpm verify` green, ready PR | M | done — DRY after 3 rounds + delta check; PR #27 | T-B.3 |
| B | T-B.5: Ship + live-verify PR-B | Deployed; steady state = quiet chip, no banner, correct collapsed-range copy | S | done — `18eba224…` @100%; 03:17Z cycle 12/12; quiet chip/no banner live at 1280+390 | T-B.4 |
| C | T-C.1: High-signal Forecast \| Analysis restructure | Tabbed spot view, slim deterministic header, home de-duplication, `tab` URL param, empty-state collapse | L | — | T-B.5 |
| C | T-C.2: Tab behavior tests | Tab rendering, param round-trip, empty-state, a11y roles | M | — | T-C.1 |
| C | T-C.3: PR-C gate | Adversarial review clean, `pnpm verify` green, ready PR | M | — | T-C.2 |
| C | T-C.4: Ship + live-verify PR-C | Deployed; Playwright checks on surf.alexlee.ai pass | S | — | T-C.3 |
| D | T-D.1: Spot catalog expansion (OD-11) | +5 spots (Rodeo Beach, Steamer Lane, Pleasure Point, Cowell's, 38th Ave) with full data/scoring/test/ops parity | L | — | T-C.4 |
| D | T-D.2: PR-D gate + ship + live-verify | Review dry; verify green; deployed; catalog-driven ops/smoke proof; new spots live | M | — | T-D.1 |

**Size guide:** S = single file/function · M = multiple files, clear boundaries · L = cross-cutting.
**Status values:** — (not started) · `done` · `in progress` · `blocked` · `re-scoped`

## Phase 0: Production Diagnostic (read-only)

Pin OI-2 with evidence before touching code, so PR-A carries the *right* corrective instead of
a guessed one. Everything here is read-only and pre-authorized under AD-4; anything that would
mutate data stops and asks.

**Gate to start:** OI-1 resolved — owner has reviewed this plan and the workstream.
**Checkpoint:** OI-2 closed in the WORKSTREAM ledger with an evidence-backed verdict and the
chosen corrective; no remote state changed.

### T-0.1: Production State Snapshot

- **Goal.** Establish what's live, since when, and whether all 12 read-model rows are ready.
- **Context.** Local ambient credentials cannot read remote D1 (7403) — run these in the
  operator's shell via `!`-prefixed commands if the wrapper fails locally:

  ```bash
  pnpm wrangler -- versions list          # what's deployed, when — resolves the deploy-timeline unknown
  pnpm wrangler -- queues info surf-ingest-dlq   # DLQ depth (name per instance overlay)
  pnpm wrangler -- d1 execute DB --remote --command \
    "with intervals(interval) as (values ('1h'), ('3h')) select s.id as spot_id, i.interval, case when r.spot_id is null then 'missing' else 'ready' end as state, r.generated_at, r.materialized_at, length(r.forecast_json) as json_chars from spots s cross join intervals i left join forecast_read_models r on r.spot_id=s.id and r.interval=i.interval where s.active=1 order by s.id,i.interval"
  ```

  Expected: 12 `ready` rows (6 spots × 1h/3h). Also snapshot recent `source_runs` (query in
  `docs/runtime-operations.md` §Health checks).
- **Deliverable.** Evidence pasted into this plan's Log + WORKSTREAM Session Log; no file
  changes.
- **Acceptance Criteria.**
  - Deploy timeline around 2026-08-03T23:01–23:29Z is known (was there a deploy/version
    change in the flapping window?).
  - Read-model state (12/12 or the gap) and DLQ depth recorded.
- **Size:** S
- **Dependencies:** OI-1 approval

### T-0.2: Pin the 23:23Z Flapping Cause

- **Goal.** Close OI-2: decide among transient-D1-reads / missing-rows / version-churn from
  logs, and select the smallest corrective for PR-A.
- **Context.** Workers Logs are already collecting (`observability.logs`, sampling 1). In the
  Cloudflare dashboard (operator-assisted — read-only), search invocation logs around
  2026-08-03T23:20–23:30Z for `"forecast read model lookup failed"` and for 503-outcome
  requests to `/api/forecast/*`. Interpretation table:
  - log line present → transient D1 read errors → corrective: **one bounded retry** inside
    `getMaterializedForecastJson` (or at its call site) before returning the typed 503.
  - silence + rows were missing → per-spot publication gap → corrective: **trace per-spot
    publication** via PR #16's logs (T-A.1 covers it; nothing extra).
  - version churn in T-0.1's timeline → corrective: **ops practice only** (post-merge routine,
    T-A.3 covers it).
- **Deliverable.** OI-2 flipped in the WORKSTREAM ledger (date + verdict + corrective);
  T-A.1's scope adjusted accordingly.
- **Acceptance Criteria.**
  - Verdict cites concrete evidence (log lines, timestamps, or version history).
  - Chosen corrective is the smallest matching one; any data mutation proposal stops and asks.
- **Size:** S
- **Dependencies:** T-0.1

## Phase A: PR-A — Observability + Ops Foundation

Make the pipeline and its failure modes visible before changing behavior; codify the ops
routine.

**Checkpoint:** ready PR; then T-A.5 live-verified before Phase B starts (AD-5).

### T-A.1: Structured Pipeline Logging

- **Goal.** Every meaningful pipeline outcome emits exactly one structured log line; the
  most visible failure mode stops being invisible.
- **Context.** Follow the existing convention —
  `console.error(JSON.stringify({ message, ...fields }))` as in the catch branch of the
  `/api/forecast/:spotId` handler (`apps/web/worker/index.ts`). Work items:
  1. The `if (!materialized)` branch logs
     `{ message: "forecast read model missing", spotId, interval }` before returning 503.
  2. Audit the source-ingest job and per-spot materialization consumer
     (`apps/web/worker/ingest/`, `forecast-read-model.ts`:
     `persistForecastMaterialization` / `materializeForecastReadModelForSpot`) so every
     publish / skip / supersede / failure emits one line carrying `ingestId`, `spotId`,
     `interval`, `generationId`, outcome. **Add only where #16 left gaps — no duplicate
     lines.**
  3. Fold in T-0.2's corrective if it's code-shaped (e.g. bounded retry in the read path).
- **Deliverable.** `apps/web/worker/index.ts`, `apps/web/worker/ingest/*`,
  `apps/web/worker/forecast-read-model.ts` (as needed), worker tests.
- **Acceptance Criteria.**
  - Worker test asserts the 503-miss branch logs (console-spy pattern exists in
    `index.test.ts` / `forecast-read-model.test.ts`).
  - One ingest cycle in local dev (`pnpm dev` + `pnpm ingest:local`) shows the full
    correlated line set; an artificially emptied local read model produces the new missing
    log + 503.
  - No log line contains secrets or full provider payloads.
- **Size:** M
- **Dependencies:** T-0.2

### T-A.2: Automatic Tracing + OTLP Export to Logfire

- **Goal.** One hourly cycle is one correlated trace in Logfire: cron → source job → 6 spot
  jobs → publishes, with logs attached.
- **Context.** Two halves:
  - *Repo half:* enable Workers automatic tracing (open beta) in `apps/web/wrangler.jsonc`.
    **OI-3: verify exact config keys against current CF docs at implementation time** — the
    beta surface moves. Keep the existing `observability.logs` block.
  - *Operator half (OI-4, stop-and-ask):* the OTLP destination + Logfire token are Cloudflare
    account/dashboard config, not repo config. Prepare exact click/API steps + the Logfire
    OTLP endpoint values, present them to Alex, and assist while he applies them. Secrets
    never enter the repo (S-4). Named rollback: delete the destination / disable export —
    fully reversible, no data risk.
- **Deliverable.** `apps/web/wrangler.jsonc` diff; an operator runbook snippet in the PR
  description + `docs/runtime-operations.md` (from T-A.3); confirmation screenshot/trace ID
  in the Log.
- **Acceptance Criteria.**
  - `pnpm verify` (includes secretless Wrangler bundle dry-run) passes with the new config.
  - After deploy (T-A.5): traces and logs for the same invocation correlate in Logfire;
    span tree shows queue producer/consumer and D1 calls.
  - `pnpm check:cloudflare` remains green (no unauthorized remote mutation from the repo).
- **Size:** M
- **Dependencies:** T-0.2 (sequenced with T-A.1 only at the wrangler.jsonc file boundary)

### T-A.3: `pnpm ops:status` + Post-Merge Runbook

- **Goal.** A one-command read-only production status check, and a written routine so
  "did the merge actually ship and recover?" never depends on memory.
- **Context.** New `scripts/ops-status.mjs` following the house pattern
  (`scripts/wrangler.mjs` wrapper for config overlay; style of `cf-deploy.mjs` /
  `smoke-local.mjs`): fetch `/api/health`, run `pnpm wrangler -- deployments status` (Phase
  0 proved `versions list` does not identify the active deployment), inspect the ingest queue
  consumer and require batch/concurrency 1, run the 12-row read-model query (T-0.1's SQL),
  print a compact table, and exit non-zero on any missing/failed row or unsafe queue setting.
  Wire as root `package.json` script `ops:status`. Test in
  `scripts/test/ops-status.test.mjs` (`node --test`, mock the wrangler/fetch boundary like
  the existing script tests). Add a "Post-merge routine" section to
  `docs/runtime-operations.md`: `pnpm verify` → `pnpm deploy` → `pnpm ops:status` (12 ready)
  → `pnpm smoke:cloudflare` → glance at the cycle trace in Logfire; plus "what's live" via
  `deployments status` (use `versions list` only as supporting upload history).
- **Deliverable.** `scripts/ops-status.mjs`, `scripts/test/ops-status.test.mjs`, root
  `package.json` script entry, `docs/runtime-operations.md` section.
- **Acceptance Criteria.**
  - `pnpm ops:status` is read-only (no ingest trigger, no writes) and works via the
    instance-overlay wrapper.
  - Script test passes under `pnpm test`; `pnpm verify` green.
  - Runbook section names the exact commands and the expected outputs.
- **Size:** M
- **Dependencies:** none within Phase A (parallel-safe: disjoint files from T-A.1/T-A.2)

### T-A.4: PR-A Gate

- **Goal.** Adversarially reviewed, canonically verified, ready PR.
- **Context.** Run the ultracode adversarial review protocol (Execution Notes) over the PR-A
  diff with lenses: correctness, repo-invariant compliance (AGENTS.md: determinism,
  attribution/freshness preservation, no secrets, no unauthorized remote mutation), test
  adequacy, config/ops safety (wrangler + scripts). Then local e2e: `pnpm dev` +
  `pnpm ingest:local` + `pnpm smoke:local`, exercising the degraded 503 path locally.
- **Deliverable.** Clean review round, `pnpm verify` output, pushed branch, ready PR
  targeting `main`.
- **Acceptance Criteria.**
  - Review loop ended dry (no confirmed findings outstanding, cap ~3 rounds).
  - `pnpm verify` green (fresh D1 + seed, checks, TS + Python tests, build, secretless
    dry-run).
  - PR body documents behavior, ops changes, OI-2 verdict + corrective, and queue-safe failure
    recovery (fix forward after activation; rollback only with explicit quiescence/
    compatibility evidence; schema untouched).
- **Size:** M
- **Dependencies:** T-A.1, T-A.2, T-A.3

### T-A.5: Ship + Live-Verify PR-A

- **Goal.** PR-A merged, deployed, and proven observable in production.
- **Context.** `pnpm deploy` is pre-authorized at ship time (AD-4); it applies migrations
  (none here), deploys, queues one authenticated ingest, waits for read models, runs strict
  smoke, and leaves an activated version in place on any verification failure for queue-safe
  fix-forward. Operator provides `SURF_INGEST_TOKEN` in his shell.
- **Deliverable.** Deployed Worker; Logfire trace link + `pnpm ops:status` output in the Log;
  WORKSTREAM updated.
- **Acceptance Criteria.**
  - One full hourly cycle (cron :17) visible as one correlated Logfire trace with the new
    structured lines attached.
  - `pnpm ops:status` reports 12 ready; `pnpm smoke:cloudflare` green on both hostnames.
  - Failure path stated: fix forward after activation; `pnpm wrangler -- rollback` only after
    proving Queue quiescence, no in-flight consumer, and predecessor-compatible payloads.
- **Size:** S
- **Dependencies:** T-A.4

## Phase B: PR-B — Cadence-Aware Freshness

One verdict authority; honest chip; banners only for actionable causes.

**Checkpoint:** ready PR; then T-B.5 live-verified before Phase C starts (AD-5).

### T-B.1: Contracts Cadence Fields + Verdict Function

- **Goal.** The freshness contract carries declared cadence, and one pure function computes
  the verdict.
- **Context.** In `packages/contracts/src/index.ts`, extend `SourceFreshnessSchema` (and the
  related per-source freshness surfaces that carry `sourceFreshnessMinutes`) with
  `expectedCadenceMinutes` and `graceMinutes` (or a single grace policy — implementer's call,
  but it must be explicit and serialized). Add
  `freshnessVerdict({ ageMinutes, expectedCadenceMinutes, graceMinutes }) → "fresh" | "aging" | "late"`
  as a pure exported function. Proposed starting cadence table — **to be confirmed in this
  task against provider docs (`docs/feed-adapters.md` §Adapter Contract already requires a
  declared cadence) and observed `source_runs` history; these are config constants, not
  hardcoded magic:**

  | Source | Proposed `expectedCadenceMinutes` | Notes |
  |---|---|---|
  | NOAA CO-OPS tide predictions | 1440 | Astronomical predictions — staleness is fetch-recency, not data change |
  | NWS point wind/alerts | 360 | Point forecasts update with forecast packages, ~2–6h |
  | NWS MTR coastal grid waves | 720 | Grid `updateTime` cadence; fallback wave source |
  | CDIP MOP nearshore forecast | 360 | Model-cycle-based; keep cycle vs file-update distinction intact |
  | NDBC realtime observations | 60 | Buoys report ~hourly; generous grace to avoid crying wolf |

- **Deliverable.** `packages/contracts/src/index.ts` + contracts unit tests (verdict matrix:
  model-cycle sources vs hourly buoys vs tide predictions; boundary values; null age).
- **Acceptance Criteria.**
  - Verdict function is pure, total (null/undefined age → explicit result, not NaN), and
    matrix-tested.
  - Cadence values are justified in the diff (doc/observation citation per source).
  - Existing payload consumers still parse (additive schema change only).
- **Size:** M
- **Dependencies:** T-A.5

### T-B.2: Adapters Surface Cadence into Payloads

- **Goal.** Materialized payload source entries carry each adapter's declared cadence, so
  clients receive verdict inputs — never re-derive them.
- **Context.** Wire the per-adapter constants through materialization
  (`apps/web/worker/forecast-read-model.ts` / the assembly in `apps/web/worker/forecast.ts` —
  wherever `sourceFreshness` entries are built) from the adapter declarations
  (`apps/web/worker/adapters/`). Preserve CDIP's model-cycle vs file-update distinction
  (`model_cycle_at` is the physics cycle; HTTP `Last-Modified` is explicitly not).
- **Deliverable.** Worker adapter/materialization diffs + worker tests asserting payloads
  include cadence per source.
- **Acceptance Criteria.**
  - Every source entry in a materialized payload carries cadence + grace.
  - `FORECAST_READ_MODEL_SCHEMA_VERSION` handling reviewed: bump only if the payload change
    is breaking for older readers (additive fields should not require it — justify either
    way in the diff).
  - Local ingest (`pnpm ingest:local`) produces payloads whose entries all carry cadence.
- **Size:** M
- **Dependencies:** T-B.1

### T-B.3: Web Consumes the Single Verdict

- **Goal.** Chip always honest, banner only actionable, workbench agrees — one judgment
  everywhere.
- **Context.** All in `apps/web/src/`:
  1. **Chip fix** — `formatSourceAgeRange` in `App.tsx`: compare *formatted* min/max labels;
     a collapsed range renders one value ("Sources ~3h old"); keep the fetched-at tooltip
     (`formatFetchedAt`).
  2. **Banner rework** — the `notice` selection in `loadDashboard`: fire only for (a) real
     unavailability, naming affected spots + whether last-good is shown ("OB North + 2
     others are refreshing — showing data from 4:22 PM"), and (b) `late` verdicts, naming
     source + cadence ("Buoy observations 3.1h old; expected hourly"). Nothing for
     `fresh`/`aging`. Auto-clear stays (refresh loop + `acceptRecoveredForecast`).
  3. **Workbench subordination** — `features/workbench/forecast-health.ts` and the freshness
     surfaces in `ForecastWorkbench.tsx` consume `freshnessVerdict` from contracts instead
     of judging locally (S-6) — this kills today's "API fresh / UI delayed" split.
- **Deliverable.** `App.tsx`, `features/workbench/forecast-health.ts`,
  `ForecastWorkbench.tsx` (+ their tests: `App.test.tsx` banner-selection matrix,
  `forecast-health.test.ts`, `ForecastWorkbench.test.tsx` freshness rendering).
- **Acceptance Criteria.**
  - Banner-selection matrix tested: no banner for fresh/aging; unavailability copy names
    spots + last-good time; late copy names source + cadence.
  - Chip never renders an X–X collapsed range; empty-payload case keeps a truthful
    fallback label; the chip remains visible at the 390 px phone viewport.
  - No web module computes fresh/aging/late outside the contracts function (grep-clean).
- **Size:** M
- **Dependencies:** T-B.2 (single lane — chip, banner, workbench all touch `App.tsx`/
  workbench files; do not parallelize inside this task)

### T-B.4: PR-B Gate

- **Goal.** Adversarially reviewed, verified, ready PR.
- **Context.** Protocol as T-A.4, adding a UX copy/a11y lens (banner copy is user-facing;
  chip/tooltip semantics). Local e2e: reproduce degraded states (empty local read models →
  503 path; stale-aged fixtures → late verdicts).
- **Deliverable.** Clean review round, `pnpm verify` output, ready PR.
- **Acceptance Criteria.** Review dry; `pnpm verify` green; PR body includes the cadence
  table with citations and before/after banner behavior.
- **Size:** M
- **Dependencies:** T-B.3

### T-B.5: Ship + Live-Verify PR-B

- **Goal.** Freshness behavior proven in production.
- **Deliverable.** Deployed; observations in the Log; WORKSTREAM updated.
- **Acceptance Criteria.**
  - Steady state on surf.alexlee.ai: quiet chip, **no banner**.
  - Chip shows a single collapsed value when source ages round together.
  - `pnpm ops:status` 12 ready; smoke green.
- **Size:** S
- **Dependencies:** T-B.4

## Phase C: PR-C — Forecast | Analysis Tabs

Deterministic data leads; AI analysis is one tab away; empty states are quiet.

**Checkpoint:** ready PR; then T-C.4 live-verified; workstream moves to closeout.

### T-C.1: Restructure the Spot View

- **Goal.** Tabbed spot page with the workbench first and all AI prose in Analysis.
- **Context.** `apps/web/src/features/workbench/ForecastWorkbench.tsx` (~1054 lines: hero +
  Daily Forecaster panel + workbench) and the spot-view shell in `App.tsx`, using the
  installed shadcn/radix `src/components/ui/tabs.tsx` (already used for Table | Graph —
  follow that usage).
  - **Forecast (default):** slim header — spot name + deterministic one-line call +
    freshness badge (PR-B's verdict); hero card shrinks; zero AI content; then day picker +
    workbench (Table | Graph, resolution).
  - **Analysis:** Daily Forecaster prose, tradeoffs, "What could change the call", data
    gaps, "Data, confidence & provenance" accordion.
  - **URL state:** add `tab=forecast|analysis` to the existing query-param pattern
    (`?spot&interval&view&date&at`); default omits it; existing deep links keep working.
  - **Degraded states:** missing core forecast → truthful compact notice in the Forecast
    header (reuse current subtitle copy); forecaster without a reliable call → one quiet
    line in Analysis (no billboard); `FORECAST_BRIEF_ENABLED=false` instances render the
    existing deterministic-fallback copy identically.
  - **Signal-to-noise amendment (OD-9):** retain v2's visual identity while deleting
    repetition: no “Trust-first”/“24-hour detail”/“Forecast workbench” boilerplate, duplicate
    condition pill, always-visible legend, or auto-expanded window explanation on Forecast.
    The default tab answers only when, size, wind, tide, surface, and confidence. Brief fetch
    begins only when Analysis is selected; hidden content is absent from the accessibility tree.
  - **Daily report surgical de-duplication:** keep the regional hero, comparison authority,
    hazards, and deterministic sort; remove the top-three shortlist (duplicate links), remove
    the weak “N source updates” claim, and compress phone comparison rows without dropping
    spot/condition/window/size/wind/tide. This narrowly supersedes OD-2's untouched-home clause.
- **Deliverable.** `ForecastWorkbench.tsx`, `App.tsx`, possibly a small extracted
  tab-content component; no worker changes.
- **Acceptance Criteria.**
  - Default view = Forecast tab, workbench above the fold; no AI prose on it.
  - At 1280×720, day controls, table header, and at least one forecast row are visible without
    scrolling. At 390×844, the first forecast row starts in the first viewport and the document
    has no horizontal overflow.
  - `?tab=analysis` deep-link opens Analysis; param round-trips through spot/interval/date
    changes; omitted by default.
  - Analysis-only content and brief requests are absent on Forecast; Analysis disclosures start
    collapsed, and a no-reliable-call brief is exactly one quiet line.
  - Daily report has exactly one spot link per catalog spot, an always-visible freshness chip,
    no healthy-state banner, and no source-update-count pseudo-metric.
  - All PR-B freshness surfaces and all provenance/attribution content survive the move
    (S-2 — restructured, not removed).
- **Size:** L
- **Dependencies:** T-B.5

### T-C.2: Tab Behavior Tests

- **Goal.** The restructure is pinned by tests.
- **Context.** `ForecastWorkbench.test.tsx`, `App.test.tsx`. Assert radix tablist roles the
  way existing Table | Graph tests do.
- **Deliverable.** Updated/added tests.
- **Acceptance Criteria.**
  - Tab rendering + default selection; URL param round-trip; forecaster-empty collapses to
    one line; brief-disabled fallback copy; tablist/tab a11y roles asserted.
  - Distinct accessible names for outer Spot view and inner Forecast view tablists; inactive
    panel content is not tabbable or announced; no `/brief` request before Analysis activation.
  - Home de-duplication, mobile freshness visibility, six unique spot links, and no horizontal
    overflow are regression-tested.
- **Size:** M
- **Dependencies:** T-C.1

### T-C.3: PR-C Gate

- **Goal.** Adversarially reviewed, verified, ready PR.
- **Context.** Protocol as T-A.4 with UX/a11y lens prominent. Local e2e across
  `?spot`/`?tab` permutations.
- **Deliverable.** Clean review round, `pnpm verify` output, ready PR.
- **Acceptance Criteria.** Review dry; `pnpm verify` green; PR body shows before/after
  screenshots for Forecast, Analysis, and home at desktop + phone sizes, plus semantic browser
  evidence for tab selection, URL state, overflow, alerts, headings, and console errors.
- **Size:** M
- **Dependencies:** T-C.2

### T-C.4: Ship + Live-Verify PR-C

- **Goal.** Tabs proven live.
- **Context.** Playwright MCP is available. SPA routes are query-param based — path routes
  404; use `https://surf.alexlee.ai/?spot=obsf-north` and `&tab=analysis`.
- **Deliverable.** Deployed; Playwright evidence in the Log; WORKSTREAM updated → closeout.
- **Acceptance Criteria.**
  - Live: Forecast tab default with workbench first; `&tab=analysis` deep-link works;
    forecaster-empty state is compact.
  - Live browser matrix at desktop and phone widths proves no horizontal overflow, no AI on
    Forecast, no workbench on Analysis, one home link per spot, visible mobile freshness, and
    zero healthy-state alerts. Evidence records deployed SHA, UTC time, viewport, host, URL,
    accessibility snapshot, and screenshots.
  - `pnpm ops:status` 12 ready; smoke green.
- **Size:** S
- **Dependencies:** T-C.3

## Execution Notes

- **Agent mode (AD-6, owner opt-in on record).** Ultracode: substantive phases run as
  orchestrated workflows. Per PR: (1) implement — inline, or small worktree-isolated agents
  where files are disjoint; (2) **adversarial review workflow before opening the PR** —
  parallel reviewer lenses (correctness; AGENTS.md invariant compliance: determinism,
  attribution/freshness preservation, no secrets, spot-catalog sync; test adequacy; UX
  copy/a11y for PR-B/C; config/ops safety for PR-A) produce findings, then independent
  adversarial verifiers attempt to REFUTE each finding (majority-refuted findings die);
  confirmed findings get fixed; loop until a round comes back dry, cap ~3 rounds;
  (3) `pnpm verify` + targeted tests; (4) live verification per the ship task. Scale
  judgment: mechanical edits skip the workflow; anything touching worker read paths,
  contracts, or the tab restructure gets it.
- **Lane boundaries.** T-A.1/T-A.2 both touch `wrangler.jsonc`-adjacent worker config —
  checkpoint between them; T-A.3 is disjoint (scripts/docs) and parallel-safe. T-B.3 is a
  single lane (shared `App.tsx`/workbench files) — never split it across parallel agents.
  Phase C tasks are sequential (same component).
- **State management.** One branch + one coherent commit story per PR
  (`aylee/<slug>` naming, e.g. `aylee/surf-ops-observability`). After each session: update
  the Task Overview status column, append to Log, update `WORKSTREAM.md` (ledger, Current
  State, Next Action, Session Log). Commit/push only at PR time per repo convention.
- **Shared context for spawned agents.** Give agents: this plan's relevant Phase section,
  the Verified Anchors block, AGENTS.md invariants, and the safeguards. Let them discover
  file details from the codebase; don't paste stale snippets.
- **Known risks.**
  - Workers tracing is beta (OI-3): config keys may differ from planning-time docs — verify
    against current CF docs before editing `wrangler.jsonc`; if the beta is
    unavailable/broken, PR-A still lands logging + ops (tracing becomes a follow-up, noted
    in the ledger).
  - OTLP destination/token (OI-4) is operator-side: schedule it with Alex; PR-A merge does
    not block on it, live-verification of Logfire correlation does.
  - Remote D1 reads need the operator's shell (7403 locally) — plan diagnostic moments
    around his availability; suggest `!`-prefixed commands.
  - `FORECAST_BRIEF_ENABLED` differs between checked-in default (false) and prod overlay —
    always test both states in PR-B/C UI work.

## Open Questions

Live tracking is the WORKSTREAM **Open Items & Decisions Ledger** (OI-1 owner review gate ·
OI-2 flapping cause · OI-3 tracing beta keys · OI-4 OTLP/Logfire provisioning). This section
stays a snapshot pointer — close-loop there, not here.

## Log

Append-only. Each session adds an entry; keep the Task Overview status column in sync.

### 2026-08-03

- **Created:** Plan authored from the approved runtime plan
  (`~/.claude/plans/goal-i-want-to-graceful-cocoa.md`) during workstream origination.
  Anchors verified by symbol at HEAD `87f45dc`. No code written — execution gated on owner
  review (OI-1).
- **Next:** Owner review; on approval (pasting the one-shot kickoff prompt — OD-8), execute
  the full workstream per `session-brief-oneshot-full-workstream.md`.

### 2026-08-03 — One-shot kickoff

- **Gate:** OI-1 resolved by Alex's one-shot kickoff (OD-8); plan status moved to active.
- **Started:** T-0.1 read-only production snapshot, current tracing/OTLP configuration
  verification, and symbol-anchor audit at HEAD `87f45dc`. No code changes began before
  approval.

### 2026-08-03 — Phase 0 diagnostic complete

- **T-0.1 evidence:** PR #16 merged `2026-08-03T23:01:29Z`; Cloudflare deployment status
  remains 100% rollback version `ea3a7a1e…`, activated `04:43:12Z`, with no later deploy.
  Primary-served D1 SELECT returned all 12 expected read-model pairs missing (zero writes).
  The `23:17Z` and current hourly source runs show four successes + NDBC partial, proving
  source persistence without read-model publication. The production Queue consumer remains
  stale at batch size 10 rather than the repo's 1/1. Wrangler confirms the DLQ exists but its
  `queues info` command does not expose backlog depth.
- **T-0.2 verdict / OI-2:** production never ran PR #16. Live tail at
  `2026-08-04T02:34:18.565Z` captured `outcome=exceededCpu`, CPU 10 ms, HTTP 503 on the active
  rollback version; successful spot requests still did request-time assembly. The 23:23Z
  flapping was CPU exhaustion/1102, not a transient D1 read and not deploy churn. Do not add
  a bounded D1 retry. Corrective: first deploy already-merged PR #16 (OI-5), then PR-A's
  ops status/runbook must prove active deployment + queue 1/1 + 12 ready rows.
- **OI-3:** current Cloudflare docs, Wrangler 4.118.0 schema, and latest Workers types
  verified `observability.traces.{enabled,head_sampling_rate,persist,destinations}` and the
  matching log destination keys; no tracing beta compatibility flag. Production uses an
  ignored full instance config, so it must be synchronized without committing IDs/secrets.
- **Anchor delta:** no HEAD drift. PR-B must also remove hardcoded freshness judgments from
  `forecast-adapter.ts`; PR-C's `forecastHref` must preserve tab state.
- **Baseline:** `pnpm verify` passed (332 tests, one skipped; fresh D1, build, dry-run).
- **Local e2e:** on unchanged `main`, `pnpm ingest:local` published all 12 read models and
  `pnpm smoke:local` passed with 6 spots, 12 read models, 0 pending, and scored forecasts.
  Optional Gemini brief quota/schema errors exercised their isolated fallback and did not
  affect deterministic forecast publication or the smoke result.
- **Gate:** OI-5 authorization is resolved; PR-A is blocked until the reviewed recovery hotfix
  is merged, deployed, and live-green. OI-4 operator destination setup remains open. OI-6 tracks the undocumented
  Queue trace-continuity assumption for live :17 verification.
- **Recovery record:** pre-deploy D1 Time Travel bookmark
  `0000032f-00000000-000050bd-e465c2c62dec95f0effa65f42f2151cc`; schema/data restore is
  reserved for confirmed corruption. Normal post-activation recovery is fix-forward; Worker
  rollback additionally requires Queue quiescence, no in-flight consumer, and predecessor
  payload compatibility.

### 2026-08-03 — PR-A implementation design prepared behind OI-5

- **T-A.1 ownership:** canonical source outcomes belong at the queue/inline orchestration
  boundary; canonical forecast outcomes are exactly one line per spot/interval from returned
  structured materialization results. Repository helpers remain log-free so queue retries do
  not duplicate outcome lines. The local path must carry the same `ingestId`; stable reason
  codes replace provider/error payloads. The outer queue retry diagnostic is infrastructure
  context and deliberately has no `outcome` field.
- **T-A.2 portability:** tracked `wrangler.jsonc` enables persisted 100% logs and traces but
  has no account-scoped destinations. The ignored production overlay adds only
  `surf-logfire-logs` and `surf-logfire-traces`; endpoint and `Authorization` token live only
  in Cloudflare destination objects. Config validation requires enabled logs/traces and
  rejects nonempty destinations only in the tracked canonical config.
- **T-A.3 contract:** `ops:status` makes exactly four read-only probes: HTTPS health,
  `deployments status --json`, `queues consumer worker list <queue> --json`, and one locked
  remote D1 SELECT. Exit 0 requires one 100% active version, exact remote Queue batch/
  concurrency 1/1 with the configured DLQ, and 12 unique ready spot/interval rows. Missing
  remote concurrency is unbounded/not proven and fails. Forecast JSON and secrets are never
  printed.
- **Still gated:** these are design notes only. No tracked PR-A code starts until OI-5's
  already-authorized corrective deployment is live-green. OI-4 must be satisfied
  before the eventual PR-A production overlay can deploy.

### 2026-08-03 — OI-5 recovery attempt auto-rolled back; bounded fix forward

- **Observed:** owner authorized the corrective. `pnpm deploy` created Worker version
  `9fdf8329…` at `03:02:00Z`; the bootstrap poll immediately rejected an invalid 503 for
  `obsf-north:1h`; the supported path restored `ea3a7a1e…` at `03:02:09Z` before the queued
  source job completed. Primary D1 remains 0/12; remote Queue is now correctly 1/1.
- **Reproduction:** three read-only 12-endpoint rounds against the rollback version produced
  intermittent exact Cloudflare error-1102 problem JSON on changing spot/interval pairs. The
  poller accepts only Surf's typed pending 503 and therefore aborts instead of waiting for the
  bounded publication deadline.
- **Fix-forward hypothesis:** classify only the exact Cloudflare 1102 resource-limit problem
  payload as pending during read-model bootstrap. Keep malformed/other 503s fatal; keep the
  ten-minute bound so a genuine new-version CPU regression still times out and leaves the
  activated version in place for queue-safe fix-forward.
  Independent refuters must clear this diagnosis before edit; targeted tests cover transient
  recovery, persistent timeout, and fail-closed malformed/other responses.
- **Sequence:** this is an OI-5 predecessor-recovery hotfix, not PR-A. Review, canonical verify,
  ready PR, merge, deploy, and 12/12 live proof all precede T-A.1.

### 2026-08-03 — OI-5 recovery hotfix implementation + adversarial decision trace

- **Observe:** the first deploy reached version `9fdf8329…` for only nine seconds, then old
  request-time assembly intermittently returned exact Cloudflare 1102 while the queued source
  job was still running. The old version also permissively misdecodes new materialization
  messages, so rollback across Queue work is unsafe.
- **Orient:** OI-5 is only the predecessor gate; PR-A/B/C remain untouched. The recovery must
  protect deterministic 12/12 publication and resume safely for a personal surf-planning app,
  without turning deployment probes into more Worker load or weakening malformed-response
  checks.
- **Decide:** use immutable Cloudflare version metadata as positive identity; affinity only
  stabilizes routing and is never treated as proof. Require three consecutive exact-version
  health responses, one authenticated enqueue, exact ingest lineage, sequential bounded
  publication/smoke checks, and exact six-field 1102 typing. Reject staged preview mutation
  (sandbox policy) and automatic rollback after activation: cron/manual/backlog producers can
  cross the schema boundary before the script's POST. Tradeoff: a failed activated deploy now
  demands urgent fix-forward, but cannot silently hand new messages to an incompatible old
  consumer.
- **Act/evidence:** added `CF_VERSION_METADATA` to canonical + ignored production configs,
  `X-Surf-Worker-Version` API evidence, strict config validation, exact Wrangler version
  parsing, full-body request deadlines, normalized abort/transport handling, single-POST and
  sequential pollers, two-minute sequential strict smoke, overlay-upgrade docs, and queue-safe
  failure guidance. Finder/refuter rounds fixed body-timeout, abort-race, transient-network,
  smoke-burst, activation-boundary, overlay-doc, and manifest-resumability findings. `pnpm
  verify` is green: 52 script, 21 forecast-core, 10 DB, 225 web unit (+1 skipped), 13 Worker,
  45 Python tests; fresh local ingest/smoke produced 12/12 and browser-loaded health exposed a
  version UUID. Residual risk is production rollout itself; any failure after activation must
  fix forward unless quiescence/in-flight/schema compatibility proof permits rollback.
- **Ship checkpoint:** PR #17 merged after GitHub Verify passed. Fresh pre-deploy D1 Time Travel
  bookmark: `00000336-00000000-000050bd-411681979faabc1f1884f3f58d32522c` (restore reserved
  for confirmed data corruption, never routine application rollback).

### 2026-08-03 — Autonomous handoff and OODA checkpoint protocol (OD-10)

- **Owner direction:** finish the workstream autonomously while Alex is away and leave an
  evidence-rich decision trail with tests, tradeoffs, and checkpoints.
- **Checkpoint template:** Observe repo/CI/production/browser truth; Orient against all open
  tasks, invariants, sequencing, and the product job (quick surf-session planning for Alex and
  friends, with forecasting education on demand); Decide among explicit alternatives and name
  tradeoffs; Act with a bounded mutation, queue-safe failure-recovery path, verification, and
  residual-risk note.
- **Application:** run this loop after OI-5 recovery and after each of PR-A, PR-B, and PR-C is
  live-verified. Append it here and summarize it in the WORKSTREAM Session Log before advancing.

### 2026-08-03 — Browser-led signal-to-noise amendment (OD-9)

- **Live baseline:** the home repeats its top-three recommendation in both the hero shortlist
  and comparison list; mobile hides the authoritative freshness chip. On spot detail, the large
  hero plus Daily Forecaster consume the first viewport and the selected row auto-expands more
  technical prose before the decision table settles into view.
- **Locked response:** preserve v2's visual identity but remove duplication. PR-B restores the
  mobile chip. PR-C deletes the duplicate home shortlist and weak source-count label, compacts
  phone rows, makes Forecast strictly deterministic/data-first, moves all AI, selected-window
  explanation, help, gaps, and provenance to Analysis, and does not request the brief until
  Analysis is active.
- **Browser gate:** semantic assertions plus screenshots at desktop and phone widths; Forecast
  data in the first viewport; no horizontal overflow; nested tablists distinctly named; URL
  state round-trips; hidden content absent from focus/accessibility trees; final evidence is
  invalid unless production is live-green. This amendment does not relax OD-5 sequencing or
  the OI-5/OI-4 remote gates.

### 2026-08-03 — PR #17 merged; rollout identity OODA corrective

- **Observe:** PR #17 passed canonical/GitHub Verify and merged as `80da93e`. Supported deploy
  activated `04915a00-5501-4143-ba09-86d59f2fc4c3` at 100% and corrected Queue 1/1, then
  readiness failed after 55 HTTP-200/unknown-version responses. Zero POSTs ran; queue-safe
  fix-forward left the version active. Plain and random-key requests reached the new version,
  while the UUID-as-affinity-key partition returned an aged cached predecessor response. Exact
  version override returned BYPASS + the expected Worker-owned header on workers.dev and the
  custom domain. A nonexistent override silently fell back to ordinary routing.
- **Orient:** the permanent deploy harness must separately prove that a version is callable,
  that ordinary users have converged to it, and that the actual mutation executes on it.
  Override-only smoke could pass a 0%-traffic version; response validation after POST is too
  late to prevent `Queue.send`. OI-5 still blocks all PR-A code.
- **Decide/tradeoffs:** replace affinity with active-name exact overrides; require one pinned
  success then three cache-busted unpinned successes; send an application precondition header
  and compare it with `CF_VERSION_METADATA.id` before Queue mutation; retain response-owned
  identity and exact lineage afterward. Constrain instance names to lowercase letter +
  lowercase/digit/hyphen and reject `WRANGLER_CI_OVERRIDE_NAME` drift before remote mutation.
  The extra probes and naming restriction are preferable to a false-green rollout or duplicate
  source generation.
- **Act/evidence:** branch `aylee/surf-exact-version-override` implements the four barriers,
  portable active-overlay resolution, docs, and fail-closed tests. Two independent reviewers
  confirmed the live diagnosis and found the 0%-traffic/silent-fallback risks. Targeted gate:
  53/53 Node script/config/bootstrap tests and 20/20 Worker tests green. Required cases cover
  exact header syntax, name/version pairing, arbitrary instance name, unpinned predecessor
  preventing POST, wrong metadata preventing Queue.send, exactly one accepted POST, exact
  lineage, sequential 12-target polling, and pinned strict smoke. Next: full `pnpm verify`, dry
  review, ready PR, GitHub Verify, merge, supported deploy, then dual-origin pinned/unpinned +
  12/12/queue live proof before closing OI-5.

### 2026-08-03 — Exact-version corrective verification checkpoint

- **Canonical gate:** `pnpm verify` green — isolated fresh D1 migration + seed; 60 script,
  21 forecast-core, 10 DB, 226 web unit (+1 skipped), 13 Worker, and 45 Python tests;
  production build; secretless Wrangler dry-run using the active ignored overlay.
- **Local e2e/browser:** fresh public-feed ingest published 12/12 deterministic read models;
  strict smoke reported 6 spots, 12 ready, 0 pending, scored forecasts, and a concrete local
  Worker version. The code browser loaded the daily report at desktop width with no role=alert
  surfaces and `scrollWidth === clientWidth`. Existing home duplication remains intentional
  baseline evidence for PR-C, not scope for the recovery patch.
- **First-rollout residual:** predecessor `04915a00…` lacks the new application precondition.
  For this transition only, dual pinned/unpinned readiness + one non-retried POST + unchanged
  Queue schema bound a silent-fallback risk to one compatible ingest before response mismatch.
  After this patch is active, every later deploy POST is rejected before Queue.send unless
  `CF_VERSION_METADATA.id` equals the requested version.
- **Next:** one complete dry finder/refuter round, then commit/ready PR/GitHub Verify/merge and
  the authorized supported deploy. No manual remote ingest is permitted.

### 2026-08-03 — Final corrective dry-round findings closed

- **Finding 1 (accepted):** a predecessor cannot enforce a new precondition header on its
  existing endpoint. If Cloudflare silently ignored the override, it could enqueue before the
  client rejected stale response identity. Fix: deploy-time calls now use new protected
  `/api/ingest/deploy`, absent from every predecessor. Fallback 404s with zero Queue sends; the
  new route requires auth, a nonempty expected version, present metadata, and exact equality
  before send. Manual/local `/api/ingest/once` remains backward-compatible. The transition test
  simulates exact read-only preflight followed by predecessor fallback and proves zero legacy
  sends/forecast polls.
- **Finding 2 (accepted):** live dry-run proof showed nonempty `CLOUDFLARE_ENV` makes Wrangler
  target `surf-<env>` while the harness still addresses config name `surf`. Fix: reject the
  ambient suffix before build/migration/deploy; `SURF_WRANGLER_CONFIG` remains the sole
  instance selector. Tests and self-hosting docs pin this boundary.
- **Review/gate:** correctness finder rerun returned DRY. Independent refuter verdict is the
  last review datum. Canonical `pnpm verify` after both fixes is green: 61 script, 21 core, 10
  DB, 226 web unit (+1 skipped), 13 Worker, 45 Python, fresh D1, build, dry-run. No remote
  mutation occurred; next is commit/ready PR only after independent refuter is dry.

### 2026-08-03 — Exact-version corrective review gate DRY

- **Verdict:** full finder rerun DRY; independent refuter DRY. Both independently confirmed
  predecessor fallback cannot reach a Queue route and ambient Wrangler name suffixes fail
  before build/mutation. No actionable findings remain.
- **Ready evidence:** corrected canonical verify green (61 script, 21 core, 10 DB, 226 web
  unit +1 skipped, 13 Worker, 45 Python, fresh D1/build/dry-run); local ingest/smoke 12/12;
  browser no-alert/no-overflow baseline. Proceed to ready PR/GitHub Verify/merge/deploy; OI-5
  stays open until production proof is complete.

### 2026-08-03 — Corrective PR #18 merge checkpoint

- **PR:** #18 ready (not draft), head `3e8cbf7`; GitHub Verify SUCCESS in 1m15s; merged as
  `2da1e0f` at `2026-08-04T04:21:44Z`.
- **Backup/recovery:** pre-deploy D1 bookmark
  `00000338-00000000-000050bd-e42c3237af77fc956eebe86e8b322909`. Time Travel restore only
  for corruption; post-activation application failures fix forward unless Queue safety is
  proven. No schema change in the corrective.
- **Next:** supported `pnpm deploy`, then record uploaded/active UUID, exact one POST lineage,
  12/12 publication/smoke, queue 1/1, and both pinned/unpinned identity on workers.dev and the
  custom domain. OI-5 remains open and PR-A untouched until all live evidence is green.

### 2026-08-03 — PR #18 live failure and third recovery OODA

- **Observe:** supported `pnpm deploy` completed migration/seed through D1 bookmark
  `00000338-00000004-000050bd-81a23bf98cdc17be8efa64af1a9a3c69`, uploaded
  `c0075263-2f92-47ae-bbcc-d3a12a9fbbe7`, and Cloudflare deployment
  `6e5f40dc-a4f3-4fae-ba75-af76b8ad8f5e` reports exactly that version at 100%. One exact
  override and three cache-busted unpinned health checks matched the version. The one protected
  POST `/api/ingest/deploy` returned 404/null and therefore produced no accepted ingest. A
  post-failure read-only D1 SELECT found zero `source_runs` since 04:20Z; Queue still reports
  one producer and one consumer. Version inspection and the local production bundle contain
  the route, so the 404 path contradiction is recorded rather than guessed away.
- **Orient:** c007 is healthy and remains active; rollback would cross a live Queue schema
  boundary without quiescence proof. OI-5 continues to block PR-A and all product/UI work. The
  deployment harness must prove both rollout state and an atomic no-wrong-version mutation;
  sequential GET/control-plane evidence alone remains vulnerable to propagation or concurrent
  deployment TOCTOU. For the personal surf-planning job, correctness and predictable hourly
  publication outweigh another narrow recovery PR and the extra deployment latency.
- **Decide/tradeoffs:** reject simply returning deploy traffic to POST `/api/ingest/once`
  because c007 cannot enforce the expected-version header. Use predecessor-absent PATCH on
  `/api/ingest/once`: c007 knows only POST and therefore 404s before Queue access, while the new
  PATCH handler requires auth, a valid expected UUID, present `CF_VERSION_METADATA`, and exact
  equality before `Queue.send`. Retain POST for manual/local compatibility. Add a pure,
  fail-closed parser for `wrangler deployments status --json` requiring exactly one expected
  version at numeric 100%, in addition to exact-override and three unpinned probes. Tradeoff:
  method asymmetry is unusual, but it is explicit, testable, and preserves first-transition
  atomicity without relying on the unexplained deploy-only path. PATCH is deliberately chosen
  over PUT because RFC 9110 permits automatic retry of idempotent PUT after connection loss,
  whereas PATCH is non-idempotent by default; the client also forbids redirects and retries.
- **Act/evidence:** no mutation was replayed. Read-only checks captured the deployment JSON,
  Queue 1/1, version/bundle route presence, and zero post-attempt source runs. Two adversarial
  reviewers are independently challenging the candidate before code begins. The next action
  is a narrow branch only after a dry design verdict; then targeted tests, canonical verify,
  local e2e/browser, finder/refuter dry round, ready PR, GitHub Verify, merge, and exactly one
  supported deploy.

### 2026-08-03 — Third recovery implementation and adversarial decision trace

- **Finder round 1:** rejected ordinary POST because c007 cannot atomically enforce its new
  header. Accepted method-versioning, then rejected PUT: RFC 9110 permits automatic retry of
  idempotent PUT after a lost response while `Queue.send` is not idempotent. PATCH is exact-
  method routed by Hono/Cloudflare, non-idempotent by default, absent from c007, and therefore
  gives the same zero-send predecessor fence without inviting standards-compliant replay.
- **Refuter round 1:** required an unprivileged liveness probe before the real mutation. The
  unpinned PATCH must return 401, `WWW-Authenticate: Bearer`, and the expected Worker-owned
  version header; only then may exactly one authenticated PATCH run. There is no redirect,
  retry, or POST fallback. Any failure prints method/path/status/Worker UUID/CF-Ray and a
  bounded sanitized body.
- **Finder round 2:** found override-pinned catalog/poll/smoke could false-green after default
  routing regressed. Exact override is now one read-only reachability proof only. Three health
  probes, catalog, route probe, mutation, all 12 lineage polls, and strict smoke use ordinary
  routing and independently require the expected response UUID. `wrangler deployments status
  --json` must contain exactly one expected version at numeric 100% both pre-enqueue and
  post-smoke; malformed, missing, duplicate, partial, wrong-strategy, and wrong-version states
  fail closed.
- **Finder round 3:** version-metadata upload time could predate a later `:17` generation and
  force the deploy lineage to skip as superseded. The Worker now captures generation time at
  the authenticated request, restoring the minimal preexisting race window, while immutable
  version UUID remains the replay-stable ingest identity. Queue batch/concurrency 1 and
  run-key/ingest lineage make duplicate unsafe requests converge rather than claim two
  generations. The producer precondition does not version-pin asynchronous consumption; that
  residual is explicit in the runbook and future payload-breaking deploys require consumer-
  side fencing or backward compatibility.
- **Finder round 4:** JSON-only parsing discarded the exact c007 plain-text 404, and truncating
  before redaction could expose a token prefix across the evidence boundary. Failure evidence
  now retains bounded single-line raw text and structured JSON, redacts sensitive values before
  any slicing, and has CF-Ray/plain-text/boundary regressions. No secret is printed.
- **Verification so far:** targeted gates green (all 68 script/config tests before the last
  added boundary case; final remote/deployment subset 28/28; web unit 226 +1 skipped; Worker
  13/13). Canonical `pnpm verify` passed the substantive design with fresh D1, 68 Node, 21 core,
  10 DB, 226 web unit +1 skipped, 13 Worker, 45 Python, build, and secretless dry-run; rerun it
  after final dry verdict because boundary tests landed afterward. Fresh local public-feed
  ingest published 12/12 read models; strict smoke returned 6 spots, 12 ready, 0 pending, and a
  concrete Worker UUID. Code browser found zero alerts and no horizontal overflow at 1093 px.
  Optional brief-agent date errors were isolated and did not affect deterministic publication.

### 2026-08-03 — Third recovery final dry gate

- **Last P1 and tradeoff:** a stable version-scoped ingest ID plus fresh request timestamps
  could reuse a source-run row whose immutable older `started_at` let a delayed intermediate
  generation pass. Alternative A added a client operation-ID/timestamp protocol; alternative B
  made the existing persisted fence monotonic. Chose B: less protocol surface and it also makes
  freshness/provenance coherent whenever a lineage is deliberately reused. The conditional
  upsert advances `started_at` and coupled metadata only for equal/newer logical timestamps;
  older same-ID writes cannot regress either. Real workerd D1 proves t1→t2 advancement,
  `sourceGenerationIsCurrent(t1.5) === false`, and no delayed t1.5 metadata overwrite.
- **Final P2s:** body/transport failure after authenticated PATCH is inherently ambiguous, so
  errors preserve name/cause while stating method/path and “mutation may have occurred; do not
  retry”; route-probe errors explicitly say mutation did not begin. Docs no longer describe
  status reads as an atomic lock: they are before/after evidence, while exact immutable UUID
  comparison is the Queue-write safety boundary.
- **Dry verdict:** correctness finder DRY; independent refuter DRY. No actionable finding
  remains after approximately four adversarial rounds.
- **Final gate:** `pnpm verify` green — fresh isolated D1; 70 Node script/config tests; 21
  forecast-core; 10 DB; 226 web unit (+1 skipped); 14 workerd/Worker; 45 Python; production
  build; secretless Wrangler dry-run. Local public-feed ingest published 12/12, strict smoke
  returned 6/12/0 with a concrete Worker UUID, and the code browser found zero alerts/no
  horizontal overflow. Ready for commit, ready PR, GitHub Verify, merge, and supported deploy.

### 2026-08-03 — PR #19 live failure and fourth recovery OODA

- **Observe/evidence:** PR #19 (`8d6cd97`) passed GitHub Verify and merged as `fd70a23`.
  Supported deploy preserved D1 bookmarks `0000033a-00000000-000050bd-d9f14ff001707c25b28114f83db287d7`
  (before) and `0000033a-00000004-000050bd-40343f2004693c48dea91d2dd18aab95`
  (after seed), then activated `ce93cdde-30b9-493a-9b17-8fb0f7eabe39` at 100%. The ordinary
  unauthenticated PATCH probe reached ce93 and returned the expected 401, but its immediately
  following authenticated PATCH reached predecessor `c0075263…` and returned its exact Hono
  404 (`404 Not Found`, `CF-Ray a25af5ced9ed1321-SJC`). Post-attempt D1 has zero source runs
  since 04:52Z; Queue is 1/1; deployment remains ce93-only at 100%.
- **Orient:** PR #19's queue-write barrier worked exactly as designed; its liveness assumption
  did not. Cloudflare's status and nearby requests are evidence, not a request-level routing
  lock. OI-5 still blocks T-A.1 and every UI task, and the product's deterministic forecast
  lineage must remain more trustworthy than rollout speed.
- **Decide/tradeoffs:** reject a manual replay, rollback without quiescence, blind retry, or
  readiness-only loop. Permit a bounded repeat only after protocol-level proof of no mutation:
  stale Worker-owned UUID plus either the permanent legacy no-route fingerprint (404, exact
  Hono body/content type) or exact PATCH-aware 409 mismatch JSON whose header/body identities
  agree. Stop on every ambiguous response and every 202, including malformed 202. Durable
  idempotency is safer but materially larger; keep it as fallback if exact protocol proof does
  not survive review.
- **Act/next gate:** three independent reviewers are challenging the design before code. If
  dry, implement pure classification plus attempt/deadline bounds and adversarial tests for
  the ce93→c007→ce93 transition, PATCH-aware predecessor, cap exhaustion, near misses,
  ambiguity, and no request after acceptance. Then canonical verify, local e2e/browser,
  finder/refuter dry round, ready PR, GitHub Verify, merge, and one supported deploy. PR-A
  remains untouched until one live lineage and 12/12 are proven.

- **Read-only follow-up (05:02Z):** no-auth/no-body PATCH probes could no longer reach c007.
  Both custom and workers.dev exact overrides fell through to ce93, and 32 affinity-keyed
  ordinary requests (including adjacent pairs) were 32/32 ce93 with the typed 401 contract.
  This cannot prove future routing, but it supports a one-command bootstrap allowlist rather
  than a permanent arbitrary-404 heuristic. The allowlisted UUID remains runtime-only and the
  exact 404 fingerprint remains mandatory.

### 2026-08-03 — Fourth recovery implementation, final DRY gate, and local OODA

- **Implemented protocol:** one random `Cloudflare-Workers-Version-Key` is reused for versioned
  catalog/probe/auth handoff requests but never treated as target selection. Catalog and no-auth
  PATCH poll under one 60-second clock until the exact target contract is visible. At most three
  authenticated PATCH attempts are permitted; a repeat requires either the exact typed pre-Queue
  409 (`error`, `expectedWorkerVersion`, `actualWorkerVersion`, header/body agreement) or the
  one runtime-allowlisted c007 Hono 404 (`text/plain; charset=UTF-8`, exact `404 Not Found`).
  Every 202 is terminal even if its body is malformed. All transport/body ambiguity, redirects,
  unexpected success/failure, identity mismatch, and classifier near misses are terminal and
  explicitly prohibit retry.
- **Evidence and configuration boundary:** safe rejections emit one bounded/redacted structured
  diagnostic immediately and survive into later failure evidence; tokens and affinity keys are
  never logged. `SURF_LEGACY_PATCHLESS_WORKER_VERSION` is accepted only as a shell-only deploy
  input and is validated by `cf-deploy.mjs` before build, Queue inspection, D1 migration/seed,
  or activation. A child-process regression runs `deploy --dry-run`, proving malformed input
  fails without risking a remote mutation. The value is absent from Wrangler and repository
  configuration by design.
- **Post-accept and smoke correctness:** forecast polling reads the Worker UUID before interpreting
  HTTP/status/body, so rollout-old 404/500/invalid responses stay pending instead of failing a
  potentially healthy target publication. Version-strict smoke uses ordinary routing and restarts
  its whole health/catalog/all-forecast round on any wrong or missing UUID; only one fully clean
  target round passes. Exact-target HTTP, JSON, schema, and data defects still fail fast, and
  response-body cancellation on known skew cannot stall the deadline.
- **Adversarial review:** successive finder/refuter rounds found and closed generic-stale replay,
  single/unkeyed catalog reads, evidence loss after malformed 202/transport, late bootstrap
  validation, an unsafe negative deploy test, identity-after-status polling, partial-round smoke,
  and awaited stale-body cancellation. Final correctness refuter: DRY. Independent second-look:
  DRY. Independent full-diff finder: DRY. Majority-refuted or obsolete findings were not carried
  forward; no actionable finding remains.
- **Canonical/local gate:** `pnpm verify` passed fresh isolated D1 migrations + seed; 112 Node
  script/config tests; 21 forecast-core; 10 DB; 226 web unit (+1 skipped); 14 Worker; 45 Python;
  production build; secretless Wrangler dry-run. Local public-feed ingest completed partial only
  because NDBC reported a non-fatal caveat, while the deterministic outputs were complete:
  12 forecast read models and 36 fact bundles. Strict smoke: 6 spots, 12 ready, 0 pending, scored
  forecasts. In-app browser at 1093×1243: correct report, zero alerts, zero horizontal overflow.
  Six optional brief-agent signals reported a local-date/fact mismatch after deterministic
  publication; keep that as explicit PR-C Analysis-path coverage rather than treating optional
  prose as forecast availability.
- **OODA — Observe:** tests now exercise the exact ce93→c007→target race and its near misses,
  while real local workerd proves end-to-end publication and rendering. The recovery changes no
  forecast facts or UI. **Orient:** deterministic lineage is the trust substrate for both the
  cadence-aware chip and the educational Analysis view; friends should never act on duplicated
  or falsely attributed updates, but a permanently unshippable app is also a product failure.
  **Decide:** choose exact proven-no-op replay with a three-attempt/one-minute bound and one clean
  smoke round. This costs rollout latency and one tightly scoped legacy bootstrap value, but has
  far less state/protocol surface than durable idempotency and keeps ambiguous outcomes terminal.
  **Act:** move to a ready PR and GitHub Verify. After merge, capture a D1 bookmark and perform
  one supported deploy with the c007 UUID inline. OI-5 closes only on target-only dual-origin
  identity, one source lineage, 12/12, deployment 100%, queue 1/1, and browser proof; otherwise
  leave the activated Worker in queue-safe fix-forward unless rollback safety is positively proven.

### 2026-08-03 — PR #20 live failure and affinity-session rotation OODA

- **Merge/deploy evidence:** PR #20 (`c0c3539`) passed GitHub Verify in 1m12s and merged as
  `7d7b04209f36895d2ac641e6ef16c13b5918c58f` at `05:34:36Z`. Time Travel info remained
  unavailable through the local OAuth credential, so recovery retained the 04:52 bookmark plus
  D1 point-in-time restore; no migration/seed content changed. Idempotent seed completed at
  bookmark `00000340-00000004-000050bd-e3bd374fc658291057f24d5f5b97b9a7`. Supported deploy
  activated `ce82bb5d-b9ba-46db-8621-c68fcb8ffbac` in deployment
  `e4c83439-2632-48c7-a50e-112ab1085e6b`, proved exact override + three ordinary responses,
  and proved one version at 100% before the handoff.
- **Failed-closed boundary:** one random version-affinity key then produced 57/57 catalog GETs
  from predecessor `ce93cdde…` until the shared 60-second deadline. No route probe, token, body,
  authenticated PATCH, Queue send, or forecast polling occurred. The script reported mutation
  did not begin and left ce82 active for queue-safe fix-forward. Preflight Queue evidence was
  exactly 1 producer/1 consumer.
- **Live hypothesis test:** read-only/no-auth sampling used 12 fresh keys with two adjacent GETs
  per key on both custom and workers.dev origins. Result: 48/48 ce82, zero within-key split pairs.
  This distinguishes stale deterministic key assignment from POP-wide rollout failure and agrees
  with Cloudflare's documented semantics: a key consistently maps within a deployment but does
  not choose the target version.
- **Independent design review:** all three reviewers reject same-key extension, affinity removal,
  override-pinned mutation, manual replay, and rollback. Majority verdict requires a complete
  candidate session: fresh UUID → exactly one keyed target catalog → exactly one same-key no-auth
  PATCH →, only after exact target 401/Bearer, exactly one same-key auth PATCH. Stale/missing/
  transport/body read-only outcomes discard the key and restart at catalog after 1s. Exact-target
  catalog/auth-contract defects fail fast; unauthenticated 2xx and every authenticated ambiguity
  remain terminal. Exact typed 409 or allowlisted legacy 404 alone consumes an auth attempt and
  permits a new candidate. One shared 60s deadline, global 60-session cap, and max three auths.
- **Tradeoff:** re-fetching the target catalog on every fresh probe session is not strictly needed
  to know spot IDs, but it gives one coherent per-key catalog→probe→auth chain and makes review
  evidence simpler. It costs one read-only request per rotated candidate. With the global session
  and time bounds, that cost is preferable to carrying state from an invalidated key. The c007
  bootstrap exception was scoped to PR #20 exactly as planned and is retired for the next deploy.
- **Implementation/test state:** `aylee/surf-affinity-session-rotation` rotates unique UUID
  sessions, rejects invalid/reused test-factory keys without printing them, retains global
  catalog/probe/session/auth counters and safe-rejection evidence, and returns keyless
  `versionAffinitySessions` plus `authenticatedAttempts`. Focused tests are 77/77 and the full
  script suite is 131/131 after adding
  deterministic stale/transport catalog rotation, target-catalog→stale-probe full restart,
  safe-auth full restart, global cap, invalid/duplicate factory, ambiguity, and no-leak coverage.
  Later finder/refuter rounds also forced header-only terminal handling for unauthenticated 2xx
  and exact-target defects, token/key redaction across transport causes, retention of prior safe
  evidence in later failures, exact `authenticatedAttempts` accounting, the deadline-crossing
  pre-auth boundary, and a full-session assertion for probe-transport recovery. Runbook wording
  now reflects fresh-session sampling instead of whole-handoff stable-key polling.
- **OODA — Observe:** write safety held; deterministic affinity liveness failed. **Orient:** the
  lineage substrate must be both non-duplicating and deployable before freshness/Analysis can be
  trusted by friends planning a surf session. **Decide:** rotate only while zero-mutation evidence
  is positive, and freeze one winning key across the three-step candidate. **Act:** finish full
  suite, adversarial diff review, canonical/local browser gates, ready PR, GitHub Verify, merge,
  and one supported deploy without the legacy UUID. OI-5 remains open until target-only identity,
  one accepted lineage, 12/12, deployment 100%, Queue 1/1, and browser proof all pass.

### 2026-08-03 — Fifth recovery ready-PR checkpoint

- **Review gate:** two independent frozen-snapshot reviewers returned DRY after approximately
  three finder/refuter rounds. Closed findings cover the stable-key liveness trap, header-only
  unauthenticated 2xx and target-defect termination, exact-target catalog fail-fast behavior,
  token/key redaction across response and transport causes, retention of prior safe evidence,
  actual rather than prospective auth-attempt diagnostics, catch-path full-session continuity,
  and the deadline-crossing-before-fetch counter edge. Accepted residual risk: fresh affinity
  keys sample but cannot select the target Worker, so the 60-session/60-second bound may still
  fail closed and require another fix-forward.
- **Automated gates:** focused remote-ingest 77/77; full scripts 131/131; `git diff --check`
  clean. Fresh canonical `pnpm verify` passed 131 Node, 21 core, 10 DB, 226 web unit (+1
  skipped), 14 Worker, 45 Python, isolated D1 migration/seed, production build, and secretless
  Wrangler bundle dry-run.
- **Local e2e/browser:** `pnpm ingest:local` published 12 forecast read models from public feeds
  with the known non-fatal NDBC partial caveat. `pnpm smoke:local` returned 6 spots, 12 ready,
  0 pending. The code browser rendered the full report at 1280px with no alerts, no console
  warnings/errors, and `scrollWidth === clientWidth` (no horizontal overflow). Optional Gemini
  brief generation independently hit quota/schema and prior-local-date failures; it did not
  affect deterministic read-model publication and remains a PR-C Analysis-path test note.
- **Tradeoffs:** retain one target catalog per candidate even though spot IDs are stable, because
  it proves one coherent catalog→probe→auth assignment and prevents state from crossing a
  discarded key. Count an authenticated attempt immediately before the fetch call and freeze a
  positive request budget first, so diagnostics neither understate a sent credentialed request
  nor overstate one blocked by the shared deadline. The consumed c007 legacy shell exception is
  documented as historical and will not be supplied to the next deploy.
- **OODA:** Observe — code, tests, runbook, and diagnostics now encode the same mutation boundary.
  Orient — deployability is a prerequisite for honest freshness and a teachable forecast UI, not
  incidental tooling. Decide — preserve bounded fail-closed liveness risk rather than permit a
  blind or ambiguous replay. Act — ready PR → GitHub Verify → merge → exactly one supported
  deploy; close OI-5 only on target-only dual-origin identity, one lineage, 12/12, deployment
  100%, Queue 1/1, and production code-browser proof. PR-A remains blocked until then.

### 2026-08-03 — PR #21 live failure; cron-safe Queue-tail fix-forward

- **Merge/control plane:** PR #21 (`ec0e222`) passed GitHub Verify in 1m29s and merged as
  `51849a8dcdcd994ec2420edddd1ce7e42c8d41df` at `06:11:53Z`. Pre-deploy state was
  `ce82bb5d…` at 100%, Queue 1 producer/1 consumer, DLQ present, D1 recovery bookmark
  `00000343-00000000-000050bd-83c68ca69e04f678e438127ce7b612af`, and legacy override unset.
  Seed advanced to `00000343-00000004-000050bd-8b408874d63624808bbf8bce5e29f2c1`.
  Supported deploy activated `8ce5bdf1-9b9b-4496-ab3b-08089f09a1a8` in
  `04dbca1e-9e55-41dc-bcf4-9fe3124965ab` at exactly 100% after exact + three ordinary probes.
- **Accepted lineage/failure:** one exact target handoff began at `06:13:19.808Z`; five source
  runs completed by `06:13:43.490Z` (CO-OPS/NWS point/NWS wave/CDIP success; NDBC partial only
  for optional missing/stale observations). Five spots published by `06:13:48.853Z`; the command
  reached its ten-minute bound with only Bolinas 1h/3h pending and explicitly left the activated
  Worker in fix-forward. No replay or rollback occurred.
- **Supersession evidence:** cron lineage `541dcaff…` began at `06:17:27.614Z`, published four
  spots by `06:17:57.258Z`, and made any older queued child unable to overwrite those rows under
  the monotonic generated-at fence. Current rows are mixed: OB×3/Linda on cron, Stinson on deploy,
  Bolinas on 05:17 lineage `3eae0acd…`. Exact production headers agree with D1 on Worker 8ce.
- **Negative/equivalence proof:** read-only exact-code reconstruction from production rows at
  06:13 produced 121/121 scored 1h windows, 41/41 scored 3h windows, 402,585/147,208-byte
  forecast payloads, and six fact bundles ≤24,312 bytes. All five source rows were persistence
  ready. Therefore auth/routing, sources, deterministic assembly, schema, and payload limits are
  refuted; the residual is Queue child execution/persistence-tail, whose exact exception was not
  durably recorded and could not be recovered by a post-fact live tail.
- **Code-shaped corrective:** before starting the 60-second affinity handoff, defer when the
  ten-minute exact-lineage verification horizon would cross the hourly :17 trigger, and resume
  only after a conservative post-cron settle window. During polling, a valid different ingest
  with strictly newer generated-at is terminal supersession, never indefinite pending or mixed
  success. Add structured child start, publish, materialization failure, superseded, and
  post-publish brief-signal failure evidence; keep Queue batch/concurrency 1.
- **OODA/tradeoff:** Observe — handoff safety/liveness passed; downstream exact-lineage liveness
  collided with an unordered Queue and scheduled supersession. Orient — one old spot hidden by
  eleven recent rows is precisely the trust failure freshness UI must expose, not normalize.
  Decide — accept up to a conservative pre-handoff wait and immediate explicit failure on newer
  lineage; reject longer blind polling, mixed-lineage success, manual replay, or rollback after
  acknowledged mutation. Act — narrow recovery PR, finder/refuter dry gate, canonical/local,
  GitHub Verify, merge, and one supported deploy. PR-A remains blocked until full live proof.

### 2026-08-03 — Sixth recovery ready-PR checkpoint

- **Confirmed/refuted findings:** the first full-round HTTP poller closed cumulative readiness
  but not within-round TOCTOU; a refuter reproduced false success after an earlier target was
  overwritten. A second refuter reproduced an unsafe clock jump between the initial cron guard
  and handoff. A logging refuter proved the queue-level brief-failure event was synthetic because
  the real optional brief helper catches and resolves. All three findings were accepted and
  corrected; final aggregate client/config review plus endpoint compatibility review are DRY.
- **Atomic readiness corrective:** public no-store `GET /api/forecast-readiness` executes one
  prepared/bound metadata-only D1 statement across active regional spots × 3h/1h. Its response
  includes exact target/generation/ingest/generated/materialized metadata and never
  `forecast_json`. The deploy client strictly validates schema, target keyset, content type,
  generation/timestamp consistency, and target Worker identity. Only one all-exact statement
  snapshot succeeds; old/equal rows remain pending; any valid strictly newer foreign lineage
  terminates. Full forecast GETs remain strict-smoke consumers, not publication authority.
- **Mutation-time corrective:** the initial cron guard returns its validated timestamp and
  anchors the existing 60-second handoff deadline before affinity-key generation or networking.
  A suspension beyond the deadline creates zero keys/requests. A final synchronous check before
  each authenticated PATCH catches jumps during read-only handoff and fails without sleeping on
  an aging key. The schedule literal is shared with config validation, which requires exactly
  `17 * * * *`; the Queue remains batch/concurrency 1.
- **Real observability corrective:** child start/publish/supersede/lineage/materialization
  failure paths emit bounded structured evidence. Optional brief failure ownership remains in
  the production helper; it now records one `forecast_brief_signal_failed` event with lineage,
  then resolves so the deterministic publication is ACKed and never retried. This explicitly
  refutes brief signaling as the cause of Bolinas missing publication because publish logging
  precedes brief work.
- **Verification:** focused remote-ingest 99/99; focused Worker 49/49; full `pnpm verify` green:
  scripts 154/154, core 21/21, DB 10/10, web unit 240 (+1 skipped), workerd/D1 15/15, Python
  45/45, isolated migration/seed, production build, secretless Wrangler bundle; diff check clean.
  Fresh local public-feed ingest wrote 12/12 read models (known non-fatal NDBC partial, zero
  errors); strict smoke returned 6 spots/12 ready/0 pending. `/api/forecast-readiness` returned
  one no-store 2,774-byte/12-row snapshot with the exact local Worker version. Code-browser
  daily-report + Bolinas checks at 1280×720 found zero alerts, console warnings/errors, or
  horizontal overflow. The unchanged AI-first spot baseline remains deliberately noisy and is
  evidence for, not scope expansion into, PR-C's Forecast-default tab.
- **Tradeoffs:** one aggregate metadata query every poll is cheaper and stronger than twelve
  forecast GETs. Public exposure is limited to metadata already carried in public response
  headers. The ten-minute settle window mitigates but cannot prove Queue emptiness, so newer
  lineage remains terminal and any post-202 failure remains queue-safe fix-forward. JS/TS
  generation regexes are duplicated but currently identical; sharing a fixture is non-blocking.
- **OODA:** Observe — sequential reads, reset clocks, and synthetic tests each created plausible
  but false evidence. Orient — this app should stay quiet and trustworthy for friends planning
  surf, so the smallest useful operations surface is one indexed snapshot and causal logs, not a
  schema or replay subsystem. Decide — require atomic evidence, anchor time before handoff, keep
  optional AI non-gating, and preserve strict no-replay/fix-forward rules. Act — ready PR →
  GitHub Verify → merge → exactly one supported deploy; close OI-5 only on dual-origin target
  identity, one lineage/12 rows, Queue 1/1, strict smoke, and production code-browser proof.

### 2026-08-04 — PR #22 live recovery checkpoint; OI-5 resolved

- **Ship evidence:** PR #22 passed its two independent DRY passes, canonical/local ladder, and
  GitHub Verify, then merged as `334c9071dfa3c8607383410dd1a1c623b2066d37` at `07:17:31Z`.
  Exactly one supported deploy activated Worker `04e3ace7-78b2-4f03-b722-44cc7cd0c126` in
  deployment `e3ab7a95-3a2a-4839-9910-15cc2cbd15de`; authenticated status had that sole version
  at 100% before enqueue and after smoke. Pre-deploy/seed/post-proof D1 recovery bookmarks were
  `00000347-000000d8-000050bd-c8eefe6a78750cc70af40919b6564957`,
  `00000347-000000dc-000050bd-7822198dfc0b4c58f36ecf5143f49065`, and
  `00000348-000000fc-000050bd-e9575969459305a3ef9ef348f15658c6` respectively.
- **Real cron-collision proof:** predecessor cron `7d430198…` completed 12/12 before upload.
  The new deploy then emitted `remote_ingest_cron_deferral` with resume `07:27:00Z`, performing
  no handoff mutation during the collision window. At `07:27:00.914Z`, one affinity session and
  one authenticated PATCH were accepted. Five source rows completed by `07:27:22.746Z` (four
  success; NDBC partial with known optional caveats, no recorded error). Six serialized Queue
  children published all rows by `07:27:29.599Z`.
- **Independent atomic/data-plane proof:** a primary-served, zero-write D1 query grouped the
  current table into one exact ingest suffix, one generation time, 12 models, six spots, and two
  intervals. The twelve keyed rows are schema 1, nonempty, and span materialization
  `07:27:23.402Z`–`07:27:29.599Z`. Custom and workers.dev aggregate responses were byte-identical,
  200/JSON/no-store/cache-bypass, exact Worker, exact 6×{3h,1h} keys, canonical chronology, and
  no duplicate/missing/extra target. Strict smoke on both hostnames returned six spots, 12 ready,
  zero pending, scored forecasts. Queue inspection independently showed one producer/one
  consumer, batch/concurrency 1, retries 3, and expected DLQ.
- **Browser/product proof:** daily report and Bolinas reloaded after target publication with no
  alert, console warning/error, or desktop overflow. An independent 390×844 pass had no mobile
  overflow and exposed deterministic workbench data. The source-age chip disappearing on phone
  and AI Daily Outlook consuming the first spot viewport are accepted baseline evidence for
  OD-9/PR-B/C, not PR #22 regressions.
- **Tradeoffs:** the cron settle adds up to ten minutes to a ship-time ingest and the public
  aggregate adds one small indexed metadata SELECT per poll. Those costs buy a coherent proof
  and eliminate mixed-lineage false positives. It still does not claim Queue quiescence, so
  terminal supersession and fix-forward after any accepted 202 remain mandatory. No replay,
  migration, queue-drain controller, or payload behavior was added.
- **Boundary OODA:** Observe — control-plane activation and data publication are distinct; the
  guard preserved that distinction and every independent surface converged on one target cycle.
  Orient — a friends-and-family surf planner needs quiet, causal trust more than elaborate ops;
  deterministic forecasts remain authoritative and optional AI remains non-gating. Decide —
  close OI-5, preserve atomic/serialized/fix-forward constraints, and carry the concrete mobile
  freshness + AI-first noise into the already-planned UI legs. Act — update the singular ledger
  and both logs, remove the temporary reconstruction after checkpointing, then branch PR-A from
  `334c907`; do not open PR-B until PR-A has its real :17 trace and 12-ready ops proof.

### 2026-08-04 — PR-A stabilized pre-ready checkpoint

- **Task reconciliation:** T-A.1 and T-A.3 are repo-complete and ended with a parallel DRY
  review. T-A.2's repo/config/runbook half is complete; its account-side OI-4 destination/token
  remains operator-owned. T-A.4 is still in progress because review is dry but the canonical
  listener/local e2e evidence is missing. T-A.5 and every B/C task remain untouched.
- **Pipeline authority:** orchestration emits one source terminal plus one terminal per
  spot/interval. D1 `meta.changes` decides publish vs supersede. Nonretryable
  skip/supersede ACK; retryable failure rejects. Mixed publish/supersede is logged literally
  and ACKed, with no history or Agent signal; a later complete generation repairs the pair.
  Source-stage success reasons now say `inline_source_persistence_completed[_with_caveats]`
  so they cannot contradict interval publication facts.
- **Privacy + optional Agent:** every touched console boundary uses fixed events/reason codes
  and a total, single-read allowlisted error-name bucket. Exact published lineage is compared
  with the active D1 fact bundle before RPC. The Agent separately persists a per-date
  generated-time high-water, bootstrapped through integrity-checked legacy state and advanced
  on every enabled equal/newer signal even when material coalesces. Older callbacks cannot
  rotate job tokens or queue work; high-water survives queue-submission cleanup. Equal-time
  material corrections remain intentionally eligible.
- **Ops/config:** tracked Wrangler config persists 100% invocation logs and automatic traces
  but stays destination-neutral. The ignored overlay contains only the two destination names.
  `ops:status` performs one bounded health GET plus exactly deployment, Queue-consumer, and
  metadata-only D1 probes; it proves serving-version identity, Queue 1/1 + DLQ, and six
  canonical synchronized 1h/3h pairs without requiring every spot to share one generation.
  Generic Cloudflare children are finite; exact operator-held `tail` is the sole unbounded
  exception. The runbook records Logfire US/EU endpoints, token placement, :17 proof, and
  configuration-only rollback.
- **Adversarial rounds:** Round 1 confirmed raw-error leakage, deterministic retry after
  terminal skip/supersede, unbounded subprocesses, missing top observability enablement, and
  noncanonical timestamps; a refuter caught the initial `tail` regression. Round 2 confirmed
  split-pair ops false positives, arbitrary/hostile error-name escape, and invalid inline
  signaling; refuters proved the missing generation fence. Round 3 confirmed read→RPC
  regression, same-material high-water loss, and false forecast-publication source reasons.
  Each majority-confirmed finding was corrected; majority-refuted candidates died. The final
  independent runtime and ops/security passes are DRY.
- **Testing notes:** fresh serial results are scripts 182/182; web unit 263 passed +1 skipped;
  focused Agent/order + inline Queue + Worker 57/57; web type/config check; TypeScript;
  production Vite build; secretless ignored-overlay Wrangler dry-run; diff check clean. One
  App timer miss under a reviewer's deliberately parallel run passed isolated and in the serial
  suite, refuting product failure. New workerd tests cover real D1 write authority, direct and
  coalesced B→A races, queue-failure high-water survival, and corrupt bootstrap, but local
  listener creation is denied with `EPERM`. Root `pnpm check` independently fails at
  `tsx` seed-check IPC for the same environment reason. No canonical `pnpm verify`, local
  public-feed ingest/smoke, or production mutation is claimed.
- **Tradeoffs:** four compact probes and 100% telemetry are proportionate at six hourly spot
  jobs; no broad admin API, replay controller, migration, raw payload logging, or global
  freshness heuristic was added. A tiny durable high-water row costs storage but prevents
  stale optional analysis from reasserting authority. Preserving equal-time corrections and
  independent complete spot generations avoids inventing an ordering rule the deterministic
  source does not own. Failed newer Agent submission still fences older work, while exact/newer
  retries remain possible.
- **OODA:** Observe — repo tests/config/log semantics and two final reviewers agree, while
  listener-backed local evidence and OI-4 do not exist. Orient — operational detail earns its
  place only when it improves trust for Alex and friends; deterministic forecast facts lead,
  optional AI stays non-gating, and B/C cannot start on an unproved predecessor. Decide — keep
  the diff frozen, record the environmental red gate honestly, and publish only as incomplete
  to obtain GitHub evidence; require operator-shell local proof and destination provisioning
  before ready/merge/deploy. Act — checkpoint manifest/plan, commit/push without
  `.playwright-mcp`, obtain GitHub Verify, request `!pnpm verify` + local ingest/smoke and
  OI-4, then ready/merge/deploy and wait for the next actual :17 before T-B.1.

### 2026-08-04 — Draft PR #23 first GitHub Verify corrective

- **Evidence:** run `30894701075` passed isolated migrations/seed, checks, scripts 182/182,
  web unit 263 (+1 skipped), the new real-D1 publication test, and every new Agent race test.
  Workerd ended 17/18 because an older terminal-recovery test expected `terminal` after a
  newer same-material input had already advanced durable high-water.
- **Verdict/fix:** actual `superseded` is correct: older G0 must lose authority before
  terminal cooldown logic once G1 is the latest observed generation. Change only that
  assertion/comment; queue count and later G1 recovery/publish assertions remain. Independent
  review is DRY; focused Agent unit 5/5, type/config, and diff checks pass.
- **Gate:** PR #23 remains draft. Push the test-only correction and require second GitHub
  Verify green. OI-4 and operator-shell `pnpm verify` + local ingest/smoke still gate ready
  status; no deploy or Phase B work is authorized yet.

### 2026-08-04 — PR #23 second GitHub Verify green

- **Evidence:** commit `5787482` passed run `30895038090` in 1m16s. The canonical
  `pnpm verify` job completed fresh isolated D1 migration/seed, repository and package
  checks, scripts, web unit, all 18 workerd tests (including new real-D1 and Agent ordering
  regressions), Python, production build, and the secretless Wrangler bundle.
- **Gate state:** GitHub Verify is closed green. T-A.4 remains in progress, and PR #23 remains
  draft, because the required operator-shell `pnpm verify` plus local public-feed
  ingest/smoke and OI-4 provisioning are still absent. No merge, deploy, or Phase B work.

### 2026-08-04 — PR-A boundary refuter reopened local acceptance

- **Finding:** the operator handoff named only the healthy local ingest/smoke sequence even
  though T-A.1/T-A.4 also require an artificially missing read-model row. Separately, the
  signature 503 log had the promised message/spot/interval but lacked the stable `event` and
  `reasonCode` used by the rest of the production observability vocabulary.
- **Correction:** T-A.1 returns to in-progress until the operator performs the explicit
  local-only `obsf-central`/`3h` delete → 503/log assertion → ingest/smoke recovery procedure
  now recorded in `docs/runtime-operations.md`. Healthy and recovery ingests must each prove
  one source terminal plus exactly six spots × two interval terminals under one `ingestId`.
  The missing-row log is normalized to
  `forecast_read_model_missing` / `read_model_missing`, with its unit contract updated.
- **Current-head gate:** the last green GitHub run proves `5787482`, not docs head `3a73ac2`
  or this corrective. Require a new green run at the eventual pushed head; no current-head CI
  claim, ready transition, merge, deploy, or Phase B work is permitted yet.
- **OODA:** Observe — independent refutation overturned a too-narrow healthy-path handoff and
  an overbroad log-coverage claim. Orient — a quiet surf-planning UI is trustworthy only if
  its rare unavailable state is diagnosable without payload leakage, and strict PR ordering
  matters more than preserving a “done” label. Decide — reopen T-A.1, add the smallest stable
  fields and a reversible local procedure, and keep the draft frozen at the safety boundary.
  Act — run focused unit/docs checks and a fresh independent refuter; until both are complete,
  do not call the corrective review dry. Then checkpoint/push and require exact-head GitHub
  plus operator-local/OI-4 evidence.
- **Corrective gate evidence:** the first refutation required explicit terminal cardinality,
  so baseline and recovery now each require one source terminal + 12 unique published
  spot/interval terminals under one `ingestId`. The second refutation is DRY. Focused Worker
  API tests pass 24/24; serial web unit is 263 passed +1 skipped; scripts are 182/182; web
  type/config check and `git diff --check` pass. An isolated-temp-D1 CLI rehearsal still hit
  this sandbox's known listener `EPERM`; neither the degraded path nor local e2e is claimed.

### 2026-08-04 — Local + exact-head CI gates closed (Claude runtime); OI-4 is the last pre-ready gate

- **Runtime:** Codex hit its usage limit at the recorded boundary; Claude resumed from the
  manifest with no state loss. This shell is the operator's machine (no listener sandbox), so
  the previously unrunnable local gates executed directly.
- **Exact-head CI:** Verify run `30896164337` green in 1m21s at pushed head `4e43384` —
  fresh isolated D1, repo/package checks, scripts, web unit, full workerd suite, Python,
  production build, secretless bundle. This satisfies the boundary refuter's current-head
  requirement (previous green `30895038090` proved only `5787482`).
- **T-A.1 local proof (now done):**
  - Canonical `pnpm verify` exit 0.
  - Healthy path: `pnpm ingest:local` published 12/12 (zero errors; known NDBC partial
    caveat); `pnpm smoke:local` 6 spots/12 ready/0 pending/scored. Dev-log assertion: exactly
    one `source_ingest_published` terminal (`a066a2f0-5895-4f47-801a-b9ba6a8bfb83`, reason
    `inline_source_persistence_completed_with_caveats`) + exactly 12 unique spot/interval
    `forecast_materialization_published` terminals, all `outcome: publish`, nonempty
    `generationId`, reason `forecast_generation_published`, same `ingestId`.
  - Degraded path: dev stopped (port freed), local-only delete of `obsf-central`/`3h`,
    restart → `GET /api/forecast/obsf-central?interval=3h` returned HTTP 503 +
    `Retry-After: 300` + typed retryable body, and the dev log carried exactly one bounded
    `{"event":"forecast_read_model_missing","message":"forecast read model missing",
    "spotId":"obsf-central","interval":"3h","reasonCode":"read_model_missing"}` line.
  - Recovery: `pnpm ingest:local` (`935915d4-4e96-4827-998a-ac0774e7bfe1`) republished 12/12
    with the full one-source/12-terminal set; `pnpm smoke:local` green.
- **Production:** read-only `deployments status` — unchanged, `04e3ace7…` at 100%.
- **Ship readiness:** root `.env` supplies `SURF_INGEST_TOKEN`/`SURF_BASE_URL`/
  `SURF_WRANGLER_CONFIG`; the ignored overlay already names `surf-logfire-traces`/
  `surf-logfire-logs`. Remaining order once OI-4 exists: refresh PR body → ready → exact-head
  Verify recheck → merge → one supported `pnpm deploy` → wait the next actual `:17` →
  OI-6 Logfire verdict + `ops:status` 12-ready + dual-origin smoke + browser proof.
- **Scope:** owner kickoff added OD-11 (five-spot catalog expansion) as Phase D / PR-D after
  PR-C; task rows added above; detailed Phase D section reconciles via x-impl before that leg.
- **Next:** OI-4 operator action (destinations per `docs/runtime-operations.md` §Logfire OTLP
  destinations), then the recorded ship ladder. PR-B untouched until PR-A is live-green.

### 2026-08-05 — Phase A complete: PR #23 merged, deployed, live-verified

- **Merge/deploy:** PR #23 → `284b25f` (01:43:32Z). Operator-run `pnpm deploy` (agent-side
  execution is classifier-blocked; recorded as the standing operator step). Worker
  `53084465-66e6-4bf1-ba1d-1fff32cef209` active at 100%, deployment `19361955…`. Pre-deploy
  bookmark `000003a7-00000000-000050be-6c0138cacaa371054793ca7638da7d3f`.
- **Deploy-window fault (new OI-8):** handoff cycle published 5/6 spots (232–395 ms CPU
  children); sixth serialized child (bolinas) killed `exceededCpu` at ~50–85 ms CPU on 4
  attempts → DLQ; verifier failed closed with `bolinas:1h|3h` pending; fix-forward held;
  users saw last-good bolinas data. Twice-reproduced pattern (matches PR #21). Cron cycles
  unaffected. Corrective decision checkpoint: T-B.5.
- **Live gate (02:17Z cron):** all 12 rows converged to generation `02:17:14.356Z`.
  `ops:status` 4/4 PASS. Strict smoke green on custom + workers.dev with exact version.
  Logfire query API: cron (3 spans) → source job (205 spans) → six children (22–24 spans),
  exactly 1 `source_ingest_published` + 12 `forecast_materialization_published` under
  `ingestId af39a489…`. OI-6 closed: no native cross-Queue trace continuity; ingestId is the
  documented correlation key. Browser: desktop + 390×844 phone, zero
  alerts/console-messages/overflow on report + bolinas pages.
- **Also live:** both Logfire destinations exporting (traces + logs); `LOGFIRE_READ_TOKEN`
  verified for autonomous gate checks; OI-7 (write-token rotation) pending operator.
- **Next:** Phase B from `284b25f` on `aylee/surf-freshness-cadence`.

### 2026-08-06 — Phase B complete: PR #27 merged, deployed, live-verified

- PR #27 merged `c39f151`; operator deploy activated `18eba224…` @100%; handoff published
  12/12 including bolinas (no OI-8 recurrence — fault confirmed intermittent, non-blocking).
- Live: ops 4/4; dual-origin smoke; payload cadence on every entry; production browser at
  1280×720 + 390×844 — honest chip, no banner, phone chip visible (OD-9), zero console
  messages; 03:17Z cron republished 12/12 (`03:17:14.351Z` single generation).
- Review trail: 3 adversarial rounds + scoped delta check → DRY (14 + 7 + 1 findings fixed;
  details in WORKSTREAM Session Log). Spend-limit degradation of rounds 2–3 refuters recorded.
- **Next:** Phase C on `aylee/surf-forecast-analysis-tabs`.
