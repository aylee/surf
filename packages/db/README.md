# Database

SQL migrations are the D1 schema authority. Files that have shipped are
immutable; new schema work belongs in a new, additive migration with a tested
fresh-database path and an explicit recovery note.

The initial v1 migration includes a few forward-looking tables that the current
runtime does not read or write. They remain as historical schema because live
instances have already applied that migration. Their presence is not an active
feature contract.

The checked-in NorCal seed is generated from the forecast-core spot catalog and
the persistence-only source catalog:

```bash
pnpm spots:sync   # update the generated SQL
pnpm spots:check  # fail if the generated SQL has drifted
```

Never put account-specific Cloudflare IDs or runtime secrets in migrations or
seed data.
