import { describe, expect, it } from "vitest";
import { assembleModelForecastBrief, buildDeterministicForecastBrief } from "./brief";
import { buildForecastFactBundle } from "./facts";
import { briefForecastFixture, validDraftFor } from "./test-helpers";

describe("forecast brief assembly", () => {
  it("always provides a schema-valid deterministic fallback", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const brief = buildDeterministicForecastBrief(bundle);

    expect(brief.provider).toBe("deterministic");
    expect(brief.modelId).toBeNull();
    expect(brief.picks.map((pick) => pick.windowId)).toEqual(bundle.input.recommendationWindowIds);
    expect(brief.bustFactors[0]?.factRefs.length).toBeGreaterThan(0);
  });

  it("attaches immutable model and input metadata to a validated draft", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const brief = assembleModelForecastBrief({
      bundle,
      draft: validDraftFor(bundle),
      revision: 3,
      generatedAt: "2026-08-02T14:00:00.000Z"
    });

    expect(brief).toMatchObject({
      provider: "google",
      modelId: "gemini-3.6-flash",
      revision: 3,
      inputFingerprint: bundle.inputFingerprint
    });
  });
});
