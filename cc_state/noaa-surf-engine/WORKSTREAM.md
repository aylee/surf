---
status: active
type: workstream
created: 2026-07-08
last_updated: 2026-07-09
binder: /Users/alex/code/alex-os/desk/personal-surf-forecast/
plan: cc_state/noaa-surf-engine/implementation-plan.md
---

# NOAA Surf Forecast Engine - Workstream

Build and operate the public-data forecast engine for `surf`. **This file is
the repo execution state** any runtime reads first to resume. **Resume path:**
this file -> Open Items & Decisions Ledger -> Next Action -> current brief
`session-brief-calibrate-break-truth.md`.

PM context lives in alex-os. This repo owns implementation truth.

## Objective & Done State

- **Objective:** Build a self-hosted surf-planning product from public
  NOAA/CDIP/NDBC/CO-OPS/NWS data, starting with Alex's NorCal spots.
- **Owner repo:** `/Users/alex/code/surf`
- **Done when (current phase):** The quiet daily report and five-day spot views
  run on issued public forecasts, store bounded evaluation history, disclose
  uncertainty honestly, pass local and live verification, and land in a ready
  pull request.
- **PM binder:** `/Users/alex/code/alex-os/desk/personal-surf-forecast/`

## Current State

The improved v1 is live at `https://surf.alex-1ca.workers.dev` on Worker
version `07c34188-549d-4919-85d1-1f498e79f979`. The dashboard is a quiet daily
NorCal report; each of six spots opens into an interactive five-day 6 AM-6 PM
timeline. Size and surface are separate so a small wave can still be clean.

Five spots prefer public CDIP MOP modeled significant wave height at an exact
10/15 m point. Linda Mar applies a visible `0.60` final cove exposure factor.
Bolinas is explicitly the regional Wharf/Brighton-facing page and remains on a
low-confidence NWS MTR coastal-grid fallback because no safe MOP point maps the
lagoon-mouth break. Surface condition comes deterministically from the roughest
hourly wind in each three-hour window and the spot's circular offshore window.
No LLM or agent performs wave physics, height conversion, or scoring.

An experimental linear-dispersion/Snell/depth-limited breaking transform is
stored in provenance only. It is not displayed or scored because it inflated
the evaluated event and has no actual-break labels. The accepted headline is
the source-supported, exposure-adjusted MOP Hs with explicit modeled-size
language.

Accuracy evidence is pinned in `docs/accuracy-evaluation.md` and
`docs/accuracy-evaluation-manifest.json`: the generic NDFD fallback had 1.44 ft
MAE against MOP across 5,195 proxy pairs, while one direct-MOP forecast cycle
had 0.29 ft MAE against MOP nowcast across 130 pairs. Neither MOP nowcast nor a
commercial peer is represented as breaking-wave truth.

Production capture is bounded. Issued products are sampled at 00/06/12/18 UTC
and keep only 6 AM-6 PM local windows. Operational forecasts keep a two-day
past tail plus the future horizon; evaluation issues, observations, hazards,
and D1 source metadata keep 400 days. Raw R2 objects have no lifecycle yet and
require a separate explicit decision.

The clean working branch is `aylee/surf-v1-accuracy` with rollback checkpoints
`c862025`, `ff446a7`, and `8c315e4`. The 2026-07-10 06:17 UTC scheduled canary
completed all five sources successfully and persisted 210 CDIP rows, 6 complete
forecast issues, 120 product snapshots, and 456 daylight wind-issue rows with
zero stale rows, incomplete issues, unreferenced configs, or foreign-key
violations.

## Open Items & Decisions Ledger

### Open

| ID | Item | Owner | Status | Resolves in |
|---|---|---|---|---|
| OI-1 | Confirm custom domain and Cloudflare Access posture. Default remains public `workers.dev`. | Alex/Codex | OPEN | `clickops-checklist.md` |
| OI-2 | Decide whether narrative reports are worth enabling. Numeric forecasts remain deterministic even if a Pydantic AI report agent is later added. | Alex | OPEN | `docs/runtime-operations.md` |
| OI-5 | Collect timestamped human or authorized-camera breaking-face height and surface labels, then run a frozen chronological evaluation. | Alex/Codex | OPEN | `session-brief-calibrate-break-truth.md` |
| OI-6 | Choose an explicit R2 raw-object lifecycle and recovery policy; the D1 retention job intentionally does not delete R2. | Alex/Codex | OPEN | future ops RFC |

