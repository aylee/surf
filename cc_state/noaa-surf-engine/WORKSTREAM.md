---
status: active
type: workstream
created: 2026-07-08
last_updated: 2026-07-08
binder: /Users/alex/code/alex-os/desk/personal-surf-forecast/
plan: cc_state/noaa-surf-engine/implementation-plan.md
---

# NOAA Surf Forecast Engine - Workstream

Bootstrap and execute the public-data forecast engine for `surf`. **This file
is the repo execution state** any runtime reads first to resume. **Resume
path:** this file -> Open Items & Decisions Ledger -> Next Action -> current
brief `brief-one-shot-v1.md`.

PM context lives in alex-os. This repo owns implementation truth.

## Objective & Done State

- **Objective:** Build a self-hosted Surfline-style forecast engine from
  public NOAA/CDIP/NDBC/CO-OPS/NWS data, starting with NorCal personal spots.
- **Owner repo:** `/Users/alex/code/surf`
- **Done when (bootstrap phase):** Repo, Cloudflare resources, PRD, RFC,
  research handoff, DAG plan, and first implementation brief are committed and
  verification commands are documented.
- **PM binder:** `/Users/alex/code/alex-os/desk/personal-surf-forecast/`

## Current State

Local v1 implementation is integrated and green. The Worker has live NOAA
CO-OPS tide and NWS wind/hazard adapters, manual/queue/cron ingest
orchestration, D1 source-run/read-model writes, scored 72-hour forecast windows
for all six NorCal spots, guarded report output, and an API-backed dashboard.
The DB migration/seed covers source runs, forecasts, observations, hazards,
scores, reports, backtests, and v1 source mappings.

The Python extractor validates live NOAA GFSwave NOMADS inventories for the
West Coast 0.16-degree grid and plans deterministic R2 artifact keys. Numeric
GRIB point extraction remains caveated until the runtime has `wgrib2` or
`cfgrib` + `xarray`. CDIP/MOP nearshore model access is mapped with public
evidence but remains contact-gated/uncertain, so forecast confidence is lowered
and caveats are visible.

Local manual ingest succeeded on 2026-07-08 for OBSF Central and the other v1
spots: CO-OPS wrote 438 tide rows, NWS wrote 936 wind rows and 10 hazards, and
`GET /api/forecast/obsf-central` returned 25 windows with live source-run IDs.
Remote D1 migration/seed, deploy, manual ingest, and Cloudflare smoke completed
on 2026-07-08. The deployed Worker version is
`ef8f2465-ca8c-4c0d-8c87-c1533bfa2873` at
`https://surf.alex-1ca.workers.dev`.

## Open Items & Decisions Ledger

### Open
| ID | Item | Owner | Status | Resolves in |
|---|---|---|---|---|
| OI-1 | Confirm custom domain and Cloudflare Access posture. Default is `workers.dev` without Access until Alex picks a domain. | Alex/Codex | OPEN | clickops-checklist.md |
| OI-2 | Provide LLM provider secret if narrative reports should be enabled. Default is disabled. | Alex | OPEN | docs/runtime-operations.md |
| OI-3 | Validate exact NOAA GFSwave NOMADS inventory names and variables against live GRIB inventory. | Codex | RESOLVED 2026-07-08 | `services/extractor/src/surf_extractor/feeds.py`, `docs/feed-adapters.md` |
| OI-4 | Map each v1 spot to CDIP/MOP modeled points or record unavailable coverage. | Codex | RESOLVED 2026-07-08 | `packages/forecast-core/src/spot-registry.ts`, `packages/forecast-core/test/source-mapping.test.ts` |

### Resolved
| ID | Decision | Date | Landed in |
|---|---|---|---|
| OD-1 | Repo is public OSS at `/Users/alex/code/surf`, default GitHub owner `aylee`, MIT license. | 2026-07-08 | README.md, LICENSE |
| OD-2 | v1 geography is NorCal: OBSF North/Central/South, Linda Mar, Stinson, Bolinas. | 2026-07-08 | PRD.md, packages/forecast-core/src/spot-registry.ts |
| OD-3 | Forecast physics come from public NOAA/CDIP outputs; LLMs only generate narrative reports from structured outputs. | 2026-07-08 | PRD.md, RFC.md, AI_POLICY.md |
| OD-4 | Cloudflare-first stack: Worker/Hono/Vite, D1, R2, KV, Queues, Python extractor for heavy geoscience tooling. | 2026-07-08 | apps/web/wrangler.jsonc, implementation-plan.md |

