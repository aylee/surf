import type { NarrativeJob } from "@surf/narrative-contracts";
import {
  assertNarrativeJobSize,
  JsonObjectSchema,
  NarrativeJobSchema
} from "@surf/narrative-contracts";
import type { ForecastFact, ForecastFactBundle, ForecastBriefWindowInput } from "../brief/types";
import { sha256Json } from "./hash";
import {
  SURF_ANALYSIS_PROMPT_VERSION,
  SURF_ANALYSIS_RESULT_TARGET,
  SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
  SurfAnalysisEditorialCardSchema,
  SurfAnalysisValidationSnapshotSchema,
  type SurfAnalysisCardPlacement,
  type SurfAnalysisEditorialCard,
  type SurfAnalysisClaimName,
  type SurfAnalysisDomain,
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
  const sectors = [
    "north",
    "northeast",
    "east",
    "southeast",
    "south",
    "southwest",
    "west",
    "northwest"
  ];
  return sectors[Math.round((((value % 360) + 360) % 360) / 45) % 8]!;
}

function findFact(
  bundle: ForecastFactBundle,
  windowId: string | undefined,
  kind: ForecastFact["kind"]
): ForecastFact {
  const expectedWindowId = windowId ?? null;
  const fact = bundle.facts.find(
    (candidate) => candidate.windowId === expectedWindowId && candidate.kind === kind
  );
  if (!fact) throw new Error(`Analysis fact ${kind} is unavailable for ${windowId ?? "global"}`);
  return fact;
}

function recommendationFor(
  bundle: ForecastFactBundle,
  windowId: string | undefined
): ForecastFactBundle["input"]["recommendations"][number] | null {
  if (!windowId) return null;
  return (
    bundle.input.recommendations.find(
      (candidate) => candidate.representativeWindowId === windowId
    ) ?? null
  );
}

function recommendationSpan(
  bundle: ForecastFactBundle,
  windowId: string | undefined
): string | null {
  if (!windowId) return null;
  const recommendation = recommendationFor(bundle, windowId);
  return recommendation
    ? span(recommendation.startAt, recommendation.endAt, bundle.input.timezone)
    : clock(windowId, bundle.input.timezone);
}

function windowFor(
  bundle: ForecastFactBundle,
  windowId: string | undefined
): ForecastBriefWindowInput {
  const window = bundle.input.windows.find((candidate) => candidate.windowId === windowId);
  if (!window) {
    throw new Error(`Analysis recommendation window is unavailable: ${windowId ?? "missing"}`);
  }
  return window;
}

type SlotOptions = {
  id: string;
  value: string;
  description: string;
  claim: SurfAnalysisClaimName;
  factRefs: string[];
  domains: SurfAnalysisDomain[];
  syntax: SurfAnalysisValueSlot["syntax"];
  required?: boolean;
};

function slot(options: SlotOptions): SurfAnalysisValueSlot {
  return {
    ...options,
    factRefs: [...new Set(options.factRefs)],
    authorship: "code",
    required: options.required ?? true
  };
}

function renderTemplate(
  template: string,
  slots: Map<string, SurfAnalysisValueSlot>
): string {
  const rendered = template.replace(/\{\{([a-z][a-z_]*)\}\}/g, (_token, id: string) => {
    const value = slots.get(id)?.value;
    if (!value) throw new Error(`Analysis card references unknown value slot ${id}`);
    return value;
  });
  if (/[{}]/.test(rendered)) throw new Error("Analysis card has a malformed value slot");
  return rendered.replace(/\s+/g, " ").trim();
}

