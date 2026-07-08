---
status: draft
type: implementation-plan
created: 2026-07-08
last_updated: 2026-07-08
source_spec: cc_state/noaa-surf-engine/PRD.md
---

# Implementation Plan: NOAA Surf Forecast Engine v1

**Owner:** Alex Lee  
**Status:** `DRAFT`  
**Last Updated:** 2026-07-08  
**Source Spec:** [PRD](PRD.md)  
**Resources:** [RFC](RFC.md), [Research](RESEARCH.md), [Brief](brief-one-shot-v1.md)

## Intent

Build the first working self-hosted surf forecast from public NOAA/CDIP data.
The target is a useful NorCal personal forecast, not a toy weather dashboard:
extract public model/observation/tide/wind data, normalize it, score spot
windows, and show the best surf opportunities with source confidence.

**Priority signals:** Optimize for forecast ownership and inspectability over
short-term convenience. Protect zero required paid data spend and deterministic
physics/scoring boundaries.

## Scope

This plan turns the bootstrap scaffold into a v1 app: live feed adapters,
normalized storage, fixture and live tests, deterministic scoring, dashboard,
daily report endpoint, and self-hosting docs.

**Not in scope:**

- Custom global wave model.
- Neural surf-quality model.
- Required paid APIs.
- Camera ingestion.
- Global spot database.

## Mental Model

Cron creates ingest jobs. The Worker handles light JSON feeds and orchestration.
The Python extractor handles GRIB2/netCDF/CDIP work. Raw artifacts land in R2,
normalized source runs and forecasts land in D1, and forecast-core turns those
rows into scored spot windows. The UI reads the API and shows best windows,
confidence, and source caveats. The report agent only summarizes structured
outputs after scoring exists.

## Architecture Decisions

- **AD-1: Public NOAA/CDIP data is the substrate.** Use off-the-shelf physics
  outputs and observations. *Rejected: required paid marine API because it
  defeats the core ownership/cost goal.*
- **AD-2: Worker for orchestration, Python for heavy extraction.** Keep GRIB2,
  netCDF, xarray, and future bathymetry outside the Worker. *Rejected: parsing
  GRIB in edge JS because it is brittle and tool-poor.*
- **AD-3: D1 stores normalized operational rows; R2 stores raw artifacts.**
  D1 should stay queryable and compact. *Rejected: storing raw blobs in D1.*
- **AD-4: Deterministic scoring before ML.** Start with transparent spot priors
  and component scores. *Rejected: neural/LLM surf model before labels.*
- **AD-5: LLM reports are downstream of computed facts.** The report layer can
  write prose, not forecasts. *Rejected: LLM numeric forecast generation.*
- **AD-6: NorCal first.** Build for OBSF, Linda Mar, Stinson, and Bolinas before
  broadening. *Rejected: global surf catalog in v1.*

## Safeguards

- **S-1:** No required paid data source.
- **S-2:** Missing/stale sources lower confidence and appear in API/UI output.
- **S-3:** Source artifacts used for forecast generation are attributable and
  reproducible from R2/source metadata.
- **S-4:** LLM output cannot create or alter numeric wave/tide/wind/score
  fields.
- **S-5:** Every live adapter has fixtures and at least one failure-mode test.

## Task Overview

| Phase | Task | Deliverable | Size | Status | Dependencies |
|---|---|---|---|---|---|
| 1 | T-1.1: Validate scaffold and contracts | Passing check/test baseline | S | DONE | - |
| 1 | T-1.2: Spot/source mapping | v1 source map and CDIP coverage notes | M | DONE | T-1.1 |
| 1 | T-1.3: D1 migrations and seed | Applied schema and spot/source seed | M | DONE | T-1.1 |
| 2 | T-2.1: NOAA GFSwave extractor | Live GRIB subset/extract for OBSF | L | PARTIAL | T-1.2 |
| 2 | T-2.2: CDIP/NDBC observations | Live observed and modeled wave pulls | L | PARTIAL | T-1.2 |
| 2 | T-2.3: CO-OPS/NWS fetchers | Tide, wind, hazard normalized rows | M | DONE | T-1.2, T-1.3 |
| 3 | T-3.1: Forecast normalization | Source runs and forecast rows in D1 | L | PARTIAL | T-2.1, T-2.2, T-2.3 |
| 3 | T-3.2: Scoring integration | API returns scored live windows | M | DONE | T-3.1 |
| 3 | T-3.3: Backtest harness | Public-history physical calibration path | L | DONE | T-3.1 |
| 4 | T-4.1: Dashboard v1 | Usable NorCal forecast console | M | DONE | T-3.2 |
| 4 | T-4.2: Daily report layer | Disabled/enabled report path with guardrails | M | DONE | T-3.2 |
| 4 | T-4.3: Self-host docs and smoke | One-command local/deploy smoke path | M | PARTIAL | T-4.1, T-4.2 |

