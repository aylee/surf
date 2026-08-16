# Component-aware production releases

Status: accepted; v1 implemented locally, production adoption trial pending.

## Decision

Surf uses a profile-driven, local production release controller with one
preview-and-confirm owner command. It separates component identity from wire
compatibility, journals exact state transitions, and supports a proven
assets-only lane plus fingerprint-selected component work inside the
conservative full lane.

The implementation is intentionally fail-closed:

- UI path classification is only a first filter. Every non-asset fingerprint
  must also match the authenticated complete active receipt.
- Unknown inputs, missing receipts, lock/shared/config/runtime changes, and
  manual escalation select the full lane.
- An inactive Worker version is uploaded and runtime-validated before any D1
  mutation. The predecessor is rechecked immediately before exact 100%
  activation and the control plane is reconciled afterward.
- D1 mutation has a Time Travel bookmark and full export, and is skipped when
  neither migrations nor the seed changed. Either Queue-consumer or cron
  topology impact removes exact stale target-owned consumers, invokes
  Wrangler's combined trigger deployment, and re-attests both surfaces. Runner
  and generation operations follow their independent impacts. Clearly
  destructive migrations are blocked from the routine flow.
- Worker/runner compatibility uses the canonical narrative protocol and exact
  Queue/DLQ/callback/token bindings. A v3 runner record is transition evidence
  only; it never proves compatibility.
- Post-activation failure advances `active`, never `last-complete`, and requires
  same-target resume or linked fix-forward.

See [Production releases](../production-releases.md) for the operator contract
and recovery workflow. Generation coordination remains deliberately unchanged;
removing the hourly scheduling wait requires a separate Queue/D1 design.
