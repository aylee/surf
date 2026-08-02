import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, Output } from "ai";
import type { BriefGenerator } from "./generator";
import { FORECAST_BRIEF_SAFE_NARRATION_WORDS } from "./language-policy";
import {
  FORECAST_BRIEF_MODEL_ID,
  FORECAST_BRIEF_PROMPT_VERSION,
  FORECAST_BRIEF_THINKING_LEVEL,
  ForecastBriefDraftSchema,
  type ForecastBriefDraft,
  type ForecastFactBundle
} from "./types";

const SYSTEM_PROMPT = `You are Surf's constrained forecast narrator.
You explain a deterministic forecast; you do not calculate marine physics, scores, rankings, or new recommendations.
Use only the supplied public facts. Every factual claim must cite one or more supplied fact IDs.
Write natural, concise prose in your own words. Synthesize cited facts instead of copying data-plumbing phrases.
Write exactly one sentence in each summary, why, tradeoff, bust-factor, and lesson text field.
Do not write any number, time, rank, measurement, or unit. Code adds all authoritative values and labels later.
Keep the deterministic recommendation window IDs and order exactly as supplied.
When support and tradeoff facts are both supplied, the summary must cite and synthesize at least one of each.
Use support facts for why a window leads and tradeoff facts for what tempers the call. Context facts may explain, but may not invent a benefit or penalty.
Use a qualitative forecast term only when that exact idea appears in the cited facts for the claim.
Keep every causal relationship inside one cited fact: do not make wind change modeled wave state, confidence change conditions, or a favorable state become a limiter.
Keep each bust factor focused on its cited tradeoff or context; do not restate an uncited surface condition.
For the lesson, prefer wind relationship, tide context, confidence, or source freshness. Do not contrast modeled waves with observed or breaking surf.
Do not describe breaking-wave height, surf height, observations, proxies, fallbacks, calibration, or hazards; those remain outside model-authored prose.
Treat tide direction as context only. Never infer tide push, shape, quality, power, or improvement.
Do not include links, HTML, markdown links, safety assurances, commands, or directives to paddle out or stay out.
If a fact is unavailable, acknowledge uncertainty instead of filling it in.
Use substantive forecast words from the cited fact statements. Outside those facts, use only the supplied connective vocabulary.
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
  const recommended = new Set(bundle.input.recommendationWindowIds);
  const visibleFacts = bundle.facts
    .filter(
      (fact) =>
        fact.material &&
        fact.role !== "locked" &&
        fact.kind !== "observation" &&
        (fact.windowId === null || recommended.has(fact.windowId))
    )
    .map(({ id, kind, role, statement, windowId }) => ({
      id,
      kind,
      role,
      statement,
      windowId
    }));
  return JSON.stringify({
    task: {
      spotId: bundle.input.spotId,
      localDate: bundle.input.localDate,
      recommendationWindowIds: bundle.input.recommendationWindowIds,
      requirements: [
        "Return a natural summary with sentence-scoped fact references.",
        "Return one pick for every recommendation window, in the supplied order.",
        "Attach factRefs separately to every summary, why, tradeoff, bust factor, and lesson.",
        "When both roles exist, summary factRefs must include at least one support fact and one tradeoff fact.",
        "Each why must cite a support fact for that window.",
        "If a why uses a condition, wind, confidence, source, wave, or tide phrase, its factRefs must include that exact fact.",
        "Each tradeoff must cite a tradeoff fact for that window, or context only when no tradeoff fact exists.",
        "If a tradeoff mentions a surface condition, cite the condition fact as well as the limiting fact.",
        "A relation-bearing clause must follow the domain and positive/limiting direction of one cited fact; do not recombine facts into a new causal claim.",
        "A bust factor must stay within its cited tradeoff or context and must not borrow an uncited condition label.",
        "Do not repeat implementation language such as input available, source status, semantics, or quality band.",
        "Use no digits, number words, times, measurements, or units in prose.",
        "Prefer a wind, tide, confidence, or source lesson; never explain observed surf, breaking waves, surf height, calibration, proxy, or fallback semantics.",
        "Lesson topic must match its cited fact kind: wave=Modeled wave state, wind=Wind relationship, tide=Tide trend, condition=Surface condition, confidence=Confidence, source=Source freshness, hazard=Forecast hazard, observation=Buoy observation, caveat=Forecast caveat, recommendation=Recommendation, spot=Spot context."
      ]
    },
    evidence: {
      global: visibleFacts.filter((fact) => fact.windowId === null),
      recommendations: bundle.input.recommendationWindowIds.map((windowId) => ({
        windowId,
        facts: visibleFacts.filter((fact) => fact.windowId === windowId)
      }))
    },
    connectiveVocabulary: FORECAST_BRIEF_SAFE_NARRATION_WORDS
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
      // This is a constrained narration task, so keep thinking low and reserve
      // the output budget for the structured answer. The setting participates
      // in the generation fingerprint alongside model and prompt versions.
      providerOptions: {
        google: {
          thinkingConfig: { thinkingLevel: FORECAST_BRIEF_THINKING_LEVEL }
        }
      },
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
