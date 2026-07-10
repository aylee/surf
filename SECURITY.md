# Security Policy

## Supported version

Security fixes target the latest commit on `main`. This project has not yet
published a stable compatibility promise.

## Report a vulnerability

Please use a [private GitHub security advisory](https://github.com/aylee/surf/security/advisories/new).
Do not open a public issue for vulnerabilities involving authentication,
secret exposure, Cloudflare account access, injection, or private data.

Include the affected commit, reproduction steps, expected impact, and any
suggested mitigation. Reports should use test accounts and redact tokens,
account IDs, and source data that is not already public. We aim to acknowledge
a report within seven days and will coordinate disclosure after a fix is
available.

## Scope

Security-sensitive surfaces include:

- the production manual-ingest endpoint and `INGEST_TOKEN` handling;
- Cloudflare Worker, D1, R2, and Queue bindings;
- upstream response parsing and raw-artifact capture;
- dependency or workflow compromise; and
- accidental secret or account-identifier exposure.

Forecast disagreement, model error, and source staleness are data-quality
issues unless they also expose a security boundary. Use the bug template for
those reports.

Never commit `.env`, `.dev.vars`, API tokens, provider keys, or exported
production data. If a secret reaches Git history, revoke and rotate it before
removing the value from the repository.
