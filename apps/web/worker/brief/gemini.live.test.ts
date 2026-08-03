import { describe, expect, it } from "vitest";
import { assembleModelForecastBrief } from "./brief";
import { buildForecastFactBundle } from "./facts";
import { createGeminiBriefGenerator } from "./gemini";
import { evaluateForecastBriefQuality } from "./quality";
import { briefForecastFixture } from "./test-helpers";
import { validateForecastBriefDraft } from "./validator";

const liveApiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
const liveEnabled = process.env.SURF_LIVE_GEMINI === "1" && liveApiKey.length > 0;

function liveFailureType(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "ForecastBriefPolicyError") return "policy_rejected";
  if (name === "AI_NoOutputGeneratedError" || name === "AI_NoObjectGeneratedError") {
    return "structured_output_missing";
  }
  if (name === "AI_APICallError") return "provider_call_failed";
  return "evaluation_failed";
}

describe.runIf(liveEnabled)("Gemini brief live evaluation", () => {
  it(
    "makes one bounded generation call and accepts only policy-validated public prose",
    async () => {
      const bundle = await buildForecastFactBundle(briefForecastFixture());
      const generator = createGeminiBriefGenerator({ apiKey: liveApiKey });
      let phase = "generation";
      try {
        // Exactly one provider call. No retries are configured in the adapter.
        const draft = await generator.generate(bundle);
        phase = "validation";
        const { draft: validatedDraft, validation } = validateForecastBriefDraft(draft, bundle);
        const quality = evaluateForecastBriefQuality(validatedDraft, bundle);
        const brief = assembleModelForecastBrief({
          draft: validatedDraft,
          bundle,
          revision: 1,
          generatedAt: bundle.input.generatedAt
        });

        expect(validation.valid).toBe(true);
        expect(quality.passed).toBe(true);
        expect(validatedDraft.picks.map((pick) => pick.windowId)).toEqual(
          bundle.input.recommendationWindowIds
        );
        console.info(
          JSON.stringify({
            liveGeminiBrief: "validated",
            scenario: "direct-nearshore",
            quality: {
              policyVersion: quality.policyVersion,
              passed: quality.passed,
              checks: quality.checks,
              issueCount: quality.issues.length,
              metrics: quality.metrics
            },
            brief: {
              headline: brief.headline,
              setup: brief.setup,
              picks: brief.picks.map(({ label, why, tradeoff }) => ({ label, why, tradeoff })),
              bustFactors: brief.bustFactors.map(({ text }) => text),
              lesson: { topic: brief.lesson.topic, text: brief.lesson.text },
              generatedAt: brief.generatedAt
            }
          })
        );
      } catch (error) {
        console.info(
          JSON.stringify({
            liveGeminiBrief: "rejected",
            scenario: "direct-nearshore",
            phase,
            failureType: liveFailureType(error)
          })
        );
        throw new Error(`Live Gemini evaluation rejected during ${phase}; see sanitized record.`);
      }
    },
    55_000
  );
});
