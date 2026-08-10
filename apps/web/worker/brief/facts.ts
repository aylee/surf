import type { ForecastResponse, ScoredForecastWindow } from "@surf/contracts";
import {
  intervalOverlapsCivilLight,
  selectCanonicalRecommendationIds,
  surfSizeRange,
  surfaceConditionForWind
} from "@surf/forecast-core";
import {
  FORECAST_BRIEF_PROMPT_VERSION,
  FORECAST_BRIEF_QUALITY_POLICY_VERSION,
  FORECAST_BRIEF_SCHEMA_VERSION,
  FORECAST_BRIEF_MODEL_ID,
  FORECAST_BRIEF_THINKING_LEVEL,
  FORECAST_FACT_BUNDLE_SCHEMA_VERSION,
  ForecastFactBundleSchema,
  ForecastBriefInputSchema,
  type ForecastBriefInput,
  type ForecastBriefWindowInput,
  type ForecastFact,
  type ForecastFactBundle
} from "./types";

export const FORECAST_BRIEF_GENERATION_CONTRACT = {
  briefSchemaVersion: FORECAST_BRIEF_SCHEMA_VERSION,
  promptVersion: FORECAST_BRIEF_PROMPT_VERSION,
  qualityPolicyVersion: FORECAST_BRIEF_QUALITY_POLICY_VERSION,
  modelId: FORECAST_BRIEF_MODEL_ID,
  thinkingLevel: FORECAST_BRIEF_THINKING_LEVEL
} as const;

export type BuildForecastFactBundleOptions = {
  localDate?: string;
  recommendationWindowIds?: string[];
  expiresAt?: string | null;
};

function dateParts(value: string, timeZone: string): { date: string; minutes: number } {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid forecast timestamp: ${value}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: hour * 60 + minute
  };
}

function isDaylight(
  forecast: ForecastResponse,
  validFrom: string,
  validTo: string,
  localDate: string
): boolean {
  const phases = forecast.sunPhases?.find((candidate) => candidate.localDate === localDate);
  if (!phases) {
    const from = dateParts(validFrom, forecast.spot.timezone);
    const to = dateParts(validTo, forecast.spot.timezone);
    if (from.date !== localDate && to.date !== localDate) return false;
    const fromMinutes = from.date < localDate ? 0 : from.minutes;
    const toMinutes = to.date > localDate ? 24 * 60 : to.minutes;
    return fromMinutes < 18 * 60 && toMinutes > 6 * 60;
  }
  return intervalOverlapsCivilLight(
    validFrom,
    validTo,
    phases.firstLight,
    phases.lastLight
  );
}

function confidenceBand(confidence: number): "low" | "medium" | "high" {
  if (confidence < 50) return "low";
  if (confidence < 75) return "medium";
  return "high";
}

function periodBand(value: number | null): "unavailable" | "short" | "medium" | "long" {
  if (value === null) return "unavailable";
  if (value < 9) return "short";
  if (value < 14) return "medium";
  return "long";
}

function directionSector(value: number | null): string {
  if (value === null) return "unavailable";
  const sectors = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return sectors[Math.round((((value % 360) + 360) % 360) / 45) % 8]!;
}

function requiredSourceStatus(
  window: ScoredForecastWindow
): ForecastBriefWindowInput["requiredSourceStatus"] {
  const statuses =
    window.sourceFreshness
      ?.filter((source) => source.capability !== "observed_wave")
      .map((source) => source.status) ?? [];
  if (statuses.length === 0) return "unknown";
  if (statuses.includes("missing")) return "missing";
  if (statuses.includes("stale")) return "stale";
  return "fresh";
}

function modeledHeightLabel(value: number | null): string | null {
  if (value === null) return null;
  const lower = Math.max(0, Math.floor(value));
  const upper = Math.max(lower + 1, Math.ceil(value));
  return `${lower}–${upper} ft modeled`;
}

function containsDirection(directionDeg: number, minDeg: number, maxDeg: number): boolean {
  const normalized = ((directionDeg % 360) + 360) % 360;
  return minDeg <= maxDeg
    ? normalized >= minDeg && normalized <= maxDeg
    : normalized >= minDeg || normalized <= maxDeg;
}