## Phase 1: Foundation And Mapping

Establish the baseline and lock exact source mappings before writing live
extractors.

**Checkpoint:** `pnpm check`, `pnpm test`, and extractor pytest pass. Source map
exists for every v1 spot.

### T-1.1: Validate scaffold and contracts

- **Goal.** Make the bootstrap repo checks pass cleanly.
- **Context.** Start with root `package.json`, `apps/web/`, `packages/`, and
  `services/extractor/`.
- **Deliverable.** Any fixes required for `pnpm check`, `pnpm test`, and
  `uv run --project services/extractor pytest`.
- **Acceptance Criteria.**
  - TypeScript checks pass.
  - Vitest tests pass.
  - Python extractor tests pass.
  - No unrelated refactors.
- **Size:** S
- **Dependencies:** None

### T-1.2: Spot/source mapping

- **Goal.** Produce the exact source map for all v1 spots.
- **Context.** Update `packages/forecast-core/src/spot-registry.ts` and add a
  source-map doc or fixture under `services/extractor/`.
- **Deliverable.** Spot profiles with reference buoys, tide station, NWS grid
  point, NOAA model point/deepwater reference, and CDIP/MOP coverage status.
- **Acceptance Criteria.**
  - Each v1 spot has explicit source mappings or explicit unavailable notes.
  - CDIP/MOP coverage is verified or marked absent with evidence.
  - Mapping data is represented in fixtures/tests.
- **Size:** M
- **Dependencies:** T-1.1

### T-1.3: D1 migrations and seed

- **Goal.** Make D1 ready for source runs, spots, forecasts, scores, and
  reports.
- **Context.** Use `packages/db/migrations/0000_initial.sql` and
  `apps/web/wrangler.jsonc`.
- **Deliverable.** Complete migration set and seed command for v1 spot/source
  records.
- **Acceptance Criteria.**
  - Local D1 migration applies through Wrangler.
  - Remote D1 migration path is documented.
  - Seed command is idempotent.
- **Size:** M
- **Dependencies:** T-1.1

## Phase 2: Live Public Feed Adapters

Implement live public-data ingestion with fixtures and failure-mode tests.

**Checkpoint:** One manual ingest creates raw/source-run records for OBSF
Central across wave, tide, and wind layers.

### T-2.1: NOAA GFSwave extractor

- **Goal.** Extract offshore wave forecast time series for NorCal reference
  points.
- **Context.** Work in `services/extractor/`; validate live NOMADS inventory
  before hard-coding filenames/variables.
- **Deliverable.** GFSwave fetch/subset/extract command, fixtures, and R2 write
  interface.
- **Acceptance Criteria.**
  - Latest complete cycle selection is correct.
  - Raw subset can be stored with deterministic R2 key.
  - Extracted fields include height, period, direction, cycle, lead hour, and
    forecast time.
  - Test covers missing cycle or unavailable field.
- **Size:** L
- **Dependencies:** T-1.2

### T-2.2: CDIP/NDBC observations

- **Goal.** Pull observed and nearshore-modeled wave data where available.
- **Context.** Use CDIP public APIs/THREDDS/netCDF and NDBC station feeds.
- **Deliverable.** Adapter(s), normalized fixtures, and source-run records.
- **Acceptance Criteria.**
  - At least one observed wave source works for the OBSF reference set.
  - CDIP/MOP coverage for each v1 spot is either used or explicitly absent.
  - Source freshness and station outages are represented.
- **Size:** L
- **Dependencies:** T-1.2

### T-2.3: CO-OPS/NWS fetchers

- **Goal.** Add tide, wind, and hazard inputs.
- **Context.** Worker TypeScript can own JSON fetchers unless a source needs
  Python.
- **Deliverable.** CO-OPS tide and NWS wind/hazard adapters with fixtures.
- **Acceptance Criteria.**
  - Tide forecast rows exist for each v1 spot.
  - Wind forecast rows exist for each v1 spot.
  - Hazards are returned as context and do not directly fabricate scores.
- **Size:** M
- **Dependencies:** T-1.2, T-1.3

## Phase 3: Forecast Assembly And Calibration

Turn source rows into forecast windows and backtesting metrics.

**Checkpoint:** API returns live-scored forecast windows for every v1 spot.

### T-3.1: Forecast normalization

- **Goal.** Normalize source outputs into D1 forecast/observation tables.
- **Context.** Extend `packages/db/src/schema.ts`, migrations, and API/service
  code as needed.
- **Deliverable.** Source-run lifecycle, normalized rows, R2 artifact pointers,
  and ingest status API.
