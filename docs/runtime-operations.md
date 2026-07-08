# Runtime Operations

## Cloudflare Resources

Provisioned in Alex's Cloudflare account on 2026-07-08:

| Resource | Name | Binding | ID |
|---|---|---|---|
| D1 | `surf` | `DB` | `a3e856fe-9ce3-4e71-ba60-f33ca3a15d4e` |
| R2 | `surf-raw` | `RAW_ARTIFACTS` | bucket name only |
| KV | `surf-cache` | `CACHE` | `392b927b791d406bbd662be3844b1b2a` |
| Queue | `surf-ingest` | `INGEST_QUEUE` | `6cca6e2cfb2541e5afcd2898e96094c7` |
| Queue | `surf-ingest-dlq` | dead letter queue | `5e1876faf4d14f5a84b23bcea315a2eb` |

## Jobs

- Worker cron enqueues ingest cycles.
- Queue consumer fans out source/spot extraction work.
- Python extractor processes GRIB2/netCDF/CDIP work that does not belong inside
  a Worker.
- Report generation is gated by `REPORT_AGENT_ENABLED=true` and provider key
  availability.

## Checks

```bash
pnpm check
pnpm test
uv run --project services/extractor pytest
pnpm cf:provision
pnpm smoke:local
pnpm smoke:cloudflare
```

## Secrets

Local personal/dev secrets:

```bash
~/.config/env/surf.env
```

Do not read or print existing secret files in agent sessions. Deployed runtime
secrets should be set with Cloudflare Worker secrets.

## Remaining Clickops

- Choose custom domain or keep `workers.dev`.
- Configure Cloudflare Access if the app should be private behind identity.
- Set `OPENAI_API_KEY` and `REPORT_AGENT_ENABLED=true` only when narrative
  report generation should run.