function editorialCard(options: {
  id: string;
  placement: SurfAnalysisCardPlacement;
  stance: SurfAnalysisEditorialCard["stance"];
  semanticKey: string;
  windowId: string | null;
  template: string;
  factRefs: string[];
  domains: SurfAnalysisDomain[];
  slots: Map<string, SurfAnalysisValueSlot>;
}): SurfAnalysisEditorialCard {
  return SurfAnalysisEditorialCardSchema.parse({
    id: options.id,
    placement: options.placement,
    stance: options.stance,
    semanticKey: options.semanticKey,
    windowId: options.windowId,
    template: options.template,
    preview: renderTemplate(options.template, options.slots),
    factRefs: [...new Set(options.factRefs)],
    domains: [...new Set(options.domains)]
  });
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
  if (window.peakPeriodSec === null && window.primaryDirectionDeg === null) {
    return "swell period and direction unavailable";
  }
  if (window.peakPeriodSec === null) {
    return `${cardinal(window.primaryDirectionDeg)} swell with period unavailable`;
  }
  if (window.primaryDirectionDeg === null) {
    return `${window.peakPeriodSec.toFixed(0)} s swell with direction unavailable`;
  }
  return `${window.peakPeriodSec.toFixed(0)} s ${cardinal(window.primaryDirectionDeg)} swell`;
}

function surfEvolution(windows: ForecastBriefWindowInput[]): string {
  const early = windows[0]!;
  const late = windows.at(-1)!;
  const earlyLabel = early.surfSizeLabel ?? "size unavailable";
  const lateLabel = late.surfSizeLabel ?? "size unavailable";
  const labels = windows.map((window) => window.surfSizeLabel ?? "size unavailable");
  if (labels.every((label) => label === earlyLabel)) {
    return `holding near ${earlyLabel} through daylight`;
  }
  const sizes = windows.map((window) => window.surfSizeFt);
  if (sizes.every((value): value is number => value !== null)) {
    const nondecreasing = sizes.every(
      (value, index) => index === 0 || value >= sizes[index - 1]!
    );
    const nonincreasing = sizes.every(
      (value, index) => index === 0 || value <= sizes[index - 1]!
    );
    if (nondecreasing || nonincreasing) {
      return `${nondecreasing ? "building" : "easing"} from ${earlyLabel} early to ${lateLabel} late`;
    }
    const minimumIndex = sizes.indexOf(Math.min(...sizes));
    const maximumIndex = sizes.indexOf(Math.max(...sizes));
    if (earlyLabel === lateLabel) {
      return `varying between ${labels[minimumIndex]} and ${labels[maximumIndex]} before returning to ${lateLabel} late`;
    }
    return `varying between ${labels[minimumIndex]} and ${labels[maximumIndex]} through daylight`;
  }
  if (early.surfSizeFt !== null && late.surfSizeFt !== null) {
    return `${late.surfSizeFt > early.surfSizeFt ? "building" : "easing"} from ${earlyLabel} early to ${lateLabel} late`;
  }
  return `${earlyLabel} early and ${lateLabel} late`;
}

function swellEvolution(windows: ForecastBriefWindowInput[]): string {
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
      return `${nondecreasing ? "lengthening" : "shortening"} from ${earlyLabel} early to ${lateLabel} late`;
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
    return `${late.peakPeriodSec > early.peakPeriodSec ? "lengthening" : "shortening"} from ${earlyLabel} early to ${lateLabel} late`;
  }
  if (earlyLabel === lateLabel) {
    return `varying away from ${earlyLabel} before returning to that swell late`;
  }
  return `shifting from ${earlyLabel} early to ${lateLabel} late`;
}

function surfaceState(window: ForecastBriefWindowInput): string {
  if (window.surfaceCondition === "unknown") return "unavailable";
  if (window.windRelation === "unknown") {
    return `${window.surfaceCondition}, with wind relationship unavailable`;
  }
  return `${window.surfaceCondition} with ${window.windRelation} wind`;
}

function surfaceEvolution(windows: ForecastBriefWindowInput[]): string {
  const runs = windows.reduce<Array<{ value: string; windows: ForecastBriefWindowInput[] }>>(
    (result, window) => {
      const value = surfaceState(window);
      const last = result.at(-1);
      if (last?.value === value) {
        last.windows.push(window);
      } else {
        result.push({ value, windows: [window] });
      }
      return result;
    },
    []
  );
  if (runs.length === 1) return `${runs[0]!.value} through daylight`;
  if (runs.length === 2) return `${runs[0]!.value} early, becoming ${runs[1]!.value} late`;
  if (runs.length === 3) {
    return `${runs[0]!.value} early, ${runs[1]!.value} around midday, then ${runs[2]!.value} late`;
  }
  return `${runs[0]!.value} early and ${runs.at(-1)!.value} late, with variable conditions between`;
}