### Resolved (this workstream)

| ID | Decision | Date | Landed in |
|---|---|---|---|
| OD-1 | Repo is public OSS at `/Users/alex/code/surf`, default GitHub owner `aylee`, MIT license. | 2026-07-08 | `README.md`, `LICENSE` |
| OD-2 | v1 geography is OBSF North/Central/South, Linda Mar, Stinson, and Bolinas. | 2026-07-08 | `PRD.md`, `packages/forecast-core/src/spot-registry.ts` |
| OD-3 | Public scientific sources own numeric facts; LLMs may only narrate structured output. | 2026-07-08 | `PRD.md`, `RFC.md`, `AI_POLICY.md` |
| OD-4 | Cloudflare Worker/D1/R2/KV/Queues own runtime; Python owns heavy scientific extraction. | 2026-07-08 | `apps/web/wrangler.jsonc`, `implementation-plan.md` |
| OD-5 | Prefer exact CDIP MOP point forecasts for five mapped spots and keep NWS MTR as the visible low-confidence fallback. | 2026-07-09 | `apps/web/worker/forecast.ts`, `docs/feed-adapters.md` |
| OD-6 | Size and surface stay independent; three-hour surface uses the roughest hourly wind and circular spot geometry. | 2026-07-09 | `packages/forecast-core/src/surface.ts`, `apps/web/worker/forecast.ts` |
| OD-7 | Product shape is one quiet daily regional report plus a five-day 6 AM-6 PM spot deep dive. | 2026-07-09 | `apps/web/src/App.tsx`, `apps/web/src/forecast-view.ts` |
| OD-8 | The bulk-Hs breaker transform remains diagnostic until actual-break labels beat the MOP-Hs baseline. | 2026-07-09 | `packages/forecast-core/src/wave-transform.ts`, `docs/accuracy-evaluation.md` |
| OD-9 | Issued history is sampled six-hourly/daylight and D1 retention is explicitly bounded; R2 lifecycle is a separate decision. | 2026-07-09 | `apps/web/worker/ingest.ts`, `docs/runtime-operations.md` |
| OD-10 | Bolinas v1 means the regional Wharf/Brighton-facing forecast; Sea Drift should be a separate future profile rather than mixed geometry. | 2026-07-09 | `packages/forecast-core/src/spot-registry.ts`, `README.md` |

## Deliverables & Working Files (index)

| File / dir | Kind | Status | Purpose |
|---|---|---|---|
| `PRD.md` | PRD/spec | draft | Original v1 product requirements. |
| `RFC.md` | RFC | accepted baseline | Architecture handoff from alex-os. |
| `implementation-plan.md` | task DAG | historical baseline | Original implementation decomposition. |
| `brief-one-shot-v1.md` | session brief | executed | Receipt for the first working v1 and accuracy release. |
| `session-brief-calibrate-break-truth.md` | session brief | ready | Next mission: actual-break labels and frozen evaluation. |
| `docs/accuracy-evaluation.md` | evaluation record | current | Evidence, limitations, promotion gates, peer alignment. |
| `docs/accuracy-evaluation-manifest.json` | reproducibility manifest | current | Pinned objects, settings, mappings, and summaries. |
| `docs/runtime-operations.md` | runbook | current | Deploy, ingest, retention, monitoring, rollback. |
| `apps/web/` | product/runtime | live | Worker/API and quiet dashboard/spot UI. |
| `services/extractor/` | scientific tooling | active | NDFD/CDIP evaluation and heavy extraction. |

## Threads / Tracks

