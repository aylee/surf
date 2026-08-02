import { describe, expect, it } from "vitest";
import { ForecastBriefResponseSchema } from "@surf/contracts";
import {
  assembleModelForecastBrief,
  buildDeterministicForecastBrief,
  buildUnavailableForecastBriefResponse
} from "./brief";
import { buildForecastFactBundle, forecastBriefWindowLabel } from "./facts";
import { briefForecastFixture, validDraftFor } from "./test-helpers";

describe("forecast brief assembly", () => {
  it("always provides a schema-valid deterministic fallback", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const brief = buildDeterministicForecastBrief(bundle);

    expect(brief.provider).toBe("deterministic");
    expect(brief.modelId).toBeNull();
    expect(brief.picks.map((pick) => pick.windowId)).toEqual(bundle.input.recommendationWindowIds);
    expect(brief.bustFactors[0]?.factRefs.length).toBeGreaterThan(0);
    expect(brief.picks[0]?.why).not.toBe(brief.picks[1]?.why);
    expect(brief.picks[0]?.tradeoff).not.toBe(brief.picks[1]?.tradeoff);
    expect(JSON.stringify(brief)).not.toMatch(/condition score|deterministic fallback/i);
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
      schemaVersion: 2,
      provider: "google",
      modelId: "gemini-3.6-flash",
      promptVersion: "surf-brief-v2",
      revision: 3,
      inputFingerprint: bundle.inputFingerprint,
      setup: validDraftFor(bundle).summary.text
    });
    expect(brief.headline).toMatch(/leads at Linda Mar/i);
    expect(brief.picks.map((pick) => pick.label)).toEqual(
      bundle.input.recommendationWindowIds.map((windowId) =>
        forecastBriefWindowLabel(bundle, windowId)
      )
    );
    expect(brief.bustFactors.at(-1)).toMatchObject({
      text: expect.stringContaining("not an observed breaking-wave face height")
    });
  });
});
