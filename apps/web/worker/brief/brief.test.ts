import { describe, expect, it } from "vitest";
import { ForecastBriefResponseSchema } from "@surf/contracts";
import {
  assembleModelForecastBrief,
  buildDeterministicForecastBrief,
  buildUnavailableForecastBriefResponse
} from "./brief";
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

  it("builds a typed last-resort response without forecast or model dependencies", () => {
    const response = buildUnavailableForecastBriefResponse({
      spotId: "obsf-central",
      spotName: "Ocean Beach Central",
      localDate: "2026-08-02",
      generatedAt: "2026-08-02T17:00:00.000Z"
    });

    expect(ForecastBriefResponseSchema.parse(response)).toMatchObject({
      status: "deterministic_fallback",
      fallbackReason: null,
      availableRevisions: 0,
      brief: {
        spotId: "obsf-central",
        localDate: "2026-08-02",
        provider: "deterministic",
        picks: []
      }
    });
    expect(JSON.stringify(response)).not.toMatch(/database|durable object|gemini|exception/i);
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
