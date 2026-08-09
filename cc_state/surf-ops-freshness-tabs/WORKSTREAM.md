---
status: active
type: workstream
created: 2026-08-03
last_updated: 2026-08-04
binder: alex-os desk/personal-surf-forecast/
plan: ~/.claude/plans/goal-i-want-to-graceful-cocoa.md
---

# Surf Ops, Freshness & Tabs — Workstream

Post-read-model-incident polish for the deployed surf app: production observability + an ops
routine (PR-A), cadence-aware freshness (PR-B), and a Forecast | Analysis spot-page restructure
(PR-C). **This file is the repo execution state** any runtime (Claude/Codex) reads first to
resume. **Resume path:** this file → the Open Items & Decisions Ledger → Next Action → **the
current brief** (one pointer line, below).

> **Handoff convention.** WORKSTREAM = state/ledger/log + a one-line pointer to the current
> brief — never the brief itself. ONE dedicated brief per session, named for its mission
> (`session-brief-<mission>.md`), self-sufficient marching orders. On execution the brief flips
> to a receipt (status + deltas) or is distilled into the session log and deleted; **closeout
> isn't done until the NEXT brief exists.** `implementation-plan.md` = the task DAG (reconciled
> occasionally), never a handoff.

## Objective & Done State

- **Objective:** After the read-model incident (PR #16), make production observable (traces +
  structured logs → Logfire), make freshness reporting honest and cadence-aware with a single
  verdict authority, and restructure the spot page so deterministic data leads and AI analysis
  is tabbed — as three sequential PRs, each verified live before the next.
- **Owner repo:** `/Users/alex/code/surf` · production https://surf.alexlee.ai (+ workers.dev).
- **Done when:** PRs A, B, C are merged and live-verified per `implementation-plan.md`
  §Verification: one full hourly ingest cycle is visible as a correlated Logfire trace; steady
  state shows a quiet chip and no banner; `?tab=analysis` deep-links work; the 23:23Z flapping
  cause is pinned and its corrective shipped; deferred scope (OD-7) remains untouched.
- **PM binder:** alex-os `desk/personal-surf-forecast/` (stale — last updated at the 2026-07-08
  handoff; refresh at closeout, not before).

## Current State

Plan approved for execution 2026-08-03 via the owner's one-shot kickoff (OD-8; OI-1 resolved;
runtime plan captured at `~/.claude/plans/goal-i-want-to-graceful-cocoa.md`;
its RCA evidence and locked decisions are folded into this workstream and the implementation
plan). Execution began at `87f45dc`; recovery PRs #17–#22 are merged and `main` is now
`334c907`.
**Phase 0 is complete and corrected the planning record:** PR #16 merged but was never
deployed, so the 23:23Z incident was old request-time assembly exhausting CPU (OI-2), not D1
flapping. The second supported recovery activated version `04915a00…` at 100%, corrected the
remote Queue to 1/1, and then failed closed before its POST because the readiness harness used
Cloudflare's affinity key as though it selected a version. No POST or rollback occurred; the
new version remains active for queue-safe fix-forward. Read-only probes proved ordinary
traffic and exact overrides reach `04915a00…`, while the old affinity partition returns a
cached predecessor response with no Worker-owned version header. PR #18 replaced affinity,
added independent unpinned convergence, a Worker-enforced pre-Queue version precondition on a
predecessor-absent deploy route, and ambient Worker-name drift rejection. It passed local and
GitHub gates, merged, and supported deploy activated `c0075263…` at exactly 100%; exact and
three unpinned readiness probes passed. The protected POST then returned 404/null, so the
harness issued no accepted enqueue and left `c0075263…` active for fix-forward. Read-only D1
proof shows zero `source_runs` since 04:20Z; deployment status remains the one expected version
at 100%; Queue remains 1 producer/1 consumer. PR #19 shipped the narrow PATCH/monotonic-lineage
corrective after two independent final DRY reviews and green local/GitHub gates. Supported
deploy activated `ce93cdde…` at exactly 100%. The unpinned unauthenticated PATCH probe reached
`ce93cdde…` and returned its expected 401, but the immediately following authenticated PATCH
was independently routed to predecessor `c0075263…`, which returned 404 before Queue access.
Read-only D1 proof shows zero source runs since the attempt and Queue remains 1/1, so write
safety held; request-level routing liveness did not. PR #20 shipped the bounded proven-no-op
handoff after three independent final DRY reviews and green local/GitHub gates. Supported
deploy activated `ce82bb5d…` at exactly 100% and passed exact plus ordinary readiness. Its one
stable version-affinity key then deterministically pinned all 57 read-only catalog requests to
predecessor `ce93cdde…` for 60 seconds; no PATCH of any kind occurred. `ce82bb5d…` remains the
sole active version for queue-safe fix-forward. Read-only sampling after the failure used 12
fresh keys × two adjacent requests × two origins and returned 48/48 `ce82bb5d…` with zero split
pairs. PR #21 shipped the fifth narrow recovery from `aylee/surf-affinity-session-rotation`:
stale/missing identity and transport/body misses before exact-target identity discard the
entire read-only catalog/probe session; exact-target defects are terminal. One winning key is
frozen only across exact-target catalog → exact 401/Bearer probe → one authenticated PATCH. The
60-second deadline, global 60-session cap, three-auth cap, exact safe-rejection classifiers,
and terminal ambiguity boundary remain unchanged. Two frozen-snapshot reviewers are DRY;
canonical verify and the local queue/read-model/browser ladder are green.
PR #21 then passed GitHub Verify, merged, and proved that handoff liveness correction in
production: supported deploy activated `8ce5bdf1…` at exactly 100% and acknowledged one exact
target lineage. Five spots published it, but sixth/last child Bolinas did not before the
ten-minute wait crossed the :17 cron; the newer scheduled generation made the older child
permanently unable to satisfy exact-lineage polling. The command failed closed with only
`bolinas:1h|3h` pending and left `8ce5bdf1…` active. Read-only reconstruction against the
production rows yields fully scored Bolinas forecasts below every payload cap, isolating a
Queue child execution/persistence-tail failure rather than routing, source, or deterministic
forecast data. The sixth recovery on `aylee/surf-cron-safe-deploy-lineage` is now dry and
canonically green. It anchors the handoff clock before any affinity key/network access, defers
outside the cron collision window, rechecks immediately before authenticated PATCH, and locks
Wrangler to the matching `17 * * * *` schedule. A public metadata-only
`GET /api/forecast-readiness` reads all 12 targets in one D1 statement; only one atomic exact
snapshot can authorize deploy success, while a valid newer lineage terminates immediately.
Structured child start/publish/supersede/failure events now preserve bounded causal evidence,
including real non-gating brief failures with lineage context.
PR #22 passed two independent DRY review passes, canonical/local gates, and GitHub Verify,
then merged as `334c9071dfa3c8607383410dd1a1c623b2066d37`. Its single supported deploy
activated Worker `04e3ace7-78b2-4f03-b722-44cc7cd0c126` in deployment
`e3ab7a95-3a2a-4839-9910-15cc2cbd15de` at exactly 100%. The cron-safe guard deferred the
handoff until `07:27Z`; one authenticated attempt then published one exact generation across
all six spots/12 read models by `07:27:29.599Z`. D1, the atomic endpoint, strict smoke on both
origins, Queue 1/1 with batch/concurrency 1, and independent desktop/phone browser checks all
agree. OI-5 is resolved and PR-A may begin. OI-4 destination provisioning remains the
operator-side stop-and-ask gate inside PR-A.
PR-A repo work is now implemented on `aylee/surf-ops-observability` from `334c907`, and the
stabilized diff has completed its adversarial loop with a final parallel DRY round. It adds
bounded causal pipeline outcomes, total secret-safe error classification, generation-bound
optional-Agent signaling with a durable per-date high-water, persisted full-sample automatic
logs/traces, an exactly four-probe read-only `pnpm ops:status`, and the post-merge/Logfire
runbook. Final non-listener evidence is 263 web unit tests (+1 intentional skip), 182 script
tests, web type/config checks, production build, secretless ignored-overlay Wrangler dry-run,
and clean diff. No production state has changed. The canonical/local listener gates are
honestly still open: this execution environment rejects Unix-socket/listener creation with
`EPERM` (including the expanded workerd suite, root `pnpm check`'s `tsx` seed-check IPC, and
local dev/e2e), while an escalation retry is unavailable under the current Codex execution
limit. The branch therefore remains pre-ready until GitHub Verify and the operator-shell local
gate supply that missing evidence. OI-4 also remains open, so no deploy or PR-B work may begin.
Draft PR #23 carries pushed docs head `3a73ac2` and the full incident/review/recovery contract.
Its first GitHub Verify run (`30894701075`) completed fresh D1, repo checks, scripts, and all
263 web unit tests, then ran the previously blocked workerd suite: the new real-D1 and race
regressions passed, as did 17/18 total Worker tests. One pre-existing terminal-recovery
assertion expected `terminal` when replaying generation A after newer same-material B had
advanced the new high-water; the runtime correctly returned `superseded`. This is an isolated
stale expectation, not a code regression. The assertion/comment is corrected on the branch,
focused unit/type checks are green, and an independent control-flow review is DRY. The
corrective landed as `5787482`; second Verify run `30895038090` passed in 1m16s at that
exact head, including fresh D1, all package/workerd/Python tests, build, and secretless bundle.
That is green evidence for `5787482`, not the later docs head or the boundary-refuter
corrective now in the local worktree. T-A.1 is reopened until its explicit missing-row local
proof passes. The PR remains draft because exact-head GitHub evidence, the operator-shell
canonical + healthy/degraded local e2e, and OI-4 still do not exist.
The owner's 2026-08-03 browser-quality amendment (OD-9) raises PR-B/C's UI bar: preserve
v2's visual identity but remove duplicate decision content, keep the freshness signal visible
on mobile, put forecast data in the first viewport, and prove every changed page in the code
browser at desktop and phone sizes.
On 2026-08-04 the runtime handed off Codex → Claude at the recorded boundary (Codex usage
limit). The two evidence gaps Codex could not close are now closed: GitHub Verify run
`30896164337` is green at the exact pushed head `4e433843fb8df9cbe1d9f2b0f833152eaabbb595`,
and the operator-machine shell (no listener sandbox) completed the full local gate — canonical
`pnpm verify` exit 0; healthy e2e with one `source_ingest_published` terminal plus exactly 12
unique spot/interval `publish` terminals under one `ingestId`; the reversible
`obsf-central`/`3h` missing-read-model proof (503 + `Retry-After: 300` + exact
`forecast_read_model_missing`/`read_model_missing` line); and a fully asserted recovery
ingest/smoke. Read-only `deployments status` confirms production is unchanged on `04e3ace7…`
at 100%. Root `.env` supplies `SURF_INGEST_TOKEN`/`SURF_BASE_URL`/`SURF_WRANGLER_CONFIG`, so
the supported deploy is executable from this runtime at ship time. T-A.1 is done and T-A.4
lacks only OI-4 — the operator-side Logfire destinations — before ready/merge/deploy. The
owner's kickoff also added scope: five new spots with full parity (OD-11), sequenced as a
fourth leg (PR-D) strictly after PR-C is live-green.

## Open Items & Decisions Ledger

**THE singular state tracker.** Specs describe the *current design*; this ledger tracks
*deltas in flight*. Task-execution status lives in `implementation-plan.md`. Close-loop:
flip status, add date + a pointer to where it landed, log it in the Session Log.

### Open

