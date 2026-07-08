---
status: draft
type: spec
created: 2026-07-08
last_updated: 2026-07-08
---

# PRD: Personal Public-Data Surf Forecast

**Owner:** Alex Lee  
**Status:** `DRAFT`  
**Reviewers:** Codex  
**Resources:** [Research](RESEARCH.md), [RFC](RFC.md), [Implementation Plan](implementation-plan.md)

## Doc Purpose

Align the first build of `surf`: a self-hosted NorCal surf forecast that uses
public NOAA/CDIP/NDBC/CO-OPS/NWS data, deterministic scoring, and optional LLM
reports without paid marine API dependencies.

## Requirements Overview

The requirements fall into five buckets:

1. **Public-data forecast substrate** - ingest and normalize the feed layers
   needed for a real surf forecast.
2. **NorCal spot forecast product** - produce useful forecast windows for the
   first personal spots.
3. **Calibration and backtesting** - improve physical forecast accuracy before
   relying on anecdotal labels.
4. **Daily surf report** - generate human-readable reports from structured
   forecast facts.
5. **Self-hosted OSS operations** - make the app cheap, inspectable, and
   reproducible for one operator and future OSS users.

Out of scope:

1. Paid marine APIs as required dependencies.
2. Global spot database.
3. Custom global wave model.
4. LLM-generated numeric forecasts.
5. Live camera/computer-vision pipeline.
6. Navigation or safety-critical marine product.

## 1. Public-Data Forecast Substrate

### Jobs To Be Done

- Alex can run a forecast without paying Surfline or a paid marine API.
- A self-hoster can see which public feeds are active, stale, missing, or
  region-specific.
- Codex can debug source failures from raw artifacts and normalized rows.

### Functional Requirements

**FR-1.1: Feed adapter registry**

- Define adapters by capability: `forecast_wave_offshore`,
  `forecast_wave_nearshore`, `observed_wave`, `tide`, `wind`, `hazard`,
  `bathymetry`, `quality_label`, `comparison_forecast`.
- Each adapter declares provider, coverage, format, parser runtime, cadence,
  attribution, and fixture strategy.

**FR-1.2: NOAA GFSwave offshore forecast**

- Pull latest complete GFSwave cycle through NOMADS.
- Subset to NorCal bounding boxes and required fields.
- Store raw subset artifacts in R2.
- Normalize point or small-grid time series into D1.

**FR-1.3: CDIP nearshore layer**

- Map v1 spots to CDIP/MOP/alongshore modeled points where available.
- Pull modeled/observed CDIP data through public THREDDS/netCDF or supported
  CDIP APIs.
- Record unavailable coverage explicitly per spot.

**FR-1.4: Observations, tides, wind, hazards**

- Ingest NDBC/CDIP observations for nowcast and validation.
- Ingest NOAA CO-OPS tide predictions for each spot's tide station.
- Ingest NWS wind/weather/hazard context for each spot.

### Success Criteria

- Fixture-backed API returns all six v1 spots.
- Live-source adapters can run at least one end-to-end extract for OBSF Central.
- D1 records source run status, freshness, and normalized forecast/observation
  rows.
- R2 contains raw source artifacts for expensive or audit-relevant pulls.

## 2. NorCal Spot Forecast Product

### Jobs To Be Done

- Alex can quickly answer "where and when should I surf today or tomorrow?"
- Alex can compare OBSF, Linda Mar, Stinson, and Bolinas without opening
  multiple forecast sites.
- The app explains why a window is good, marginal, or poor.

### Functional Requirements

**FR-2.1: Spot registry**

- Ship hand-authored profiles for:
  - Ocean Beach North
  - Ocean Beach Central
  - Ocean Beach South
  - Linda Mar / Pacifica
  - Stinson
  - Bolinas
- Each profile includes coordinates, timezone, shore normal, swell priors,
  tide priors, wind priors, reference buoys, CDIP mapping status, and tide
  station.

**FR-2.2: Forecast windows**

- Return hourly or 3-hour forecast windows for at least 72 hours.
- Include wave, tide, wind, source freshness, confidence, and quality score.
- Preserve source attribution and model cycle time.

**FR-2.3: Deterministic spot scoring**

- Use transparent rules first: swell direction/period/height, tide window,
  wind direction/speed, source freshness, buoy/model agreement.
- Return component scores and plain-English explanations.
- Keep rules inspectable and testable per spot.

### Success Criteria

- Dashboard shows all v1 spots with current best windows.
- API exposes `GET /api/spots`, `GET /api/forecast/:spotId`, and
  `GET /api/reports/today`.
- Missing source layers degrade confidence instead of fabricating certainty.

## 3. Calibration And Backtesting

### Jobs To Be Done

- Codex can improve forecast quality without waiting months for Alex's surf
  anecdotes.