- **Acceptance Criteria.**
  - Manual ingest records success/failure by source.
  - Duplicate runs are idempotent.
  - API exposes source freshness per spot.
- **Size:** L
- **Dependencies:** T-2.1, T-2.2, T-2.3

### T-3.2: Scoring integration

- **Goal.** Replace fixture-only scoring with live normalized inputs.
- **Context.** Build on `packages/forecast-core/src/scoring.ts` and API
  endpoints in `apps/web/worker/index.ts`.
- **Deliverable.** Scored windows with component scores and confidence.
- **Acceptance Criteria.**
  - `GET /api/forecast/:spotId` returns live windows when data exists.
  - Missing layers lower confidence and explain why.
  - Fixture fallback remains available for tests.
- **Size:** M
- **Dependencies:** T-3.1

### T-3.3: Backtest harness

- **Goal.** Start physical calibration without Alex anecdote dependency.
- **Context.** Compare historical public observations against forecast/model
  outputs.
- **Deliverable.** Backtest command, metrics output, and calibration notes.
- **Acceptance Criteria.**
  - Runs against at least one public observation history.
  - Reports height/period/direction/timing bias.
  - Produces inputs that can adjust confidence or transfer coefficients later.
- **Size:** L
- **Dependencies:** T-3.1

## Phase 4: Product Surface And Ops

Make the app usable and self-hostable.

**Checkpoint:** Local and Cloudflare smoke paths are documented and pass when
credentials are present.

### T-4.1: Dashboard v1

- **Goal.** Build the actual NorCal forecast console.
- **Context.** Update `apps/web/src/` and use the API contracts.
- **Deliverable.** Spot comparison dashboard with best windows, source
  freshness, and caveats.
- **Acceptance Criteria.**
  - Responsive UI shows all v1 spots.
  - Best windows are easy to scan.
  - No source/freshness caveat is hidden.
- **Size:** M
- **Dependencies:** T-3.2

### T-4.2: Daily report layer

- **Goal.** Generate a daily report from deterministic forecast outputs.
- **Context.** Keep AI behavior inside the boundaries in `AI_POLICY.md`.
- **Deliverable.** Report generation service/path with disabled state and tests.
- **Acceptance Criteria.**
  - No provider key means clean disabled state.
  - Enabled report cites structured forecast facts.
  - Tests prevent invented numeric forecast fields.
- **Size:** M
- **Dependencies:** T-3.2

### T-4.3: Self-host docs and smoke

- **Goal.** Make a fresh self-hoster path credible.
- **Context.** Update `docs/self-hosting.md`, `docs/runtime-operations.md`,
  `README.md`, and scripts.
- **Deliverable.** Local and Cloudflare smoke instructions.
- **Acceptance Criteria.**
  - `pnpm smoke:local` verifies health and v1 spots.
  - `pnpm smoke:cloudflare` works after deploy URL is configured.
  - Secrets guidance does not require reading secret files.
- **Size:** M
- **Dependencies:** T-4.1, T-4.2

## Execution Notes

- **Agent mode.** Use orchestrator-workers after T-1.1. T-2.1, T-2.2, and
  T-2.3 can run in parallel if write scopes stay separate.
- **State management.** Commit after each phase. Update `WORKSTREAM.md` ledger
  when OI items close.
- **Shared context.** Every agent reads `WORKSTREAM.md`, PRD, RFC, and this
  plan before editing.
- **Known risks.** NOMADS inventory names and CDIP/MOP availability must be
  verified live; stale assumptions here will break extraction.

## Open Questions

- [ ] Custom domain and Access posture.
- [ ] LLM provider/model for daily reports.
- [x] Exact CDIP/MOP coverage by spot recorded with public evidence and
  confidence-lowering access caveats.

## Log

### 2026-07-08

- **Completed:** Bootstrap repo, Cloudflare resources, PRD/RFC/research handoff,
  and initial implementation DAG.
- **Next:** Execute T-1.1, then close OI-3/OI-4.
- **Completed:** Validated baseline, added v1 source mapping/tests, expanded D1
  schema and seed, implemented live CO-OPS/NWS ingest with normalized rows,
  added GFSwave live inventory validation/R2 key planning, built scored 72-hour
  API windows, dashboard, guarded report path, smoke checks, and NDBC public
  history backtest harness.
- **Partial / caveated:** GFSwave numeric GRIB point extraction remains blocked
  until `wgrib2` or `cfgrib` + `xarray` is available in the Python runtime.
  CDIP/MOP nearshore access is mapped with public evidence but remains
  contact-gated/uncertain; the app surfaces caveats and lowers confidence.
- **Next:** Apply remote D1 migration/seed, deploy Worker, run manual remote
  ingest and `pnpm smoke:cloudflare`, then push and open PR.