| ID | Item | Owner | Status | Resolves in |
|---|---|---|---|---|
| OI-9 | Brief headline restates content the page already shows: on the spot page the model-authored headline names both the pick time and the spot name that the `h1` already carries (owner-reported from production, 2026-08-06). PR-C removes the hero↔brief duplication by tabbing them apart; the residual is worker-side brief prompt/validator wording, deliberately kept out of PR-C's UI-only reviewed diff | agent | OPEN | small worker-side polish PR after PR-D, or fold into PR-D's gate |
| OI-10 | The Analysis outlook's `/brief` fetch has no timeout, so a hung (as opposed to failed) request pins the panel on the loading line while a forecast outage the parent already knows about goes unstated. Pre-existing — the pre-restructure walk also returned the loading line unconditionally — so not a PR-C regression. Bounded in practice by Cloudflare's ~100s 524. Fix candidate: a timeout signal distinct from the unmount abort, so the request resolves to `failed` in bounded time | agent | OPEN | small UI PR after PR-D; needs a timeout path that does not collide with the abort-on-unmount check |
| OI-11 | A 2xx `/brief` response whose JSON the adapter cannot read is classified `empty` ("answered with nothing") rather than `failed`, so envelope drift would surface as a deterministic "no daylight recommendation" instead of a load failure. Unreachable against today's handler: `ForecastBriefReferencedProseSchema` requires a non-empty headline, so every published brief parses. The honest split needs the envelope to state emptiness explicitly | agent | OPEN | fold into the next brief-contract change; comment at the call site records the current behavior |
| OI-12 | The card's meta stamp demotes a *correct* provenance claim on the common Worker path. `buildDeterministicForecastBrief` stamps `bundle.input.generatedAt` — the forecast's own issue time, the same value the local read uses — but the client cannot distinguish it from `buildUnavailableForecastBriefResponse`, which stamps the request clock, so both render the weaker "Updated <t>" instead of "From the <t> forecast". Nothing rendered is false, only less specific; AGENTS.md asks to preserve issue times. Fix needs the envelope to mark the last-resort case explicitly (it already self-identifies via `inputFingerprint: fallback:<spotId>:<localDate>` and `availableRevisions: 0`) and `parseBriefResponse` to carry the flag | agent | OPEN | fold into the next brief-contract change |
| OI-7 | Rotate the Logfire write token: the Cloudflare destinations GET echoes the `Authorization` header, so the token entered the agent transcript while completing OI-4. Rotate in Logfire, update both destinations (operator dashboard edit keeps the new token out of transcripts), confirm export still works | alex + agent | OPEN | PR-A live gate is now green — rotate at next operator touch (config-only, fully reversible) |
| OI-8 | Deploy-window sixth-child kill, now twice reproduced (PR #21 deploy of `8ce5bdf1…`; PR-A deploy of `53084465…` at 01:51Z): during the immediate post-activation handoff cycle, the last serialized Queue child (bolinas) is killed `exceededCpu` at ~50–85 ms CPU across 4 delivery attempts while healthy siblings use 196–395 ms; the message lands in `surf-ingest-dlq` (no consumer; left parked per no-replay policy). Cron cycles on the same version are unaffected (bolinas published 02:17:14 with 22-span healthy trace). Working theory: cold-version isolate contention (fresh HTTP-poller isolates + five just-signaled brief Agent DOs + queue consumer on a seconds-old version). Corrective candidates: quiet-down the verifier polling during fan-out, stagger/handoff-delay the enqueue, or verifier tolerance for one cron-cycle convergence. Decide at the PR-B ship boundary — if PR-B's deploy reproduces it, the corrective becomes mandatory before PR-C | agent | OPEN | dedicated corrective, decision checkpoint at T-B.5 |

### Resolved (this workstream)

| ID | Decision | Date | Landed in |
|---|---|---|---|
| OI-1 | RESOLVED — owner approved the manifest and 16-task implementation plan by pasting the one-shot kickoff; execution is authorized under OD-8 | 2026-08-03 | Owner kickoff → `session-brief-oneshot-full-workstream.md` |
| OI-2 | RESOLVED — PR #16 was never deployed; production stayed on the pre-read-model rollback version, so 23:23Z flapping was request-time `exceededCpu`/1102, not transient D1 reads or deploy churn. Corrective: deploy the already-merged per-spot fix, then make PR-A ops status prove active deployment + queue 1/1 + 12 rows | 2026-08-03 | Phase 0 evidence → `implementation-plan.md` Log; corrective deploy OI-5 + PR-A T-A.3 |
| OI-3 | RESOLVED — Wrangler 4.118.0/current CF docs confirm explicit `observability.traces.{enabled,head_sampling_rate,persist,destinations}` and signal-specific log destinations; no beta compatibility flag | 2026-08-03 | CF docs + local schema → PR-A T-A.2 |
| OI-4 | RESOLVED — both account-level destinations exist and are enabled with auth headers: `surf-logfire-traces` (opentelemetry-traces → logfire-us `/v1/traces`, created 2026-08-05T01:33:37Z, operator-created in dashboard) and `surf-logfire-logs` (opentelemetry-logs → `/v1/logs`, created 2026-08-05T01:37:58Z, agent-created via authorized Cloudflare API MCP mirroring the traces auth header). Creation preflight passed, proving Logfire accepts the credential. `LOGFIRE_READ_TOKEN` in gitignored root `.env` verified against the Logfire query API (HTTP 200). Named rollback: disable/delete destinations + remove names from the ignored overlay (config-only) | 2026-08-05 (UTC) | Cloudflare account config + `.env`; see OI-7 for the follow-up token rotation |
| OI-5 | RESOLVED — PR #22 made deploy publication cron-safe and atomically verifiable. One supported deploy activated exact Worker `04e3ace7…` at 100%; after the guarded `07:27Z` handoff, all 12 rows switched to that one lineage, Queue stayed 1/1 at batch/concurrency 1, strict dual-origin smoke passed, and independent desktop/phone browser checks were clean | 2026-08-04 | PR #22 (`334c907`) + Worker `04e3ace7…`; recovery live checkpoint in Session Log / implementation-plan Log |
| OI-6 | RESOLVED — verdict: Cloudflare automatic tracing does NOT propagate one trace across the Queue producer→consumer boundary. The live 02:17Z cycle exported as separate Logfire traces (cron 3-span → source job 205-span → six spot children 22–24 spans each), every span/event carrying the shared `ingestId af39a489…`; exactly 1 source + 12 publish terminal events verified via the Logfire query API. `ingestId` is the documented cross-trace correlation key; the one-trace criterion is closed as a platform limitation with evidence, not silently rewritten | 2026-08-05 | Logfire records query (02:16:55–02:20:00Z window) → Session Log; runbook already documents the fallback |
| OD-1 | Freshness UX is two-tier and cadence-aware: chip always visible (min–max label bug fixed); banner only for actionable causes, naming them. One verdict authority: a pure contracts function computing `fresh \| aging \| late` from adapter-declared `expectedCadenceMinutes` (+ grace) shipped in the payload; web never re-judges | 2026-08-03 | Runtime plan → `implementation-plan.md` PR-B |
| OD-2 | Spot page restructures to Forecast \| Analysis tabs: Forecast (default) = slim deterministic header + workbench first, zero AI content; Analysis = Daily Forecaster prose, tradeoffs, data-gaps, provenance accordion; forecaster with no reliable call collapses to one quiet line; daily-report page hero unchanged | 2026-08-03 | Runtime plan → `implementation-plan.md` PR-C |
| OD-3 | Telemetry is CF-native: keep Workers Logs, enable automatic-tracing beta, native OTLP export of traces + logs → Logfire as the pane of glass; spans/logs carry `ingestId`/`spotId`/`generationId` | 2026-08-03 | Runtime plan → `implementation-plan.md` PR-A |
| OD-4 | Remote ops boundary: pre-authorized = read-only diagnostics (`wrangler tail`, `versions list`, D1 SELECTs) whenever needed + the supported `pnpm deploy` at ship time. Worker activation is the Queue-schema boundary: any later readiness/publication/smoke failure leaves that version active for fix-forward. Rollback is allowed only after proving Queue quiescence, no in-flight consumer, and predecessor-compatible payloads. Everything else remote — secrets, dashboard config incl. the OTLP destination/token, backfills, any D1 write — is stop-and-ask with a named recovery/rollback plan, per AGENTS.md | 2026-08-03 | Recovery hotfix review → brief Guardrails + `docs/runtime-operations.md` |
| OD-5 | Delivery is 3 sequential PRs — A (obs+ops) → B (freshness) → C (tabs) — each verified in production before the next starts | 2026-08-03 | Runtime plan → `implementation-plan.md` phasing |
| OD-6 | Execution style is ultracode (owner opt-in on record): Workflow-orchestrated phases with an adversarial review gate before each PR; mechanical edits exempt | 2026-08-03 | Runtime plan → `implementation-plan.md` §Execution protocol |
| OD-7 | Deferred scope locked: push alerting (revisit after PR-A), brief "stale"-status semantics polish, Analysis-tab growth (issued history, accuracy evals), retention/pruning | 2026-08-03 | Runtime plan §Explicitly deferred |
| OD-8 | One-shot execution authorized: a single run executes the full workstream (Phase 0 → PR-A → PR-B → PR-C), including merging each PR once its adversarial review is dry and GitHub Verify is green, and deploying via the supported `pnpm deploy` per leg. OD-5 sequencing and per-PR adversarial gates are unchanged; stop-and-ask points (OD-4) survive one-shot mode. Owner pasting the one-shot kickoff prompt constitutes OI-1 approval | 2026-08-03 | `session-brief-oneshot-full-workstream.md` |
| OD-9 | Browser-led signal-to-noise is a ship criterion: retain v2's visual identity, remove repeated content instead of adding chrome, keep the authoritative freshness chip visible on every viewport, make Forecast data visible in the first viewport, move AI/explanation/provenance to Analysis, and collect semantic + screenshot evidence at desktop and phone sizes. This narrowly amends OD-2's “daily-report untouched” clause to permit de-duplicating its shortlist and weak source-count label while preserving its hero | 2026-08-03 | Owner quality direction → PR-B T-B.3/B.5 + PR-C T-C.1–C.4 |
| OD-10 | Owner delegated autonomous end-to-end execution while away and requires an evidence-backed OODA checkpoint at every recovery/PR boundary. Each checkpoint records Observe (repo/prod truth), Orient (full workstream + personal surf-planning/learning intent), Decide (alternatives/tradeoffs), and Act (change, queue-safe failure recovery, verification). Decision traces belong in this manifest + implementation-plan Log so review can reconstruct why, not only what | 2026-08-03 | Owner handoff while away → all remaining checkpoints |
| OD-11 | Owner-directed catalog expansion: add Rodeo Beach (Fort Cronkhite, Marin Headlands) plus Santa Cruz — Steamer Lane, Pleasure Point, Cowell's, 38th Ave (Jack's) — as a fourth sequential leg (PR-D) after PR-C is live-green. No functional changes; full data/scoring/test/ops parity with the existing six spots. Narrowly amends OD-7's "no spot-catalog change" to apply to PRs A–C only; no-paid-source and no-unreviewed-migration rules unchanged | 2026-08-04 | Owner kickoff (Claude handoff session) → impl-plan Phase D (reconcile via x-impl before the leg starts) |

## Deliverables & Working Files (index)

| File / dir | Kind | Status | Purpose |
|---|---|---|---|
| `WORKSTREAM.md` | manifest | active | Operating state (this file) |
| `implementation-plan.md` | impl-plan | approved — executing | Full self-contained task DAG for Phase 0 + PRs A/B/C |
| `session-brief-oneshot-full-workstream.md` | brief | executing | Current mission: one-shot the full workstream (Phase 0 → PR-C, per-PR adversarial gates) |
| `~/.claude/plans/goal-i-want-to-graceful-cocoa.md` | approved runtime plan | accepted | Planning-session output: RCA evidence + the decisions minted as OD-1…OD-7 |

## Threads / Tracks

| Track | Status | Where (code) | Next action |
|---|---|---|---|
| Phase 0 — production diagnostic (read-only) | DONE — OI-2 pinned, OI-5 corrective live | prod: deployment status, D1 read-model/source-run queries, live tail, queue config | Complete |
| PR-A — observability + ops foundation | DONE — PR #23 merged (`284b25f`), deployed (`53084465…` @100%), live-verified on the 02:17Z cycle | `apps/web/worker/` (index, ingest, read-model), `apps/web/wrangler.jsonc`, `scripts/`, `docs/runtime-operations.md` | Complete; OI-7 rotation + OI-8 corrective tracked in ledger |
| PR-B — cadence-aware freshness | DONE — PR #27 live-verified 2026-08-06 | `packages/contracts/`, worker materialization, `apps/web/src/App.tsx`, `features/workbench/` | T-B.1 contracts verdict fn → T-B.2 adapter cadence → T-B.3 web single-verdict → gate → ship |
| PR-C — Forecast \| Analysis tabs | ACTIVE | `apps/web/src/features/workbench/ForecastWorkbench.tsx`, `App.tsx`, `src/components/ui/tabs.tsx` | After PR-B verified live |
| PR-D — spot catalog expansion (OD-11) | QUEUED | `packages/db` catalog/seed, worker adapter config, `scripts/`, tests, docs | After PR-C verified live |

## Decisions

- [x] **Numeric forecast authority stays deterministic and testable** (repo invariant; LLM
  explains structured facts only).
- [x] **Freshness/uncertainty surfaces are never deleted, only made honest** (repo invariant;
  OD-1 restructures, it does not remove).
- [x] **No paid marine API enters any path** (repo invariant).
- [x] **No new D1 migrations anticipated in any of the three PRs**; additive schema remains
  untouched on failure. Worker rollback is conditional on Queue quiescence, no in-flight
  consumer, and predecessor-compatible payloads; otherwise fix forward on the active version.
- [x] **Phase 0 corrective selected from evidence:** no bounded D1 retry. Deploy the merged
  per-spot materialization fix, then make PR-A's routine prove the active deployment (not just
  uploaded versions), remote queue 1/1, and all 12 rows.

## Open Questions

→ **Tracked in the Open Items & Decisions Ledger above** — the singular live tracker.

## Links

- **Production:** https://surf.alexlee.ai (spot IDs `obsf-north|central|south`, `linda-mar`,
  `stinson`, `bolinas`; 6 spots × 1h/3h = 12 read-model rows; hourly ingest cron at :17)
- **Incident lineage:** PR #16 (`gh pr view 16` — body documents the queue-CPU RCA) ·
  `cc_state/obsf-unavailable-regression/` (prior workstream: RCA + recovery + rollback points)
- **Prior workstreams:** `cc_state/surf-forecaster-v2/` (Daily Forecaster contract),
  `cc_state/surf-trust-experience/` (freshness/provenance surfaces this work builds on)
- **PM binder:** alex-os `desk/personal-surf-forecast/BINDER.md`
- **Repo contract:** `AGENTS.md` · `docs/architecture.md` · `docs/feed-adapters.md` ·
  `docs/runtime-operations.md`

## Verification

Phase 0 read-only evidence at `main` @ `87f45dc`: GitHub merge `23:01:29Z`; Cloudflare active
deployment still rollback `ea3a7a1e…` from `04:43:12Z` with no later deployment; primary D1
reported 0/12 read models and current hourly source runs succeeding/partial; a live tail at
`02:34:18Z` captured `exceededCpu`, CPU 10 ms, HTTP 503 on the active version; production
queue config is stale at batch size 10 rather than repo target 1/1. Wrangler exposes DLQ
metadata but not backlog count. Baseline `pnpm verify` passed: 332 tests, 1 skipped, fresh D1,
build, and secretless dry-run. All load-bearing anchors were re-verified by symbol with no HEAD
drift; the audit additionally found PR-B's client authority in `forecast-adapter.ts` and the
ignored production-config synchronization requirement. A clean local pre-deploy e2e also
passed: `pnpm ingest:local` published all 12 read models and `pnpm smoke:local` reported 6
spots, 12 read models, 0 pending, and scored forecasts. Optional Gemini brief calls hit their
isolated quota/schema fallback, but deterministic forecast publication and every smoke check
remained green.

PR-A pre-PR evidence at `334c907` + the branch diff: the final two independent review lenses
are DRY after three adversarial rounds and independently refuted fixes. Fresh non-listener
gates pass: scripts 182/182; web unit 263 passed +1 skipped; focused Agent/order, inline Queue,
and Worker paths 57/57; web Worker types + TypeScript; production Vite build; secretless
`wrangler deploy --dry-run` against the ignored production overlay; and `git diff --check`.
The exact new workerd/D1 regressions are checked in but not locally run: listener creation is
denied with `EPERM`; root `pnpm check` independently reaches the same environmental failure at
`tsx`'s seed-check IPC socket. This is a red/missing gate, not a test pass. The last previously
completed workerd baseline was 15/15 before these new specs. No local public-feed ingest/e2e
and no production mutation have been performed for PR-A.

## Next Action

**PR-C is merged and green on `main` at `2bff460` but NOT DEPLOYED — production still runs the
pre-PR-C build. The single blocking step is an operator deploy; `pnpm deploy` is refused by the
Claude Code permission classifier, so Alex must run it:**

```
! pnpm deploy
```

