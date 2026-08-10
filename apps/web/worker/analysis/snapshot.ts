import type { NarrativeJob } from "@surf/narrative-contracts";
import { assertNarrativeJobSize, NarrativeJobSchema } from "@surf/narrative-contracts";
import type { ForecastFact, ForecastFactBundle, ForecastBriefWindowInput } from "../brief/types";
import { sha256Json } from "./hash";
import {
  SURF_ANALYSIS_PROMPT_VERSION,
  SURF_ANALYSIS_RESULT_TARGET,
  SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
  SurfAnalysisValidationSnapshotSchema,
  type SurfAnalysisBlockName,
  type SurfAnalysisValidationSnapshot,
  type SurfAnalysisValueSlot
} from "./types";

function clock(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function span(startAt: string, endAt: string, timeZone: string): string {
  const start = clock(startAt, timeZone);
  const end = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(endAt));
  return `${start}–${end}`;
}

function cardinal(value: number | null): string {
  if (value === null) return "unknown-direction";
  const sectors = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return sectors[Math.round((((value % 360) + 360) % 360) / 45) % 8]!;
}

function findFact(
  bundle: ForecastFactBundle,
  windowId: string | undefined,
  kind: ForecastFact["kind"]
): ForecastFact {
  const expectedWindowId = windowId ?? null;
  const fact = bundle.facts.find((candidate) => candidate.windowId === expectedWindowId && candidate.kind === kind);
  if (!fact) throw new Error(`Analysis fact ${kind} is unavailable for ${windowId ?? "global"}`);
  return fact;
}

function recommendationSpan(
  bundle: ForecastFactBundle,
  windowId: string | undefined
): string | null {
  if (!windowId) return null;
  const recommendation = bundle.input.recommendations.find(
    (candidate) => candidate.representativeWindowId === windowId
  );
  return recommendation
    ? span(recommendation.startAt, recommendation.endAt, bundle.input.timezone)
    : clock(windowId, bundle.input.timezone);
}

function windowFor(bundle: ForecastFactBundle, windowId: string | undefined): ForecastBriefWindowInput {
  const window = bundle.input.windows.find((candidate) => candidate.windowId === windowId);
  if (!window) throw new Error(`Analysis recommendation window is unavailable: ${windowId ?? "missing"}`);
  return window;
}

function slot(
  id: string,
  value: string,
  description: string,
  block: SurfAnalysisBlockName,
  factRefs: string[]
): SurfAnalysisValueSlot {
  return { id, value, description, block, factRefs, required: true };
}

function defaultDeadline(bundle: ForecastFactBundle): string {
  const recommendationEnd = bundle.input.recommendations.reduce<string | null>(
    (latest, recommendation) =>
      latest === null || new Date(recommendation.endAt).getTime() > new Date(latest).getTime()
        ? recommendation.endAt
        : latest,
    null
  );
  const base = recommendationEnd ?? bundle.input.generatedAt;
  return new Date(new Date(base).getTime() + 3 * 60 * 60 * 1_000).toISOString();
}

function swellLabel(window: ForecastBriefWindowInput): string {
  return window.peakPeriodSec === null
    ? `${cardinal(window.primaryDirectionDeg)} swell with period unavailable`
    : `${window.peakPeriodSec.toFixed(0)} s ${cardinal(window.primaryDirectionDeg)} swell`;
}

