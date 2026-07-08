---
status: active
type: checklist
created: 2026-07-08
last_updated: 2026-07-08
---

# Clickops / Prep Checklist

## Completed By Codex

- [x] Provisioned D1 database `surf`
  - ID: `a3e856fe-9ce3-4e71-ba60-f33ca3a15d4e`
- [x] Provisioned R2 bucket `surf-raw`
- [x] Provisioned KV namespace `surf-cache`
  - ID: `392b927b791d406bbd662be3844b1b2a`
- [x] Provisioned Queue `surf-ingest`
  - ID: `6cca6e2cfb2541e5afcd2898e96094c7`
- [x] Provisioned Queue `surf-ingest-dlq`
  - ID: `5e1876faf4d14f5a84b23bcea315a2eb`
- [x] Wrote Cloudflare bindings into `apps/web/wrangler.jsonc`

## Needs Alex Or A Later Authenticated Browser/API Pass

- [ ] Pick custom domain.
  - Default: deploy to `workers.dev` first.
- [ ] Decide whether Cloudflare Access should gate the app.
  - Default: no Access until domain is chosen.
- [ ] Configure `OPENAI_API_KEY` if daily narrative reports should be enabled.
  - Default: `REPORT_AGENT_ENABLED=false`.
- [ ] If using local secrets, create `~/.config/env/surf.env` with mode `600`.
  - Do not ask agents to read existing secret files.

## Not Needed For v1

- Paid marine data API key.
- Surfline/Magicseaweed/Surf Captain credential.
- Camera feed credential.
- Custom bathymetry/SWAN infrastructure.

