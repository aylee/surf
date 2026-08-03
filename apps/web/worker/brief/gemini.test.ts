import { describe, expect, it, vi } from "vitest";
import { buildForecastFactBundle } from "./facts";
import {
  createGeminiBriefGenerator,
  forecastBriefSystemPrompt,
  type GeminiBriefInvocation
} from "./gemini";
import { briefForecastFixture, validDraftFor } from "./test-helpers";

describe("Gemini brief generator", () => {
  it("uses a fixed prompt and accepts a mocked structured response without network I/O", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const invoke = vi.fn<GeminiBriefInvocation>(async () => draft);
    const generator = createGeminiBriefGenerator({ apiKey: "test-key", invoke });

    await expect(generator.generate(bundle)).resolves.toEqual(draft);
    expect(invoke).toHaveBeenCalledOnce();
    const request = invoke.mock.calls[0]![0];
    expect(request.system).toBe(forecastBriefSystemPrompt);
    expect(request.system).toContain("Write natural, concise prose in your own words");
    expect(request.system).toContain("Do not write any number, time, rank, measurement, or unit");
    expect(request.system).toContain("summary must cite and synthesize at least one of each");
    expect(request.system).toContain("prefer wind relationship, tide context, confidence, or source freshness");
    expect(request.prompt).toContain(bundle.facts[0]!.id);
    expect(request.prompt).toContain(bundle.input.recommendationWindowIds[0]!);
    const nonRecommendedFact = bundle.facts.find(
      (fact) =>
        fact.windowId !== null &&
        !bundle.input.recommendationWindowIds.includes(fact.windowId)
    );
    expect(nonRecommendedFact).toBeDefined();
    expect(request.prompt).not.toContain(nonRecommendedFact!.id);
    expect(request.prompt).not.toContain("requiredHeadline");
    expect(request.prompt).not.toContain("requiredSetup");
    expect(request.prompt).not.toContain("not an observed breaking-wave face height");
    expect(request.prompt).not.toContain("exact modeled nearshore height");
    expect(request.prompt).not.toContain("observation age");
    expect(request.prompt).not.toContain("nearby public buoy observation");
    expect(request.prompt).not.toContain("test-key");
  });

  it("fails closed when mocked Gemini output violates the structured schema", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const generator = createGeminiBriefGenerator({
      apiKey: "test-key",
      invoke: async () => ({ headline: "Incomplete" })
    });

    await expect(generator.generate(bundle)).rejects.toThrow();
  });
});