function windRelation(
  forecast: ForecastResponse,
  window: ScoredForecastWindow
): ForecastBriefWindowInput["windRelation"] {
  if (window.windDirectionDeg === null || window.windSpeedKt === null) return "unknown";
  const offshore = forecast.spot.offshoreWindFromDeg;
  if (containsDirection(window.windDirectionDeg, offshore.minDeg, offshore.maxDeg)) return "offshore";
  const onshoreMin = (offshore.minDeg + 180) % 360;
  const onshoreMax = (offshore.maxDeg + 180) % 360;
  if (containsDirection(window.windDirectionDeg, onshoreMin, onshoreMax)) return "onshore";
  return "cross-shore";
}

function waveSemantics(window: ScoredForecastWindow): ForecastBriefWindowInput["waveSemantics"] {
  if (window.waveState) return window.waveState.semantics;
  if (!window.waveProvenance) return "unavailable";
  if (window.waveProvenance.derivation === "cdip_mop_point_hs_spot_scale") return "cove_proxy";
  if (window.waveProvenance.derivation === "cdip_mop_point_hs") return "direct_nearshore";
  return "nws_fallback";
}

function calibrationStatus(
  window: ScoredForecastWindow
): ForecastBriefWindowInput["calibrationStatus"] {
  if (window.waveState) return window.waveState.calibrationStatus;
  const semantics = waveSemantics(window);
  if (semantics === "direct_nearshore") return "modeled_uncalibrated";
  if (semantics === "cove_proxy") return "proxy_uncalibrated";
  if (semantics === "nws_fallback") return "cold_start_uncalibrated";
  return "unavailable";
}

function validity(window: ScoredForecastWindow, interval: "1h" | "3h"): { from: string; to: string } {
  const from = window.waveState?.validFrom ?? window.resolution?.wave.validFrom ?? window.forecastAt;
  const fallbackTo = new Date(
    new Date(window.forecastAt).getTime() + (interval === "1h" ? 1 : 3) * 60 * 60 * 1000
  ).toISOString();
  return {
    from,
    to: window.waveState?.validTo ?? window.resolution?.wave.validTo ?? fallbackTo
  };
}

function toWindowInput(
  forecast: ForecastResponse,
  window: ScoredForecastWindow,
  localDate: string
): ForecastBriefWindowInput {
  const waveHeight = window.waveState?.modeledNearshoreHeightFt ?? window.waveHeightFt;
  const surfSizeFt = window.waveHeightFt;
  const interval = forecast.interval ?? "3h";
  const valid = validity(window, interval);
  const displayValidTo = new Date(
    Date.parse(window.forecastAt) + (interval === "1h" ? 1 : 3) * 60 * 60 * 1000
  ).toISOString();
  return {
    windowId: window.forecastAt,
    forecastAt: window.forecastAt,
    validFrom: valid.from,
    validTo: valid.to,
    isDaylight: isDaylight(forecast, window.forecastAt, displayValidTo, localDate),
    ratingStatus: window.ratingStatus,
    surfaceCondition:
      window.surfaceCondition ??
      surfaceConditionForWind(forecast.spot, {
        windSpeedKt: window.windSpeedKt,
        windDirectionDeg: window.windDirectionDeg
      }),
    qualityLabel: window.qualityLabel,
    score: window.score,
    confidence: window.confidence,
    confidenceBand: confidenceBand(window.confidence),
    surfSizeFt,
    surfSizeLabel: surfSizeRange(surfSizeFt),
    modeledHeightFt: waveHeight,
    modeledHeightLabel: modeledHeightLabel(waveHeight),
    waveSemantics: waveSemantics(window),
    calibrationStatus: calibrationStatus(window),
    peakPeriodSec: window.waveState?.periodSec ?? window.peakPeriodSec,
    primaryDirectionDeg: window.waveState?.directionDeg ?? window.primaryDirectionDeg,
    windSpeedKt: window.windSpeedKt,
    windGustKt: window.windGustKt ?? null,
    windRelation: windRelation(forecast, window),
    tideFt: window.tideFt,
    tideTrend: window.tideTrend ?? null,
    activeCapabilities: [...window.activeCapabilities].sort(),
    caveats: window.caveats,
    sourceFreshnessMinutes: window.sourceFreshnessMinutes,
    requiredSourceStatus: requiredSourceStatus(window)
  };
}

