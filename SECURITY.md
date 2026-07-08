# Security Policy

## Supported Versions

The project is pre-v1. Security fixes should target `main`.

## Reporting

Open a private security advisory on GitHub when available, or contact Alex
directly if the issue exposes secrets, account access, or user data.

## Secrets

Never commit:

- `.env`
- `.dev.vars`
- Cloudflare API tokens
- OpenAI/API provider keys
- private calibration or camera data unless explicitly anonymized and licensed

Local personal secrets belong in `~/.config/env/surf.env` with mode `600`.
Deployed secrets belong in Cloudflare Worker secrets.

