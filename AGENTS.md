# AGENTS.md

Instructions for coding agents and automated contributors working in this
repository.

## Start here

1. `README.md`
2. `docs/architecture.md`
3. `docs/feed-adapters.md`
4. `CONTRIBUTING.md`

## Commands

```bash
pnpm install --frozen-lockfile
pnpm setup:local
pnpm dev
# In a second terminal, after the Worker is listening:
pnpm ingest:local
pnpm smoke:local
pnpm verify
pnpm check:cloudflare
```

`pnpm verify` is the canonical final gate and matches CI: an isolated fresh D1
migration and seed, generated/config/type checks, TypeScript and Python tests,
production build, and a secretless Wrangler bundle dry-run. It does not alter
the normal local development database.

## Remote mutation boundary

Default to local commands and `pnpm check:cloudflare`, which does not change
Cloudflare state. Do not run `pnpm setup:cloudflare`, `pnpm deploy`,
`pnpm ingest:remote`, `wrangler ... --remote`, Queue create/delete, secret,
migration, or remote D1 write commands without explicit operator authorization
and a named backup/rollback plan. Ambient credentials are not authorization.

## Non-negotiable invariants

- Free public ocean/weather feeds are the default substrate. Do not add a paid
  marine API as a required path without an explicit architecture decision.
- Numeric wave, tide, wind, condition, confidence, and score fields must be
  deterministic and testable. LLMs may explain structured facts only.
- Preserve source attribution, issue/valid times, freshness, and uncertainty.
- Raw provider artifacts belong in R2 and normalized operational rows in D1.
- Python owns heavy GRIB2, netCDF, xarray, ecCodes, and scientific evaluation.
  TypeScript owns the Worker/API, contracts, scoring orchestration, and UI.
- The checked-in spot catalog is the NorCal reference configuration. Do not
  imply that arbitrary regions work without implementing and testing them.
- Never commit secrets, account-specific Cloudflare resource IDs, generated
  local Wrangler state, or proprietary forecast data.

## Working posture

- Define the observable success criterion before coding.
- Make the smallest coherent change that satisfies it.
- SQL migrations are the database schema authority. Keep the checked-in spot
  catalog and generated seed synchronized with `pnpm spots:sync`, and cover
  migration changes with fresh-database tests.
- Add or update tests for contracts, scoring, source mappings, adapters,
  migrations, and configuration behavior.
- Preserve unrelated work in a dirty tree and avoid destructive Git commands.
- For stateful changes, name the backup and rollback path before deployment.

This is for personal surf planning, not navigation, emergency response, or
maritime safety.
