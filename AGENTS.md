# AGENTS.md

## Project Identity

`surf` is a self-hosted public-data surf forecast engine. The repo owns code,
tests, runtime operations, forecast schemas, data adapters, and implementation
truth. The alex-os binder owns PM context and historical product thinking.

## First Reads

1. `README.md`
2. `cc_state/noaa-surf-engine/WORKSTREAM.md`
3. `cc_state/noaa-surf-engine/PRD.md`
4. `cc_state/noaa-surf-engine/RFC.md`
5. `cc_state/noaa-surf-engine/implementation-plan.md`
6. `docs/feed-adapters.md`

## Non-Negotiable Invariants

- Free public ocean/weather feeds are the default substrate. Do not add a paid
  marine API as a required path without a new RFC.
- LLMs may generate reports, explanations, and diagnostics from structured
  forecast facts. They must not perform wave physics or numeric scoring.
- Raw NOAA/CDIP/model artifacts belong in R2. Normalized operational rows
  belong in D1. Cacheable source/config state belongs in KV.
- Python is for heavy scientific processing: GRIB2, netCDF, xarray, ecCodes,
  CDIP extraction, and later bathymetry transforms. TypeScript owns app/API,
  contracts, scoring orchestration, and UI.
- Secrets are never committed. Local secrets live in `~/.config/env/surf.env`
  or `.dev.vars`; deployed secrets live in Cloudflare Worker secrets.
- The first geography is NorCal. Do not broaden the spot database until the
  first end-to-end pipeline works for the v1 spots.

## Commands

```bash
pnpm install
pnpm check
pnpm test
uv run --project services/extractor pytest
pnpm dev
pnpm cf:provision
pnpm smoke:local
```

## Source Of Truth

- Product/PM background: alex-os binder `desk/personal-surf-forecast/`
- Active repo execution: `cc_state/noaa-surf-engine/WORKSTREAM.md`
- Task DAG: `cc_state/noaa-surf-engine/implementation-plan.md`
- Public operator docs: `docs/`
- Accepted implementation truth: code, tests, migrations, and durable docs in
  this repo

## Coding Posture

- **Think Before Coding** - Do not assume; name tradeoffs and unknowns before
  writing code when intent is unclear.
- **Simplicity First** - Write the minimum code that solves the stated problem.
  No speculative abstractions.
- **Surgical Changes** - Touch only what the task requires. Do not reformat,
  rename, or refactor unrelated code in the same diff.
- **Goal-Driven Execution** - Define the success criterion before starting and
  loop until it is met. State explicitly when it is not.

## Data And Safety Notes

This is not a navigation, emergency, or maritime safety product. Forecast output
is for personal surf planning only. Always keep source attribution and freshness
visible in user-facing surfaces.