export function forecastBriefWindowLabel(
  bundle: Pick<ForecastFactBundle, "input">,
  windowId: string
): string {
  const window = bundle.input.windows.find((candidate) => candidate.windowId === windowId);
  if (!window) throw new Error(`Unknown forecast brief window: ${windowId}`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: bundle.input.timezone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(window.forecastAt));
}

export function forecastBriefFrame(bundle: Pick<ForecastFactBundle, "input">): {
  headline: string;
  setup: string;
} {
  const leadingWindowId = bundle.input.recommendationWindowIds[0];
  return leadingWindowId
    ? {
        headline: `${forecastBriefWindowLabel(bundle, leadingWindowId)} leads at ${bundle.input.spotName}`,
        setup: "The leading daylight window comes from the current condition, wind, wave, confidence, and source read."
      }
    : {
        headline: `${bundle.input.spotName} has no scored daylight recommendation`,
        setup: "Sourced inputs are incomplete, so no ranked session window is available yet."
      };
}

function conditionRole(
  window: ForecastBriefWindowInput
): ForecastFact["role"] {
  if (window.surfaceCondition === "choppy" || window.qualityLabel === "poor") return "tradeoff";
  if (
    window.surfaceCondition === "clean" ||
    window.qualityLabel === "fun" ||
    window.qualityLabel === "good" ||
    window.qualityLabel === "excellent"
  ) {
    return "support";
  }
  return "context";
}

function confidenceRole(
  window: ForecastBriefWindowInput
): ForecastFact["role"] {
  return window.confidenceBand === "high" ? "support" : "tradeoff";
}

function windRole(window: ForecastBriefWindowInput): ForecastFact["role"] {
  if (window.windRelation === "offshore") return "support";
  if (window.windRelation === "onshore" || window.windRelation === "cross-shore") {
    return "tradeoff";
  }
  return "context";
}

function lockedWaveCaveats(
  window: ForecastBriefWindowInput
): Array<{ suffix: string; statement: string }> {
  if (window.waveSemantics === "unavailable") return [];
  const caveats = [
    {
      suffix: "measurement",
      statement:
        "The size shown is modeled nearshore wave state, not an observed breaking-wave face height."
    }
  ];
  if (window.waveSemantics === "cove_proxy") {
    caveats.push({
      suffix: "proxy",
      statement: "The wave state is a nearby cove proxy rather than a direct value for this spot."
    });
  } else if (window.waveSemantics === "nws_fallback") {
    caveats.push({
      suffix: "fallback",
      statement: "The wave state uses an NWS fallback rather than direct nearshore model output."
    });
  }
  if (window.calibrationStatus !== "unavailable") {
    caveats.push({
      suffix: "calibration",
      statement: "The modeled wave state has not been calibrated against breaking waves at this spot."
    });
  }
  return caveats;
}

const CODE_OWNED_RAW_CAVEAT_PATTERN =
  /\b(?:active nws hazard|breaking|wave[- ]face|significant wave height|calibrat|proxy|fallback|cold[- ]start|coastal[- ]grid|cdip|model point|source model cycle|height scale|bulk[- ]hs|buoy|observation)\b/i;

function modelEligibleRawCaveat(caveat: string): boolean {
  return !CODE_OWNED_RAW_CAVEAT_PATTERN.test(caveat);
}

