## What changed

<!-- Describe the user/operator-visible outcome and why this change is needed. -->

## Risk and data impact

<!-- Note forecast semantics, source/provenance, schema, migration, cost, privacy, or operational impact. -->

## Verification

- [ ] `pnpm verify`
- [ ] Relevant local/manual behavior was checked

## Stateful changes

- [ ] No migration or stateful runtime change
- [ ] Or: backup, rollout, and rollback/recovery steps are described above

## Public-data and AI invariants

- [ ] No secrets, private data, proprietary forecast output, or account-specific resource IDs are committed
- [ ] Required sources remain public and attributed
- [ ] Numeric forecast facts remain deterministic
- [ ] Material AI-generated code is disclosed and understood by the contributor
