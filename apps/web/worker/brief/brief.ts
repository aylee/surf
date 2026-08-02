import {
  forecastBriefFrame,
  forecastBriefLockedFacts,
  forecastBriefWindowLabel
} from "./facts";
import {
  FORECAST_BRIEF_MODEL_ID,
  FORECAST_BRIEF_PROMPT_VERSION,
  FORECAST_BRIEF_SCHEMA_VERSION,
  ForecastBriefResponseSchema,
  ForecastBriefSchema,
  type ForecastBrief,
  type ForecastBriefResponse,
  type ForecastBriefDraft,
  type ForecastBriefWindowInput,
  type ForecastFact,
  type ForecastFactBundle
} from "./types";

export function assembleModelForecastBrief(options: {
  draft: ForecastBriefDraft;
  bundle: ForecastFactBundle;
  revision: number;
  generatedAt?: string;
}): ForecastBrief {
  const frame = forecastBriefFrame(options.bundle);
  const lockedFacts = forecastBriefLockedFacts(options.bundle);
  const lockedStatements = [...new Set(lockedFacts.map((fact) => fact.statement))];
  const bustFactors = options.draft.bustFactors.map((factor) => ({
    text: factor.text,
    factRefs: factor.factRefs
  }));
  if (lockedFacts.length > 0) {
    bustFactors.push({
      text: lockedStatements.join(" "),
      factRefs: lockedFacts.map((fact) => fact.id)
    });
  }
  return ForecastBriefSchema.parse({
    schemaVersion: FORECAST_BRIEF_SCHEMA_VERSION,
    spotId: options.bundle.input.spotId,
    localDate: options.bundle.input.localDate,
    revision: options.revision,
    inputFingerprint: options.bundle.inputFingerprint,
    headline: frame.headline,
    setup: options.draft.summary.text,
    picks: options.draft.picks.map((pick) => ({
      windowId: pick.windowId,
      label: forecastBriefWindowLabel(options.bundle, pick.windowId),
      why: pick.why.text,
      tradeoff: pick.tradeoff.text,
      factRefs: [...new Set([...pick.why.factRefs, ...pick.tradeoff.factRefs])]
    })),
    bustFactors,
    lesson: options.draft.lesson,
    provider: "google",
    modelId: FORECAST_BRIEF_MODEL_ID,
    promptVersion: FORECAST_BRIEF_PROMPT_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString()
  });
}