function addWindowFacts(
  facts: ForecastFact[],
  window: ForecastBriefWindowInput,
  index: number
): void {
  const prefix = `window:w${index}`;
  facts.push({
    id: `${prefix}:condition`,
    kind: "condition",
    role: conditionRole(window),
    statement: `Surface conditions are ${window.surfaceCondition}, and the overall quality read is ${window.qualityLabel}.`,
    windowId: window.windowId,
    material: true
  });
  facts.push({
    id: `${prefix}:confidence`,
    kind: "confidence",
    role: confidenceRole(window),
    statement:
      window.confidenceBand === "high"
        ? "Confidence is high, which strengthens the forecast call."
        : `Confidence is ${window.confidenceBand}, leaving meaningful uncertainty around the forecast call.`,
    windowId: window.windowId,
    material: true
  });
  if (window.modeledHeightFt !== null && window.modeledHeightLabel) {
    facts.push({
      id: `${prefix}:wave`,
      kind: "wave",
      role: "context",
      statement: `The modeled nearshore wave state is ${periodBand(window.peakPeriodSec)}-period from the ${directionSector(window.primaryDirectionDeg)}.`,
      windowId: window.windowId,
      material: true
    });
  } else {
    facts.push({
      id: `${prefix}:wave`,
      kind: "wave",
      role: "tradeoff",
      statement: "The modeled wave state is unavailable for this window.",
      windowId: window.windowId,
      material: true
    });
  }
  facts.push({
    id: `${prefix}:wind`,
    kind: "wind",
    role: window.windSpeedKt === null ? "tradeoff" : windRole(window),
    statement:
      window.windSpeedKt === null
        ? "The wind relationship is unavailable for this window."
        : window.windRelation === "offshore"
          ? "Offshore wind supports the cleaner surface read at this shoreline."
          : window.windRelation === "onshore"
            ? "Onshore wind is a surface-quality limiter at this shoreline."
            : window.windRelation === "cross-shore"
              ? "Cross-shore wind is a surface-quality tradeoff at this shoreline."
              : `The wind relationship is ${window.windRelation} at this shoreline.`,
    windowId: window.windowId,
    material: true
  });
  facts.push({
    id: `${prefix}:tide`,
    kind: "tide",
    role: "context",
    statement:
      window.tideFt === null
        ? "Tide context is unavailable for this window."
        : `The tide is ${window.tideTrend ?? "unknown"}. Surf has no validated spot-specific tide preference here, so the trend is context rather than a quality signal.`,
    windowId: window.windowId,
    material: true
  });
  facts.push({
    id: `${prefix}:freshness`,
    kind: "source",
    role:
      window.requiredSourceStatus === "stale" || window.requiredSourceStatus === "missing"
        ? "tradeoff"
        : "context",
    statement:
      window.requiredSourceStatus === "fresh"
        ? "The required forecast sources are fresh for this window."
        : window.requiredSourceStatus === "stale"
          ? "A required forecast source is stale, limiting confidence in this window."
          : window.requiredSourceStatus === "missing"
            ? "A required forecast source is missing, limiting confidence in this window."
            : "Required forecast source health is unknown for this window.",
    windowId: window.windowId,
    material: true
  });
  lockedWaveCaveats(window).forEach((caveat) => {
    facts.push({
      id: `${prefix}:locked:${caveat.suffix}`,
      kind: "caveat",
      role: "locked",
      statement: caveat.statement,
      windowId: window.windowId,
      material: true
    });
  });
  window.caveats.filter(modelEligibleRawCaveat).slice(0, 2).forEach((caveat, caveatIndex) => {
    facts.push({
      id: `${prefix}:caveat:${caveatIndex}`,
      kind: "caveat",
      role: "tradeoff",
      statement: caveat,
      windowId: window.windowId,
      material: true
    });
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceHealth(forecast: ForecastResponse, windows: ForecastBriefWindowInput[]) {
  const severity = { fresh: 0, stale: 1, missing: 2 } as const;
  const bySource = new Map<
    string,
    { sourceId: string; status: "fresh" | "stale" | "missing"; ageMinutes: number | null }
  >();
  const selectedWindowIds = new Set(windows.map((window) => window.windowId));
  forecast.windows.filter((window) => selectedWindowIds.has(window.forecastAt)).forEach((window) => {
    window.sourceFreshness?.forEach((source) => {
      const key = `${source.sourceId}:${source.capability}`;
      const current = bySource.get(key);
      if (!current) {
        bySource.set(key, {
          sourceId: key,
          status: source.status,
          ageMinutes: source.freshnessMinutes
        });
        return;
      }
      bySource.set(key, {
        sourceId: key,
        status: severity[source.status] > severity[current.status] ? source.status : current.status,
        ageMinutes:
          source.freshnessMinutes === null
            ? current.ageMinutes
            : Math.max(current.ageMinutes ?? 0, source.freshnessMinutes)
      });
    });
  });
  if (bySource.size === 0) {
    const maximumAge = windows.reduce<number | null>(
      (current, window) =>
        window.sourceFreshnessMinutes === null
          ? current
          : Math.max(current ?? 0, window.sourceFreshnessMinutes),
      null
    );
    bySource.set("combined-required-sources", {
      sourceId: "combined-required-sources",
      status: maximumAge === null ? "missing" : maximumAge > 360 ? "stale" : "fresh",
      ageMinutes: maximumAge
    });
  }
  return [...bySource.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function activeHazards(windows: ForecastBriefWindowInput[]): string[] {
  return [
    ...new Set(
      windows.flatMap((window) =>
        window.caveats.filter((caveat) => /^active nws hazard:/i.test(caveat))
      )
    )
  ].sort();
}

function materialSnapshot(input: ForecastBriefInput) {
  return {
    generationContract: FORECAST_BRIEF_GENERATION_CONTRACT,
    spotId: input.spotId,
    spotName: input.spotName,
    timezone: input.timezone,
    localDate: input.localDate,
    recommendationWindowIds: input.recommendationWindowIds,
    recommendations: input.recommendations,
    tideEvents: input.tideEvents,
    windows: input.windows.map((window) => ({
      windowId: window.windowId,
      surfaceCondition: window.surfaceCondition,
      surfSizeLabel: window.surfSizeLabel,
      modeledHeightLabel: window.modeledHeightLabel,
      qualityLabel: window.qualityLabel,
      confidenceBand: window.confidenceBand,
      periodBand: periodBand(window.peakPeriodSec),
      directionSector: directionSector(window.primaryDirectionDeg),
      waveSemantics: window.waveSemantics,
      calibrationStatus: window.calibrationStatus,
      waveAvailable: window.modeledHeightFt !== null,
      windAvailable: window.windSpeedKt !== null,
      windRelation: window.windRelation,
      tideAvailable: window.tideFt !== null,
      tideTrend: window.tideTrend ?? "unknown",
      requiredSourceStatus: window.requiredSourceStatus,
      caveats: window.caveats.slice(0, 2)
    })),
    activeHazards: input.activeHazards,
    sourceHealth: input.sourceHealth.map((source) => ({
      sourceId: source.sourceId,
      status: source.status
    })),
    observationAvailable: input.observation !== null
  };
}

export async function buildForecastFactBundle(
  forecast: ForecastResponse,
  options: BuildForecastFactBundleOptions = {}
): Promise<ForecastFactBundle> {
  const generatedLocalDate = dateParts(forecast.generatedAt, forecast.spot.timezone).date;
  const firstWindowLocalDate = forecast.windows[0]
    ? dateParts(forecast.windows[0].forecastAt, forecast.spot.timezone).date
    : null;
  const hasGeneratedDateWindow = forecast.windows.some(
    (window) => dateParts(window.forecastAt, forecast.spot.timezone).date === generatedLocalDate
  );
  const localDate =
    options.localDate ??
    (hasGeneratedDateWindow ? generatedLocalDate : firstWindowLocalDate ?? generatedLocalDate);
  const windows = forecast.windows
    .filter((window) => dateParts(window.forecastAt, forecast.spot.timezone).date === localDate)
    .map((window) => toWindowInput(forecast, window, localDate));
  if (windows.length === 0) {
    throw new Error(`Forecast has no windows for ${localDate} at ${forecast.spot.id}`);
  }
  const recommendationWindowIds =
    options.recommendationWindowIds ??
    forecast.recommendations
      ?.filter((recommendation) => recommendation.localDate === localDate)
      .map((recommendation) => recommendation.representative.forecastAt) ??
    selectCanonicalRecommendationIds(windows, new Date(forecast.generatedAt));
  const recommendations =
    forecast.recommendations
      ?.filter(
        (recommendation) =>
          recommendation.localDate === localDate &&
          recommendationWindowIds.includes(recommendation.representative.forecastAt)
      )
      .map((recommendation) => ({
        representativeWindowId: recommendation.representative.forecastAt,
        constituentWindowIds: recommendation.constituentWindowIds,
        startAt: recommendation.startAt,
        endAt: recommendation.endAt
      })) ?? [];
  const health = sourceHealth(forecast, windows);
  const input = ForecastBriefInputSchema.parse({
    spotId: forecast.spot.id,
    spotName: forecast.spot.name,
    timezone: forecast.spot.timezone,
    localDate,
    generatedAt: new Date(forecast.generatedAt).toISOString(),
    expiresAt: options.expiresAt ?? null,
    recommendationWindowIds,
    recommendations,
    tideEvents:
      forecast.tideEvents
        ?.filter(
          (event) => dateParts(event.eventAt, forecast.spot.timezone).date === localDate
        )
        .map((event) => ({
          eventAt: event.eventAt,
          type: event.type,
          heightFtMllw: event.heightFtMllw
        })) ?? [],
    windows,
    activeHazards: activeHazards(windows),
    sourceHealth: health,
    observation: forecast.observation
      ? {
          stationId: forecast.observation.stationId,
          observedAt: new Date(forecast.observation.observedAt).toISOString(),
          waveHeightFt: forecast.observation.waveHeightFt,
          dominantPeriodSec: forecast.observation.dominantPeriodSec,
          directionDeg: forecast.observation.meanWaveDirectionDeg,
          ageMinutes: forecast.observation.sourceFreshnessMinutes
        }
      : null
  });

  const facts: ForecastFact[] = [
    {
      id: "spot:identity",
      kind: "spot",
      role: "context",
      statement: `${input.spotName} forecast for ${input.localDate}.`,
      windowId: null,
      material: true
    }
  ];
  input.recommendationWindowIds.forEach((windowId, rank) => {
    facts.push({
      id: `recommendation:r${rank + 1}`,
      kind: "recommendation",
      role: "support",
      statement:
        rank === 0
          ? "This window is the leading daylight recommendation."
          : "This window is also worth a look among the daylight recommendations.",
      windowId,
      material: true
    });
  });
  input.windows.forEach((window, index) => addWindowFacts(facts, window, index));
  input.activeHazards.forEach((hazard, index) => {
    facts.push({
      id: `hazard:h${index}`,
      kind: "hazard",
      role: "locked",
      statement: hazard,
      windowId: null,
      material: true
    });
  });
  input.tideEvents.forEach((event, index) => {
    facts.push({
      id: `tide:event:e${index}`,
      kind: "tide",
      role: "context",
      statement: `An official ${event.type}-tide event is available for this forecast date.`,
      windowId: null,
      material: true
    });
  });
  input.sourceHealth.forEach((source, index) => {
    facts.push({
      id: `source:s${index}`,
      kind: "source",
      role: source.status === "fresh" ? "context" : "tradeoff",
      statement:
        source.status === "fresh"
          ? "This public forecast source is fresh."
          : source.status === "stale"
            ? "This public forecast source is stale and limits confidence."
            : "This public forecast source is missing and limits confidence.",
      windowId: null,
      material: true
    });
  });
  if (input.observation) {
    facts.push({
      id: "observation:latest",
      kind: "observation",
      role: "context",
      statement:
        "A nearby public buoy observation provides regional context; it is not a forecast for this surf spot.",
      windowId: null,
      material: true
    });
  }

  const inputFingerprint = await sha256({
    generationContract: FORECAST_BRIEF_GENERATION_CONTRACT,
    input,
    facts
  });
  const materialFingerprint = await sha256(materialSnapshot(input));
  return ForecastFactBundleSchema.parse({
    schemaVersion: FORECAST_FACT_BUNDLE_SCHEMA_VERSION,
    input,
    facts,
    inputFingerprint,
    materialFingerprint
  });
}

export function forecastBriefLockedFacts(
  bundle: Pick<ForecastFactBundle, "facts" | "input">
): ForecastFact[] {
  const recommended = new Set(bundle.input.recommendationWindowIds);
  return bundle.facts.filter(
    (fact) =>
      fact.role === "locked" &&
      (fact.windowId === null || recommended.has(fact.windowId))
  );
}

export function isMaterialBriefChange(
  previous: Pick<ForecastFactBundle, "materialFingerprint"> | null,
  next: Pick<ForecastFactBundle, "materialFingerprint">
): boolean {
  return previous === null || previous.materialFingerprint !== next.materialFingerprint;
}
