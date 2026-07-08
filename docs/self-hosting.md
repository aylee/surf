# Self-Hosting

`surf` is designed to be self-hosted for one operator first, then generalized
for OSS users.

## Prerequisites

- Node 24+
- pnpm 11+
- uv
- Cloudflare account with Workers, D1, R2, KV, and Queues access
- Optional OpenAI/API-provider key for narrative reports

## Local Setup

```bash
pnpm install
uv run --project services/extractor pytest
pnpm check
pnpm test
```

Create a local operator env file outside the repo:

```bash
install -m 600 /dev/null ~/.config/env/surf.env
```

Then add only the values you need. Do not commit the file.

## Cloudflare Setup

Alex's bootstrap resources are already reflected in `apps/web/wrangler.jsonc`.
For another account:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account-id>
export CLOUDFLARE_API_TOKEN=<token-with-workers-d1-r2-kv-queues-access>
pnpm cf:provision
```

The script is idempotent: it lists existing resources first and creates missing
ones.

## Data Costs

NOAA, NDBC, CDIP, CO-OPS, and NWS feeds do not require paid API keys for v1.
Cloudflare usage and optional LLM report generation are the expected costs.