function firstFact(bundle: ForecastFactBundle, kinds: ForecastFact["kind"][]): ForecastFact {
  return (
    bundle.facts.find((fact) => kinds.includes(fact.kind)) ??
    bundle.facts.find((fact) => fact.id === "spot:identity") ??
    bundle.facts[0]!
  );
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function factsForWindow(
  bundle: ForecastFactBundle,
  windowId: string
): ForecastFact[] {
  return bundle.facts.filter((fact) => fact.windowId === windowId);
}

function fallbackWhy(
  bundle: ForecastFactBundle,
  window: ForecastBriefWindowInput,
  primary: boolean
): { text: string; factRefs: string[] } {
  const facts = factsForWindow(bundle, window.windowId);
  const condition = facts.find((fact) => fact.kind === "condition") ?? firstFact(bundle, ["condition"]);
  const wind = facts.find((fact) => fact.kind === "wind");
  if (window.windRelation === "offshore" && wind) {
    return {
      text: primary
        ? `${capitalize(window.surfaceCondition)} surface conditions and offshore wind support the leading daylight option.`
        : `${capitalize(window.surfaceCondition)} surface conditions and offshore wind keep this alternate worth comparing.`,
      factRefs: [condition.id, wind.id]
    };
  }
  return {
    text: primary
      ? `${capitalize(window.surfaceCondition)} surface conditions put this daylight window at the front of the current call.`
      : `${capitalize(window.surfaceCondition)} surface conditions keep this alternate daylight window worth comparing.`,
    factRefs: [condition.id]
  };
}

function fallbackTradeoff(
  bundle: ForecastFactBundle,
  window: ForecastBriefWindowInput,
  primary: boolean
): { text: string; factRefs: string[] } {
  const facts = factsForWindow(bundle, window.windowId);
  const confidence = facts.find((fact) => fact.kind === "confidence");
  if (window.confidenceBand !== "high" && confidence) {
    return {
      text: primary
        ? `${capitalize(window.confidenceBand)} confidence leaves room for the beach to differ from the forecast.`
        : `${capitalize(window.confidenceBand)} confidence also makes this alternate vulnerable to local variation.`,
      factRefs: [confidence.id]
    };
  }
  const freshness = facts.find((fact) => fact.id.endsWith(":freshness"));
  if (
    freshness &&
    (window.requiredSourceStatus === "stale" || window.requiredSourceStatus === "missing")
  ) {
    return {
      text: primary
        ? `A ${window.requiredSourceStatus} required source limits confidence in this window.`
        : `This alternate is also limited by a ${window.requiredSourceStatus} required source.`,
      factRefs: [freshness.id]
    };
  }
  const wind = facts.find((fact) => fact.kind === "wind");
  if (
    wind &&
    (window.windRelation === "onshore" || window.windRelation === "cross-shore")
  ) {
    return {
      text: primary
        ? `${capitalize(window.windRelation)} wind may limit surface quality at this shoreline.`
        : `This alternate still carries a ${window.windRelation} wind tradeoff at the shoreline.`,
      factRefs: [wind.id]
    };
  }
  const tide = facts.find((fact) => fact.kind === "tide");
  if (tide && window.tideFt !== null) {
    return {
      text: primary
        ? `The tide is ${window.tideTrend ?? "unknown"}, but Surf has not validated a spot-specific tide preference here.`
        : `Tide is ${window.tideTrend ?? "unknown"}; it remains context because Surf has no validated preference for this spot.`,
      factRefs: [tide.id]
    };
  }
  const context = facts.find((fact) => fact.role === "context") ?? firstFact(bundle, ["source", "wave"]);
  return {
    text: primary
      ? "Source health and local variation still leave uncertainty around the call."
      : "The alternate remains exposed to the same source and local uncertainty.",
    factRefs: [context.id]
  };
}

export function buildDeterministicForecastBrief(
  bundle: ForecastFactBundle,
  revision = 1
): ForecastBrief {
  const picks = bundle.input.recommendationWindowIds.map((windowId, index) => {
    const window = bundle.input.windows.find((candidate) => candidate.windowId === windowId);
    if (!window) throw new Error(`Unknown deterministic recommendation window: ${windowId}`);
    const why = fallbackWhy(bundle, window, index === 0);
    const tradeoff = fallbackTradeoff(bundle, window, index === 0);
    return {
      windowId,
      label: forecastBriefWindowLabel(bundle, windowId),
      why: why.text,
      tradeoff: tradeoff.text,
      factRefs: [...new Set([...why.factRefs, ...tradeoff.factRefs])]
    };
  });
  const frame = forecastBriefFrame(bundle);
  const firstWindowId = bundle.input.recommendationWindowIds[0];
  const firstWindow = firstWindowId
    ? bundle.input.windows.find((window) => window.windowId === firstWindowId)
    : undefined;
  const firstWindowFacts = firstWindowId ? factsForWindow(bundle, firstWindowId) : [];
  const firstTradeoff = firstWindowFacts.find((fact) => fact.role === "tradeoff");
  const lockedFacts = forecastBriefLockedFacts(bundle);
  const bustFactors = firstTradeoff
    ? [{ text: firstTradeoff.statement, factRefs: [firstTradeoff.id] }]
    : [];
  if (lockedFacts.length > 0) {
    bustFactors.push({
      text: [...new Set(lockedFacts.map((fact) => fact.statement))].join(" "),
      factRefs: lockedFacts.map((fact) => fact.id)
    });
  }
  const tideFact = firstWindowFacts.find((fact) => fact.kind === "tide");
  const windFact = firstWindowFacts.find((fact) => fact.kind === "wind");
  const lesson = tideFact && firstWindow?.tideFt !== null
    ? {
        topic: "Tide is context here",
        text: "A rising or falling tide is useful context, but Surf does not yet use it as a quality signal at this spot.",
        factRefs: [tideFact.id]
      }
    : {
        topic: "Wind meets each shoreline differently",
        text: "Wind direction becomes useful only after relating it to the orientation of this shoreline.",
        factRefs: [
          (windFact ?? firstFact(bundle, ["wind", "wave", "confidence", "source"])).id
        ]
      };
  const setup = firstWindow
    ? `${capitalize(firstWindow.surfaceCondition)} surface conditions and ${firstWindow.windRelation} wind shape the call; confidence and source health set the guardrails.`
    : frame.setup;
  return ForecastBriefSchema.parse({
    schemaVersion: FORECAST_BRIEF_SCHEMA_VERSION,
    spotId: bundle.input.spotId,
    localDate: bundle.input.localDate,
    revision: Math.max(1, revision),
    inputFingerprint: bundle.inputFingerprint,
    headline: frame.headline,
    setup,
    picks,
    bustFactors,
    lesson,
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