- Alex can later label actual sessions and tune subjective surf-quality rules.
- OSS users can bring their own calibration records without sharing private
  data by default.

### Functional Requirements

**FR-3.1: Physical backtesting**

- Compare historical model forecasts against NDBC/CDIP/CO-OPS observations.
- Track height, period, direction, tide, wind, and timing bias by source/spot.
- Store backtest runs and summary metrics.

**FR-3.2: Spot-quality labels**

- Define a portable session feedback record with spot, occurred time, rating,
  notes, and source snapshot reference.
- Keep labels optional for v1.
- Do not make Alex's personal anecdotes a blocking dependency.

### Success Criteria

- Backtest harness can run on public observations for at least one v1 spot.
- Scoring confidence reflects source agreement and historical bias where
  available.

## 4. Daily Surf Report

### Jobs To Be Done

- Alex receives a Brian Allegretto/OpenSnow-style daily surf readout.
- The report communicates the forecast story without hiding the underlying
  structured facts.

### Functional Requirements

**FR-4.1: Report generation**

- Generate a daily markdown report only from computed forecast windows and
  source metadata.
- Include best bets, timing, confidence, source caveats, and "why".
- Disable cleanly when `REPORT_AGENT_ENABLED=false` or no provider key exists.

**FR-4.2: AI boundary**

- LLMs cannot generate numeric wave/tide/wind fields.
- LLM output must cite structured inputs used to form the report.

### Success Criteria

- `GET /api/reports/today` returns a disabled state without secrets.
- With a configured model key, the report uses deterministic forecast facts and
  does not invent source data.

## 5. Self-Hosted OSS Operations

### Jobs To Be Done

- Alex can run the app for near-zero recurring cost beyond Cloudflare.
- A future OSS self-hoster can configure their own region and resources.
- Codex can resume work from repo-local state without re-reading alex-os.

### Functional Requirements

**FR-5.1: Cloudflare-first deployment**

- Worker/Hono API and Vite UI deploy through Wrangler.
- D1, R2, KV, and Queues are configured in `wrangler.jsonc`.
- Cron and queue consumer path exist for scheduled ingest.

**FR-5.2: Repo operating state**

- `cc_state/noaa-surf-engine/WORKSTREAM.md` is the active state manifest.
- `implementation-plan.md` is the task DAG.
- `brief-one-shot-v1.md` is the first implementation prompt.

**FR-5.3: Secret handling**

- Local secrets live in `~/.config/env/surf.env` or `.dev.vars`.
- Deployed secrets use Cloudflare Worker secrets.
- No secret file is read or committed by agents.

### Success Criteria

- `pnpm check`, `pnpm test`, and extractor pytest pass.
- Cloudflare resources are provisioned or blockers are documented.
- A new Codex session can start v1 implementation from the current brief.

## Non-Goals

- Training a wave model from scratch.
- Paid marine forecast API dependency.
- Global camera ingestion.
- Forecast claims suitable for navigation, rescue, or maritime safety.
- Mobile app before the web/Worker path is working.

## Open Questions

- [ ] Which custom domain should serve the app, if any?
- [ ] Should Cloudflare Access gate the first deployed app?
- [ ] Which LLM provider/model should generate daily reports?
- [ ] Which CDIP/MOP points best cover each v1 spot?

## Appendix A: Code Map

| Symbol / path | What it is | Why it matters |
|---|---|---|
| `apps/web/worker/index.ts` | Worker/Hono API shell | Owns API endpoints, cron, queue consumer. |
| `apps/web/wrangler.jsonc` | Cloudflare binding config | Encodes provisioned D1/R2/KV/Queue resources. |
| `packages/contracts/src/index.ts` | Zod contracts | Shared wire/type shape for app, scoring, adapters. |
| `packages/forecast-core/src/spot-registry.ts` | v1 spot priors | Cold-start profile source for NorCal spots. |
| `packages/forecast-core/src/scoring.ts` | deterministic scoring shell | Keeps forecast scoring inspectable before ML. |
| `packages/db/src/schema.ts` | D1/Drizzle schema shell | Normalized operational storage. |
| `services/extractor/src/surf_extractor/feeds.py` | Python source-planning shell | Start of NOAA/CDIP extraction layer. |

## Appendix B: Field / Source Inventory

| Field / source | Type | Notes |
|---|---|---|
| NOAA GFSwave | GRIB2 | Offshore wave forecast via NOMADS. |
| CDIP modeled/MOP | netCDF/THREDDS | California nearshore transform where available. |
| NDBC/CDIP buoys | text/netCDF | Observed wave truth and historical backtesting. |
| NOAA CO-OPS | JSON/API | Tide/water-level predictions. |
| NWS | JSON/API, later model grids | Wind/weather/hazard context. |
| Session labels | JSON | Optional calibration record. |

