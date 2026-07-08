# cc_state

`cc_state/` is repo-local working state for active agent execution. It is not a
generic backlog or permanent archive.

Read the active workstream first:

- `noaa-surf-engine/WORKSTREAM.md`

Workstreams own resumable state. Implementation plans own task DAGs. Session
briefs own the next execution prompt.

## Lifecycle

- Active work lives in `cc_state/<slug>/`.
- Accepted implementation truth graduates into code, tests, migrations, or
  durable docs.
- Cooled workstreams archive intact to `cc_state/z_archive/<slug>/`.