function surfEvolution(
  windows: ForecastBriefWindowInput[]
): string {
  const early = windows[0]!;
  const late = windows.at(-1)!;
  const earlyLabel = early.surfSizeLabel ?? "Size unavailable";
  const lateLabel = late.surfSizeLabel ?? "Size unavailable";
  const labels = windows.map((window) => window.surfSizeLabel ?? "Size unavailable");
  if (labels.every((label) => label === earlyLabel)) {
    return `holding near ${earlyLabel} through daylight`;
  }
  const sizes = windows.map((window) => window.surfSizeFt);
  if (sizes.every((value): value is number => value !== null)) {
    const nondecreasing = sizes.every((value, index) => index === 0 || value >= sizes[index - 1]!);
    const nonincreasing = sizes.every((value, index) => index === 0 || value <= sizes[index - 1]!);
    if (nondecreasing || nonincreasing) {
      const direction = nondecreasing ? "building" : "easing";
      return `${direction} from ${earlyLabel} early to ${lateLabel} late`;
    }
    const minimumIndex = sizes.indexOf(Math.min(...sizes));
    const maximumIndex = sizes.indexOf(Math.max(...sizes));
    if (earlyLabel === lateLabel) {
      return `varying between ${labels[minimumIndex]} and ${labels[maximumIndex]} before returning to ${lateLabel} late`;
    }
    return `varying between ${labels[minimumIndex]} and ${labels[maximumIndex]} through daylight`;
  }
  if (early.surfSizeFt !== null && late.surfSizeFt !== null) {
    const direction = late.surfSizeFt > early.surfSizeFt ? "building" : "easing";
    return `${direction} from ${earlyLabel} early to ${lateLabel} late`;
  }
  return `${earlyLabel} early and ${lateLabel} late`;
}

function swellEvolution(
  windows: ForecastBriefWindowInput[]
): string {
  const early = windows[0]!;
  const late = windows.at(-1)!;
  const earlyLabel = swellLabel(early);
  const lateLabel = swellLabel(late);
  const labels = windows.map(swellLabel);
  if (labels.every((label) => label === earlyLabel)) {
    return `holding near ${earlyLabel} through daylight`;
  }
  const periods = windows.map((window) => window.peakPeriodSec);
  const sameDirection = windows.every(
    (window) => window.primaryDirectionDeg === early.primaryDirectionDeg
  );
  if (sameDirection && periods.every((value): value is number => value !== null)) {
    const nondecreasing = periods.every(
      (value, index) => index === 0 || value >= periods[index - 1]!
    );
    const nonincreasing = periods.every(
      (value, index) => index === 0 || value <= periods[index - 1]!
    );
    if (nondecreasing || nonincreasing) {
      const direction = nondecreasing ? "lengthening" : "shortening";
      return `${direction} from ${earlyLabel} early to ${lateLabel} late`;
    }
    const minimumIndex = periods.indexOf(Math.min(...periods));
    const maximumIndex = periods.indexOf(Math.max(...periods));
    if (earlyLabel === lateLabel) {
      return `varying between ${labels[minimumIndex]} and ${labels[maximumIndex]} before returning to ${lateLabel} late`;
    }
    return `varying between ${labels[minimumIndex]} and ${labels[maximumIndex]} through daylight`;
  }
  if (
    early.primaryDirectionDeg === late.primaryDirectionDeg &&
    early.peakPeriodSec !== null &&
    late.peakPeriodSec !== null
  ) {
    const direction = late.peakPeriodSec > early.peakPeriodSec ? "lengthening" : "shortening";
    return `${direction} from ${earlyLabel} early to ${lateLabel} late`;
  }
  if (earlyLabel === lateLabel) {
    return `varying away from ${earlyLabel} before returning to that swell late`;
  }
  return `shifting from ${earlyLabel} early to ${lateLabel} late`;
}

function selectedTideTiming(bundle: ForecastFactBundle, primaryAt: string): {
  value: string;
  factId: string;
} {
  const target = new Date(primaryAt).getTime();
  const nearest = bundle.input.tideEvents
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) =>
        Math.abs(new Date(left.event.eventAt).getTime() - target) -
        Math.abs(new Date(right.event.eventAt).getTime() - target)
    )[0];
  if (!nearest) {
    return {
      value: "tide timing is unavailable",
      factId: findFact(bundle, primaryAt, "tide").id
    };
  }
  return {
    value: `${nearest.event.type} tide at ${clock(nearest.event.eventAt, bundle.input.timezone)} (${nearest.event.heightFtMllw.toFixed(1)} ft MLLW)`,
    factId: `tide:event:e${nearest.index}`
  };
}