function windSurfaceLabel(window: ForecastBriefWindowInput): string {
  const relation = `${window.windRelation} wind`;
  if (window.windSpeedKt === null) {
    return `${relation} and a ${window.surfaceCondition} surface`;
  }
  const gust =
    window.windGustKt !== null && window.windGustKt > window.windSpeedKt
      ? `, gusting ${window.windGustKt.toFixed(0)} kt`
      : "";
  return `${window.windSpeedKt.toFixed(0)} kt ${relation}${gust}, and a ${window.surfaceCondition} surface`;
}

function selectedTideTiming(
  bundle: ForecastFactBundle,
  windowId: string
): { value: string | null; factId: string } {
  const window = windowFor(bundle, windowId);
  const recommendation = recommendationFor(bundle, windowId);
  const startAt = recommendation?.startAt ?? window.validFrom;
  const endAt = recommendation?.endAt ?? window.validTo;
  const target = (new Date(startAt).getTime() + new Date(endAt).getTime()) / 2;
  const nearest = bundle.input.tideEvents
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) =>
        Math.abs(new Date(left.event.eventAt).getTime() - target) -
        Math.abs(new Date(right.event.eventAt).getTime() - target)
    )[0];
  if (nearest) {
    const eventAt = new Date(nearest.event.eventAt).getTime();
    const eventLabel = `${nearest.event.type} tide at ${clock(nearest.event.eventAt, bundle.input.timezone)} (${nearest.event.heightFtMllw.toFixed(1)} ft MLLW)`;
    const value =
      eventAt >= new Date(startAt).getTime() && eventAt <= new Date(endAt).getTime()
        ? `A ${eventLabel} falls inside the window.`
        : eventAt < new Date(startAt).getTime()
          ? `The window follows a ${eventLabel}.`
          : `A ${eventLabel} follows the window.`;
    return {
      value,
      factId: `tide:event:e${nearest.index}`
    };
  }
  if (window.tideFt !== null) {
    const trend =
      window.tideTrend && window.tideTrend !== "unknown"
        ? ` and ${window.tideTrend}`
        : "";
    return {
      value: `Tide is around ${window.tideFt.toFixed(1)} ft MLLW${trend} near ${clock(windowId, bundle.input.timezone)}.`,
      factId: findFact(bundle, windowId, "tide").id
    };
  }
  return {
    value: null,
    factId: findFact(bundle, windowId, "tide").id
  };
}

function windowSlots(
  bundle: ForecastFactBundle,
  windowId: string,
  claim: "primary" | "alternate"
): SurfAnalysisValueSlot[] {
  const window = windowFor(bundle, windowId);
  const prefix = claim === "primary" ? "primary" : "backup";
  const recommendation = findFact(bundle, windowId, "recommendation");
  const wave = findFact(bundle, windowId, "wave");
  const wind = findFact(bundle, windowId, "wind");
  const condition = findFact(bundle, windowId, "condition");
  return [
    slot({
      id: `${prefix}_session`,
      value: recommendationSpan(bundle, windowId)!,
      description:
        claim === "primary"
          ? "the code-owned leading session window"
          : "the code-owned alternate session window",
      claim,
      factRefs: [recommendation.id],
      domains: ["recommendation"],
      syntax: "noun_phrase"
    }),
    slot({
      id: `${prefix}_surf_size`,
      value: window.surfSizeLabel ?? "size unavailable",
      description: "the breaking-surf planning range for this session; use before the noun surf",
      claim,
      factRefs: [wave.id],
      domains: ["wave"],
      syntax: "noun_phrase"
    }),
    slot({
      id: `${prefix}_swell`,
      value: swellLabel(window),
      description: "the dominant modeled swell period and direction for this session",
      claim,
      factRefs: [wave.id],
      domains: ["wave"],
      syntax: "noun_phrase"
    }),
    slot({
      id: `${prefix}_wind_surface`,
      value: windSurfaceLabel(window),
      description: "the wind relationship, speed, gust when material, and surface condition",
      claim,
      factRefs: [wind.id, condition.id],
      domains: ["wind", "surface"],
      syntax: "noun_phrase"
    }),
    slot({
      id: `${prefix}_surface_condition`,
      value: window.surfaceCondition,
      description: "the code-owned surface-condition semantic for this session",
      claim,
      factRefs: [condition.id],
      domains: ["surface"],
      syntax: "noun_phrase",
      required: false
    })
  ];
}

