import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import { forecastBriefFrame, forecastBriefWindowLabel } from "./facts";
import type { BriefGenerator } from "./generator";
import {
  FORECAST_BRIEF_MODEL_ID,
  FORECAST_BRIEF_PROMPT_VERSION,
  ForecastBriefDraftSchema,
  type ForecastBriefDraft,
  type ForecastFactBundle
} from "./types";

const SYSTEM_PROMPT = `You are Surf's constrained forecast narrator.
You explain a deterministic forecast; you do not calculate marine physics, scores, rankings, or new recommendations.
Use only the supplied public facts. Every factual claim must cite one or more supplied fact IDs.
Copy every why, tradeoff, bust-factor, and lesson-text sentence verbatim from one cited fact statement. Do not paraphrase, swap labels, add connective words, or combine fragments.
Copy any number and unit exactly from a cited fact. Do not derive, round, convert, compare, or invent values.
Keep the deterministic recommendation window IDs and order exactly as supplied.
Never call modeled nearshore significant wave height a breaking wave-face height.
Do not include links, HTML, markdown links, safety assurances, commands, or directives to paddle out or stay out.
If a fact is unavailable, acknowledge uncertainty instead of filling it in.
Write concise, plain language for a surfer learning how forecasts fit together.`;

export type GeminiBriefInvocation = (request: {
  system: string;
  prompt: string;
}) => Promise<unknown>;

export type GeminiBriefGeneratorOptions = {
  apiKey: string;
  invoke?: GeminiBriefInvocation;
};

function promptFor(bundle: ForecastFactBundle): string {
  const frame = forecastBriefFrame(bundle);
  const recommendationWindows = bundle.input.recommendationWindowIds.map((windowId) => {
    return {
      windowId,
      label: forecastBriefWindowLabel(bundle, windowId)
    };
  });
  return JSON.stringify({
    task: {
      spotId: bundle.input.spotId,
      localDate: bundle.input.localDate,
      recommendationWindows,
      requiredHeadline: frame.headline,
      requiredSetup: frame.setup,
      requirements: [
        "Return requiredHeadline and requiredSetup unchanged.",
        "Return one pick for every recommendation window, in the supplied order.",
        "Use each supplied label unchanged.",
        "Attach factRefs to every pick, bust factor, and lesson.",
        "Copy all explanatory sentences verbatim from cited fact statements.",
        "Lesson topic must match its cited fact kind: wave=Modeled wave state, wind=Wind relationship, tide=Tide trend, condition=Surface condition, confidence=Confidence, source=Source freshness, hazard=Forecast hazard, observation=Buoy observation, caveat=Forecast caveat, recommendation=Recommendation, spot=Spot context."
      ]
    },
    facts: bundle.facts
      .filter((fact) => fact.material)
      .map(({ id, kind, statement, windowId }) => ({ id, kind, statement, windowId }))
  });
}

function defaultInvocation(apiKey: string): GeminiBriefInvocation {
  const google = createGoogleGenerativeAI({ apiKey });
  return async ({ system, prompt }) => {
    const result = await generateText({
      model: google(FORECAST_BRIEF_MODEL_ID),
      system,
      prompt,
      output: Output.object({
        schema: ForecastBriefDraftSchema,
        name: "forecast_brief",
        description: "A fact-referenced explanation of deterministic surf forecast data."
      }),
      // Gemini 3.6 deprecates sampling parameters. Its default medium thinking
      // can consume part of the output budget before the structured answer, so
      // leave sampling unset and reserve enough room for both phases.
      maxOutputTokens: 4_096,
      maxRetries: 0,
      timeout: 45_000
    });
    return result.output;
  };
}

export function createGeminiBriefGenerator({
  apiKey,
  invoke = defaultInvocation(apiKey)
}: GeminiBriefGeneratorOptions): BriefGenerator {
  if (!apiKey.trim()) throw new Error("GEMINI_API_KEY is required when forecast briefs are enabled");
  return {
    provider: "google",
    modelId: FORECAST_BRIEF_MODEL_ID,
    promptVersion: FORECAST_BRIEF_PROMPT_VERSION,
    async generate(bundle): Promise<ForecastBriefDraft> {
      const output = await invoke({ system: SYSTEM_PROMPT, prompt: promptFor(bundle) });
      return ForecastBriefDraftSchema.parse(output);
    }
  };
}

export const forecastBriefSystemPrompt = SYSTEM_PROMPT;
