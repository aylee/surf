import { describe, expect, it } from "vitest";
import { buildForecastFactBundle } from "./facts";
import { createGeminiBriefGenerator } from "./gemini";
import { briefForecastFixture } from "./test-helpers";
import { validateForecastBriefDraft } from "./validator";

const liveApiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
const liveEnabled = process.env.SURF_LIVE_GEMINI === "1" && liveApiKey.length > 0;

describe.runIf(liveEnabled)("Gemini brief live evaluation", () => {
  it(
    "makes one bounded generation call and accepts only policy-validated public prose",
    async () => {
      const bundle = await buildForecastFactBundle(briefForecastFixture());
      const generator = createGeminiBriefGenerator({ apiKey: liveApiKey });

      // Exactly one provider call. No retries are configured in the adapter.
      const draft = await generator.generate(bundle);
      const { validation } = validateForecastBriefDraft(draft, bundle);

      expect(validation.valid).toBe(true);
      expect(draft.picks.map((pick) => pick.windowId)).toEqual(
        bundle.input.recommendationWindowIds
      );
      console.info(
        JSON.stringify({
          liveGeminiBrief: "validated",
          headline: draft.headline,
          picks: draft.picks.map(({ label, why, tradeoff }) => ({ label, why, tradeoff })),
          lesson: draft.lesson
        })
      );
    },
    55_000
  );
});