function assertRecommendedWindowUsable(
  bundle: ForecastFactBundle,
  windowId: string,
  rank: number
): void {
  const window = windowFor(bundle, windowId);
  const label = rank === 0 ? "primary" : "backup";
  if (window.ratingStatus !== "scored") {
    throw new Error(`Analysis ${label} recommendation is not scored`);
  }
  if (window.surfaceCondition === "unknown") {
    throw new Error(`Analysis ${label} recommendation has unknown surface guidance`);
  }
  if (window.windRelation === "unknown") {
    throw new Error(`Analysis ${label} recommendation has unknown wind guidance`);
  }
  if (
    window.windSpeedKt === null ||
    !Number.isFinite(window.windSpeedKt) ||
    window.windSpeedKt < 0
  ) {
    throw new Error(`Analysis ${label} recommendation has invalid wind speed guidance`);
  }
}

export async function buildSurfAnalysisSnapshot(
  bundle: ForecastFactBundle
): Promise<SurfAnalysisValidationSnapshot> {
  const primaryId = bundle.input.recommendationWindowIds[0];
  if (!primaryId) throw new Error("Analysis requires a deterministic primary recommendation");
  const backupId = bundle.input.recommendationWindowIds[1];
  bundle.input.recommendationWindowIds.forEach((windowId, rank) =>
    assertRecommendedWindowUsable(bundle, windowId, rank)
  );
  const primary = windowFor(bundle, primaryId);
  const daylightWindows = bundle.input.windows.filter((window) => window.isDaylight);
  const evolutionWindows = daylightWindows.length > 0 ? daylightWindows : bundle.input.windows;
  const evolutionWaveFacts = evolutionWindows.map((window) =>
    findFact(bundle, window.windowId, "wave")
  );
  const evolutionSurfaceFacts = evolutionWindows.flatMap((window) => [
    findFact(bundle, window.windowId, "condition"),
    findFact(bundle, window.windowId, "wind")
  ]);
  const primaryRecommendation = findFact(bundle, primaryId, "recommendation");
  const spotFact = findFact(bundle, undefined, "spot");
  const primaryCondition = findFact(bundle, primaryId, "condition");
  const primaryWind = findFact(bundle, primaryId, "wind");
  const primarySource = findFact(bundle, primaryId, "source");
  const primaryConfidence = findFact(bundle, primaryId, "confidence");
  const baselineUncertaintyFact: ForecastFact = {
    id: "uncertainty:modeled_breaking_calibration",
    kind: "caveat",
    role: "tradeoff",
    statement: "Actual breaking surf can differ from the modeled guidance at this spot.",
    windowId: null,
    material: true
  };
  const primarySession = recommendationSpan(bundle, primaryId)!;
  const primaryTide = selectedTideTiming(bundle, primaryId);

  const slots: SurfAnalysisValueSlot[] = [
    slot({
      id: "headline_call",
      value: `${bundle.input.spotName}: ${primarySession} is the best window`,
      description: "complete code-owned headline",
      claim: "headline",
      factRefs: [spotFact.id, primaryRecommendation.id],
      domains: ["recommendation"],
      syntax: "headline"
    }),
    slot({
      id: "day_surf_evolution",
      value: surfEvolution(evolutionWindows),
      description: "daylight surf-size evolution predicate; place after a surf subject",
      claim: "outlook_wave",
      factRefs: evolutionWaveFacts.map((fact) => fact.id),
      domains: ["wave"],
      syntax: "predicate"
    }),
    slot({
      id: "day_swell_evolution",
      value: swellEvolution(evolutionWindows),
      description: "daylight swell-period/direction evolution predicate; place after a swell subject",
      claim: "outlook_wave",
      factRefs: evolutionWaveFacts.map((fact) => fact.id),
      domains: ["wave"],
      syntax: "predicate"
    }),
    slot({
      id: "day_surface_evolution",
      value: surfaceEvolution(evolutionWindows),
      description: "daylight surface and wind evolution predicate; place after a surface subject",
      claim: "outlook_surface",
      factRefs: evolutionSurfaceFacts.map((fact) => fact.id),
      domains: ["surface", "wind"],
      syntax: "predicate"
    }),
    ...windowSlots(bundle, primaryId, "primary"),
    ...(backupId ? windowSlots(bundle, backupId, "alternate") : []),
    slot({
      id: "confidence_sentence",
      value: `Confidence in this timing call is ${primary.confidenceBand}.`,
      description: "complete code-owned confidence sentence for the leading call",
      claim: "confidence",
      factRefs: [primaryConfidence.id],
      domains: ["confidence"],
      syntax: "sentence"
    }),
    ...(primaryTide.value
      ? [
          slot({
            id: "primary_tide_sentence",
            value: primaryTide.value,
            description: "complete neutral primary-window tide sentence",
            claim: "primary",
            factRefs: [primaryTide.factId],
            domains: ["tide"],
            syntax: "sentence",
            required: false
          })
        ]
      : [])
  ];

  const facts = [
    ...bundle.facts.filter((fact) => fact.role !== "locked"),
    baselineUncertaintyFact
  ];
  const slotMap = new Map(slots.map((candidate) => [candidate.id, candidate]));
  const cards: SurfAnalysisEditorialCard[] = [
    editorialCard({
      id: "outlook:size-arc",
      placement: "outlook",
      stance: "context",
      semanticKey: "day:size",
      windowId: null,
      template: "Surf is {{day_surf_evolution}}.",
      factRefs: evolutionWaveFacts.map((fact) => fact.id),
      domains: ["wave"],
      slots: slotMap
    }),
    editorialCard({
      id: "outlook:swell-arc",
      placement: "outlook",
      stance: "context",
      semanticKey: "day:swell",
      windowId: null,
      template: "The dominant swell is {{day_swell_evolution}}.",
      factRefs: evolutionWaveFacts.map((fact) => fact.id),
      domains: ["wave"],
      slots: slotMap
    }),
    editorialCard({
      id: "outlook:surface-arc",
      placement: "outlook",
      stance: "context",
      semanticKey: "day:surface",
      windowId: null,
      template: "Surface conditions are {{day_surface_evolution}}.",
      factRefs: evolutionSurfaceFacts.map((fact) => fact.id),
      domains: ["surface", "wind"],
      slots: slotMap
    })
  ];

  if (primary.surfaceCondition === "clean") {
    cards.push(
      editorialCard({
        id: "primary:support:surface",
        placement: "primary_support",
        stance: "support",
        semanticKey: "primary:surface",
        windowId: primaryId,
        template:
          "That {{primary_surface_condition}} surface read is the clearest upside in the leading window.",
        factRefs: [primaryCondition.id],
        domains: ["surface", "recommendation"],
        slots: slotMap
      })
    );
  }
  if (primaryWind.role === "support") {
    cards.push(
      editorialCard({
        id: "primary:support:wind",
        placement: "primary_support",
        stance: "support",
        semanticKey: "primary:wind",
        windowId: primaryId,
        template: "That wind and surface pairing is the strongest support for the call.",
        factRefs: [primaryWind.id],
        domains: ["wind", "surface", "recommendation"],
        slots: slotMap
      })
    );
  }
  if (!cards.some(({ placement }) => placement === "primary_support")) {
    cards.push(
      editorialCard({
        id: "primary:support:ranking",
        placement: "primary_support",
        stance: "support",
        semanticKey: "primary:ranking",
        windowId: primaryId,
        template: "This window leads the daylight options in the current forecast.",
        factRefs: [primaryRecommendation.id],
        domains: ["recommendation"],
        slots: slotMap
      })
    );
  }
  if (primary.surfaceCondition === "choppy") {
    cards.push(
      editorialCard({
        id: "primary:tradeoff:surface",
        placement: "primary_tradeoff",
        stance: "tradeoff",
        semanticKey: "primary:surface",
        windowId: primaryId,
        template:
          "That {{primary_surface_condition}} surface texture is still a limitation in the leading window.",
        factRefs: [primaryCondition.id],
        domains: ["surface", "recommendation"],
        slots: slotMap
      })
    );
  }
  if (primaryWind.role === "tradeoff") {
    cards.push(
      editorialCard({
        id: "primary:tradeoff:wind",
        placement: "primary_tradeoff",
        stance: "tradeoff",
        semanticKey: "primary:wind",
        windowId: primaryId,
        template: "The wind relationship is still a surface-quality tradeoff at this shoreline.",
        factRefs: [primaryWind.id],
        domains: ["wind", "surface", "recommendation"],
        slots: slotMap
      })
    );
  }
  if (backupId) {
    const backup = windowFor(bundle, backupId);
    const backupWave = findFact(bundle, backupId, "wave");
    const backupCondition = findFact(bundle, backupId, "condition");
    const baseAlternate =
      "The alternate is {{backup_session}}: {{backup_surf_size}} surf from {{backup_swell}}, with {{backup_wind_surface}}.";
    const baseAlternateRefs = [
      findFact(bundle, backupId, "recommendation").id,
      backupWave.id,
      findFact(bundle, backupId, "wind").id,
      backupCondition.id
    ];
    cards.push(
      editorialCard({
        id: "alternate:session",
        placement: "alternate",
        stance: "context",
        semanticKey: "alternate:session",
        windowId: backupId,
        template: baseAlternate,
        factRefs: baseAlternateRefs,
        domains: ["recommendation", "wave", "wind", "surface"],
        slots: slotMap
      })
    );
    if (
      primary.surfSizeFt !== null &&
      backup.surfSizeFt !== null &&
      Math.abs(backup.surfSizeFt - primary.surfSizeFt) >= 0.5
    ) {
      cards.push(
        editorialCard({
          id: "alternate:size-contrast",
          placement: "alternate",
          stance: "context",
          semanticKey: "alternate:size-contrast",
          windowId: backupId,
          template: `${baseAlternate.slice(0, -1)}; it carries ${
            backup.surfSizeFt > primary.surfSizeFt ? "more" : "less"
          } size than the main window.`,
          factRefs: [...baseAlternateRefs, findFact(bundle, primaryId, "wave").id],
          domains: ["recommendation", "wave", "wind", "surface"],
          slots: slotMap
        })
      );
    }
    const surfaceOrder = { unknown: -1, choppy: 0, fair: 1, clean: 2 } as const;
    if (backup.surfaceCondition !== primary.surfaceCondition) {
      cards.push(
        editorialCard({
          id: "alternate:surface-contrast",
          placement: "alternate",
          stance: "context",
          semanticKey: "alternate:surface-contrast",
          windowId: backupId,
          template: `${baseAlternate.slice(0, -1)}; its surface read is ${
            surfaceOrder[backup.surfaceCondition] > surfaceOrder[primary.surfaceCondition]
              ? "cleaner"
              : "rougher"
          } than the main window.`,
          factRefs: [...baseAlternateRefs, primaryCondition.id],
          domains: ["recommendation", "wave", "wind", "surface"],
          slots: slotMap
        })
      );
    }
  }

  const primaryCaveats = bundle.facts.filter(
    (fact) => fact.windowId === primaryId && fact.kind === "caveat" && fact.role === "tradeoff"
  );
  const criticalSource = primary.requiredSourceStatus === "missing" || primary.requiredSourceStatus === "stale";
  if (criticalSource) {
    cards.push(
      editorialCard({
        id: "watch:source",
        placement: "watch",
        stance: "tradeoff",
        semanticKey: "primary:source",
        windowId: primaryId,
        template:
          primary.requiredSourceStatus === "missing"
            ? "A required source is missing, which is the main uncertainty in this call."
            : "A required source is stale, which is the main uncertainty in this call.",
        factRefs: [primarySource.id],
        domains: ["source", "confidence"],
        slots: slotMap
      })
    );
  } else {
    for (const [index, caveat] of primaryCaveats.slice(0, 2).entries()) {
      cards.push(
        editorialCard({
          id: `watch:caveat:${index}`,
          placement: "watch",
          stance: "tradeoff",
          semanticKey: `primary:caveat:${index}`,
          windowId: primaryId,
          template: /[.!?]$/.test(caveat.statement) ? caveat.statement : `${caveat.statement}.`,
          factRefs: [caveat.id],
          domains: ["recommendation", "confidence"],
          slots: slotMap
        })
      );
    }
    cards.push(
      editorialCard({
        id: "watch:spot-calibration",
        placement: "watch",
        stance: "tradeoff",
        semanticKey: "spot:calibration",
        windowId: null,
        template: baselineUncertaintyFact.statement,
        factRefs: [baselineUncertaintyFact.id],
        domains: ["confidence", "recommendation"],
        slots: slotMap
      })
    );
  }

  const refsForClaim = (claim: SurfAnalysisClaimName) => [
    ...new Set(
      slots.filter((candidate) => candidate.claim === claim).flatMap((candidate) => candidate.factRefs)
    )
  ];
  const refsForCards = (...placements: SurfAnalysisCardPlacement[]) => [
    ...new Set(
      cards
        .filter((candidate) => placements.includes(candidate.placement))
        .flatMap((candidate) => candidate.factRefs)
    )
  ];
  const refsForOutlookDomains = (...domains: SurfAnalysisDomain[]) => [
    ...new Set(
      cards
        .filter(
          (candidate) =>
            candidate.placement === "outlook" &&
            candidate.domains.some((domain) => domains.includes(domain))
        )
        .flatMap((candidate) => candidate.factRefs)
    )
  ];
  const mergeRefs = (...groups: string[][]) => [...new Set(groups.flat())];
  const refsByClaim: SurfAnalysisValidationSnapshot["allowedFactRefs"] = {
    headline: refsForClaim("headline"),
    outlook_wave: mergeRefs(
      refsForClaim("outlook_wave"),
      refsForOutlookDomains("wave")
    ),
    outlook_surface: mergeRefs(
      refsForClaim("outlook_surface"),
      refsForOutlookDomains("surface", "wind")
    ),
    primary: mergeRefs(
      refsForClaim("primary"),
      refsForCards("primary_support", "primary_tradeoff")
    ),
    alternate: mergeRefs(refsForClaim("alternate"), refsForCards("alternate")),
    confidence: mergeRefs(refsForClaim("confidence"), refsForCards("watch"))
  };
  const relevantFactIds = new Set(Object.values(refsByClaim).flat());
  const relevantFacts = facts
    .filter((fact) => relevantFactIds.has(fact.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const callMode = backupId ? "primary_and_alternate" : "primary_only";
  const factFingerprint = await sha256Json({
    snapshotSchemaVersion: 3,
    domain: "surf",
    entityId: bundle.input.spotId,
    localDate: bundle.input.localDate,
    recommendationWindowIds: bundle.input.recommendationWindowIds,
    callMode,
    slots: slots.map(
      ({ id, value, claim, factRefs, domains, syntax, authorship, required }) => ({
        id,
        value,
        claim,
        factRefs,
        domains,
        syntax,
        authorship,
        required
      })
    ),
    cards: cards.map(
      ({ id, placement, stance, semanticKey, windowId, template, preview, factRefs, domains }) => ({
        id,
        placement,
        stance,
        semanticKey,
        windowId,
        template,
        preview,
        factRefs,
        domains
      })
    ),
    facts: relevantFacts.map(({ id, kind, role, statement, windowId }) => ({
      id,
      kind,
      role,
      statement,
      windowId
    }))
  });

  return SurfAnalysisValidationSnapshotSchema.parse({
    schemaVersion: 3,
    spotId: bundle.input.spotId,
    spotName: bundle.input.spotName,
    localDate: bundle.input.localDate,
    factFingerprint,
    materialFingerprint: bundle.materialFingerprint,
    deadlineAt: defaultDeadline(bundle),
    recommendationWindowIds: bundle.input.recommendationWindowIds,
    callMode,
    facts: relevantFacts,
    slots,
    cards,
    allowedFactRefs: refsByClaim
  });
}

export const SURF_ANALYSIS_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "outlook", "call", "close"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    outlook: {
      type: "object",
      additionalProperties: false,
      required: ["leadCardId", "supportingCardId"],
      properties: {
        leadCardId: { $ref: "#/$defs/cardId" },
        supportingCardId: { $ref: "#/$defs/cardId" }
      }
    },
    call: {
      type: "object",
      additionalProperties: false,
      required: ["primarySupportCardId", "primaryTradeoffCardId", "alternateCardId"],
      properties: {
        primarySupportCardId: {
          anyOf: [{ $ref: "#/$defs/cardId" }, { type: "null" }]
        },
        primaryTradeoffCardId: {
          anyOf: [{ $ref: "#/$defs/cardId" }, { type: "null" }]
        },
        alternateCardId: { anyOf: [{ $ref: "#/$defs/cardId" }, { type: "null" }] }
      }
    },
    close: {
      type: "object",
      additionalProperties: false,
      required: ["watchCardId"],
      properties: { watchCardId: { $ref: "#/$defs/cardId" } }
    }
  },
  $defs: {
    cardId: {
      type: "string",
      minLength: 1,
      maxLength: 160,
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9:._-]*$"
    }
  }
};

