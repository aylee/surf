import { buildForecastFactBundle } from "./facts";
import { briefForecastFixture } from "./test-helpers";
import type {
  ForecastBriefDraft,
  ForecastFact,
  ForecastFactBundle
} from "./types";

export type ForecastBriefQualityFixture = {
  bundle: ForecastFactBundle;
  draft: ForecastBriefDraft;
};

function factsForWindow(
  bundle: ForecastFactBundle,
  windowId: string,
  predicate: (fact: ForecastFact) => boolean
): ForecastFact[] {
  return bundle.facts.filter(
    (fact) => fact.windowId === windowId && fact.role !== "locked" && predicate(fact)
  );
}

function distinctKindIds(facts: ForecastFact[], maximum = 3): string[] {
  const seen = new Set<ForecastFact["kind"]>();
  const ids: string[] = [];
  for (const fact of facts) {
    if (seen.has(fact.kind)) continue;
    seen.add(fact.kind);
    ids.push(fact.id);
    if (ids.length === maximum) break;
  }
  return ids;
}

function naturalDraftFor(bundle: ForecastFactBundle): ForecastBriefDraft {
  const recommended = bundle.input.recommendationWindowIds;
  const firstWindowId = recommended[0]!;
  const firstFacts = factsForWindow(bundle, firstWindowId, () => true);
  const summarySupport = firstFacts.find(
    (fact) => fact.role === "support" && fact.kind !== "recommendation"
  )!;
  const summaryTradeoff =
    firstFacts.find((fact) => fact.role === "tradeoff" && fact.kind === "confidence") ??
    firstFacts.find((fact) => fact.role === "tradeoff")!;
  const summaryContext = firstFacts.find((fact) => fact.role === "context")!;

  const picks = recommended.map((windowId, index) => {
    const facts = factsForWindow(bundle, windowId, () => true);
    const support = facts.filter(
      (fact) => fact.role === "support" && fact.kind !== "recommendation"
    );
    const tradeoffs = facts
      .filter((fact) => fact.role === "tradeoff")
      .sort((left, right) => Number(right.kind === "confidence") - Number(left.kind === "confidence"));
    const context = facts.filter((fact) => fact.role === "context");
    const whyRefs = distinctKindIds(support.length > 0 ? support : facts.filter((fact) => fact.role === "support"), 2);
    const tradeoffRefs = distinctKindIds(tradeoffs.length > 0 ? tradeoffs : context, 2);
    const confidenceTradeoff = tradeoffs[0]?.kind === "confidence";
    return {
      windowId,
      why: {
        text:
          index === 0
            ? "Cleaner surface signals make the earlier daylight window the most promising option."
            : "Favorable surface conditions keep the later daylight window worth comparing.",
        factRefs: whyRefs
      },
      tradeoff: {
        text:
          confidenceTradeoff
            ? index === 0
              ? "Forecast uncertainty leaves room for the beach to differ from the expected setup."
              : "The uncertain forecast read may not match the local shape later in the day."
            : index === 0
              ? "A wind shift could weaken the favorable surface read before the session."
              : "Changing wind could erode the favorable surface signal later in the day.",
        factRefs: tradeoffRefs
      }
    };
  });

  const globalTradeoffs = bundle.facts.filter(
    (fact) =>
      fact.role === "tradeoff" &&
      (fact.windowId === null || recommended.includes(fact.windowId))
  );
  const globalTradeoff =
    globalTradeoffs.find((fact) => fact.kind === "confidence") ?? globalTradeoffs[0]!;
  const lessonFacts = firstFacts.filter(
    (fact) => ["wave", "wind"].includes(fact.kind) && fact.id !== globalTradeoff.id
  );

  return {
    summary: {
      text:
        summaryTradeoff.kind === "confidence"
          ? "Favorable surface signals lead the day, while uncertainty keeps the recommendation appropriately cautious."
          : "Favorable surface signals lead the day, while a possible wind shift keeps the call cautious.",
      factRefs: distinctKindIds([summarySupport, summaryTradeoff, summaryContext], 3)
    },
    picks,
    bustFactors: [
      {
        text:
          globalTradeoff.kind === "confidence"
            ? "Forecast uncertainty leaves room for the expected call to miss at the beach."
            : "A wind shift could erase the favorable surface read before it develops.",
        factRefs: [globalTradeoff.id]
      }
    ],
    lesson: {
      topic: "Modeled wave state",
      text:
        "Read the modeled wave state separately from the surface texture shaped by local wind.",
      factRefs: distinctKindIds(lessonFacts, 2)
    }
  };
}

export async function directModelQualityFixture(): Promise<ForecastBriefQualityFixture> {
  const bundle = await buildForecastFactBundle(briefForecastFixture());
  return { bundle, draft: naturalDraftFor(bundle) };
}

export async function nwsFallbackQualityFixture(): Promise<ForecastBriefQualityFixture> {
  const forecast = briefForecastFixture();
  forecast.spot = {
    ...forecast.spot,
    id: "bolinas",
    name: "Bolinas — Wharf/Brighton"
  };
  forecast.windows = forecast.windows.map((window) => ({
    ...window,
    confidence: Math.min(window.confidence, 55),
    waveState: window.waveState
      ? {
          ...window.waveState,
          semantics: "nws_fallback" as const,
          calibrationStatus: "cold_start_uncalibrated" as const
        }
      : null
  }));
  const bundle = await buildForecastFactBundle(forecast);
  return { bundle, draft: naturalDraftFor(bundle) };
}

export function withImplementationPlumbing(
  fixture: ForecastBriefQualityFixture
): ForecastBriefQualityFixture {
  const draft = structuredClone(fixture.draft);
  draft.summary.text =
    "Deterministic recommendation uses quality band excellent and confidence band medium.";
  return { bundle: fixture.bundle, draft };
}

export function withIrrelevantRecommendationEvidence(
  fixture: ForecastBriefQualityFixture
): ForecastBriefQualityFixture {
  const draft = structuredClone(fixture.draft);
  const windowId = draft.picks[0]!.windowId;
  const recommendation = fixture.bundle.facts.find(
    (fact) => fact.kind === "recommendation" && fact.windowId === windowId
  )!;
  draft.picks[0]!.why = {
    text: "This daylight window ranks first among the available options for the day.",
    factRefs: [recommendation.id]
  };
  return { bundle: fixture.bundle, draft };
}

export function withRepeatedPickProse(
  fixture: ForecastBriefQualityFixture
): ForecastBriefQualityFixture {
  const draft = structuredClone(fixture.draft);
  if (draft.picks.length < 2) throw new Error("Repetition fixture requires two picks");
  draft.picks[1]!.why.text = draft.picks[0]!.why.text;
  return { bundle: fixture.bundle, draft };
}

export function withSwappedRoles(
  fixture: ForecastBriefQualityFixture
): ForecastBriefQualityFixture {
  const draft = structuredClone(fixture.draft);
  const pick = draft.picks[0]!;
  const whyRefs = pick.why.factRefs;
  pick.why.factRefs = pick.tradeoff.factRefs;
  pick.tradeoff.factRefs = whyRefs;
  return { bundle: fixture.bundle, draft };
}

export function withLockedModelCitation(
  fixture: ForecastBriefQualityFixture
): ForecastBriefQualityFixture {
  const draft = structuredClone(fixture.draft);
  const locked = fixture.bundle.facts.find((fact) => fact.role === "locked")!;
  draft.lesson = {
    topic: "Measurement meaning",
    text:
      "The displayed wave state describes a model input rather than a measured breaking wave.",
    factRefs: [locked.id]
  };
  return { bundle: fixture.bundle, draft };
}
