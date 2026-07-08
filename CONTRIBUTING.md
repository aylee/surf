# Contributing

`surf` is public OSS, but it starts as a sole-user project. Contributions should
make the self-hosted public-data engine more reproducible, transparent, and
cheap to run.

## Good First Contribution Areas

- Feed adapters with public documentation and fixtures.
- Station/spot mapping improvements.
- Backtesting and fixture coverage.
- Self-hosting and Cloudflare setup docs.
- Deterministic scoring improvements with clear rationale.

## Contribution Rules

- Do not add required paid APIs.
- Do not commit secrets, private station credentials, or scraped proprietary
  forecast data.
- Do not add LLM logic that computes numeric forecast fields.
- Add or update tests when changing contracts, scoring, schema, or adapters.
- Keep public-data source attribution visible.

## Development

```bash
pnpm install
pnpm check
pnpm test
uv run --project services/extractor pytest
```

