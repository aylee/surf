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
    expect(request.system).toContain("Copy every why, tradeoff, bust-factor, and lesson-text sentence verbatim");
    expect(request.prompt).toContain(bundle.facts[0]!.id);
    expect(request.prompt).toContain(bundle.input.recommendationWindowIds[0]!);
    expect(request.prompt).not.toContain("exact modeled nearshore height");
    expect(request.prompt).not.toContain("observation age");
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
