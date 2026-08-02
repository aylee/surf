import { describe, expect, it } from "vitest";
import { buildForecastFactBundle, forecastBriefLockedFacts } from "./facts";
import { briefForecastFixture, validDraftFor } from "./test-helpers";
import { ForecastBriefPolicyError, validateForecastBriefDraft } from "./validator";

describe("forecast brief policy validator", () => {
  it("accepts natural, sentence-scoped, fact-referenced prose", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const result = validateForecastBriefDraft(
      draft,
      bundle,
      new Date("2026-08-02T14:00:00.000Z")
    );

    expect(result.validation.valid).toBe(true);
    expect(result.draft.summary.text).not.toEqual(
      bundle.facts.find((fact) => fact.id === draft.summary.factRefs[0])?.statement
    );
    expect(result.validation.referencedFactIds).toEqual(
      expect.arrayContaining(forecastBriefLockedFacts(bundle).map((fact) => fact.id))
    );
    expect(result.validation.claimRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "summary", factRefs: draft.summary.factRefs }),
        expect.objectContaining({ path: "picks[0].why", factRefs: draft.picks[0]!.why.factRefs }),
        expect.objectContaining({ path: "codeOwned.lockedCaveats" })
      ])
    );
  });

  it("rejects unknown facts, new recommendation IDs, and model-authored measurements", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.picks[0] = {
      ...draft.picks[0]!,
      windowId: "invented-window",
      why: { text: "The wave will be ninety-nine feet.", factRefs: ["unknown:fact"] }
    };

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(ForecastBriefPolicyError);
    try {
      validateForecastBriefDraft(draft, bundle);
    } catch (error) {
      expect((error as ForecastBriefPolicyError).issues.join(" ")).toMatch(
        /window IDs|unknown fact|model-authored number|measurement unit/i
      );
    }
  });

  it.each([
    "You should paddle out now.",
    "This is always safe.",
    "Read https://example.com for more.",
    "Use <strong>this window</strong>."
  ])("rejects prohibited model prose: %s", async (text) => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.summary.text = text;
    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(ForecastBriefPolicyError);
  });

  it("requires one sentence per cited prose field", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.summary.text = `${draft.summary.text} The same facts still apply.`;

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(/exactly one cited sentence/i);
  });

  it("rejects evidence borrowed from another recommendation window", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const otherWindow = bundle.input.recommendationWindowIds[1]!;
    draft.picks[0]!.why.factRefs = [
      bundle.facts.find(
        (fact) => fact.windowId === otherWindow && fact.kind === "condition"
      )!.id
    ];

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /different recommendation window/i
    );
  });

  it("rejects unsupported qualitative and surf claims", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const windowId = draft.picks[0]!.windowId;
    draft.picks[0]!.why = {
      text: "Onshore wind makes the waves glassy and punchy.",
      factRefs: [
        bundle.facts.find((fact) => fact.windowId === windowId && fact.kind === "wave")!.id
      ]
    };

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /unsupported qualitative claim|unsupported surf descriptor/i
    );
  });

  it.each([
    "Parking will be easy and the water warm.",
    "Fog will settle over the beach before the session.",
    "Sea otters favor this inviting setup."
  ])("rejects unrelated natural-language claims despite valid citations: %s", async (text) => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.summary.text = text;

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /words unsupported by its cited facts/i
    );
  });

  it.each([
    "Offshore wind supports the modeled wave state.",
    "Offshore wind supports meaningful uncertainty around the call.",
    "Clean conditions and offshore wind weaken this option.",
    "Offshore wind is the modeled wave state.",
    "Cleaner surface supports offshore wind.",
    "Offshore wind limits this option.",
    "Uncertainty strengthens the call.",
    "Offshore wind does not support cleaner surface.",
    "Cleaner surface meets offshore wind.",
    "Cleaner surface describes offshore wind.",
    "Offshore wind supports cleaner surface and weakens this option."
  ])("rejects semantically inverted or recombined cited facts: %s", async (text) => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const windowId = draft.picks[0]!.windowId;
    draft.picks[0]!.why = {
      text,
      factRefs: bundle.facts
        .filter(
          (fact) =>
            fact.windowId === windowId &&
            fact.role !== "locked" &&
            ["recommendation", "condition", "wave", "wind", "confidence", "caveat"].includes(
              fact.kind
            )
        )
        .map((fact) => fact.id)
    };

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /cited relationship|unlicensed (?:support|tradeoff|context) relation|ambiguous forecast relation/i
    );
  });

  it.each([
    "Onshore wind keeps this option worth a look.",
    "Onshore wind helps this window.",
    "Onshore wind limits surface quality and favors this option."
  ])("rejects a limiting wind fact rewritten as a positive recommendation: %s", async (text) => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const windowId = draft.picks[0]!.windowId;
    const recommendation = bundle.facts.find(
      (fact) => fact.windowId === windowId && fact.kind === "recommendation"
    )!;
    const condition = bundle.facts.find(
      (fact) => fact.windowId === windowId && fact.kind === "condition"
    )!;
    const wind = bundle.facts.find(
      (fact) => fact.windowId === windowId && fact.kind === "wind"
    )!;
    wind.role = "tradeoff";
    wind.statement = "Onshore wind is a surface-quality limiter at this shoreline.";
    draft.picks[0]!.why = {
      text,
      factRefs: [recommendation.id, condition.id, wind.id]
    };

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /unlicensed support relation/i
    );
  });

  it.each([
    "The wave is thirteen feet.",
    "The pressure is nine hundred millibars.",
    "The energy is two hundred kilojoules.",
    "This window is low risk.",
    "Head into the water during this window."
  ])("rejects indirect numeric, unit, or safety policy bypasses: %s", async (text) => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.picks[0]!.why.text = text;
    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(ForecastBriefPolicyError);
  });

  it("rejects model-authored measurement semantics and locked caveat references", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.lesson.text = "This is an observed breaking-wave face height.";
    draft.lesson.factRefs = [forecastBriefLockedFacts(bundle)[0]!.id];

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /code-owned measurement caveat|locked caveat/i
    );
  });

  it("rejects invented tide effects even when the real tide fact is cited", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const windowId = draft.picks[0]!.windowId;
    draft.picks[0]!.tradeoff = {
      text: "The rising tide will improve shape and add push.",
      factRefs: [
        bundle.facts.find((fact) => fact.windowId === windowId && fact.kind === "tide")!.id
      ]
    };

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /unsupported tide effect/i
    );
  });

  it("rejects implementation plumbing and robotic availability copy", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.summary.text =
      "The deterministic quality band leads because the tide input is available and required-source status is fresh.";

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /implementation|availability|plumbing/i
    );
  });

  it("rejects grammatical negation that contradicts the cited tide fact", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const windowId = draft.picks[0]!.windowId;
    draft.picks[0]!.tradeoff = {
      text: "This window is without tide context.",
      factRefs: [
        bundle.facts.find((fact) => fact.windowId === windowId && fact.kind === "tide")!.id
      ]
    };

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /contradicts the available tide context/i
    );
  });

  it("rejects field/value swaps even when each word appears in cited evidence", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.picks[0]!.why.text =
      "Surface conditions are excellent while the overall quality read is clean.";

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /swaps or invents the surface condition|swaps or invents the quality/i
    );
  });

  it("rejects a rationale without substantive support and a tradeoff without a limiter", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const windowId = draft.picks[0]!.windowId;
    draft.picks[0]!.why.factRefs = [
      bundle.facts.find(
        (fact) => fact.windowId === windowId && fact.kind === "recommendation"
      )!.id
    ];
    draft.picks[0]!.tradeoff.factRefs = [
      bundle.facts.find((fact) => fact.windowId === windowId && fact.kind === "tide")!.id
    ];

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /supporting forecast fact|eligible tradeoff/i
    );
  });

  it("allows a least-compromised recommendation when no forecast dimension is positive", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    for (const fact of bundle.facts) {
      if (
        fact.windowId !== null &&
        bundle.input.recommendationWindowIds.includes(fact.windowId) &&
        ["condition", "wind", "confidence"].includes(fact.kind)
      ) {
        fact.role = "tradeoff";
        fact.statement =
          fact.kind === "confidence"
            ? "Meaningful uncertainty remains around the expected call."
            : `The expected setup has a ${fact.kind} tradeoff.`;
      }
    }
    const facts = (windowId: string) =>
      bundle.facts.filter((fact) => fact.windowId === windowId && fact.role !== "locked");
    const firstWindowId = bundle.input.recommendationWindowIds[0]!;
    const firstFacts = facts(firstWindowId);
    const firstRecommendation = firstFacts.find((fact) => fact.kind === "recommendation")!;
    const firstConfidence = firstFacts.find((fact) => fact.kind === "confidence")!;
    const firstWave = firstFacts.find((fact) => fact.kind === "wave")!;
    const draft = {
      summary: {
        text: "The daylight recommendation remains worth comparing, while meaningful uncertainty keeps the call cautious.",
        factRefs: [firstRecommendation.id, firstConfidence.id]
      },
      picks: bundle.input.recommendationWindowIds.map((windowId, index) => {
        const windowFacts = facts(windowId);
        const recommendation = windowFacts.find((fact) => fact.kind === "recommendation")!;
        const condition = windowFacts.find((fact) => fact.kind === "condition")!;
        const confidence = windowFacts.find((fact) => fact.kind === "confidence")!;
        return {
          windowId,
          why: {
            text:
              index === 0
                ? "The daylight recommendation remains worth comparing despite the expected setup."
                : "This alternate daylight recommendation remains an option despite the expected setup.",
            factRefs: [recommendation.id, condition.id]
          },
          tradeoff: {
            text:
              index === 0
                ? "Meaningful uncertainty leaves room for the expected call to differ."
                : "Meaningful uncertainty keeps this alternate vulnerable to local variation.",
            factRefs: [confidence.id]
          }
        };
      }),
      bustFactors: [
        {
          text: "Meaningful uncertainty could undercut the expected call.",
          factRefs: [firstConfidence.id]
        }
      ],
      lesson: {
        topic: "Modeled wave state",
        text: "The modeled nearshore wave state helps describe the expected setup.",
        factRefs: [firstWave.id]
      }
    };

    expect(() => validateForecastBriefDraft(draft, bundle)).not.toThrow();
  });
});