**Then the T-C.4 live gate, in order:**
1. `pnpm ops:status` → expect **12 ready, 0 pending** (watch the handoff for an OI-8 recurrence:
   a sixth-child `exceededCpu` kill during the post-activation cycle. Production stays healthy on
   last-good data if it recurs, and the next `:17` cron converges — but if this deploy reproduces
   it a third time, the corrective becomes mandatory before PR-D).
2. `pnpm smoke:cloudflare` → dual-origin green.
3. Playwright evidence on https://surf.alexlee.ai at 1280 and 390:
   - a spot page **defaults to Forecast** with the workbench first, **zero `/brief` requests**,
     no AI-authored text, no auto-expanded row, first table row inside the first viewport;
   - `?tab=analysis` **deep-links** to Analysis and issues **exactly one** `/brief`; the panel
     renders day label → card → tools → provenance disclosure;
   - the card's meta line reads "Daily outlook"/"Outlook updated <t>" only for an authored brief,
     and "Forecast read"/"From the <t> forecast" (local) or "Updated <t>" (Worker summary)
     otherwise — the attribution fix from PRs #31/#32;
   - the hero freshness badge agrees with the banner, and no horizontal overflow at 390.
4. Confirm one hourly cycle in Logfire as a correlated trace via `ingestId` (PR-A's key).

**Then PR-D (OD-11): +5 spots** — Rodeo Beach (Fort Cronkhite) and Steamer Lane, Pleasure Point,
Cowell's, 38th Ave. Catalog is `packages/forecast-core/src/spot-registry.ts`; no migration needed
(`pnpm spots:sync` regenerates the seed, `pnpm deploy` upserts remotely). Known work: ~24
hardcoded six-spot/12-row assertions to parameterize; Santa Cruz needs its own NWS office/zone
(the helper pins MTR/PZZ545) plus CDIP MOP points; `norcal-seed-config.ts` needs SourceSeedRows
for the new stations. **Do not start until the PR-C live gate above is green (OD-5).**

**Operator items outstanding:** rotate the leaked Logfire write token (**OI-7**, dashboard edit
keeps it out of transcripts); dependabot PR **#28** (CI actions only) is safe to merge — the 5
open `undici` alerts are not in the shipped Worker bundle and clear on the weekly grouped bump.

## Closeout Path

Accepted truth lands in repo code/tests/docs via PRs A–C (ops routine →
`docs/runtime-operations.md`; freshness contract → `packages/contracts` + tests). Cross-cutting
lessons (CF Workers tracing/OTLP setup, post-merge ops routine for personal CF projects) →
alex-os `memory/logs/` via `/x-compound`. Binder gets a Last Session refresh at closeout. On
cool, archive the whole workstream to `cc_state/z_archive/surf-ops-freshness-tabs/` — intact.

## Session Log

_2026-08-03_ — **Workstream originated from the approved plan.** Planning session (separate,
interrupted) produced the RCA: PR #16's incident cause documented, 23:04–23:06Z screenshots
explained as the unrecovered window, self-recovery at 23:17Z confirmed, 23:23Z flapping left
unpinned (→ OI-2); owner locked OD-1…OD-7 in the planning interview. This session: housekeeping
only — scaffolded manifest, full self-contained `implementation-plan.md`, and the first brief
(`session-brief-diagnose-and-instrument.md`). **No code written; owner review gate OI-1 is the
next action.**

_2026-08-03_ — **Mission upgraded to one-shot (OD-8).** Owner chose one-shot execution of the
full workstream over per-PR sessions. Minted `session-brief-oneshot-full-workstream.md`
(supersedes the unexecuted diagnose-and-instrument brief, now deleted — its Phase 0 + PR-A
marching orders are Leg 1–2 of the new brief). Per-PR adversarial gates, OD-5 sequencing, and
OD-4 stop-and-ask points unchanged. Still no code; OI-1 remains the gate, resolved by the
owner pasting the kickoff prompt.

_2026-08-03_ — **One-shot execution authorized; OI-1 closed.** Alex pasted the ratified
kickoff, resolving the hard review gate exactly as OD-8 specifies. Phase 0 began with three
read-only lanes: production/version evidence for OI-2, current Cloudflare tracing/Logfire
configuration research for OI-3/OI-4, and symbol-anchor re-verification at HEAD `87f45dc`.
No code was written before the gate closed.

_2026-08-03_ — **Phase 0 pinned OI-2 and exposed an undeployed predecessor.** PR #16 merged
at `23:01:29Z` but Cloudflare never advanced past the `04:43:12Z` rollback. Primary D1 has
0/12 read models; source rows keep refreshing; live tail proved request-time `exceededCpu`
at the 10 ms limit; production queue settings are also the stale pre-fix batch configuration.
The earlier `:17` source success was misclassified as recovery. OI-2 closed: no D1 retry;
recover by deploying the already-merged per-spot fix, then PR-A codifies active-deployment,
queue-serialization, and 12-row checks. OI-3 also closed from current CF docs/schema. Baseline
`pnpm verify` passed (332/332, one skipped). OI-5 now gates any PR-A code; OI-4 remains the
operator-side Logfire destination setup. Native one-trace propagation across durable Queues
is undocumented and is tracked as OI-6 for the live :17 proof.

_2026-08-03_ — **Clean local recovery path verified while OI-5 awaited.** On unchanged
`main` @ `87f45dc`, a fresh local Worker/database run completed `pnpm ingest:local` with all
12 read models and then passed `pnpm smoke:local` (6 spots, 12 read models, 0 pending, scored
forecasts). Optional Gemini brief quota/schema errors stayed isolated from deterministic
forecast publication. No production state changed.

_2026-08-03_ — **PR-A design checkpointed without crossing the recovery gate.** Three
read-only design lanes fixed the implementation boundaries: orchestration-owned canonical
outcome logs with no duplicate repository logging; destination-neutral tracked tracing config
plus signal-specific destinations only in the ignored production overlay; and a strict
four-probe `ops:status` whose remote Queue and 12-row D1 checks fail closed. Details and test
traps are recorded in the implementation-plan Log. OI-5 and OI-4 remain unchanged; no tracked
code or production state changed.

_2026-08-03_ — **Owner raised the UI bar; OD-9 locked from code-browser evidence.** The live
v2 baseline showed duplicated home recommendations, a hidden mobile freshness chip, a spot
hero plus AI card consuming the entire first viewport, and repeated per-window caveats before
the core forecast. PR-B now proves the chip on mobile. PR-C keeps v2's stronger identity but
removes the duplicate home shortlist/weak source-count claim, makes Forecast data-first with
no AI or auto-expanded explanation, moves analysis/provenance behind Analysis, lazy-loads the
brief, and captures semantic plus screenshot evidence at desktop and phone widths. This was a
read-only audit; OI-5/OI-4 and the strict PR sequence remain unchanged.

_2026-08-03_ — **Authorized PR #16 recovery failed closed; fix forward isolated.** Supported
`pnpm deploy` created version `9fdf8329…`, then its immediate read-model poll rejected an
`obsf-north:1h` 503 and triggered the automatic rollback to `ea3a7a1e…` nine seconds later.
The queued source job completed about twenty seconds after rollback; D1 remained 0/12, while
the Queue correction persisted remotely at exact batch/concurrency 1/1. Three bounded GET
rounds against the rollback version reproduced intermittent exact Cloudflare error-1102
problem JSON across different spot/intervals. The poller currently accepts only Surf's typed
pending 503, so a rollout-time old-version 1102 aborts before publication can start. OI-5 is
now a reviewed/tested bounded exact-1102 poller fix forward; malformed/other 503s still fail
immediately and persistent 1102 must time out while leaving the activated version in place for
queue-safe fix-forward. D1's post-attempt bookmark is
`00000332-00000004-000050bd-b952a5719310c0a44dd632cf7f4c82b3`.

_2026-08-03_ — **Owner handed off autonomous completion; OD-10 locked.** Alex stepped away
and delegated the remaining workstream end to end. Every recovery/PR boundary now includes a
full OODA trace grounded in both current repo/production evidence and the product purpose:
help Alex and friends make quick surf-session decisions while offering forecasting education
on demand. Existing sequencing, adversarial review, queue-safe failure recovery, determinism,
attribution, and
secret-handling constraints remain intact; the trail must make tests, alternatives, tradeoffs,
and residual risk reviewable without this conversation.

_2026-08-03_ — **OI-5 recovery hotfix survived four adversarial rounds; manifest safety finding
being closed.** The first finder/refuter cycle confirmed that the failed deploy polled an old
CPU-bound version too early. The fix now parses Wrangler's exact version UUID, requires three
consecutive `X-Surf-Worker-Version` health responses with Cloudflare affinity, performs one
authenticated POST, and verifies the acknowledged ingest lineage sequentially. Later rounds
confirmed and fixed full-body timeout gaps, AbortError races, transient transport handling,
unbounded/12-way strict smoke, and the mistaken belief that the script's own POST was the
rollback boundary. Cron/manual/backlog work can cross schemas immediately after activation, so
all post-activation failures now keep the version active for fix-forward; rollback requires
Queue quiescence, no in-flight consumer, and predecessor-compatible payloads. The ignored
production overlay has `CF_VERSION_METADATA`; self-hosting docs now require structural overlay
reconciliation without overwriting IDs/routes/flags. Evidence: `pnpm verify` green with 52
script tests, 21 forecast-core, 10 DB, 225 web unit (+1 skipped), 13 Worker, and 45 Python tests;
fresh local ingest/smoke published 12/12, and the code browser loaded the local dashboard with
a concrete version header. No remote mutation occurred during these fixes. Final review must
return dry before commit/PR/deploy.

_2026-08-03_ — **PR #17 merged; exact-version rollout false-negative triggered a second OODA
fix-forward.** GitHub Verify passed and PR #17 merged as `80da93e`. With pre-deploy D1 bookmark
`00000336-00000000-000050bd-411681979faabc1f1884f3f58d32522c`, supported `pnpm deploy`
activated Worker `04915a00-5501-4143-ba09-86d59f2fc4c3` at 100% and left Queue consumption
1/1. Its 60-second readiness gate saw 55 HTTP-200 responses but `workerVersion=unknown`, so it
issued zero POSTs and correctly left the activated version in place. Observe: unheadered and
random-key probes returned `04915a00…`; the expected UUID used as an affinity key returned
`CF-Cache-Status: HIT`, an aged predecessor body, and no version header; exact
`Cloudflare-Workers-Version-Overrides: surf="04915a00…"` returned BYPASS + exact identity on
both origins. An invalid override UUID silently fell back to the active version, confirming
Cloudflare's documented behavior. Orient: exact reachability is not active rollout, and a
post-response check cannot undo a wrong-version Queue send. Decide: require (1) validated
config-derived name with no CI name drift, (2) one exact-override reachability proof, (3) three
cache-busted unpinned exact-version responses, (4) `X-Surf-Expected-Worker-Version` checked
against `CF_VERSION_METADATA.id` before `INGEST_QUEUE.send`, and (5) pinned response identity
through catalog, POST, lineage polling, and strict smoke. Tradeoff: one extra readiness phase
and a lowercase-letter-first Worker naming constraint buy a fail-closed mutation boundary;
manual remote ingest without a deploy target remains supported. Act/evidence: two independent
reviewers confirmed the diagnosis and found the 0%-traffic and silent-fallback edges; 53
targeted script/config/bootstrap tests and 20 Worker tests pass, including exact-override,
unpinned-predecessor/no-POST, all-or-neither name/version, arbitrary overlay name, wrong-version
zero-send, one POST, sequential polling, and strict response identity. Full verify + a dry
review round still gate the narrow corrective PR; no manual ingest was issued.

_2026-08-03_ — **Exact-version corrective canonical/local gate green; bootstrap limitation
explicit.** `pnpm verify` passed on the reviewed diff: fresh isolated D1 migration/seed, 60
script tests, 21 forecast-core, 10 DB, 226 web unit (+1 skipped), 13 Worker, 45 Python,
production build, and secretless Wrangler dry-run against the active ignored overlay. Fresh
local provider ingest published 12/12 read models (NDBC caveats isolated); strict smoke proved
6 spots, 12 ready, zero pending, scored data, and a concrete local Worker UUID. Code-browser
desktop evidence loaded the daily report with no alerts or horizontal overflow. Residual for
this one transition: active predecessor `04915a00…` does not yet enforce the new POST
precondition. Exact override + three unpinned matches still precede one non-retried POST, and
the Queue payload schema is unchanged, so a rare silent fallback can cause at most one
compatible source ingest before response identity fails. Once this corrective is live, future
deploy mutations gain the atomic Worker-side precondition. Final finder/refuter dry verdict is
the remaining local gate before commit/PR.

_2026-08-03_ — **Dry-round findings closed; first-rollout mutation hole eliminated.** The final
finder did not accept the recorded bootstrap residual: predecessor `04915a00…` cannot enforce
a header on its existing `/api/ingest/once` route, so a silent override fallback could still
enqueue before the client saw stale response identity. The corrective now sends deploy-time
POSTs only to new `/api/ingest/deploy`; every predecessor lacks that path and returns 404
without Queue mutation, while the new route requires auth + exact metadata before send.
Legacy `/api/ingest/once` remains manual/local. The same finder proved Wrangler's ambient
`CLOUDFLARE_ENV` silently suffixes the actual Worker target; active-config validation now
rejects any nonempty value before build or remote mutation. Transition and validator tests
cover both. Finder rerun returned DRY; independent refutation is pending its final verdict.
Corrected canonical `pnpm verify` is green: 61 script, 21 forecast-core, 10 DB, 226 web unit
(+1 skipped), 13 Worker, 45 Python, fresh D1, build, and secretless dry-run. This entry
supersedes the prior residual-risk acceptance; no remote mutation occurred.

_2026-08-03_ — **Exact-version corrective review gate DRY.** Independent refutation confirmed
both final P1s closed: predecessors 404 the deploy-only route before Queue access, and active
config validation sees root-env-loaded target overrides before build or remote commands. Final
finder and refuter rounds found no remaining actionable issue. Canonical verify is green on
the corrected diff; the branch is ready for commit, ready PR, GitHub Verify, merge, and the
authorized supported deployment. OI-5 remains open until dual-origin identity + exact lineage
+ 12/12 + queue 1/1 are proven live.

_2026-08-03_ — **Corrective PR #18 merged; deploy boundary checkpointed.** Ready PR #18 at
commit `3e8cbf7` passed GitHub Verify in 1m15s and merged as `2da1e0f` at
`2026-08-04T04:21:44Z`. Fresh pre-deploy D1 Time Travel bookmark is
`00000338-00000000-000050bd-e42c3237af77fc956eebe86e8b322909`; restore remains reserved
for confirmed data corruption. Code rollback remains queue-conditional; any failure after
activation fixes forward unless quiescence, no in-flight consumer, and predecessor-compatible
payloads are independently proven. Next authorized action is exactly `pnpm deploy`; no manual
remote ingest.

_2026-08-03_ — **PR #18 live gate failed closed; third recovery OODA began.** Supported deploy
seeded through final D1 bookmark
`00000338-00000004-000050bd-81a23bf98cdc17be8efa64af1a9a3c69`, activated Worker
`c0075263-2f92-47ae-bbcc-d3a12a9fbbe7` in deployment
`6e5f40dc-a4f3-4fae-ba75-af76b8ad8f5e` at 100%, and passed exact-override reachability plus
three unpinned identity checks. Its protected POST `/api/ingest/deploy` unexpectedly returned
404 with a null JSON body; no accepted enqueue or publication polling followed. Observe:
read-only D1 reports zero `source_runs` since 04:20Z, control plane still reports exactly
`c0075263…` at 100%, and Queue topology is one producer/one consumer. The bundled Worker and
version metadata both contain the route, but the missing response-version header was not
printed and will not be recovered by replaying a production mutation. Orient: OI-5 still
blocks PR-A, rollback is not queue-safe, and a status/probe sequence alone cannot atomically
prevent c007 from serving the next mutation. Decide: review a predecessor-absent method on the
established route (PATCH `/api/ingest/once`) with the exact metadata check before `Queue.send`,
plus a strict one-version/100%-traffic control-plane assertion. This avoids relying on the
unexplained path while retaining a zero-mutation fallback on c007; manual POST remains
compatible. Act: no manual POST, ingest, rollback, or D1 write; only read-only deployment,
Queue, version, bundle, and source-run evidence. A new narrow PR is required only after finder
and independent refuter agree the design is dry.

_2026-08-03_ — **Third recovery implementation checkpoint; adversarial findings incorporated.**
Observe: three independent lenses rejected plain POST (c007 cannot precondition it), then
rejected PUT because HTTP permits automatic replay of idempotent methods. They also found that
override-pinned publication/smoke could hide default-route regression, an upload timestamp
could lose the deploy lineage to `:17`, and JSON-only/truncate-before-redact diagnostics would
repeat the prior 404 evidence loss or leak a token prefix. Orient: the harness must prove the
route users actually receive and keep exactly one logical lineage without weakening the
manual POST contract; this queue recovery still gates every product-facing PR. Decide: deploys
use unpinned predecessor-absent PATCH `/api/ingest/once`; unauthenticated PATCH must first
return 401 + Bearer challenge + exact Worker UUID, then one authenticated PATCH checks a valid
expected UUID against immutable metadata before Queue mutation. Exact overrides remain only a
read-only reachability probe. Version UUID is the stable ingest identity; generation time is
captured at the Worker request, not upload. Catalog, 12 lineage polls, and strict smoke are
unpinned and exact-version checked; deployment JSON must show one expected version at 100%
both before enqueue and after smoke. Act/evidence: pure malformed/split/partial deployment
parsing, route/precondition/zero-send/replay tests, no-POST/no-redirect assertions, bounded raw
CF-Ray/body diagnostics with pre-truncation token redaction, and runbook changes are on
`aylee/surf-deploy-patch-barrier`. Canonical `pnpm verify` passed on the substantive design
(68 Node, 21 core, 10 DB, 226 web unit +1 skipped, 13 Worker, 45 Python, fresh D1/build/dry-run);
the final redaction-boundary test and replay assertion are targeted-green and require the final
post-review canonical rerun. Local public-feed ingest published 12/12; strict smoke was green;
code-browser evidence showed zero alerts and no horizontal overflow. Optional brief-agent
local-date errors remained isolated from deterministic publication. Final finder/refuter dry
verdict is still required before commit/PR.

_2026-08-03_ — **Third recovery review gate DRY; ready to publish.** A nested refuter found the
last P1: stable version ID with a fresh request timestamp could reuse a source-run row whose
older `started_at` let an intermediate delayed generation through. Chosen over a larger
client/server operation-header protocol, the persistence invariant now updates a reused
lineage only when `excluded.started_at >= current`, advancing generation clock and metadata
together while rejecting regressions. A real workerd D1 test proves t1→t2, fences t1.5, and
prevents delayed same-ID t1.5 metadata overwrite. Final P2s add explicit mutation ambiguity
to transport/body-timeout failures and correct the runbook: deployment status reads are
checkpoints, not a lock; immutable Worker UUID matching is the write-safety boundary. Both
independent final reviews returned DRY. Final `pnpm verify` is green: 70 Node, 21 core, 10 DB,
226 web unit (+1 skipped), 14 workerd/Worker, 45 Python, fresh D1, build, and secretless dry-run.
Local ingest/smoke remains 12/12 and browser clean. The branch may now become a ready PR; no
production mutation has occurred since the failed PR #18 gate.

_2026-08-03_ — **PR #19 merged; adjacent requests disproved request-level rollout
convergence.** Ready PR #19 at `8d6cd97` passed GitHub Verify in 1m18s and merged as
`fd70a23f6d068954f90e930f5579c6023afa6d80` at `2026-08-04T04:52:42Z`. Pre-deploy D1 Time
Travel bookmark: `0000033a-00000000-000050bd-d9f14ff001707c25b28114f83db287d7`; seed final
bookmark: `0000033a-00000004-000050bd-40343f2004693c48dea91d2dd18aab95`. Supported deploy
activated Worker `ce93cdde-30b9-493a-9b17-8fb0f7eabe39` in deployment
`9f207887-2992-4480-9a5d-cb0f1880e9ed` at exactly 100% and passed the status plus unpinned
readiness gates. The unauthenticated PATCH probe then returned 401 from `ce93cdde…`, while the
immediately following authenticated PATCH returned 404/`404 Not Found` from stale
`c0075263-2f92-47ae-bbcc-d3a12a9fbbe7` (`CF-Ray a25af5ced9ed1321-SJC`). Because c007 has no
PATCH handler, `Queue.send` was unreachable. A read-only D1 query from 04:52Z found zero
source runs; control plane still shows only ce93 at 100%; Queue is 1 producer/1 consumer.

**OODA — Observe:** deployment-level and even adjacent unpinned probe success do not guarantee
that the next ordinary request reaches the same Worker version. The exact response UUID made
the stale route attributable, and the predecessor-absent method made it a proven no-op.
**Orient:** OI-5 remains the safety/liveness predecessor to all user-facing work. For friends
planning a session, missing an update is preferable to duplicating or misattributing forecast
data, but an indefinitely brittle deploy harness would prevent every product improvement.
**Decide:** do not replay manually, rollback, accept a blind retry, or weaken ordinary-route
proof. Review a bounded protocol retry whose predicate requires a stale Worker UUID and an
exact zero-mutation fingerprint: legacy Hono PATCH 404 body/content type, or the PATCH-aware
409 `worker_version_mismatch` contract with header/body agreement. Any transport/body
ambiguity, malformed or expected UUID, arbitrary failure, or any 202 stops after one request.
The heavier durable-idempotency design remains unnecessary if this transition protocol can be
proved. **Act:** leave ce93 active, preserve the bookmarks, perform read-only evidence checks,
and send the classifier/attempt cap to independent finder/refuter review before code. No new
production mutation occurs until a reviewed narrow PR passes local/canonical/GitHub gates.

_2026-08-03_ — **Read-only legacy reachability check narrowed the bootstrap exception.** At
05:02Z, unauthenticated PATCH diagnostics sent no token/body. Exact c007 overrides on custom
and workers.dev both fell through to current ce93 (401, Bearer, ce93 UUID, exact Unauthorized
JSON). Six distinct affinity keys × two adjacent requests × two origins produced 24/24 ce93;
one shared key produced another 8/8 ce93 across both origins. No c007/404 was observed. This is
negative liveness evidence, not a safety proof: the code may accept c007 only when an
uncommitted shell-only UUID matches the exact Hono no-route fingerprint. Permanent operation
accepts only typed pre-Queue 409; version affinity is liveness-only. The next recovery deploy
will scope the legacy UUID to that one command and omit it forever after a PATCH-capable
predecessor is established.

_2026-08-03_ — **Fourth recovery final dry/local checkpoint; ready PR.** The implementation
survived approximately three finder/refuter rounds and three independent final DRY verdicts.
Review findings materially tightened the protocol: catalog and no-auth probe joined the same
stable affinity key and shared 60-second clock; only an exact three-field typed 409 or the
runtime-allowlisted c007 plain-text Hono 404 permits another authenticated PATCH; every 202,
transport/body ambiguity, redirect, and near miss is terminal; safe-rejection evidence is
redacted, bounded, emitted immediately, and retained in later failures; invalid bootstrap UUIDs
fail before build/Queue/D1/activation; post-accept forecast errors inspect Worker identity
before status; strict smoke restarts health + catalog + every forecast until one entire round
is exact-version clean. Canonical `pnpm verify` is green: fresh D1 migration/seed, 112 Node
script/config tests, 21 core, 10 DB, 226 web unit (+1 skipped), 14 Worker, 45 Python, production
build, and secretless Wrangler dry-run. Local public-feed ingest completed with one non-fatal
NDBC caveat but published 12/12 read models; strict smoke returned 6 spots/12 ready/0 pending;
the code browser rendered the complete report with zero alerts and no horizontal overflow.
Optional brief-agent local-date signals failed independently of deterministic publication and
are retained as a PR-C Analysis-path test note, not allowed to weaken this recovery gate.

**OODA — Observe:** the recovery has no UI or forecast-algorithm delta; all remaining risk is
the boundary between Cloudflare rollout routing and a non-idempotent Queue mutation. Unit
adversaries cover stale catalog/probe/auth combinations, ambiguous responses, deadline/cap
exhaustion, redaction, and full-round smoke convergence; the real local Worker proves the
queue-to-read-model path. **Orient:** the workstream exists to make forecasts dependable before
making them quieter and more teachable for a small group of surfers. A deploy routine that can
duplicate or misattribute a generation would undermine every later freshness chip and Analysis
explanation; indefinite deployment brittleness would block those user benefits just as surely.
**Decide:** prefer a narrow transition protocol over durable idempotency storage: repeat only
when the predecessor proves no mutation, cap it at three attempts/one minute, keep affinity as
liveness—not authority—and demand one exact-version smoke round. Accept the extra worst-case
handoff latency and a shell-only one-deploy legacy exception; reject blind retry, POST fallback,
manual replay, status-as-lock, or rollback without Queue quiescence. **Act:** publish the ready
recovery PR, require GitHub Verify, merge, take a fresh D1 bookmark, and run one supported deploy
with the c007 UUID scoped to that command. Close OI-5 only after one lineage, 12/12, exact
dual-origin identity, 100% deployment, queue 1/1, and browser proof are all live-green.

_2026-08-03_ — **PR #20 live gate failed closed; affinity-session OODA corrective began.**
Ready PR #20 at `c0c3539` passed GitHub Verify in 1m12s and merged as
`7d7b04209f36895d2ac641e6ef16c13b5918c58f` at `2026-08-04T05:34:36Z`. The local OAuth
token could execute D1 migration/seed but not the read-only Time Travel info endpoint, so the
named recovery anchor remained the 04:52 bookmark plus D1 point-in-time recovery; this patch
had no schema/seed delta. Seed completed at bookmark
`00000340-00000004-000050bd-e3bd374fc658291057f24d5f5b97b9a7`. Supported deploy activated
Worker `ce82bb5d-b9ba-46db-8621-c68fcb8ffbac` in deployment
`e4c83439-2632-48c7-a50e-112ab1085e6b` at exactly 100%; exact override and three ordinary
readiness checks passed. The handoff then made 57 keyed `GET /api/spots` requests, all served
by `ce93cdde…`, and reached its 60-second deadline before any route probe or authenticated
PATCH. The command explicitly reported “mutation did not begin”; ce82 remains active.

**OODA — Observe:** Cloudflare affinity did exactly what its contract promises: one key maps
deterministically to one version for a deployment and does not select the target. Fifty-seven
same-key reads were one frozen sample, not 57 convergence opportunities. After the deadline,
12 fresh keys × two adjacent requests on each origin produced 48/48 ce82 responses and zero
split pairs, proving key rotation is the missing liveness mechanism. Preflight and post-failure
control plane still show one target version at 100% and Queue 1 producer/1 consumer. **Orient:**
the safety boundary remains correct—no surf generation was duplicated or falsely attributed—
but OI-5 still blocks the quieter freshness and educational UI work. A personal planning tool
can tolerate one delayed refresh; it cannot tolerate a deploy path that permanently mistakes a
deterministic stale affinity assignment for convergence. **Decide:** reject longer same-key
polling, removal of affinity, override-pinned mutation, manual replay, and rollback. Rotate the
whole read-only candidate session: one fresh key, one exact-target valid catalog, one exact
401/Bearer probe, then at most one authenticated PATCH on that same key. Any read-only miss
discards the key; only the existing exact pre-Queue 409/allowlisted legacy 404 may discard a key
after authentication. Keep one 60-second deadline, one 60-session cap, three auth attempts, and
terminal semantics for every 202/ambiguity. The c007 shell exception was consumed by PR #20 and
will not be carried into the next deploy. **Act:** three independent design reviews converged on
this state machine. Implement it with deterministic key-factory, uniqueness, cap/deadline,
full-session restart, keyless convergence evidence, ambiguity, and no-leak tests; correct the
runbook; then repeat the full local/adversarial/GitHub/live ladder before touching PR-A.

_2026-08-03_ — **Fifth recovery reached the ready-PR checkpoint.** Two independent
frozen-snapshot reviews are DRY after successive finder/refuter rounds closed the stable-key
liveness trap, unread unauthenticated-2xx ambiguity, exact-target fail-fast boundary, token/key
cause leakage, lost prior evidence, misleading prospective auth counts, catch-path session
continuity, and the deadline-crossing-before-send counter edge. Focused remote-ingest tests are
77/77; all script tests are 131/131. Fresh canonical `pnpm verify` is green: 131 Node, 21 core,
10 DB, 226 web unit (+1 skipped), 14 Worker, 45 Python, fresh migration/seed, production build,
and secretless Wrangler dry-run. Local public-feed ingest published 12/12 read models with the
known non-fatal NDBC partial caveat; strict smoke returned 6 spots/12 ready/0 pending. The code
browser rendered the complete 1280px report with zero alerts, zero console warnings/errors, and
no horizontal overflow. Optional Gemini brief work hit quota/schema and prior-local-date
failures independently; deterministic forecast publication stayed green, so that signal remains
a PR-C Analysis-path test note rather than a recovery blocker.

**Checkpoint OODA — Observe:** every adversarial and real local path now preserves the exact
line between safe read-only session rotation and potentially mutating terminal outcomes; the
artifact, runbook, and diagnostics agree. **Orient:** this recovery carries no user-facing
forecast change, but it is the trust substrate for the quiet freshness and educational tabs
Alex and friends will use to decide when and where to surf. **Decide:** accept a bounded chance
that 60 fresh Cloudflare assignments still miss the target, because fail-closed fix-forward is
safer than weakening mutation identity; retain one extra catalog read per candidate for a
coherent evidence chain. Do not carry the consumed c007 exception into deployment. **Act:**
publish the ready PR, require GitHub Verify, merge, and execute exactly one supported deploy.
OI-5 stays open—and PR-A stays untouched—until one target lineage, 12/12, exact dual-origin
identity, deployment 100%, Queue 1/1, and production-browser proof are all simultaneously green.

_2026-08-03_ — **PR #21 merged; live gate isolated the cron/Queue-tail predecessor.** Ready
PR #21 at `ec0e222` passed GitHub Verify in 1m29s and merged as
`51849a8dcdcd994ec2420edddd1ce7e42c8d41df` at `2026-08-04T06:11:53Z`. Pre-deploy control
plane was exactly `ce82bb5d…` at 100%, Queue 1 producer/1 consumer, DLQ present, and D1 bookmark
`00000343-00000000-000050bd-83c68ca69e04f678e438127ce7b612af`; the historical legacy
override was explicitly unset. Supported deploy seeded to bookmark
`00000343-00000004-000050bd-8b408874d63624808bbf8bce5e29f2c1`, activated Worker
`8ce5bdf1-9b9b-4496-ab3b-08089f09a1a8` in deployment
`04dbca1e-9e55-41dc-bcf4-9fe3124965ab`, and passed exact + three ordinary readiness and 100%
deployment proof. The corrected affinity protocol acknowledged that exact Worker and began one
lineage at `06:13:19.808Z`; all five source runs completed by `06:13:43.490Z` (four success,
NDBC partial only for optional stale/missing metrics). Five spots published between 06:13:44Z
and 06:13:48.853Z. Bolinas did not, so the ten-minute verifier failed closed with exactly
`bolinas:1h|3h` pending; no replay or rollback followed.

The independent `:17` cron lineage `541dcaff…` started at `06:17:27.614Z`, completed at
`06:17:51.013Z`, and superseded four published rows by 06:17:57.258Z while Stinson retained the
deploy lineage and Bolinas retained `3eae0acd…` from 05:17Z. Read-only production-row
reconstruction at the deploy timestamp produced 121/121 scored hourly windows, 41/41 scored
three-hour windows, forecast payloads 402,585/147,208 bytes, and six fact bundles no larger
than 24,312 bytes. This rules out auth/routing, source ingest/persistence, schema, payload cap,
and deterministic Bolinas assembly. The exact child exception is absent from D1 and historical
tail was not available, leaving Queue child execution/persistence-tail as the bounded fault.

**Checkpoint OODA — Observe:** the new handoff worked and mutation identity held; the failure
moved downstream to sixth-child publication, then a newer scheduled source generation made the
older exact-lineage condition impossible. **Orient:** accepting mixed recent rows would hide a
real publication gap and teach the UI the wrong freshness semantics; blindly replaying could
duplicate work while the Queue state is unknown. `8ce5bdf1…` serves 12 usable rows and is safer
to fix forward than roll back after acknowledged Queue mutation. **Decide:** keep exact-lineage
success strict, but make non-convergence explicit and prevent the known schedule collision:
wait before any handoff request until the :17 cycle settles, terminate on positively newer
lineage, and log every child boundary durably. Retain batch/concurrency 1 and reject manual
replay, mixed-lineage success, longer blind polling, or rollback. **Act:** implement/review/test
the sixth narrow recovery, keep a read-only tail armed, ship through the full PR ladder, then
run one supported deploy and close OI-5 only on the original complete live proof.

_2026-08-03_ — **Sixth recovery reached the ready-PR checkpoint after two confirmed review
findings.** The first implementation reset readiness each polling round, but an independent
refuter proved that twelve sequential HTTP reads still have a within-round TOCTOU: an early
target can be overwritten while later targets are read, producing false mixed-lineage success.
The corrective is a public, no-store, metadata-only `/api/forecast-readiness` endpoint backed
by exactly one prepared D1 statement over active regional spots × 3h/1h. The client rejects
duplicate/missing/extra targets, non-canonical generation/timestamp metadata, wrong content
types, and malformed typed failures; one all-exact statement snapshot alone authorizes success.
A five-spots-exact/Bolinas-old snapshot remains pending, and any valid strictly newer foreign
lineage is immediately terminal. Individual forecast GETs no longer authorize publication;
strict smoke still validates their full payloads after the atomic gate.

The second refuter proved a clock-suspension race between the first safe-window read and the
authenticated PATCH. The guard now returns the exact validated timestamp and anchors the
existing 60-second handoff deadline there, before affinity-key creation or any network access;
a suspension beyond it creates zero keys and zero requests. A final synchronous pre-PATCH
check catches a jump during catalog/probe without sleeping on an aging affinity session. The
schedule literal is shared with Wrangler validation, which rejects anything except exactly
`17 * * * *`. The ten-minute post-cron settle is deliberately conservative but does not claim
Queue quiescence; atomic supersession remains fail-closed, and every accepted 202 remains
fix-forward unless quiescence and predecessor compatibility are independently proved.

The logging review also killed a synthetic signal: the Queue-level brief-failure catch could
never run because the production brief helper intentionally swallows optional Agent failures.
Ownership now stays in that helper, which emits one bounded
`forecast_brief_signal_failed` event with `ingestId`, `spotId`, generated/materialized times,
then resolves so the published deterministic forecast is ACKed and never retried. Queue child
start, supersede, lineage-check failure, materialization throw/rejection, and publish paths have
bounded structured evidence. Batch size/concurrency remain 1; no schema, auth, source, scoring,
or forecast payload behavior changed.

**Review/test evidence:** finder/refuter rounds confirmed and corrected the atomicity,
clock-anchor, and dead-observability findings; the final independent client/config review and
endpoint compatibility pass are DRY. Fresh `pnpm verify` passed 154/154 script tests, 21/21
forecast-core, 10/10 DB, 240 web unit (+1 skipped), 15/15 workerd/D1, 45/45 Python, isolated
migration/seed, production build, and secretless Wrangler dry-run. Focused remote-ingest is
99/99; focused Worker paths are 49/49; `git diff --check` is clean. Fresh local public-feed
ingest published 12/12 rows (known non-fatal NDBC partial, zero errors), strict smoke returned
6 spots/12 ready/0 pending, and the new endpoint returned one no-store 2,774-byte snapshot with
12 complete rows and the exact local Worker version. Code-browser checks at 1280×720 covered
the daily report and Bolinas spot page: zero alerts, console warnings/errors, or horizontal
overflow. The unchanged spot baseline still visibly leads with the large Daily Outlook before
forecast data, reinforcing rather than weakening the locked PR-C low-noise/tab direction.

**Checkpoint OODA — Observe:** the failed deploy exposed both a real sixth-child gap and the
inability of sequential client reads to prove a coherent database state; adversarial review
then found the same kind of false evidence in brief logging and clock anchoring. **Orient:**
Surf is a small friends-and-family planning tool, so operational complexity must earn its keep:
one cheap indexed metadata query and a few bounded log lines materially improve truth, while a
new schema, replay controller, or broad ops API would add noise. The deterministic forecast is
the product authority; AI brief work stays optional. **Decide:** pay one conservative pre-deploy
wait and one atomic metadata read per poll, expose only metadata already present in public
headers, and reject mixed/malformed evidence. Accept that a settle timer cannot prove Queue
emptiness, retain terminal supersession/fix-forward semantics, and record the duplicated JS/TS
generation regex as a non-blocking future drift risk. **Act:** publish the ready PR, require
GitHub Verify, merge, deploy exactly once, and close OI-5 only on simultaneous target identity,
one lineage/12 rows, Queue 1/1, strict smoke, and production code-browser proof. PR-A remains
untouched until that live checkpoint is green.

_2026-08-04_ — **PR #22 merged/live; OI-5 closed at the recovery boundary.** Ready PR #22
passed GitHub Verify in 1m24s and merged as `334c9071dfa3c8607383410dd1a1c623b2066d37`
at `07:17:31Z`. Pre-deploy D1 bookmark was
`00000347-000000d8-000050bd-c8eefe6a78750cc70af40919b6564957`; the supported deploy's seed
advanced it to `00000347-000000dc-000050bd-7822198dfc0b4c58f36ecf5143f49065`. One deploy
activated Worker `04e3ace7-78b2-4f03-b722-44cc7cd0c126` in deployment
`e3ab7a95-3a2a-4839-9910-15cc2cbd15de`; exact plus ordinary health probes converged and
authenticated deployment status showed that sole version at 100% both before enqueue and
after smoke. Because the upload followed the scheduled `07:17` run, the new guard emitted
`remote_ingest_cron_deferral` and made no mutation until `07:27:00Z`.

The resumed handoff accepted exactly one authenticated PATCH and one affinity session. All
five source rows share start `07:27:00.914Z` and completion `07:27:22.746Z`; CO-OPS, CDIP, and
both NWS adapters succeeded, while NDBC was partial only for its known optional observation
caveats and recorded no error. Six Queue children materialized all spot pairs from
`07:27:23.402Z` through `07:27:29.599Z`. A primary-served, zero-write D1 SELECT returned one
ingest suffix (`04e3ace7…`), one generation time, six spots, two intervals, and exactly 12
rows; every row has schema 1 and a nonempty forecast payload. The fresh post-proof recovery
bookmark is `00000348-000000fc-000050bd-e9575969459305a3ef9ef348f15658c6`.

Public verification was intentionally independent of the deploy command. Custom and
workers.dev origins returned byte-identical 3,710-byte atomic snapshots: HTTP 200,
`application/json`, `Cache-Control: no-store`, Cloudflare cache bypass, exact Worker header,
exact 6×{3h,1h} keyset, and no duplicate/missing/extra rows. Strict smoke on both origins
returned 6 spots/12 ready/0 pending with scored five-day forecasts and the exact Worker.
Authenticated Queue inspection showed `surf-ingest` at one producer/one consumer; its sole
consumer remains batch size 1, max concurrency 1, max retries 3, and the expected DLQ.
In-app-browser reloads of the daily report and Bolinas at desktop, plus an independent 390×844
phone pass, found no alerts, console warnings/errors, or horizontal overflow. The browser also
preserved a useful future-state observation: phone still hides source age and the spot's AI
Daily Outlook still pushes deterministic forecast data below the first viewport; those are
OD-9 evidence for PR-B/C, not recovery regressions.

**Checkpoint OODA — Observe:** version activation preceded data publication, but the guard
held mutation through the real cron collision and the atomic endpoint then changed from the
complete predecessor snapshot to one complete target snapshot; no observer accepted a mixed
state. Control plane, D1, HTTP, strict payload consumers, and two browser auditors agree.
**Orient:** recovery now restores the trust foundation for a personal surf planner: friends
see deterministic, scored data from one coherent cycle, while optional AI failure remains
non-gating. Operational evidence must stay compact and causal; the visibly noisy spot hierarchy
belongs to the already-locked Forecast/Analysis work, not this hotfix. **Decide:** close OI-5;
retain the conservative ten-minute cron settle, public metadata-only atomic endpoint, exact
lineage/supersession rules, Queue serialization, and fix-forward-after-202 policy. Accept the
small extra deploy latency and metadata query cost because they prevent false publication
claims; do not add replay, schema, or queue-drain machinery. **Act:** preserve bookmark
`00000348…`, remove the now-unneeded temporary production reconstruction only after this
checkpoint, and begin PR-A from `334c907`. PR-B remains gated on PR-A live-green; PR-C remains
gated on PR-B live-green.

_2026-08-04_ — **PR-A repo implementation stabilized; final adversarial round DRY, but the
ready-PR gate remains honestly open.** Branch `aylee/surf-ops-observability` still points at
live-green base `334c907`; no commit, PR, Cloudflare mutation, or PR-B code was made before
this checkpoint. T-A.1 now gives orchestration sole ownership of one terminal source line and
one terminal line per spot/interval, using real D1 `meta.changes` to distinguish publication
from supersession. Deterministic skip/supersede paths ACK, retryable failures reject, and a
mixed publish/supersede pair is logged literally, ACKed, excluded from history/Agent work, and
left for the next generation to repair. The formerly silent missing-read-model 503 now logs.
Every production console site touched by this flow emits fixed reason codes and a total,
single-read error-name bucket; hostile accessors, proxies, revoked proxies, raw provider
messages, payloads, and secrets cannot cross the log boundary.

Optional brief signaling now carries the exact published `ingestId`/`generationId` and reads
the active fact bundle from one D1 snapshot before RPC. Already-superseded work is skipped with
a bounded info event. Adversarial review then proved the stronger A/B race: a delayed older
Agent RPC could arrive after newer B and replace its coordination row. A first generated-time
guard closed the direct case, but an independent refuter found that newer same-material B
coalesced without advancing the stored timestamp, allowing an intermediate older/different A
to return. The final design uses a separate idempotent Durable Object SQLite
`forecast_brief_generation_high_water` row per local date. Existing objects bootstrap only
from a schema/identity/fingerprint-checked job bundle; every enabled equal/newer signal
advances canonical high-water before any duplicate/coalescing/status return; older work loses
authority before token/state/queue mutation; and token-scoped queue cleanup intentionally
leaves high-water intact. Equal-timestamp material corrections remain allowed to preserve
current correction/retry semantics. This is coordination state, not product history; no D1
migration or new remote resource was added.

T-A.2's tracked config enables and persists 100% invocation logs plus automatic traces using
Wrangler 4.118.0's current schema. Account-scoped destination names stay only in the ignored
instance overlay; tokens/endpoints never enter commands or tracked files. Current Cloudflare
docs were rechecked for
`observability.{logs,traces}.{enabled,head_sampling_rate,persist,destinations}`, the account
destination API (`GET /accounts/{account_id}/workers/observability/destinations`), and
Durable Object input-gate behavior. The runbook names US Logfire trace/log endpoints, a raw
`Authorization` write-token header entered only in Cloudflare, EU substitution, and
configuration-only rollback. OI-4 remains operator-owned and OI-6 remains a real :17
production proof, not an acceptance rewrite.

T-A.3 adds `pnpm ops:status` with exactly four read-only probes: one 10-second HTTPS health
GET, active deployment status, the sole Queue consumer, and one metadata-only D1 SELECT.
Success requires the serving Worker to equal the one 100% deployment, one Worker consumer
with batch/concurrency 1/1 and the configured DLQ, and exactly six complete 1h/3h pairs whose
generation IDs are canonical, timestamps round-trip canonically, chronology is valid, and
payload length is nonzero. A spot pair may not split lineage, but complete spots may
legitimately differ in generation/materialization time; the command does not invent a global
freshness rule. Generic Cloudflare subprocesses are finite (45 minutes for the supported
deploy horizon, 60 seconds for ops probes); only exact operator-held `wrangler tail` is
explicitly unbounded. Timeout/subprocess diagnostics suppress captured output and stderr.

**Adversarial cookie trail:** Round 1 confirmed raw brief-error leakage, deterministic
skip/supersede retry, unbounded child processes, missing top-level observability enablement,
and noncanonical timestamps; all were fixed. A refuter then caught the 45-minute timeout
breaking operator-held `tail`; exact `tail` alone became unbounded and the round dried.
Round 2 confirmed split-pair false positives in `ops:status`, attacker-controlled
`Error.name`, and invalid inline brief signals for superseded/mixed pairs. Fix refuters then
proved hostile proxy/accessor sanitizer escape and context-without-enforcement at the fact
bundle lookup; both were fixed and independently closed. Round 3 proved the post-read Agent
race, the same-material high-water hole, and a source reason that literally claimed
`inline_forecasts_published` for all-superseded/mixed outcomes. The high-water design above
closes both Agent races; source success reasons now describe only
`inline_source_persistence_completed[_with_caveats]`, leaving the 12 interval lines as the
sole publication authority. The final independent runtime and ops/security lenses are DRY.

**Verification/tradeoffs:** fresh serial evidence is web unit 263 passed +1 intentional skip,
scripts 182/182, focused Agent/order + inline Queue + Worker 57/57, Worker type/config check,
TypeScript, production Vite build, secretless ignored-overlay Wrangler bundle dry-run, and
clean diff. One parallel reviewer run missed an App timer test; it passed isolated and in the
serial full suite, so harness contention was refuted. Listener-backed evidence is explicitly
missing: the new workerd regressions (real D1 publish/supersede, B→A ordering, queue-failure
high-water persistence, corrupt bootstrap) are typechecked but cannot bind locally; root
`pnpm check` independently fails at `tsx`'s IPC listener with `EPERM`. The current Codex
execution limit prevents the already-rejected escalated listener path, so no workaround was
attempted and `pnpm verify`/local public-feed e2e are not claimed green. GitHub Verify must
run the canonical listener suite; Alex's operator shell must still run the local canonical and
e2e commands before the PR becomes ready.

**Boundary OODA — Observe:** repo behavior, structured-log semantics, tests, config schema,
and secretless bundle now agree; two fresh reviewers can no longer produce a P0–P3 finding.
Production is unchanged and still healthy on `04e3ace7…`, but OI-4 and the listener-backed
local evidence are absent. **Orient:** this is a personal planner for Alex and friends, not an
ops dashboard; every line and status must help answer “can I trust this forecast?” without
duplicating or contradicting the deterministic interval facts. AI remains optional, Queue
serialization and last-good D1 data remain authoritative, and PR-B/C cannot borrow trust from
an unverified predecessor. **Decide:** accept small coordination/storage cost for durable
generation monotonicity, four compact probes instead of a broad admin surface, 100% telemetry
for six hourly jobs, and neutral source-stage language. Preserve equal-time corrections and
per-spot generation independence; reject raw diagnostics, replay, global freshness heuristics,
silent local-gate waivers, premature merge/deploy, and any PR-B start. **Act:** checkpoint this
state, publish only as incomplete to obtain GitHub evidence, request the exact operator-shell
and OI-4 actions, and move to ready/merge/deploy only after both gates are real. Then wait for
the next actual :17, close OI-6 from Logfire evidence, prove 12-ready ops + dual-origin smoke
and browser health, and only then begin PR-B.

_2026-08-04_ — **Draft PR #23 first GitHub gate failed on one stale high-water assertion;
runtime behavior and the corrective are independently DRY.** Commit `d411245` was pushed and
opened as an intentionally incomplete draft because OI-4 and the operator-shell local gate
remain open. Verify run `30894701075` passed fresh isolated migrations/seed, portability and
all package checks, 182 scripts, 263 web unit (+1 skipped), and 17 of 18 workerd tests. The new
real-D1 publish/supersede test and every direct/coalesced Agent race regression passed. The sole
failure replayed old bundle G0 after newer same-material G1 had already advanced durable
high-water, but retained the pre-high-water expectation `terminal`; actual
`superseded` is the required monotonic outcome. A one-line expectation/comment correction
preserves the queue-length assertion and the later proof that equal-high-water G1 recovers and
publishes after cooldown. Independent control-flow review is DRY; focused Agent unit 5/5,
type/config check, and diff check pass. No runtime code or production state changed. Push the
test-only corrective and require a wholly green second Verify before reconsidering readiness.

_2026-08-04_ — **PR #23 GitHub Verify is green at the corrected head.** Commit `5787482`
passed run `30895038090` in 1m16s: fresh isolated D1, repo/package checks, scripts, web unit,
all 18 workerd tests, Python, production build, and secretless Wrangler bundle. This closes the
CI execution gap for the new listener-backed regressions but does not rewrite the local gate:
Alex still needs to run `!pnpm verify`, `!pnpm dev`, and
`!pnpm ingest:local && pnpm smoke:local` in his ordinary shell. OI-4 destination/token
provisioning also remains open. Keep PR #23 draft, make no deployment, and do not start PR-B.

_2026-08-04_ — **PR-A boundary OODA/refuter reopened T-A.1.** Independent manifest-to-code
reconciliation found that the operator commands covered only healthy ingest/smoke, not the
locked missing-read-model acceptance, and that the signature 503 line lacked the stable
event/reason vocabulary claimed for production logs. The smallest corrective adds
`forecast_read_model_missing` / `read_model_missing`, pins the exact JSON contract, and records
a reversible local-only `obsf-central`/`3h` delete → 503/log → ingest/smoke recovery procedure.
Each healthy/recovery ingest must also prove one source terminal plus exactly 12 unique
spot/interval terminals under its `ingestId`; smoke alone is insufficient.
The corrective's second independent refutation is DRY; focused Worker 24/24, serial web unit
263 +1 skipped, scripts 182/182, web check, and diff check are green. T-A.1 is still in
progress until that procedure runs in Alex's ordinary shell. The last green CI is
evidence for `5787482`, not the later docs/corrective head; require exact-head Verify. OI-4
remains open, production is unchanged, and PR-B/C remain untouched.

_2026-08-04_ — **Runtime handoff Codex → Claude; PR-A local + exact-head CI gates closed;
OI-4 is the last pre-ready gate; owner added PR-D spot scope (OD-11).** GitHub Verify run
`30896164337` completed green in 1m21s at the exact pushed head `4e43384` (fresh isolated D1,
repo/package checks, scripts, web unit, full workerd suite, Python, build, secretless bundle),
closing the current-head CI gap the boundary refuter required. The operator-machine shell then
closed the local gate end to end: canonical `pnpm verify` exit 0; healthy e2e (`pnpm dev` +
`pnpm ingest:local` published 12/12 with zero errors and the known NDBC partial caveat;
`pnpm smoke:local` 6 spots/12 ready/0 pending/scored) with dev-log proof of exactly one
`source_ingest_published` terminal (`a066a2f0-5895-4f47-801a-b9ba6a8bfb83`, reason
`inline_source_persistence_completed_with_caveats`) plus 12 unique spot/interval
`forecast_materialization_published` terminals, all `publish` with nonempty `generationId`s
and reason `forecast_generation_published`; the reversible degraded proof (dev stopped,
local-only `obsf-central`/`3h` delete, restart → HTTP 503 + `Retry-After: 300` + exact bounded
`{"event":"forecast_read_model_missing","reasonCode":"read_model_missing"}` line); and the
recovery ingest `935915d4-4e96-4827-998a-ac0774e7bfe1` republishing 12/12 with the full
one-source/12-terminal set and green smoke. T-A.1 is done; T-A.4 awaits only OI-4. Read-only
`deployments status` shows production unchanged on `04e3ace7…` at 100%. Root `.env` carries
`SURF_INGEST_TOKEN`/`SURF_BASE_URL`/`SURF_WRANGLER_CONFIG`, so the ship-time deploy runs from
this runtime without new secrets handling. The owner's kickoff added the five-spot catalog
expansion (Rodeo Beach/Fort Cronkhite; Steamer Lane; Pleasure Point; Cowell's; 38th Ave/Jack's)
locked as OD-11 → PR-D strictly after PR-C; read-only parity scouting started in parallel.
No production state changed this session so far.

_2026-08-05 (UTC)_ — **OI-4 closed; OI-7 opened; ship ladder authorized.** Alex authorized the
Cloudflare API MCP and created `surf-logfire-traces` in the dashboard (the earlier Bad Request
was the destination preflight failing on an empty custom-header row). The agent verified via
the authorized API that only the traces destination existed, then created `surf-logfire-logs`
(opentelemetry-logs → logfire-us `/v1/logs`) mirroring the traces auth header
programmatically; both destinations are enabled with passing preflights. `LOGFIRE_READ_TOKEN`
landed in gitignored root `.env` and returned HTTP 200 on the Logfire query API, so the OI-6
`:17` verification can run autonomously. One cost: the destinations GET echoes the
`Authorization` header, so the Logfire write token entered the agent transcript — recorded as
OI-7 (rotate token + PATCH destinations after the live gate; config-only rollback). Next: the
recorded ship ladder (checkpoint commit → exact-head Verify → ready → merge → deploy → `:17`
proof).

_2026-08-05 (UTC)_ — **PR-A shipped and live-verified; OI-6 closed with a split-trace verdict;
one new bounded fault recorded (OI-8).** Ready PR #23 merged as `284b25f` at 01:43:32Z. Alex
ran the supported deploy (runtime permission classifier blocks agent-initiated `pnpm deploy`;
recorded as the expected operator step). Pre-deploy D1 bookmark
`000003a7-00000000-000050be-6c0138cacaa371054793ca7638da7d3f`. The deploy activated Worker
`53084465-66e6-4bf1-ba1d-1fff32cef209` in deployment `19361955…` at exactly 100% and passed
exact + 3-consecutive readiness; the handoff source job and five spot children published 10
rows on the deploy lineage (232–395 ms CPU each), but the sixth serialized child (bolinas)
was killed `exceededCpu` at ~50–85 ms CPU on all four delivery attempts — no terminal event
could run, the message parked in the DLQ, and the verifier correctly failed closed with
exactly `bolinas:1h|3h` pending, leaving the new version active for fix-forward. Production
stayed user-healthy throughout (bolinas served last-good 01:17 data; `ops:status` PASSed with
the pair un-split). PR-A telemetry turned the previously blind PR #21-class fault into exact
evidence (queue-child outcomes + CPU/wall per attempt) — recorded as OI-8 with a corrective
decision checkpoint at T-B.5.

**OODA — Observe:** the 02:17Z cron on the same version published all six spots including
bolinas (22-span healthy child trace, 02:17:53Z), converging all 12 rows to one generation
`02:17:14.356Z`. Live gate evidence: `ops:status` 4/4 PASS · strict smoke green on
surf.alexlee.ai and workers.dev with exact Worker identity · Logfire query API returned the
cycle as cron→source (205 spans)→six children traces with exactly 1 source + 12 publish
terminal events under `ingestId af39a489…` · desktop + 390×844 phone browser passes with zero
alerts/console errors/overflow. **Orient:** the failure mode moved from invisible to
diagnosable in one release — precisely the workstream's purpose; the deploy-window kill is an
operational annoyance, not a data-integrity risk (fail-closed held twice). **Decide:** close
T-A.5/Phase A; do not block PR-B on OI-8 (UI-only leg; watch its deploy for recurrence);
keep the DLQ message parked per no-replay policy; rotate the write token (OI-7) at next
operator touch. **Act:** ledger close-looped (OI-6 → resolved, OI-8 → open), impl-plan Phase A
marked done, PR-B branch starts from `284b25f`.

_2026-08-05 (UTC)_ — **PR-B implemented; adversarial round 1 confirmed real defects; fixes
landed; round 2 in flight.** Branch `aylee/surf-freshness-cadence` from `284b25f`. T-B.1:
`freshnessVerdict` pure/total in contracts (+11-test matrix, new contracts vitest harness);
additive `expectedCadenceMinutes`/`graceMinutes` on `SourceFreshnessSchema`; status enum
deliberately unwidened ("late" renders stale, "aging" stays quiet-fresh). T-B.2: cadence+grace
exported beside each adapter's source ID with citations (CO-OPS 1440/360 fetch-recency; NWS
point 360/180; NWS grid 720/240; CDIP 360/180 against the file-update timestamp, cycle stays
lead-hour authority; NDBC 60/60 ≡ the existing 120-minute boundary); worker entries carry
them; `docs/feed-adapters.md` gains the Declared Freshness Cadence table. T-B.3: chip compares
formatted labels; banner = named unavailability or named late source only; forecast-health
and forecast-adapter judgments subordinated (legacy fallback boundary preserved via contracts
constants); phone chip un-hidden (OD-9). Local e2e: 12/12 ingest, all 41×4 payload entries
carry cadence, quiet desktop, visible 390px chip, clean console, screenshots banked.
**Round 1 (5 finder lenses → 3 refuters each, 53 agents): 16 findings → 14 survived; root
causes: (P1) delayed-banner "showing data from" drifted with the dashboard clock — fixed with
per-spot fetch times + anchored-drift regression; (P2) tide's 30h late verdict unreachable —
the 100-row source_runs window evicts referenced runs at ~20h — fixed with a
newest-success-per-source union; plus restored null-age banner guards (an interim edit had
dropped them), banner day tier, byte-budget fixture realism, and seven pinned test gaps.
Canonical `pnpm verify` green again at `24a97a1`. Note: 7 round-1 refuters died on the
owner's individual spend limit; round 2 runs leaner (3 lenses × 2 refuters).**

