# AI Policy

AI is allowed in this project as a reporting and operator-assistance layer.

## Allowed

- Generate daily surf reports from structured forecast facts.
- Explain confidence, source freshness, and tradeoffs.
- Summarize ingest failures or missing data.
- Help users write spot notes and calibration labels.

## Not Allowed

- Generate numeric wave, tide, wind, or quality scores without deterministic
  model output.
- Replace NOAA/CDIP/NDBC/CO-OPS/NWS data with prose guesses.
- Hide missing, stale, or conflicting source data.
- Train on proprietary forecast text or camera data without clear permission.

## Default Runtime

The report layer is disabled unless `REPORT_AGENT_ENABLED=true` and a provider
secret such as `OPENAI_API_KEY` is configured.

