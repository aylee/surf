import { forecastBriefFrame, forecastBriefWindowLabel } from "./facts";
import {
  FORECAST_BRIEF_MODEL_ID,
  FORECAST_BRIEF_PROMPT_VERSION,
  FORECAST_BRIEF_SCHEMA_VERSION,
  ForecastBriefResponseSchema,
  ForecastBriefSchema,
  type ForecastBrief,
  type ForecastBriefResponse,
  type ForecastBriefDraft,
  type ForecastFact,
  type ForecastFactBundle
} from "./types";

export function assembleModelForecastBrief(options: {
  draft: ForecastBriefDraft;
  bundle: ForecastFactBundle;
  revision: number;
  generatedAt?: string;
}): ForecastBrief {
  return ForecastBriefSchema.parse({
    schemaVersion: FORECAST_BRIEF_SCHEMA_VERSION,
    spotId: options.bundle.input.spotId,
    localDate: options.bundle.input.localDate,
    revision: options.revision,
    inputFingerprint: options.bundle.inputFingerprint,
    ...options.draft,
    provider: "google",
    modelId: FORECAST_BRIEF_MODEL_ID,
    promptVersion: FORECAST_BRIEF_PROMPT_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString()
  });
}

function factForWindow(
  bundle: ForecastFactBundle,
  windowId: string,
  suffix: string
): ForecastFact | undefined {
  return bundle.facts.find(
    (fact) => fact.windowId === windowId && fact.id.endsWith(`:${suffix}`)
  );
}

function firstFact(bundle: ForecastFactBundle, kinds: ForecastFact["kind"][]): ForecastFact {
  return (
    bundle.facts.find((fact) => kinds.includes(fact.kind)) ??
    bundle.facts.find((fact) => fact.id === "spot:identity") ??
    bundle.facts[0]!
  );
}

export function buildDeterministicForecastBrief(
  bundle: ForecastFactBundle,
  revision = 1
): ForecastBrief {
  const picks = bundle.input.recommendationWindowIds.map((windowId) => {
    const condition = factForWindow(bundle, windowId, "condition") ?? firstFact(bundle, ["condition"]);
    const wave = factForWindow(bundle, windowId, "wave") ?? condition;
    const confidenceBand = bundle.input.windows.find((window) => window.windowId === windowId)?.confidenceBand;
    return {
      windowId,
      label: forecastBriefWindowLabel(bundle, windowId),
      why: "The condition score places this daylight window among the leading options.",
      tradeoff: `Confidence is ${confidenceBand ?? "unknown"}; modeled wave values describe nearshore state rather than observed breaking-wave faces.`,
      factRefs: [...new Set([condition.id, wave.id])]
    };
  });
  const frame = forecastBriefFrame(bundle);

  const bustFact = firstFact(bundle, ["hazard", "caveat", "source", "wave"]);
  const lessonFact = firstFact(bundle, ["wave", "confidence", "source"]);
  return ForecastBriefSchema.parse({
    schemaVersion: FORECAST_BRIEF_SCHEMA_VERSION,
    spotId: bundle.input.spotId,
    localDate: bundle.input.localDate,
    revision: Math.max(1, revision),
    inputFingerprint: bundle.inputFingerprint,
    headline: frame.headline,
    setup: frame.setup,
    picks,
    bustFactors: [
      {
        text: bustFact.statement,
        factRefs: [bustFact.id]
      }
    ],
    lesson: {
      topic: "Read the measurement label first",
      text: "Modeled nearshore wave state and observed breaking-wave face height are different measurements; keep that distinction attached to the size number.",
      factRefs: [lessonFact.id]
    },
    provider: "deterministic",
    modelId: null,
    promptVersion: FORECAST_BRIEF_PROMPT_VERSION,
    generatedAt: bundle.input.generatedAt
  });
}

/**
 * Last-resort public copy for a brief request that could not be assembled.
 *
 * This deliberately depends only on validated route metadata. It must remain
 * usable when forecast rows, brief storage, the Agent, and the model are all
 * unavailable.
 */
export function buildUnavailableForecastBriefResponse(input: {
  spotId: ForecastBrief["spotId"];
  spotName: string;
  localDate: string;
  generatedAt: string;
}): ForecastBriefResponse {
  return ForecastBriefResponseSchema.parse({
    status: "deterministic_fallback",
    brief: {
      schemaVersion: FORECAST_BRIEF_SCHEMA_VERSION,
      spotId: input.spotId,
      localDate: input.localDate,
      revision: 1,
      inputFingerprint: `fallback:${input.spotId}:${input.localDate}`,
      headline: `${input.spotName} daily summary is refreshing`,
      setup:
        "Use the forecast table and data-health details below for the latest available wave, wind, and tide context.",
      picks: [],
      bustFactors: [
        {
          text: "Some forecast inputs may be delayed; unavailable values remain blank.",
          factRefs: ["fallback:data-health"]
        }
      ],
      lesson: {
        topic: "Read the available inputs",
        text: "Wave, wind, tide, and source health remain useful independently when a daily summary is still refreshing.",
        factRefs: ["fallback:forecast-details"]
      },
      provider: "deterministic",
      modelId: null,
      promptVersion: FORECAST_BRIEF_PROMPT_VERSION,
      generatedAt: input.generatedAt
    },
    fallbackReason: null,
    availableRevisions: 0
  });
}
