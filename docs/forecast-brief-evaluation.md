# Forecast Brief Evaluation

Surf's daily outlook is useful only when it adds a clear explanation without
weakening the deterministic forecast underneath it. The model may synthesize
public facts into natural language, but it cannot calculate wave physics,
change the ranked windows, or turn modeled wave state into observed breaking
surf.

The publication path therefore has two independent gates:

1. **Policy validation** checks schemas, recommendation identity and order,
   sentence-level fact references, measurements, qualitative claims, modeled
   versus observed semantics, and prohibited safety or markup content.
2. **Quality evaluation** checks that a policy-valid answer is still worth
   showing: it explains the recommendation, names a real tradeoff, cites
   relevant and varied evidence, avoids repeated boilerplate, and reads like a
   surf outlook rather than an implementation trace.

Failure at either gate is fail-closed. The model draft is not written to D1,
and the read-only brief endpoint continues to return the fact-based local
summary. Forecast publication, ranking, Table, and Graph remain independent of
the Agent and model.

## What CI proves

Ordinary CI is secretless and deterministic. It never calls Gemini and never
needs `GEMINI_API_KEY`. Fixed direct-model and NWS-fallback cases exercise the
same quality evaluator used at publication time, alongside negative cases for:

- recommendation prose supported only by a rank or unrelated fact;
- missing support or tradeoff roles;
- citations from another forecast window;
- repeated reasons or tradeoffs across adjacent picks;
- implementation language such as raw enum values, fingerprints, fact IDs, or
  source-status plumbing;
- raw fact dumps that pass factual checks but do not synthesize the setup; and
- weak evidence diversity when better facts are available.

These tests establish a deterministic quality floor. They do not prove that a
particular hosted model will always write well.

### Claim licenses, not word matching

Each cited fact acts as a narrow claim license. The validator derives its
forecast domain, evidence role, polarity, explicit state, and recommendation
window before accepting model prose. A clause that says one factor supports or
limits another must be licensed by a single cited fact carrying that
relationship and polarity for the same window. Citing separate true wind and
wave facts therefore cannot license a new claim that wind strengthens the
modeled wave state, and support evidence cannot be rewritten as a limiter.
Compound predicates are split and checked independently, so a licensed first
relationship cannot conceal an inverted relationship later in the sentence.

The vocabulary allowlist is an additional guard, not the grounding model. It
prevents uncited topics from entering otherwise natural prose. Adversarial
tests cover cross-domain recombination, inverted support/tradeoff claims,
field/value swaps, invented tide effects, and evidence borrowed from another
recommendation window. The validator remains deliberately conservative: when
it cannot prove the relationship, it rejects the draft and serves the local
fact-based outlook.

## What the optional live evaluation proves

The opt-in Gemini evaluation uses the ignored `apps/web/.dev.vars` key for one
bounded call on a representative direct-nearshore scenario. It runs the result
through the production policy validator and deterministic quality evaluator,
then assembles the same public brief shape used by the product. Its safe log
contains the scenario name, quality-policy version, pass/fail checks, issue
count, metrics, and user-visible brief copy. It omits prompts, API keys, provider
requests, fact references, recommendation window IDs, and private context.
If generation or validation rejects the draft, the harness emits only the
scenario, phase, and an allowlisted failure category before failing the test;
raw provider or policy messages are not printed.

Direct-model and NWS-fallback quality cases remain deterministic, secretless
fixtures in ordinary tests; the opt-in evaluator does not make a separate
provider call for each case.

The live evaluation is intentionally outside CI: model output is stochastic,
quota-limited, and tied to a versioned external provider. It is a release and
prompt-development tool, not a substitute for deterministic tests.

## Quality checks

### Relevance and role coverage

Facts are assigned a product role before they reach the model:

- `support` explains why a ranked window is attractive;
- `tradeoff` explains what limits confidence or quality;
- `context` helps teach the user how to read the setup; and
- `locked` is a code-owned caveat that the model cannot rewrite or select.

Every recommended window needs window-specific support in its `why` text and a
window-specific tradeoff when one is available. When every forecast dimension
is limiting, the deterministic recommendation may support a "least
compromised" explanation only when it is paired with substantive
window-specific context. A context fact may fill a tradeoff only when the input
has no applicable tradeoff fact. Recommendation rank and spot identity cannot
be the sole evidence for a forecast claim.

Locked measurement, proxy, fallback, calibration, and hazard caveats are
inserted by code after model validation. Nearby buoy observations remain
separate regional context and are not promoted into a mandatory forecast bust
factor. This keeps precise trust language stable while allowing the model to
write the explanatory connective prose.

Validation metadata retains the claim-level fact references for the summary,
each reason and tradeoff, every bust factor, the lesson, and code-owned locked
caveats. The public response remains compact, while persisted revisions keep
enough provenance to audit which evidence supported each sentence. Older v1
rows without the additive claim map remain readable.

### Evidence diversity

The evaluator expects a pick to use more than one forecast dimension when the
input makes that possible. Across the full outlook it checks the breadth of
fact kinds and rejects a single generic fact reused as the reason, tradeoff,
bust factor, and lesson. The learning note must add a distinct concept rather
than restate the call.

### Naturalness and non-repetition

The quality floor rejects exact fact-statement copies, repeated sentence
skeletons, labeled data dumps, and internal vocabulary such as `window ID`,
`input fingerprint`, `quality band`, `required-source status`, or raw enum
names. It also bounds extremely short fragments and unusually long fields.

These are deliberately conservative heuristics. They catch the failure mode
where structurally valid output still looks machine-assembled; they do not
attempt to compute a universal prose-quality score.

## Versioning and rollout

Model identity, thinking level, prompt, schema, and quality-policy versions are
forecast-generation inputs. They participate in the generation fingerprints
so a generation-policy upgrade can publish a new revision even when the
physical forecast facts have not changed. Freshness-age drift remains
non-material.

Published v1 rows stay in additive history. A v2 deployment reads only a
revision compatible with the current material and generation policy; while a
new revision is pending or rejected, the endpoint serves the local fact-based
summary. Rollout does not require a new Agent namespace, public Agent route, or
model key.

For production, preserve the existing two-version sequence:

1. deploy the post-Agent Worker with forecast briefs disabled;
2. smoke-test forecast and fallback behavior;
3. enable Gemini in a second Worker version and trigger ingest;
4. inspect outcomes for all configured spots; and
5. disable brief generation if provider or quality behavior regresses.

Do not remove the `ForecastBriefAgent` export as a rollback technique. D1
brief revisions and Durable Object coordination state are additive and can
remain in place while model generation is disabled.
