# Analysis Narrative Evaluation

This page defines the quality gate for Analysis v5. The historical filename is
retained for existing links. The active path is the generic Cloudflare Queue to
local narrative runner described in [`narrative-runner.md`](./narrative-runner.md),
not the dormant `ForecastBriefAgent`.

Analysis is useful only when it turns the deterministic forecast into a clear
session call without changing the forecast. TypeScript owns the headline,
recommendation order, every time and measurement, surf-size range, swell
period/direction, wind and surface state, tide context, confidence band, every
candidate sentence, and all provenance. The model is an editor: it returns only
IDs selecting and ordering code-authored cards. It never writes report prose.

## V5 editorial-plan anatomy

The model returns one strict card-selection plan:

```json
{
  "schemaVersion": 1,
  "outlook": {
    "leadCardId": "outlook:...",
    "supportingCardId": "outlook:..."
  },
  "call": {
    "primarySupportCardId": "primary:support:...",
    "primaryTradeoffCardId": "primary:tradeoff:...",
    "alternateCardId": "alternate:..."
  },
  "close": { "watchCardId": "watch:..." }
}
```

The two outlook IDs must be distinct and jointly cover wave plus surface/wind.
Primary support is required when candidates exist; primary tradeoff is required
when its candidate group exists. The alternate may be `null` when it adds no
useful contrast and must be `null` for a primary-only snapshot. One concrete
watch card is always selected. Recommendation rank is immutable.

Each card already contains a complete code-authored template, rendered preview,
placement, stance, semantic key, optional recommendation window, fact refs, and
domains. The snapshot also carries every code-owned value slot and relevant
fact. Cloud code renders the selected cards into the unchanged public
`SurfAnalysisReportV3`; neutral tide context and the primary call frame are
inserted by code, not selected or authored by the model.

## Publication gate

Cloud validation is fail-closed. A generated result is publishable only when
all of these checks pass:

1. The result authenticates to the internal endpoint and matches the active
   job, submission, prompt, output schema, target, and exact fact fingerprint.
2. The response matches the bounded strict JSON plan schema. Unknown fields,
   missing sections, malformed JSON, and non-card values fail.
3. Every selected ID exists in its exact placement group. Outlook IDs are
   distinct, selection cardinality is exact, and mutually duplicative semantic
   points cannot be selected twice.
4. Primary support/tradeoff requirements match the supplied candidate groups;
   alternate nullability matches the snapshot call mode and can never change
   recommendation rank.
5. Every selected card's complete fact refs remain within the code-built
   allowed provenance for that claim. The model cannot add a measurement,
   sentence, citation, hazard, or causal claim.
6. Tide remains neutral code-owned context and is never a selectable reason
   conditions improve. Primary/alternate identity and ordering come only from
   deterministic recommendations.
7. The renderer resolves every code-owned value, emits no template token, stays
   compact, and matches the unchanged public report contract. Selected card IDs
   and claim-to-fact references are stored with validation evidence.

A semantically invalid primary result requests the bounded fallback route. A
semantically invalid fallback still cannot publish. Neither path fabricates a
deterministic pseudo-report under the Analysis heading.

## Deterministic test corpus

Ordinary verification is secretless and never contacts a model provider. Unit
and Worker integration fixtures cover accepted plans, card construction, and
adversarial selection mutations.

Golden coverage includes:

- primary plus alternate and a genuinely primary-only day;
- stable, building, easing, and same-endpoint/midday-peak surf evolution;
- changing and all-day-stable surface/wind runs;
- official tide events during, before, and after a session, plus missing tide;
- high, medium, and low confidence with explicit and baseline uncertainty;
- missing swell direction/period, wind, surf size, or tide context;
- short winter daylight, DST boundaries, and all checked-in spot names; and
- fresh direct guidance, cove proxy, NWS fallback, stale/missing source, and
  nearby-observation context.

Adversarial coverage must reject:

- unknown, duplicate, missing, or wrong-placement card IDs;
- one card reused across claims or two cards with the same semantic point;
- an alternate on a primary-only day, an alternate promoted over the primary,
  or any selection that changes deterministic recommendation order;
- missing required primary support/tradeoff or a watch choice outside the
  concrete watch group;
- two outlook choices that fail to cover both wave and surface/wind;
- card provenance outside the claim's allowed fact refs, stale fingerprints,
  or a card/template/value mutation after snapshot construction; and
- any prose-shaped output, extra field, template, measurement, citation,
  directive, or implementation/source-plumbing text in the plan.

The deterministic validator is the publication authority. An LLM judge can
never waive one of these failures.

## Offline model bakeoff

Run model selection outside CI against production-shaped snapshots and the
real cloud validator/renderer. Load all 55 current fact bundles (all 11 spots
across five dates), record recommendation-free dates as intentional no-calls,
and run each eligible generator with three seeds. The checked-in deterministic
validator suite owns the synthetic/adversarial matrix above; it is both more
repeatable and safer than paying a model to invent roughly 24 hostile payloads.
The production runner has no output-repair protocol, so the bakeoff records
first-pass validity and gives no model a harness-only repair advantage. The
operational procedure and artifact contract live in
[`analysis-model-bakeoff.md`](analysis-model-bakeoff.md).