## Deliverables & Working Files

| File / dir | Kind | Status | Purpose |
|---|---|---|---|
| `PRD.md` | PRD/spec | draft | v1 product requirements and acceptance. |
| `RFC.md` | RFC | draft | Architecture handoff from alex-os binder. |
| `RESEARCH.md` | research | draft | Source/data research handoff from alex-os binder. |
| `implementation-plan.md` | task DAG | draft | Agent-dispatchable implementation plan. |
| `brief-one-shot-v1.md` | session brief | active | First implementation prompt. |
| `clickops-checklist.md` | checklist | active | Provisioning status and remaining user prep. |
| `apps/web/` | code | scaffolded | Worker/API/UI shell. |
| `packages/` | code | scaffolded | contracts, scoring, D1 schema. |
| `services/extractor/` | code | scaffolded | Python extraction shell. |

## Threads / Tracks

| Track | Status | Where | Next action |
|---|---|---|---|
| Repo bootstrap | DONE | root files, `cc_state/` | Commit initial repo state. |
| Cloudflare resources | DONE | `apps/web/wrangler.jsonc` | Configure domain/Access later. |
| Bootstrap deploy | DONE | `https://surf.alex-1ca.workers.dev` | Use for remote smoke. |
| Public-data extraction | PARTIAL | `services/extractor/`, `apps/web/worker/adapters/` | Add GRIB point parser/runtime and CDIP/MOP direct model pulls. |
| Forecast scoring | DONE | `packages/forecast-core/`, `apps/web/worker/forecast.ts` | Tune confidence once wave rows exist. |
| Product UI/API | DONE | `apps/web/` | Push branch and open ready PR. |

## Verification

Latest local checks:

```bash
pnpm install
pnpm check
pnpm test
uv run --project services/extractor pytest
pnpm smoke:local
pnpm ingest:once
```

Local verification on 2026-07-08:

- `pnpm check` passed.
- `pnpm test` passed.
- `uv run --project services/extractor pytest` passed, 10 tests.
- `pnpm --filter @surf/web build` passed.
- Local D1 migration + seed applied with Wrangler.
- `pnpm ingest:once` succeeded against live public CO-OPS/NWS feeds.
- `pnpm smoke:local` passed after ingest.
- Remote D1 migration + seed succeeded.
- Cloudflare deploy succeeded:
  `ef8f2465-ca8c-4c0d-8c87-c1533bfa2873`.
- Remote manual ingest succeeded: 438 tide rows, 936 wind rows, 10 hazards, no
  errors.
- `pnpm smoke:cloudflare` passed against
  `https://surf.alex-1ca.workers.dev`.

## Next Action

**Push `aylee/v1-noaa-surf-engine` and open the ready PR with verification
results and the remaining GFSwave/CDIP caveats.**

## Closeout Path

Accepted implementation truth lands in code, tests, migrations, and `docs/`.
When this workstream cools, archive it intact to `cc_state/z_archive/noaa-surf-engine/`.
Only cross-repo lessons should be distilled back to alex-os memory.

## Session Log

_2026-07-08_ - **Bootstrap and handoff.** Created the public OSS repo scaffold,
provisioned Cloudflare D1/R2/KV/Queues, handed off alex-os research/RFC, added
PRD and DAG implementation plan, deployed the bootstrap Worker, and minted
`brief-one-shot-v1.md`.

_2026-07-08_ - **Local v1 integrated.** Fanned out workers for spot/source
mapping, GFSwave inventory extraction, CO-OPS/NWS ingest, D1 schema/seed, and
dashboard UI. Integrated shared contracts, 72-hour scored windows, live
CO-OPS/NWS source-run/read-model persistence, guarded report generation, smoke
coverage, and the NDBC public-history backtest harness. Local ingest produced
live source-run IDs for OBSF Central; GFSwave numeric GRIB extraction and
CDIP/MOP direct model access remain explicit confidence-lowering caveats.

_2026-07-08_ - **Deployed v1.** Applied remote D1 migration and seed, deployed
Worker version `ef8f2465-ca8c-4c0d-8c87-c1533bfa2873`, fixed remote D1
persistence by batching writes, reran manual ingest successfully in production,
and passed `pnpm smoke:cloudflare`.
