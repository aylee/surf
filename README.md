# surf

Self-hosted public-data surf forecast engine. The project is built to replace
Surfline-style SaaS for a handful of personal surf spots without introducing a
paid marine data dependency.

The core bet is simple: NOAA and CDIP already run the hard physics. This repo
owns extraction, normalization, spot calibration, scoring, and the daily surf
report layer.

## Current Status

Working v1 implementation in progress. The app has live CO-OPS tide and NWS
wind/hazard ingest, D1 source-run/read-model storage, deterministic 72-hour
forecast windows for the six NorCal spots, an API-backed dashboard, guarded
report output, and a Python GFSwave/backtest extractor shell. Read the active
workstream before extending v1:
[`cc_state/noaa-surf-engine/WORKSTREAM.md`](cc_state/noaa-surf-engine/WORKSTREAM.md).

## First Region

v1 targets NorCal:

- Ocean Beach North
- Ocean Beach Central
- Ocean Beach South
- Linda Mar / Pacifica
- Stinson
- Bolinas

Additional spots are welcome after the first pipeline works end to end.

## Data Posture

Default data sources are free public feeds:

- NOAA/NCEP GFSwave via NOMADS for offshore wave forecasts.
- CDIP modeled data/MOP where available for California nearshore transforms.
- NDBC/CDIP buoys for observations and model validation.
- NOAA CO-OPS for tide and water-level predictions.
- NWS for weather, wind products, and hazards.

LLMs may write narrative surf reports from structured forecast facts. They must
not compute numeric forecasts or replace deterministic scoring.

## Quickstart

```bash
pnpm install
pnpm check
pnpm test
```

Run the web app during implementation:

```bash
pnpm dev
```

Run the extractor tests:

```bash
uv run --project services/extractor pytest
```

Cloudflare resources are already provisioned in Alex's account:

- D1 database: `surf`
- R2 bucket: `surf-raw`
- KV namespace: `surf-cache`
- Queues: `surf-ingest`, `surf-ingest-dlq`

Bootstrap deployment:

- `https://surf.alex-1ca.workers.dev`

To reconcile or recreate resources from a local machine, set
`CLOUDFLARE_API_TOKEN` and run:

```bash
pnpm cf:provision
```

Local personal secrets belong in `~/.config/env/surf.env` with mode `600`.
Never commit `.env`, `.dev.vars`, API tokens, OpenAI keys, or provider secrets.

## Repo Layout

```text
apps/web/                 Cloudflare Worker, Hono API, Vite React UI
packages/contracts/       Shared Zod schemas and TypeScript types
packages/forecast-core/   Spot registry and deterministic scoring shell
packages/db/              Drizzle/D1 schema and migrations
services/extractor/       Python GRIB/netCDF/CDIP extraction shell
docs/                     Public operator and architecture docs
cc_state/                 Active agent workstreams and implementation plans
```

## Verification

Honest starter checks:

```bash
pnpm check
pnpm test
uv run --project services/extractor pytest
pnpm smoke:local
```

Deployment/smoke checks after Cloudflare auth is available:

```bash
pnpm cf:provision
pnpm smoke:cloudflare
```
