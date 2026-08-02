import { describe, expect, it } from "vitest";
import { buildForecastFactBundle } from "./facts";
import { briefForecastFixture, validDraftFor } from "./test-helpers";
import { ForecastBriefPolicyError, validateForecastBriefDraft } from "./validator";

describe("forecast brief policy validator", () => {
  it("accepts a constrained fact-referenced draft", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const result = validateForecastBriefDraft(validDraftFor(bundle), bundle, new Date("2026-08-02T14:00:00.000Z"));

    expect(result.validation.valid).toBe(true);
    expect(result.validation.referencedFactIds.length).toBeGreaterThan(0);
  });

  it("rejects unknown facts, new recommendation IDs, and novel measurements", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.picks[0] = {
      ...draft.picks[0]!,
      windowId: "invented-window",
      why: "The wave will be 99 ft.",
      factRefs: ["unknown:fact"]
    };

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(ForecastBriefPolicyError);
    try {
      validateForecastBriefDraft(draft, bundle);
    } catch (error) {
      expect((error as ForecastBriefPolicyError).issues.join(" ")).toMatch(
        /window IDs|unknown fact|novel numeric/i
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
    draft.setup = text;
    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(ForecastBriefPolicyError);
  });

  it("rejects evidence borrowed from another recommendation window", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const otherWindow = bundle.input.recommendationWindowIds[1]!;
    draft.picks[0]!.factRefs = [
      bundle.facts.find((fact) => fact.windowId === otherWindow && fact.kind === "condition")!.id
    ];

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(/different recommendation window/i);
  });

  it("rejects unsupported qualitative claims even when a real but unrelated fact is cited", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const windowId = draft.picks[0]!.windowId;
    draft.picks[0]!.why = "The wind is offshore.";
    draft.picks[0]!.factRefs = [
      bundle.facts.find((fact) => fact.windowId === windowId && fact.kind === "wave")!.id
    ];

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(/unsupported qualitative claim offshore/i);
  });

  it("rejects unsupported prose outside the qualitative keyword list", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.picks[0]!.why = "The swell is exceptionally consistent and well organized.";

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /not an exact allowlisted fact sentence/i
    );
  });

  it.each([
    "The wave is thirteen feet.",
    "The pressure is 1013 mb.",
    "The energy is 200 kJ.",
    "This window is low risk.",
    "Head into the water during this window."
  ])("rejects indirect numeric, unit, or safety policy bypasses: %s", async (text) => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.picks[0]!.why = text;
    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(ForecastBriefPolicyError);
  });

  it("rejects inversion of the modeled-wave semantics caveat", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.lesson.text =
      "This is an observed breaking-wave face height, not a modeled wave state.";

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /reverses or weakens the modeled-wave semantics caveat/i
    );
  });

  it("rejects grammatical negation that is absent from the cited tide fact", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const windowId = draft.picks[0]!.windowId;
    const tide = bundle.facts.find(
      (fact) => fact.windowId === windowId && fact.kind === "tide"
    )!;
    draft.picks[0]!.why = "This window is without tide.";
    draft.picks[0]!.factRefs = [tide.id];

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /not an exact allowlisted fact sentence/i
    );
  });

  it("rejects field/value swaps even when every word occurs in the cited fact", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.picks[0]!.why =
      "The deterministic surface condition is excellent; quality band is clean; confidence band is high.";

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /not an exact allowlisted fact sentence/i
    );
  });

  it("rejects a contradictory wave claim even when a later sentence repeats the caveat", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    draft.lesson.text =
      "This is an observed breaking-wave face height, not a modeled wave state. This is not an observed breaking-wave face height.";

    expect(() => validateForecastBriefDraft(draft, bundle)).toThrow(
      /reverses or weakens the modeled-wave semantics caveat/i
    );
  });
});
