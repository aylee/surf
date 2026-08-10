# Analysis Narrative Evaluation

This page defines the quality gate for the current Analysis v3 narrative. The
historical filename is retained for links; the active path is the generic
Cloudflare Queue to local oMLX runner described in
[`narrative-runner.md`](./narrative-runner.md), not Gemini or the dormant
`ForecastBriefAgent`.

The narrative is useful only when it makes the deterministic forecast easier
to read without changing it. TypeScript owns every time, measurement, surf-size
range, swell evolution, wind/surface description, tide event, confidence band,
bust factor, and recommendation. The model may connect those code-owned slots
into three compact paragraphs. It may not calculate wave physics, author a
measurement, change the ranked sessions, or turn modeled wave state into an
observation.

## Publication gate

Cloud validation is fail-closed. A generated result is published only when all
of these checks pass:

1. The result authenticates to the internal endpoint and matches the active
   job, per-attempt submission ID, schema, prompt, model capability, and exact
   Analysis fact fingerprint.
2. The response matches the advertised bounded JSON schema. The model returns
   only paragraph templates; the headline is code-owned and fact references
   are derived from the slots actually used.
3. Every required slot appears exactly once in its assigned paragraph, all
   braces resolve, and the rendered report remains within the public contract.
4. The setup preserves surf-before-swell grammar, the plan names the leading
   call before a distinct alternate, and the confidence paragraph places the
   code-owned bust factor last after uncertainty framing.
5. Model-authored measurements, time claims, condition ratings, reversed or
   negated recommendations, unsupported causation, directives, markup, and
   implementation vocabulary are rejected.

Validation or rendering failure marks that attempt rejected. It never writes a
published revision and never blocks deterministic forecast publication. The
public `/brief` response honestly remains `pending` or `unavailable`; there is
no deterministic pseudo-report under an Analysis heading.

## What ordinary verification proves

`pnpm verify` is secretless and deterministic. It does not contact oMLX,
Gemini, or another model provider. Its fixtures cover:

- exact-fact generation identity, repeat-ingest deduplication, and
  supersession when output-visible facts change;
- recommendation order and anti-reversal semantics;
- accepted natural variations and rejected unsupported adjectives,
  conditions, causes, measurements, time words, directives, and malformed
  placeholders;
- schema limits, slot placement, renderability, and derived provenance;
- delayed or duplicated results across rearmed attempts;
- authenticated, byte-bounded result ingestion before JSON parsing;
- all complete selectable dates, Queue send reconciliation, expiration, and
  fail-isolated forecast publication;
- published/pending/unavailable API and UI behavior, no-store caching, bounded
  polling, and cancellation; and
- fresh D1 migration/seed, seven-day FK-safe retention, production build, and a
  secretless Wrangler dry-run.

These checks establish the authority and reliability floor. They cannot prove
that a particular local model will always produce useful prose.

## Live local-model acceptance

Run live acceptance only as an explicit prompt/model evaluation against the
same response schema and cloud validator used in production. Keep the model ID
configurable; do not add model-specific branches to the runner. The current
local baseline is `Qwen3.5-27B-8bit` on oMLX.

Before enabling Queue production, require at least three consecutive generated
drafts to:

- pass the real cloud validator and renderer, not merely JSON parsing;
- retain the deterministic best and alternate calls;
- render the code-owned headline and all required slots exactly once;
- read as three short forecaster paragraphs rather than a field inventory; and
- end confidence with the supplied bust factor without duplication.

Record only the model/config version, bounded timings, pass/fail category, and
sanitized rendered copy. Never log the result token, Queue credentials, raw
provider artifacts, private target maps, or full rejected payloads. A failed
probe is a prompt/evaluation result, not permission to weaken fact authority.

Live acceptance is intentionally outside CI because output is stochastic and
depends on the operator's local hardware. It is a rollout gate, not a
substitute for deterministic tests.

## Versioning and identity

Prompt version, output schema version, target capability, and exact code-owned
Analysis facts participate in generation identity. Model identity participates
in revision identity. Volatile generation timestamps, source ages, deadlines,
and facts the report cannot render do not create new work.

The inference deadline bounds one attempt; it is not report freshness. A
published revision remains eligible while its exact fact fingerprint still
matches the current forecast bundle. Changed facts make the stable `/brief`
URL return pending or unavailable until a matching revision exists, and every
response uses `Cache-Control: no-store`.

## Rollout and rollback

The tracked Worker configuration keeps `NARRATIVE_ENABLED=false`. Follow the
operator sequence in [`self-hosting.md`](./self-hosting.md): provision the Queue
and DLQ through the normal authorized setup/deploy path, add the out-of-band
HTTP pull consumer, configure separate Queue and result credentials, prove the
runner health path, complete live acceptance, and only then enable production
in a versioned deploy. No evaluation command itself mutates Cloudflare state.

Rollback is non-destructive: disable new narrative production, stop the local
pull runner, quiesce or reconcile outstanding jobs, and revoke its scoped
credentials as appropriate. Deterministic Forecast remains available
throughout.

`ForecastBriefAgent`, its `FORECAST_BRIEF_AGENT` binding/export, migration
`0002`, and old brief rows remain dormant rollback compatibility for existing
installations. They are not an active generation path, should not be enabled as
part of Analysis v3, and do not require Gemini credentials.