| Track | Status | Where | Next action |
|---|---|---|---|
| Cloudflare runtime | DONE | `apps/web/`, live Worker | Monitor canaries and retention. |
| Public-data extraction | DONE for v1 | Worker adapters, Python extractor | Preserve source contracts; add sources only with evidence. |
| Forecast interpretation | DONE for current baseline | forecast core, Worker forecast | Do not tune without actual-break labels. |
| Accuracy evaluation | PARTIAL by truth level | accuracy docs/manifest | Add actual breaking-face and surface labels. |
| Issued history / retention | DONE | migration, ingest, ops docs | Monitor D1 counts; decide R2 lifecycle separately. |
| Product UI | DONE | `apps/web/src/` | Gather real-use feedback after merge. |
| Break-truth calibration | OPEN | next session brief | Execute `session-brief-calibrate-break-truth.md`. |

## Decisions

- [x] Use direct public MOP Hs where mapped; do not pretend it is measured surf face.
- [x] Keep clean/fair/choppy independent of size and skill level.
- [x] Retain the breaker transform only as an experiment.
- [x] Preserve source attribution, freshness, hazards, and personal-planning disclaimer.
- [ ] Decide the legal/practical actual-break labeling path.
- [ ] Decide the R2 lifecycle and recovery policy.

## Open Questions

Tracked only in the Open Items & Decisions Ledger above.

## Links

- **Branch:** `aylee/surf-v1-accuracy`
- **PR:** https://github.com/aylee/surf/pull/2 (ready for review)
- **Live:** `https://surf.alex-1ca.workers.dev`
- **PM binder:** `/Users/alex/code/alex-os/desk/personal-surf-forecast/`

## Verification

Verified at code checkpoint `8c315e4`, handoff commit `6b1a51d`, and deployed version
`07c34188-549d-4919-85d1-1f498e79f979`:

- `pnpm check` passed.
- `pnpm test` passed: 5 DB, 16 forecast-core, 52 Worker/UI, and 45 extractor tests.
- `pnpm build` and `wrangler deploy --dry-run` passed.
- Fresh/repeated migrations and seed produced 6 spots, 16 sources, 9 retention indexes, and zero FK violations.
- A real local stale-wave sentinel was deleted; operational stale counts stayed zero.
- Remote migration/seed passed before Worker activation; remote FK check passed.
- Scheduled production ingest completed all five source runs successfully.
- Production persisted 210 CDIP rows, 6 configs/issues, 120 complete snapshots, and 456 wind issues; integrity/stale checks all returned zero.
- `pnpm smoke:cloudflare` passed before and after ingest.
- Live browser QA covered dashboard, spot navigation, timeline interaction, provenance disclosure, and commercial-peer comparison. Mobile layout was verified locally at 390x844 before deploy; production serves the identical asset hash.

## Next Action

**Review and merge ready PR #2 for `aylee/surf-v1-accuracy`, then execute
`session-brief-calibrate-break-truth.md` without changing the production height
transform first.**

## Closeout Path

Keep this workstream active for the calibration phase. Accepted implementation
truth lives in code, tests, migrations, and `docs/`. Cool/archive only after the
actual-break calibration decision has durable repo truth; no cross-repo memory
write is needed for this release.

## Session Log

_2026-07-08_ - **Bootstrap and handoff.** Created the public OSS repo scaffold,
provisioned Cloudflare D1/R2/KV/Queues, handed off alex-os research/RFC, added
PRD and DAG implementation plan, deployed the bootstrap Worker, and minted
`brief-one-shot-v1.md`.

_2026-07-08_ - **Local v1 integrated.** Integrated spot/source mapping,
GFSwave inventory tooling, CO-OPS/NWS ingest, D1 schema/seed, scored windows,
guarded reports, and the first dashboard. Deployed v1 and passed remote ingest
and smoke checks.

_2026-07-09_ - **Quiet, evidence-backed v1 release.** Reframed the product as a
daily report plus five-day spot deep dive; added direct CDIP MOP forecasts,
deterministic surface geometry, pinned NDFD/MOP evaluation, diagnostic-only
breaking physics, issued-history capture, and bounded D1 retention. Corrected
Bolinas to the regional Wharf/Brighton geometry after Surf Captain/Surfline
comparison. Closed adversarial findings on wind aggregation, stale-day
selection, migration integrity, rollback, reproducibility, GRIB slicing, and
storage growth. Deployed Worker `07c34188-549d-4919-85d1-1f498e79f979`, passed
the scheduled production canary and browser QA, and minted the actual-break
calibration brief.
