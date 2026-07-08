---
status: active
type: session-brief
created: 2026-07-08
workstream: cc_state/noaa-surf-engine/WORKSTREAM.md
plan: cc_state/noaa-surf-engine/implementation-plan.md
---

# Brief: One-Shot Working v1

You are implementing the first working v1 of `surf`.

## Read First

1. `cc_state/noaa-surf-engine/WORKSTREAM.md`
2. `cc_state/noaa-surf-engine/PRD.md`
3. `cc_state/noaa-surf-engine/RFC.md`
4. `cc_state/noaa-surf-engine/RESEARCH.md`
5. `cc_state/noaa-surf-engine/implementation-plan.md`
6. `docs/feed-adapters.md`
7. `AGENTS.md`

## Mission

Turn the bootstrap into a working NorCal public-data forecast:

- live NOAA GFSwave offshore extraction;
- CDIP/MOP/NDBC observation and nearshore coverage where available;
- CO-OPS tides and NWS wind/hazard context;
- normalized D1 source runs and forecasts;
- R2 raw artifacts for expensive source pulls;
- deterministic scored forecast windows for all v1 spots;
- dashboard showing best windows and source confidence;
- daily report endpoint that is disabled without secrets and guarded when
  enabled.

## Done

- `pnpm check` passes.
- `pnpm test` passes.
- `uv run --project services/extractor pytest` passes.
- One manual ingest produces forecast windows for at least OBSF Central.
- API returns all v1 spots and scored windows.
- UI shows all v1 spots with best windows.
- Missing sources lower confidence instead of fabricating certainty.
- Workstream ledger closes or updates OI-3 and OI-4.

## Constraints

- No required paid data APIs.
- No LLM numeric forecasting.
- Do not read or print secret files.
- Keep NorCal scope tight until the end-to-end pipeline works.
- Commit after coherent phases, not as one giant dump.

## Suggested Execution

1. Run T-1.1 from `implementation-plan.md` and fix scaffold issues.
2. Run T-1.2/T-1.3.
3. Split Phase 2 into independent adapter work:
   - NOAA GFSwave extractor.
   - CDIP/NDBC observations.
   - CO-OPS/NWS JSON fetchers.
4. Reconcile Phase 3 scoring/API after adapters land.
5. Finish with dashboard/report/docs/smoke.

