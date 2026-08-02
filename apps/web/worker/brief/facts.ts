import type { ForecastResponse, ScoredForecastWindow } from "@surf/contracts";
import {
  selectCanonicalRecommendationIds,
  surfaceConditionForWind
} from "@surf/forecast-core";
import {
  FORECAST_BRIEF_SCHEMA_VERSION,
  ForecastFactBundleSchema,
  ForecastBriefInputSchema,
  type ForecastBriefInput,
  type ForecastBriefWindowInput,
  type ForecastFact,
  type ForecastFactBundle
} from "./types";

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

function phaseMinutes(value: string, timeZone: string): number | null {
  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) return dateParts(parsed.toISOString(), timeZone).minutes;
  const match = value.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function isDaylight(
  forecast: ForecastResponse,
  forecastAt: string,
  localDate: string
): boolean {
  const local = dateParts(forecastAt, forecast.spot.timezone);
  if (local.date !== localDate) return false;
  const phases = forecast.sunPhases?.find((candidate) => candidate.localDate === localDate);
  if (!phases) return local.minutes >= 6 * 60 && local.minutes <= 18 * 60;
  const firstLight = phaseMinutes(phases.firstLight, forecast.spot.timezone);
  const lastLight = phaseMinutes(phases.lastLight, forecast.spot.timezone);
  if (firstLight === null || lastLight === null) return false;
  return local.minutes >= firstLight && local.minutes <= lastLight;
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
  const interval = forecast.interval ?? "3h";
  const valid = validity(window, interval);
  return {
    windowId: window.forecastAt,
    forecastAt: window.forecastAt,
    validFrom: valid.from,
    validTo: valid.to,
    isDaylight: isDaylight(forecast, window.forecastAt, localDate),
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

function formatLocalTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
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
  return bundle.input.recommendationWindowIds.length > 0
    ? {
        headline: `${bundle.input.spotName} daylight outlook`,
        setup: "Compare the cited wind, tide, modeled wave state, confidence, and source caveats before making the call."
      }
    : {
        headline: `${bundle.input.spotName} has no scored daylight recommendation`,
        setup: "Sourced inputs are incomplete, so no ranked session window is available yet."
      };
}

function addWindowFacts(
  facts: ForecastFact[],
  window: ForecastBriefWindowInput,
  index: number,
  timeZone: string
): void {
  const prefix = `window:w${index}`;
  const localTime = formatLocalTime(window.forecastAt, timeZone);
  facts.push({
    id: `${prefix}:condition`,
    kind: "condition",
    statement: `${localTime}: deterministic surface condition ${window.surfaceCondition}; quality band ${window.qualityLabel}; confidence band ${window.confidenceBand}.`,
    windowId: window.windowId,
    material: true
  });
  if (window.modeledHeightFt !== null && window.modeledHeightLabel) {
    facts.push({
      id: `${prefix}:wave`,
      kind: "wave",
      statement: `${localTime}: ${window.modeledHeightLabel}; ${periodBand(window.peakPeriodSec)}-period modeled wave state from the ${directionSector(window.primaryDirectionDeg)}; semantics ${window.waveSemantics}; calibration ${window.calibrationStatus}. This is not an observed breaking-wave face height.`,
      windowId: window.windowId,
      material: true
    });
  } else {
    facts.push({
      id: `${prefix}:wave`,
      kind: "wave",
      statement: `${localTime}: modeled wave height is unavailable; calibration ${window.calibrationStatus}.`,
      windowId: window.windowId,
      material: true
    });
  }
  facts.push({
    id: `${prefix}:wind`,
    kind: "wind",
    statement: `${localTime}: wind input is ${window.windSpeedKt === null ? "unavailable" : "available"}; shoreline relationship ${window.windRelation}.`,
    windowId: window.windowId,
    material: true
  });
  facts.push({
    id: `${prefix}:tide`,
    kind: "tide",
    statement: `${localTime}: tide input is ${window.tideFt === null ? "unavailable" : "available"}; trend ${window.tideTrend ?? "unknown"}.`,
    windowId: window.windowId,
    material: true
  });
  facts.push({
    id: `${prefix}:freshness`,
    kind: "source",
    statement: `${localTime}: required-source status ${window.requiredSourceStatus}.`,
    windowId: window.windowId,
    material: true
  });
  window.caveats.slice(0, 2).forEach((caveat, caveatIndex) => {
    facts.push({
      id: `${prefix}:caveat:${caveatIndex}`,
      kind: "caveat",
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
    spotId: input.spotId,
    localDate: input.localDate,
    recommendationWindowIds: input.recommendationWindowIds,
    windows: input.windows.map((window) => ({
      windowId: window.windowId,
      surfaceCondition: window.surfaceCondition,
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
    selectCanonicalRecommendationIds(windows, new Date(forecast.generatedAt));
  const health = sourceHealth(forecast, windows);
  const input = ForecastBriefInputSchema.parse({
    spotId: forecast.spot.id,
    spotName: forecast.spot.name,
    timezone: forecast.spot.timezone,
    localDate,
    generatedAt: new Date(forecast.generatedAt).toISOString(),
    expiresAt: options.expiresAt ?? null,
    recommendationWindowIds,
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
      statement: `${input.spotName} forecast for ${input.localDate}.`,
      windowId: null,
      material: true
    }
  ];
  input.recommendationWindowIds.forEach((windowId, rank) => {
    const window = input.windows.find((candidate) => candidate.windowId === windowId)!;
    facts.push({
      id: `recommendation:r${rank + 1}`,
      kind: "recommendation",
      statement: `Deterministic recommendation rank ${rank + 1} is ${formatLocalTime(window.forecastAt, input.timezone)} with window ID ${window.windowId}.`,
      windowId,
      material: true
    });
  });
  input.windows.forEach((window, index) => addWindowFacts(facts, window, index, input.timezone));
  input.activeHazards.forEach((hazard, index) => {
    facts.push({
      id: `hazard:h${index}`,
      kind: "hazard",
      statement: hazard,
      windowId: null,
      material: true
    });
  });
  input.sourceHealth.forEach((source, index) => {
    facts.push({
      id: `source:s${index}`,
      kind: "source",
      statement: `${source.sourceId} status ${source.status}.`,
      windowId: null,
      material: true
    });
  });
  if (input.observation) {
    facts.push({
      id: "observation:latest",
      kind: "observation",
      statement: `A public buoy observation is available for context. Its freshness is represented by source status. It is not a spot forecast.`,
      windowId: null,
      material: true
    });
  }

  const inputFingerprint = await sha256({ input, facts });
  const materialFingerprint = await sha256(materialSnapshot(input));
  return ForecastFactBundleSchema.parse({
    schemaVersion: FORECAST_BRIEF_SCHEMA_VERSION,
    input,
    facts,
    inputFingerprint,
    materialFingerprint
  });
}

export function isMaterialBriefChange(
  previous: Pick<ForecastFactBundle, "materialFingerprint"> | null,
  next: Pick<ForecastFactBundle, "materialFingerprint">
): boolean {
  return previous === null || previous.materialFingerprint !== next.materialFingerprint;
}