_2026-08-05 (UTC)_ — **PR-B review reached DRY after three rounds + a scoped delta check.**
Round 2 (3 lenses; all 18 refuters died on the owner spend limit, agent-adjudicated by the
orchestrator with the finders' SQLite reproductions): (P2) the round-1 union rescued only
`success` runs while `partial` runs also own referenced rows — fixed; (P2) cross-day
"showing data from" times — date-aware format; (P2) recovery left a stale named banner —
notice recomputed for remaining delayed spots; (P2) unscoped late banner could contradict a
fresh spot's panel — worst-spot scoping when not late everywhere; (P3×3) the retention SQL
was executed by zero tests (finders proved invalid SQL passed both suites) — new real-D1
workerd spec; plus removal of refuter probe files/root screenshots a blanket `git add -A`
had swept in (also the source of the interim `lateSourceNotice` guard regression). Round 3
(single fresh-eyes finder) found the residual: newer partial runs evict a spot's OLDER
pinned run from the newest-per-source branch — replaced the union with reference-driven
retention (exact follow-up fetch of referenced run ids; zero extra queries steady-state),
pinned by the spec's newer-partial scenario. Scoped delta check: DRY. `pnpm verify` green at
`b1122fd` (contracts 11, core 21, db 10, web 277+1skip incl. 20 App tests, workerd 19,
Python 45). Next: ready PR → Verify → merge → operator deploy → `:17` quiet-steady-state
live proof (watch OI-8 at the handoff).

_2026-08-06 (UTC)_ — **PR-B merged and deployed; live UI verification green; awaiting the
03:17Z scheduled-cycle proof.** PR #27 merged as `c39f151` after exact-head Verify (1m31s).
Pre-deploy bookmark `000003cf-00000000-000050bf-b3532ca26d4380b4c83ed7c161b38319`.
Operator-run supported deploy activated Worker `18eba224-79ac-4b53-9045-af0f82d3cbb0` in
deployment `8a966cae…` at 100%; the handoff published **all 12 rows including bolinas — no
OI-8 recurrence** (1 affinity session, 1 authenticated attempt); strict smoke green on
workers.dev, post-smoke control plane unchanged. OI-8 verdict at this checkpoint:
intermittent (1 of 2 deploys), stays open, does not block PR-C; re-evaluate at PR-C's deploy.
Live verification on the new version: `ops:status` 4/4 with 12/12 on one `02:27:01Z`
generation; custom-domain smoke green; live payloads carry cadence+grace on every source
entry (all fresh); production browser at 1280×720 and 390×844 — honest chip
("Sources 33m–7h old", the grid-wave age quiet inside its declared cadence), **no banner**,
phone chip visible for the first time (OD-9), zero console messages, no overflow. Remaining
for T-B.5: the 03:17Z cron republishing 12/12 with the steady state staying quiet (watcher
armed). PR-C scouting started read-only in parallel; implementation stays gated on live-green.

_2026-08-06 (UTC)_ — **PR-B live-green; Phase B closed; Phase C begins.** The 03:17Z cron
republished all 12 rows (`generated 03:17:14.351Z`, ops 4/4). T-B.5 acceptance held: quiet
chip, no banner, correct collapsed-range copy, mobile chip visible, smoke green both origins.
Phase C starts from `c39f151` on `aylee/surf-forecast-analysis-tabs`; the tabs-scout map is
in hand (AnalysisPanel extraction for lazy brief fetch; `tab` param null-on-default; the
exact-match `readWorkbenchUrl` test; ~20 moving assertions; OD-9 deletion list; S-2
provenance surfaces move intact).

_2026-08-06 (UTC)_ — **PR-C implemented and locally proven; adversarial round 1 in flight.**
Commit `3918354` on `aylee/surf-forecast-analysis-tabs`: outer Spot-view tabs (Forecast
default | Analysis) with the brief fetch owned by an extracted AnalysisPanel (zero /brief
requests until Analysis mounts — verified in-browser), `tab=analysis` deep link with
null-on-default URL writes, slim deterministic header (kicker gone, duplicate ConditionPill
gone, PR-B verdict badge added), OD-9 deletions (workbench heading/blurb/legend, auto-expanded
row explanation — expansion now click-driven and decoupled from selection), quiet one-line
no-reliable-call collapse (fetch skipped), home de-dup (shortlist + source-count removed →
exactly 6 unique spot links), phone compare-row CSS pairing. Provenance/learning-guide moved
intact to Analysis (S-2). `pnpm verify` green (web 282 incl. 22 App + 12 workbench tests;
workerd 19). Local browser e2e at 1280/390: default-tab semantics, deep link (exactly 1 brief
request on Analysis), distinct tablist names, no auto-expanded detail, no overflow, home
6-unique-links — plus PR-B's banner observed live-firing on stale local buoy data with spot
scoping, day tier, and cadence copy ("Buoy observations at Linda Mar / Pacifica 1d old;
expected hourly."). Review round 1 (3 lenses × 2 refuters) running.

_2026-08-06 (UTC)_ — **Runtime handoff Fable → Opus (owner spend limit); PR-C round-1
findings fixed and self-adjudicated.** The owner's Fable 5 monthly spend limit terminated all
18 round-1 refuters, so the orchestrator adjudicated the 9 findings by reading the code
directly — recorded as a degraded protocol, not a clean refuted/confirmed split. Four
substantive issues were **confirmed and fixed** in `7717677`:
(1) **P2, twice-found:** the new hero badge mapped null-age placeholder entries through
`sourceFreshnessVerdict`, which returns `late` when cadence exists — so one absent source
(e.g. a buoy with no observation row; the worker always ships all four entries with cadence)
pinned every spot to "Data late" while the banner deliberately stayed silent and the
provenance panel said "Missing". The badge now applies the banner's exact null-age exclusion.
(2) **P1:** the badge used a light-surface color recipe on the deep `.spotHero` (measured
1.0–2.3:1); it is now light-on-dark — in-page measurement gives text 10.21/10.66/11.25:1 and
border-vs-glow 3.76/4.22/3.10:1 for fresh/aging/late, clearing WCAG 1.4.3 and 1.4.11 in the
worst case. `text-transform: capitalize` (which rendered the locked copy as "Data Late") is
gone, and the phone grid no longer stretches the pill (82 px, `justify-self: start`).
(3) **P2 (S-2):** the deleted legend was the only decoder for the moon icon and night-row
dimming on the default view — the learning guide never covered it and moved to Analysis
anyway. Night semantics are restored in place via a Time-column `InfoTooltip` and
`aria-label="Night window"` on both desktop and mobile moon icons — information preserved
without re-adding always-visible chrome.
(4) **P3×4:** the badge aggregation and the desktop expand/toggle/reset logic had zero pins —
finders proved both survived mutation with all tests green. Added four badge-state pins
(fresh/aging/late/absent, including the null-age case that fails without fix 1) and a desktop
pin (no auto-expand on load, click expands with `aria-expanded`, second click collapses,
resolution change clears it). `pnpm verify` green: web 284 (+1 skip), workerd 19.

_2026-08-06 (UTC)_ — **PR-C round 2 found four more real defects (all fixed in `6738f0f`);
round 3 running; owner UI nit logged as OI-9.** Subagents work again on the Opus session, so
round 2 ran with real fresh-eyes lenses (two, no refuter panel — budget-lean):
(1) **P1:** the round-1 badge fix was incomplete. It excluded null-age entries but still
reduced over an `observed_wave` entry whose observation is too far from the featured window to
support it — a state the worker itself excludes from `activeCapabilities` and from the
window's freshness scalar. A buoy 2–24h stale therefore made the header claim "Data late"
while every row read High confidence and the provenance panel showed three Fresh sources
(reproduced by probe). The badge now judges only the window's own `activeCapabilities`,
mirroring the worker exactly.
(2) **P2, found twice:** the round-1 night-decoding fix was desktop-only — the Time-column
tooltip lives inside `.forecastTableViewport`, which is `display: none` below 800px (and Radix
tooltips do not open on touch), so phone users still had an undecoded moon glyph. Night
semantics now also appear in `WindowExpandedDetails` (rendered by both the desktop table and
the mobile accordion, so tapping a moon row explains it in context) and as a field-guide entry.
(3) **P2 regression:** `hasReliableCall` gated the brief *fetch* on `canonicalDayBest`, which
`selectCanonicalRecommendationIds` limits to current-or-future daylight windows — so selecting
a day whose windows had merely elapsed issued zero `/brief` requests and made the Worker's
published outlook, its bust factors, and its lesson unreachable from any surface. The fetch is
gated on `selectedDate` again; the quiet line now appears only when the server has no brief
*and* the local read has no pick.
(4) **P2:** the quiet line asserted "the Forecast tab still shows every available public
input" even when that tab was showing a `role="alert"` outage, and Analysis carried no status
of its own. It now states the real state with `role="status"` and only makes the sibling-tab
claim when a forecast actually exists.
Two new pins cover brief reachability on an elapsed day and the outage copy; one earlier pin
was corrected because it had encoded defect 3 as expected behavior. `pnpm verify` green: web
285 (+1 skip), workerd 19. Owner also reported a production UI nit (repeated best-window
statement) → tracked as OI-9, deliberately not folded into PR-C's reviewed diff.

_2026-08-06 (UTC)_ — **PR-C round 3 caught an overcorrection plus three AnalysisPanel gaps;
all fixed in `4e7e0fc`; scoped delta check running.**
(1) **P1 — my round-2 fix was wrong.** Filtering the badge by the window's `activeCapabilities`
looked principled but inverted the failure: `NDBC_STALE_AFTER_MINUTES` *equals*
cadence + grace, so "buoy verdict is late" and "worker drops observed_wave from
activeCapabilities" are the same boundary. Every late buoy therefore became an unqualified
"Data fresh" in the header while the banner named that exact source as late and the provenance
panel labelled it Stale — a worse contradiction than the original. The badge is back on the
banner's rule (non-null age + declared cadence, worst wins) and is now pinned on the exclusion
path, which the shared fixture could not previously reach because it hardcodes `observed_wave`
into `activeCapabilities`. Recorded as a lesson: two rounds disagreed about this surface, and
the tie-breaker is cross-surface consistency, not per-window input purity.
(2) **P2:** the date-scoped outlook had no day context once the day picker moved to the
Forecast tab — a Saturday brief read as today's call beside a hero keyed to another date.
Analysis now renders "Outlook for <weekday, Mon D>" from the selected local date key.
(3) **P2:** the quiet line announced "No daylight recommendation for this day" through
`role="status"` for the whole in-flight window and then silently retracted it — worst on a cold
Worker or slow link, and repeated on every tab re-entry since Radix remounts the panel. An
in-flight request now shows a neutral `aria-busy` loading status instead.
(4) **P2:** dropping `fallbackBrief` from the effect deps removed the only refetch path, so a
mounted Analysis tab kept a superseded outlook through refreshes while every other surface
advanced. The deps now include `canonicalGeneratedAt` — a stable string that moves only when
the payload really does.
Four new pins cover the badge exclusion path, the day label, the loading state, and the
refresh-driven refetch. `pnpm verify` green: web 287 (+1 skip), workerd 19, Python 45.

_2026-08-06 (UTC)_ — **PR-C delta check found three fix-induced defects (fixed in `eca25f1`);
a convergence check is now running on the churned component.** All three came from my own
round-3 fixes, which is the signal that matters:
(1) **P1:** adding `canonicalGeneratedAt` to the brief effect deps without touching the
`setServerBrief(null)` at the top of the effect body meant every refresh *tore down* the
outlook it was refreshing — and a transient refetch failure erased a good published brief
outright. The clear is now scoped to a `spot:date` change via a ref, replacement happens only
on success, and the error boundary is keyed by scope so a refresh no longer remounts the card
and collapses disclosures the reader has open.
(2) **P2:** `briefLoading` started false and was only set inside the effect, so the first
committed paint on an elapsed day was the recommendation *denial* — announced through a live
region — before the request had even been issued, repeating on every tab re-entry. It is now
initialized from the selected date, and the outage copy takes precedence in the render order.
(3) **P2:** the new day label interpolated an unvalidated URL date key, and JS rolls impossible
dates forward, so `?date=2026-02-31` rendered a confident "Tuesday, Mar 3" nobody asked for
(and `?date=hello` echoed "hello"). The formatter now round-trips its parts and returns null
for anything that is not a real calendar day, the label is omitted rather than fabricated, and
malformed date params are discarded at the URL boundary.
Three new pins cover refresh-keeps-outlook, failed-refetch-keeps-outlook, and the bogus-date
label; the adapter pins date-key validation. `pnpm verify` green: web 290 (+1 skip), workerd 19.
**Process note:** rounds 1–3 plus the delta check found 4/4/4/3 defects, increasingly
*introduced by the previous fix* and concentrated in the extracted `AnalysisPanel`. Rather than
patch a fifth time, the next pass is an explicit convergence check that must also judge whether
the panel's state model (three booleans + a ref) should be restructured — e.g. a scope-keyed
remount or a single discriminated status union — instead of accumulating more instance fixes.

_2026-08-06 (UTC)_ — **Convergence check said "not converging"; restructured the Analysis
state model instead of patching a fifth time (`5497101`).** The checker's diagnosis, which I
accepted: the panel encoded a four-state request machine in `serverBrief` + `briefLoading` +
a `loadedScope` ref, then intersected it at render time with a prop pair (`forecast`,
`forecastErrored`) that *structurally cannot* distinguish "not fetched yet" from "fetch
failed". Every pass rebalanced precedence among `hasBriefContent`, `awaitingBrief`, and
`forecastUnavailable`, and each rebalance moved the falsehood to a different cell — round 3
fixed the pre-request denial, the delta pass fixed the refresh teardown and in doing so broke
loading-vs-outage, the live-region truth, and the boundary's recovery. Three defects were
still open at that point (outage claimed during a healthy in-flight hourly request; provenance
unmounting mid-read on an hourly refresh; "Daily outlook updated." announced for a refetch
that returned nothing).
**The restructure:** the parent derives one `ForecastStatus` (`loading | ready | error`) from
state it already had; the brief moved into a `DailyOutlook` child keyed `spot:date` so a scope
change *remounts* rather than being cleared by hand; that child owns one `OutlookState`
(`loading | ready | empty`); the render is an exhaustive walk with no precedence to get wrong;
a failed or empty refetch keeps its `ready` state so nothing is torn down or falsely announced;
and provenance renders from `forecast ?? canonicalForecast` so the disclosure survives an
interval refetch. Deleted outright: `serverBrief`, `briefLoading`, `loadedScope`, `briefScope`,
`hasBriefContent`, `awaitingBrief`, `forecastUnavailable`, the clear-on-scope branch, and the
boundary-key tradeoff.
All 293 web tests (incl. every pin from rounds 1–3 and the delta) pass unchanged through the
restructure, which is the evidence that behavior was preserved rather than redefined; three new
pins cover loading-vs-outage, provenance survival, and the absent false-update announcement.
Browser-verified at 390: Analysis renders day label → card → tools → provenance with exactly
one `/brief` request and `aria-busy=false`; Forecast default has zero `/brief` requests, no AI
content, no auto-expanded row, first row in the first viewport, no overflow.

_2026-08-09 (UTC)_ — **Rounds 5 and 6 on the restructured panel: the class is closed, two
residual cells were not (`3fd43a0`, `4a16ba7`).** The convergence re-check returned
`converged: false` but with a materially different verdict than round 4: no P0/P1 across mount,
tab switch, date change, spot change, interval change, refresh, abort/unmount, elapsed day, or
missing cadence — the four-boolean intersection is genuinely gone — and three P2s that were
"residual cells inside the new union, not another overloaded truth table". Fixed all three:
(1) `OutlookState.empty` documented itself as "the Worker answered and published nothing", but
the non-2xx branch and the `.catch` both resolved to it, so a transport failure read as a
deterministic editorial judgment *and hid a brief the Worker was holding*. `failed` is now its
own cell with its own copy.
(2) The outage line preempted the panel's own in-flight brief — the brief is a separate endpoint
that answers even while the forecast read fails, so a reload during an outage denied analysis
and retracted it one round trip later.
(3) Suppressing the false update announcements had silenced the real ones: the live region's
text was fixed, so it spoke once and stayed quiet through every genuine revision.

**Round 6 found that (2)'s fix introduced its mirror, and I had shipped it.** Placing `failed`
above the parent's loading branch meant a failed brief printed a definitive "could not be
loaded — every available public input is still listed on the Forecast tab" while the payload
was still in flight and the tab listed nothing. All three lenses found it independently; a
surviving refuter reproduced it and verified the fix. The walk now defers to *either*
outstanding request before rendering anything settled, with the reasoning written per branch.
Round 6 also killed my own fix (3): `generatedAt` is a materialization or request clock on both
deterministic paths, so keying the announcement on it re-announced identical prose on every
payload refresh. The message now derives from the headline — moves when the call moves, not
otherwise; the same-headline-body-rewrite limit is documented in place.

**Test quality was the real finding.** Five mutations survived the round-5 suite: stripping
`role`/`aria-live` from the live region, resolving the `.catch` to `empty`, letting the `.catch`
evict a rendered brief, announcing by clock, and dropping `role` from the failure line. Each is
now caught by exactly one test, verified by applying each mutation and observing a single
failure. `pnpm verify` green: web 300 (+1 skip), workerd 19, core 21, contracts 11, db 10,
Python 45; Cloudflare dry-run clean.

**Protocol degradation (recorded, not hidden):** 13 of 18 round-5 agents died on the Fable/Opus
individual spend limit, including *every* refuter for two of three lenses — so those lenses'
findings were dropped as unrefuted rather than refuted. I recovered them from the workflow
journal and adjudicated them myself; the P1 was the one finding that kept a live refuter.
**A refuter also left mutation edits in `ForecastWorkbench.tsx` and three probe test files in
the repo** despite reporting it had reverted — caught by `git status` before commit, tree
restored to HEAD. Same failure mode as the PR-B R2 probe leak; round 6's prompt now forbids
repo writes explicitly and directs probes to the scratchpad.

**Deferred, with reasons (not silently dropped):**
- Hung `/brief` with no timeout pins the loading line while a known outage goes unstated. Real,
  but *pre-existing* — the pre-restructure walk also returned the loading line unconditionally —
  so it is not a PR-C regression. Logged as OI-10.
- A 2xx whose JSON the adapter cannot read is still classified `empty`. Unreachable against
  today's handler (the schema requires a non-empty headline); becomes reachable on envelope
  drift. The overclaiming comment was corrected to say exactly this. Logged as OI-11.

_2026-08-09 (UTC), later_ — **Rounds 7 and 8: the review walked out of PR-C's blast radius and
into the repo's (`7046fb9`, `5864cf4`, `b774d7a`).** Round 7 audited the walk's *inputs* and
found two P1s plus a P2, all reproduced with scratchpad probes:
(1) `forecastStatus` derived "error" from `initialError` — the *dashboard's* failure, not the
workbench's. The workbench retries on mount whenever its cache is cold and that retry usually
succeeds, so the ordinary degraded first paint claimed an outage over a healthy in-flight
request. Now derived from `intervalError` alone; `initialError` still drives the Forecast tab's
own banner.
(2) A **third** pending source the walk could not see: the daylight pick comes from the canonical
3h payload while `forecastStatus` tracks the active interval — different requests at 1h. The
hourly can land and report "ready" while the canonical, which decides whether a pick exists at
all, is still out. `canonicalPending` is now real state (a ref would strand the panel on the
failure path that sets no state).
(3) The live region announced "Daily outlook updated" at the instant the request **failed**,
because the card renders the local read whenever a pick exists, so "not loading" was being read
as "published". Audible only to screen-reader users. `DailyBriefCard` now takes the outcome.

**Round 7's worst finding predates this PR** — the `initialForecast` reset is from PR #15 and the
interval effect's deps from PR #12. The reset aborts the active interval's in-flight fetch and
drops its cache entry; at 1h no other dep moves, so the request is never reissued and the panel
waits on a dead fetch forever (escape: toggle resolution twice). The variant where an hourly
outage is awaiting its canonical fallback loses the switch too, turning a failure the app owed
the reader into an indefinite spinner. Fixed here (`reloadToken`) because PR-C is what makes it
visible as a permanent "Loading the daily outlook", with the provenance recorded rather than
quietly absorbed.

Round 7 also found the walk counted every pending source **except the brief's own retry**:
`OutlookState` holds the last *settled* answer and never re-enters loading on a refresh (so a
rendered brief is not torn down), meaning from the 2nd request onward the panel asserted the
previous attempt's outcome for exactly as long as the request overturning it was in flight — and
the trigger for that retry is the canonical landing, the very event round 6 taught the walk to
wait for. Pendency is now tracked separately from the settled outcome.

**Two existing assertions were pinning defects rather than catching them** (the card's
"Outlook updated" stamp on a local read, in both `ForecastWorkbench.test.tsx` and
`App.test.tsx`) — the third occurrence of that pattern this workstream.

**A browser check found what the tests structurally could not.** After giving the card an
authored-vs-local distinction, the running page showed the inverse defect: the Worker returns a
*deterministic summary* when it has no authored outlook (what a stale dataset produces), so the
request succeeds, state is "ready", and the live region said "Daily outlook updated" beside a
card correctly labelled "Forecast read". Every unit test in the area either publishes an authored
brief or publishes nothing, so none of them put a Worker-published deterministic summary on
screen. One does now. Lesson worth compounding: **a test suite built from the two clean cases
cannot see the mixed one.**

`pnpm verify` green at each step, ending at web 307 (+1 skip), workerd 19, core 21, contracts 11,
db 10, Python 45. GitHub Verify green at `7046fb9`, `5864cf4`, and `b774d7a`. Every new pin was
mutation-verified; two mutations initially survived (a vacuous canonical test that asserted
before the payload landed, and a retry test that exercised the quiet-line path instead of the
card path) and both tests were rewritten until they failed against the unfixed code.

**Stopping rule, pre-registered before round 8:** every finding must be classified by `git blame`
as introduced-by-this-delta, introduced-by-PR-C, or pre-existing. Only the first two block the
merge; pre-existing findings become ledger items. Rationale: by round 7 the review was returning
defects from PRs #12 and #15, which is the signal that it has exhausted this PR's own surface and
is now auditing the surrounding code. Absent a rule, that search does not terminate.

_2026-08-09 (UTC), evening_ — **Round 8 found four defects in the round-7 fixes; owner merged
PR #30 mid-round; fixes landed as PR #31 (`2f03f5a`, merged `b28d7d9`).**

Round 8 classified every finding by `git blame` per the pre-registered rule, and all four came
back `5864cf4` — my own delta — so all four blocked:
1. **P1 — the panel denied a recommendation on the frame before it asked for one.** `pending`
initialised `false` while `state` initialised `loading`, and the effect that sets `pending` is
passive, so it runs *after* the commit paints. The first render of every (spot, date) scope fell
past every deferral and painted "No daylight recommendation for this day", then retracted it —
same `role="status"` region, so a screen reader receives both. Now initialised from the date,
exact because the child is keyed `spot:date`.
2. **P2 — a failing brief re-narrated itself on every dashboard poll.** Routing the card's message
through pendency made a persistently failing brief cycle failed → "Updating" → failed forever
while nothing visible changed. `outcome` (last settled answer → the message) and `busy` (request
in flight → `aria-busy`) are now separate props. This satisfies round 7 (a busy signal exists)
*and* round 8 (no text churn) — the two rounds were pulling in opposite directions on one prop.
3. **P2 — the stamp claimed provenance it did not have.** The Worker's last-resort summary carries
the *request clock* precisely because no forecast bundle existed, so "From the <t> forecast"
asserted an issue time for a forecast never issued — in the `dateTime` attribute too. Only the
local read may make that claim.
4. **P3 — the error-boundary recovery card labelled the local read "Daily outlook."**

**Why my four round-7 tests passed straight over all of this:** `render()` wraps its work in
`act()`, which flushes passive effects into the same synchronous batch — exactly the boundary the
`pending` change moved. Round 8 caught it by recording every *committed frame* with a
MutationObserver outside `act()`. First-frame coverage now comes from `renderToStaticMarkup`,
which closes the class of gap structurally rather than case by case. **This is the methodological
lesson of the whole workstream: a suite that only asserts settled state cannot see a frame that is
painted and retracted, and four tests written specifically for a change can all miss it.**

**Sequencing deviation, recorded:** the owner merged PR #30 while round 8 was still running, so
PR-C reached `main` carrying these four defects. No deploy occurred in between, so production
never saw them. The fixes went out as follow-up PR #31 rather than as more commits on the merged
branch — which is the correct shape for a defect found after merge, and preserves the "green
GitHub Verify at the exact head" property for both PRs.

**Dependency note:** merging main pulled dependabot #29's lockfile (TypeScript 6→7, jsdom 29→30,
vite 8.1→8.2). `pnpm verify` is green on that set — first validation of the upgrade.
**Dependabot triage (owner asked):** config is already sound (weekly, grouped per ecosystem, PR
limits). One PR open, #28, touching only `.github/workflows/ci.yml`. The push banner's "25
vulnerabilities" is stale; the alerts API shows **5 open, all `undici`** (1 high, 4 medium).
Checked the built Worker bundle rather than the dependency tree: undici's implementation is not
in it — only the AI SDK's error-classification code that *names* undici (`undiciTimeoutCodes`, a
string match on `internal/deps/undici`). The three real copies come from miniflare/wrangler (dev),
jsdom/vitest (test), and the AI SDK's Node path; the Workers runtime uses its own `fetch`. **No
production exposure**; clears on the weekly grouped bump.