The evaluation harness should use the production contract directly:

1. build a real fact bundle, then call `buildSurfAnalysisSnapshot(bundle)`;
2. call `buildSurfNarrativeJob(snapshot)` and send its `inference` object to
   the candidate model without rewriting the messages or response schema;
3. parse returned JSON with `SurfAnalysisPlanV5Schema`;
4. require `validateSurfAnalysisDraft(output, snapshot)` to pass; and
5. render accepted copy with `renderSurfAnalysisReport(...)` before judging.

`buildSurfNarrativeJob` is the supported prompt/schema hook. Prompt assembly
stays private so an offline bakeoff cannot silently diverge from production.
For a primary-only snapshot the output must contain
`call.alternateCardId: null`; a primary-plus-alternate snapshot may still omit
an alternate when none adds useful contrast. Validation failure is a scored
generation failure, not a reason for the harness to patch card IDs or relax
policy.

Compare a candidate to the current baseline with blind, order-swapped A/B
judging. The judge receives the call mode, immutable recommendation order,
every code-owned value/fact, every candidate card preview/template/evidence,
and the rendered reports, all explicitly marked authoritative; it never sees
model identities. It must judge editorial selection and cannot call supplied
measurements or claims hallucinations. It returns structured 1–5 scores for:

- actionable session call;
- daylight evolution clarity;
- concrete reason and tradeoff;
- primary-versus-alternate distinction;
- uncertainty calibration;
- natural local-forecaster voice;
- concision and non-repetition; and
- factual fidelity.

The judge response is fail-closed: one top-level object, unique reason codes,
`tie_equivalent` if and only if the winner is `tie`, and a complete punctuated
rationale. A schema-valid but self-contradictory or truncated decision is an
invalid judge call, not a result to reinterpret.

Use cross-family judges: a Gemma-family judge for Qwen-family generators and a
Qwen-family judge for Gemma-family generators. Run two judges when practical;
a win requires both judges to agree, or one win plus one tie. Reverse A/B order
and send disagreements or order instability to a small owner calibration set.
Never use the same generator as the only judge of itself.
Calibrate each proposed judge on fixed, order-swapped cases before the full
matrix; specifically include identical-report pairs, where any invented
difference is a disqualifying factual-fidelity failure.

Minimum activation gates:

- 100% rejection of the adversarial corpus;
- at least 98% first-pass hard-valid outputs across the eligible real corpus;
- no factual-fidelity regression in the blinded judge; a model that is
  quality-equivalent may win on lower latency and tighter token use;
- mean actionability and naturalness scores of at least 4/5;
- at least 90% agreement after swapping A/B order; and
- an owner calibration sample before a future prompt or model-family change
  materially expands what the model is allowed to author.

Those automated judge gates apply only after the proposed judge itself passes
the fixed identical/nonidentical, order-swapped calibration set. If no local
judge clears that bar, use the bakeoff's explicit `generator_only` mode for a
single generator over all 55 cases and gate only on the real production
validator, diversity/sensitivity, latency, and token telemetry. That mode must
not be presented as an automated quality win: owner/Codex calibration of
sanitized hard-pass reports replaces the unavailable judge gate before
activation.

Also inspect plan-selection diversity rather than treating schema validity as
evidence of useful model behavior. Record semantic plan signatures, dominant
signature rate, stability across seeds for the same case, and distinct dominant
signatures across cases. A model selecting one dominant plan for every
materially different snapshot is a sensitivity/calibration failure even when
all plans validate.

Also record bounded end-to-end latency, token usage, and estimated sequential
throughput. The current non-streaming oMLX API does not expose first-token
latency, so do not manufacture it. Keep sanitized hard-pass report copy,
model/config version, timings, output hashes, and failure category. Never log
Queue/result credentials, provider keys, raw source artifacts, private target
maps, or rejected model payloads.

## Versioning, rollout, and rollback

V5 uses prompt `surf-analysis-v5-editorial-1`, internal output schema `6`,
validation snapshot schema `3`, and result target `surf.analysis.v5`. The public
report remains schema v3 because its headline/paragraph shape did not change.
Snapshot schema, slot values and metadata, fact provenance, prompt, and output
schema participate in generation identity; model/provider/route participate in
revision provenance.

Do not create a production blank while changing contracts. Deploy consumer and
runner support first, generate and validate the current spot/date envelope,
then switch reads to the new exact contract. Old revisions remain auditable but
cannot satisfy the current prompt/schema/target query. Rollback is
non-destructive: disable new narrative production or restore the previous
contract constants while deterministic Forecast remains available.

`ForecastBriefAgent`, its binding/export, migration `0002`, and old brief rows
remain dormant compatibility for existing installations. They are not an
active Analysis generation path.