export async function buildSurfAnalysisSnapshot(
  bundle: ForecastFactBundle
): Promise<SurfAnalysisValidationSnapshot> {
  const primaryId = bundle.input.recommendationWindowIds[0];
  if (!primaryId) throw new Error("Analysis requires a deterministic primary recommendation");
  const backupId = bundle.input.recommendationWindowIds[1];
  const primary = windowFor(bundle, primaryId);
  const daylightWindows = bundle.input.windows.filter((window) => window.isDaylight);
  const evolutionWindows = daylightWindows.length > 0 ? daylightWindows : bundle.input.windows;
  const primaryWave = findFact(bundle, primaryId, "wave");
  const primaryWind = findFact(bundle, primaryId, "wind");
  const primaryCondition = findFact(bundle, primaryId, "condition");
  const primaryConfidence = findFact(bundle, primaryId, "confidence");
  const primaryRecommendation = findFact(bundle, primaryId, "recommendation");
  const backupRecommendation = backupId
    ? findFact(bundle, backupId, "recommendation")
    : primaryRecommendation;
  const bustKindPriority: ForecastFact["kind"][] = [
    "caveat",
    "wind",
    "source",
    "condition",
    "confidence"
  ];
  const selectedBust = bustKindPriority
    .flatMap((kind) =>
      bundle.facts.filter(
        (fact) => fact.windowId === primaryId && fact.role === "tradeoff" && fact.kind === kind
      )
    )[0];
  const baselineUncertaintyFact: ForecastFact | null = selectedBust
    ? null
    : {
        id: "uncertainty:modeled_breaking_calibration",
        kind: "caveat",
        role: "context",
        statement: "Actual breaking surf can differ from the modeled guidance at this spot.",
        windowId: null,
        material: true
      };
  const bust = selectedBust ?? baselineUncertaintyFact!;
  const spotFact = findFact(bundle, undefined, "spot");
  const evolutionWaveFacts = evolutionWindows.map((window) =>
    findFact(bundle, window.windowId, "wave")
  );
  const surfSize = primary.surfSizeLabel ?? "Size unavailable";
  const sizeEvolution = surfEvolution(evolutionWindows.length > 0 ? evolutionWindows : [primary]);
  const daySwellEvolution = swellEvolution(
    evolutionWindows.length > 0 ? evolutionWindows : [primary]
  );
  const wind = primary.windSpeedKt === null
    ? `${primary.windRelation} wind with ${primary.surfaceCondition} surface`
    : `${primary.windSpeedKt.toFixed(0)} kt ${primary.windRelation} wind with ${primary.surfaceCondition} surface`;
  const tideTiming = selectedTideTiming(bundle, primaryId);
  const primarySession = recommendationSpan(bundle, primaryId)!;
  const headlineCall = `${bundle.input.spotName}: ${primarySession} is the best window`;
  const backupSession = recommendationSpan(bundle, backupId) ??
    "no separate backup window cleared the planning threshold";
  const noBackupFact: ForecastFact | null = backupId
    ? null
    : {
        id: "recommendation:none_backup",
        kind: "recommendation",
        role: "context",
        statement: "No second recommendation met the daylight planning threshold.",
        windowId: null,
        material: true
      };
  const slots = [
    slot("headline_call", headlineCall, "complete headline naming the code-owned best window; use alone", "headline", [spotFact.id, primaryRecommendation.id]),
    slot("day_surf_evolution", sizeEvolution, "surf evolution predicate complement; write 'surf is' or 'surf should be' immediately before it", "setup", [...new Set(evolutionWaveFacts.map((fact) => fact.id))]),
    slot("day_swell_evolution", daySwellEvolution, "swell evolution predicate complement; write 'swell is' or 'swell should be' immediately before it", "setup", [...new Set(evolutionWaveFacts.map((fact) => fact.id))]),
    slot("primary_session", primarySession, "the code-owned best forecast window", "plan", [primaryRecommendation.id]),
    slot("primary_surf_size", surfSize, "surf-size label for the best window; place before the noun 'surf'", "plan", [primaryWave.id]),
    slot("primary_wind_surface", wind, "complete wind and surface phrase for the best window", "plan", [primaryWind.id, primaryCondition.id]),
    slot("primary_tide_timing", tideTiming.value, "complete tide-timing phrase for the best window", "plan", [tideTiming.factId]),
    slot("backup_session", backupSession, "backup window or code-owned statement that none qualified", "plan", [noBackupFact?.id ?? backupRecommendation.id]),
    slot("forecast_confidence", `${primary.confidenceBand} confidence`, "confidence-band phrase, such as 'high confidence'; use before the bust factor", "confidence", [primaryConfidence.id]),
    slot("bust_factor", bust.statement, "complete final uncertainty sentence; make this the last token with no text or punctuation after it", "confidence", [bust.id])
  ];
  const facts = [
    ...bundle.facts.filter((fact) => fact.role !== "locked"),
    ...(noBackupFact ? [noBackupFact] : []),
    ...(baselineUncertaintyFact ? [baselineUncertaintyFact] : [])
  ];
  const refsForBlock = (block: SurfAnalysisBlockName) => [
    ...new Set(
      slots.filter((candidate) => candidate.block === block).flatMap((candidate) => candidate.factRefs)
    )
  ];
  const refsByBlock = {
    headline: refsForBlock("headline"),
    setup: refsForBlock("setup"),
    plan: refsForBlock("plan"),
    confidence: refsForBlock("confidence")
  };
  const relevantFactIds = new Set([
    ...Object.values(refsByBlock).flat(),
    ...slots.flatMap((candidate) => candidate.factRefs)
  ]);
  const relevantFacts = facts
    .filter((fact) => relevantFactIds.has(fact.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const factFingerprint = await sha256Json({
    domain: "surf",
    entityId: bundle.input.spotId,
    localDate: bundle.input.localDate,
    recommendationWindowIds: bundle.input.recommendationWindowIds,
    slots: slots.map(({ id, value, block, factRefs }) => ({ id, value, block, factRefs })),
    facts: relevantFacts.map(({ id, kind, role, statement, windowId }) => ({
      id,
      kind,
      role,
      statement,
      windowId
    }))
  });
  return SurfAnalysisValidationSnapshotSchema.parse({
    schemaVersion: 1,
    spotId: bundle.input.spotId,
    spotName: bundle.input.spotName,
    localDate: bundle.input.localDate,
    factFingerprint,
    materialFingerprint: bundle.materialFingerprint,
    deadlineAt: defaultDeadline(bundle),
    recommendationWindowIds: bundle.input.recommendationWindowIds,
    facts: relevantFacts,
    slots,
    allowedFactRefs: refsByBlock
  });
}

export const SURF_ANALYSIS_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["paragraphs"],
  properties: {
    paragraphs: {
      type: "object",
      additionalProperties: false,
      required: ["setup", "plan", "confidence"],
      properties: {
        setup: { $ref: "#/$defs/setupBlock" },
        plan: { $ref: "#/$defs/planBlock" },
        confidence: { $ref: "#/$defs/confidenceBlock" }
      }
    }
  },
  $defs: {
    setupBlock: {
      type: "object",
      additionalProperties: false,
      required: ["template"],
      properties: {
        template: { type: "string", minLength: 60, maxLength: 1_000 }
      }
    },
    planBlock: {
      type: "object",
      additionalProperties: false,
      required: ["template"],
      properties: {
        template: { type: "string", minLength: 145, maxLength: 1_000 }
      }
    },
    confidenceBlock: {
      type: "object",
      additionalProperties: false,
      required: ["template"],
      properties: {
        template: { type: "string", minLength: 70, maxLength: 1_000 }
      }
    }
  }
};

const SURF_ANALYSIS_FEW_SHOT_OUTPUT = JSON.stringify({
  paragraphs: {
    setup: {
      template:
        "Surf is {{day_surf_evolution}}; swell is {{day_swell_evolution}}."
    },
    plan: {
      template:
        "The best window is {{primary_session}}, with {{primary_surf_size}} surf, {{primary_wind_surface}}, and {{primary_tide_timing}}. The alternate window is {{backup_session}}."
    },
    confidence: {
      template:
        "This is a {{forecast_confidence}} call. The main uncertainty remains: {{bust_factor}}"
    }
  }
});

function promptFor(snapshot: SurfAnalysisValidationSnapshot): NarrativeJob["inference"] {
  const slots = snapshot.slots.map(({ id, description, block }) => ({
    token: `{{${id}}}`,
    description,
    block
  }));
  return {
    messages: [
      {
        role: "system",
        content:
          "Write exactly three compact local surf-forecaster paragraphs as JSON template strings named setup, plan, and confidence. Do not return a headline or fact IDs; code adds the exact headline and derives provenance. The code-owned value tokens carry every factual claim: use every paragraph token exactly once, only in its assigned block, and never restate or embellish a token's value. Setup may be one or two sentences: use a plain surf topic immediately before {{day_surf_evolution}}, then a plain swell topic immediately before {{day_swell_evolution}}. Do not add time-of-day wording because the slots already contain the evolution horizon. Plan must be exactly two sentences. Its first sentence must clearly recommend {{primary_session}} as the best or leading window and include {{primary_surf_size}} surf, {{primary_wind_surface}}, and {{primary_tide_timing}}. Its later sentence must neutrally name {{backup_session}} as the backup or alternate; never negate or down-rank the best window, and never promote the backup. Confidence may be one or two sentences: frame {{forecast_confidence}} as confidence in the call, then introduce the complete {{bust_factor}} sentence with an uncertainty or risk phrase followed by a colon. Finish with {{bust_factor}} as the final token, with no punctuation or words after it; never put 'is' directly before that token. Use concise everyday forecast language and vary only connective wording around the supplied surf, swell, window, tide, call, confidence, and uncertainty topics. Do not introduce any independent subject such as weather, rain, beach safety, or water risk. Never author measurements, times, directions, conditions, ratings, trends, confidence bands, hazards, links, directives, or extra factual claims. Avoid implementation words such as deterministic, schema, source health, and guardrail."
      },
      {
        role: "user",
        content:
          "Show one valid shape using the supplied placeholder names. Keep all factual substance inside placeholders."
      },
      {
        role: "assistant",
        content: SURF_ANALYSIS_FEW_SHOT_OUTPUT
      },
      {
        role: "user",
        content: JSON.stringify({
          spot: snapshot.spotName,
          date: snapshot.localDate,
          valueSlots: slots
        })
      }
    ],
    responseSchema: SURF_ANALYSIS_RESPONSE_JSON_SCHEMA,
    maxOutputTokens: 1_200,
    temperature: 0.35
  };
}

export async function buildSurfNarrativeJob(
  snapshot: SurfAnalysisValidationSnapshot
): Promise<NarrativeJob> {
  const inference = promptFor(snapshot);
  const generationFingerprint = await sha256Json({
    domain: "surf",
    entity: { id: snapshot.spotId, localDate: snapshot.localDate },
    factFingerprint: snapshot.factFingerprint,
    promptVersion: SURF_ANALYSIS_PROMPT_VERSION,
    outputSchemaVersion: SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
    capability: {
      protocol: "openai-chat-completions",
      structuredOutput: "json-schema"
    }
  });
  return assertNarrativeJobSize(
    NarrativeJobSchema.parse({
      schemaVersion: 1,
      jobId: `narrative.${generationFingerprint}`,
      domain: "surf",
      entity: { id: snapshot.spotId, localDate: snapshot.localDate },
      factFingerprint: snapshot.factFingerprint,
      materialFingerprint: snapshot.materialFingerprint,
      generationFingerprint,
      promptVersion: SURF_ANALYSIS_PROMPT_VERSION,
      outputSchemaVersion: SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
      deadlineAt: snapshot.deadlineAt,
      capability: {
        protocol: "openai-chat-completions",
        structuredOutput: "json-schema"
      },
      result: {
        target: SURF_ANALYSIS_RESULT_TARGET,
        submissionId: `submission.${generationFingerprint}`
      },
      inference
    })
  );
}