**State:** `main` at `b28d7d9`, `pnpm verify` green (web 309 +1 skip, workerd 19, core 21,
contracts 11, db 10, Python 45), GitHub Verify green at both merge heads. **Production is still
running the pre-PR-C build — PR-C is merged but NOT deployed.** Round 9 (frame-level, pre-deploy)
is running. `pnpm deploy` remains blocked by the permission classifier and needs the owner.

_2026-08-09 (UTC), night_ — **Round 9 (pre-deploy, frame-level): `deployable: true`, zero
blocking findings — the first dry round of PR-C.** Four follow-ups, none blocking, one worth
fixing anyway and fixed (`main`, post-merge):

The P2 it did flag was mine by inheritance: round 8's second fix separated "what is true" from
"what is in flight" **for the card only**, leaving the identical pathology on the adjacent
quiet-line path. On any day with no local daylight pick, a failing brief still rewrote the same
`role="status"` node failed → "Loading" → failed on every dashboard poll, indefinitely, while
nothing visible changed — the exact thing the commit message claimed to have removed. The walk
now defers only until the **first** answer settles; after that a retry is signalled by
`aria-busy` on whatever line already stands. Same split, both paths.

Round 9 also caught that `busy={pending}` had dropped half of a property round 6 established:
a *rendered* brief used to stay un-busy through a quiet background refetch, and I had made it
flip. Now `busy={pending && state.status !== "ready"}` — the reader who already has the answer
is not asked to wait on a refresh they did not request. Three mutations verified; `pnpm verify`
green at web 310 (+1 skip).

Left as follow-ups with reasons: the stamp-specificity regression (**OI-12**, needs an envelope
flag, current output accurate but less specific), and a pre-existing paint/retract/restate on the
quiet line that the same walk change resolves.

**Nine rounds is the headline finding of this leg.** The shape: rounds 1–3 inside the panel,
round 4 restructure, rounds 5–6 residual cells and my own mirror bug, round 7 the walk's
*inputs*, round 8 the *frame* boundary, round 9 dry. Each round moved one level outward, and by
round 7 it was returning defects from PRs #12 and #15 — the signal that this PR's own surface was
exhausted. Two methodological lessons worth compounding: **(1)** a suite that asserts only settled
state cannot see a frame that is painted and retracted, and `act()` actively hides it — four
tests written for that exact change all missed it; **(2)** three separate times an existing test
was found *pinning* a defect rather than catching it, so a green suite over a changed assertion
deserves suspicion, not comfort.
