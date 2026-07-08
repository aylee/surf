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

Bootstrap is complete enough for implementation kickoff. Cloudflare D1, R2,
KV, and Queues were provisioned on 2026-07-08 and encoded in
`apps/web/wrangler.jsonc`. The repo has a Hono Worker/API shell, Vite React UI,
Zod contracts, deterministic scoring fixtures, Drizzle/D1 schema shell, and
Python extractor shell.

No live NOAA/CDIP extraction has been implemented yet. v1 starts from
`brief-one-shot-v1.md`.

## Open Items & Decisions Ledger

### Open
| ID | Item | Owner | Status | Resolves in |
|---|---|---|---|---|
| OI-1 | Confirm custom domain and Cloudflare Access posture. Default is `workers.dev` without Access until Alex picks a domain. | Alex/Codex | OPEN | clickops-checklist.md |
| OI-2 | Provide LLM provider secret if narrative reports should be enabled. Default is disabled. | Alex | OPEN | docs/runtime-operations.md |
| OI-3 | Validate exact NOAA GFSwave NOMADS inventory names and variables against live GRIB inventory. | Codex | OPEN | implementation-plan.md T-2.1 |
| OI-4 | Map each v1 spot to CDIP/MOP modeled points or record unavailable coverage. | Codex | OPEN | implementation-plan.md T-2.2 |

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
| Public-data extraction | OPEN | `services/extractor/` | Implement live NOAA/CDIP adapters. |
| Forecast scoring | OPEN | `packages/forecast-core/` | Replace fixtures with live normalized inputs. |
| Product UI/API | OPEN | `apps/web/` | Build v1 dashboard and reports. |

## Verification

Starter checks:

```bash
pnpm install
pnpm check
pnpm test
uv run --project services/extractor pytest
pnpm cf:provision
```

Expected before v1 implementation starts: checks pass or blockers are written
into this workstream.

## Next Action

**Implement v1 from `brief-one-shot-v1.md`, using `implementation-plan.md` as
the task DAG and closing OI-3/OI-4 first.**

## Closeout Path

Accepted implementation truth lands in code, tests, migrations, and `docs/`.
When this workstream cools, archive it intact to `cc_state/z_archive/noaa-surf-engine/`.
Only cross-repo lessons should be distilled back to alex-os memory.

## Session Log

_2026-07-08_ - **Bootstrap and handoff.** Created the public OSS repo scaffold,
provisioned Cloudflare D1/R2/KV/Queues, handed off alex-os research/RFC, added
PRD and DAG implementation plan, and minted `brief-one-shot-v1.md`.

