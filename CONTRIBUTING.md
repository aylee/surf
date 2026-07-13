# Contributing

Contributions are welcome when they make the forecast more trustworthy, the
self-hosting path more reproducible, or the public-data integrations easier to
maintain.

## Before you start

- Search existing issues before opening a duplicate.
- Open an issue before a large schema, architecture, geography, or scoring
  change so the tradeoffs are visible first.
- Keep pull requests focused. A feed adapter, spot calibration, UI change, and
  unrelated refactor should not arrive as one review unit.

## Development setup

Follow the local quickstart in [README.md](README.md), then run the full gate:

Contributor verification requires Python 3.12 and
[uv](https://docs.astral.sh/uv/) in addition to the Node.js prerequisites.

```bash
pnpm verify
```

The gate applies migrations and the generated seed to an isolated fresh D1,
checks generated/config files and types, runs the TypeScript suites and base
Python extractor suite, then builds the app and performs a secretless deploy
dry-run.
The optional GRIB decoder path requires:

```bash
uv sync --project services/extractor --locked --extra grib
```

## Change-specific expectations

| Change | Include |
|---|---|
| Forecast/scoring logic | Unit tests, deterministic inputs, and a rationale for changed calls |
| Spot or source mapping | Catalog update, generated seed update, mapping tests, and source evidence |
| Feed adapter | Bounded fixture, attribution, failure behavior, and freshness semantics |
| D1 schema | Additive SQL migration, fresh-local apply test, migration assertion, and rollback/data note |
| Worker/config | Local smoke or deploy dry-run; never account-specific IDs |
| UI | Loading, missing-data, narrow-screen, and spot-navigation checks |
| Accuracy claim | Immutable inputs, issue/valid times, no-lookahead method, and limitations |

## Project invariants

- Free public ocean and weather feeds are the default substrate.
- Numeric surf facts and scores are deterministic. An LLM may explain
  structured facts, but may not perform wave physics or invent measurements.
- Missing, stale, low-confidence, and conflicting sources stay visible.
- Raw source artifacts belong in R2; normalized operational data belongs in D1.
- Heavy GRIB2/netCDF processing stays in Python. The Worker/API/contracts/UI
  stay in TypeScript.
- This is a planning product, not a navigation or emergency-safety product.

AI-assisted contributions are welcome, but the contributor is responsible for
understanding the change, disclosing material generated code in the pull
request, and running the same verification expected of any contribution.

## Pull requests

A useful pull request explains:

1. What behavior changed and why.
2. What data, schema, or operational risk exists.
3. Which commands and manual checks were run.
4. How to roll back a stateful or forecast-affecting change.

Do not commit secrets, proprietary forecast output, personal browsing data, or
large raw model artifacts.