function promptFor(snapshot: SurfAnalysisValidationSnapshot): NarrativeJob["inference"] {
  const facts = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
  const card = (candidate: SurfAnalysisEditorialCard) => ({
    id: candidate.id,
    preview: candidate.preview,
    stance: candidate.stance,
    domains: candidate.domains,
    factRefs: candidate.factRefs,
    evidence: candidate.factRefs.map((id) => facts.get(id)?.statement ?? "")
  });
  const candidates = {
    outlook: snapshot.cards.filter(({ placement }) => placement === "outlook").map(card),
    primarySupport: snapshot.cards
      .filter(({ placement }) => placement === "primary_support")
      .map(card),
    primaryTradeoff: snapshot.cards
      .filter(({ placement }) => placement === "primary_tradeoff")
      .map(card),
    alternate: snapshot.cards.filter(({ placement }) => placement === "alternate").map(card),
    watch: snapshot.cards.filter(({ placement }) => placement === "watch").map(card)
  };
  return {
    messages: [
      {
        role: "system",
        content:
          "Act as the editor of a deterministic local surf report. Return only the IDs of supplied code-authored candidate cards in the strict JSON plan; never write prose or alter a card. Lead with the information that most changes the day's read. Choose two distinct outlook cards, order the most useful first, and make the pair cover both waves and surface or wind. Select one primary support card. Select one primary tradeoff when tradeoff candidates exist; otherwise return null. An alternate is optional even when candidates exist: choose one only when it adds useful timing, size, or surface contrast, and return null when there is no backup. Pick exactly one concrete watch card. Prefer a specific source or forecast limitation over generic uncertainty. Do not select the same semantic point twice. Recommendation rank is immutable. Tide is neutral code-owned context and is inserted separately; it is never selectable or a reason conditions improve. Use only IDs present in the matching candidate group. There is intentionally no canonical prose example to copy."
      },
      {
        role: "user",
        content: JSON.stringify({
          spot: snapshot.spotName,
          date: snapshot.localDate,
          callMode: snapshot.callMode,
          requiredSelections: {
            primarySupport: candidates.primarySupport.length > 0,
            primaryTradeoff: candidates.primaryTradeoff.length > 0,
            alternateMustBeNull: snapshot.callMode === "primary_only"
          },
          immutableFrame: snapshot.slots.map(({ id, value, factRefs }) => ({
            id,
            value,
            factRefs
          })),
          candidates
        })
      }
    ],
    responseSchema: JsonObjectSchema.parse(SURF_ANALYSIS_RESPONSE_JSON_SCHEMA),
    maxOutputTokens: 500,
    temperature: 0.15
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
