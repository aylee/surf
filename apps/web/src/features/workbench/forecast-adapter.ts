import {
  freshnessVerdict,
  LEGACY_WAVE_FALLBACK_CADENCE_MINUTES,
  LEGACY_WAVE_FALLBACK_GRACE_MINUTES,
  sourceFreshnessVerdict,
  type ApiSpot,
  type ForecastResponse,
  type FreshnessVerdict,
  type ScoredForecastWindow,
  type SourceFreshness,
  type SwellComponent,
  type WaveObservationSummary
} from "@surf/contracts";
import { cardinalDirection, confidenceLabel, localDateParts, surfaceCondition, windRelation } from "../../forecast-view";

export type ForecastInterval = "1h" | "3h";
export type WorkbenchView = "table" | "graph";
export type SpotTab = "forecast" | "analysis";
export type WaveSemantics = "direct_nearshore" | "cove_proxy" | "nws_fallback" | "unavailable";
export type WaveResolutionMethod = "exact" | "held" | "aggregated" | "unavailable";

export type WorkbenchSwell = {
  label: string;
  heightFt: number | null;
  periodSec: number | null;
  directionDeg: number | null;
};

export type WorkbenchWindow = {
  raw: ScoredForecastWindow;
  forecastAt: string;
  localDateKey: string;
  localHour: number;
  isDaylight: boolean;
  modeledHeightFt: number | null;
  periodSec: number | null;
  directionDeg: number | null;
  waveSemantics: WaveSemantics;
  waveSemanticsLabel: string;
  calibrationLabel: string;
  waveResolutionMethod: WaveResolutionMethod;
  resolutionHours: number | null;
  validFrom: string | null;
  validTo: string | null;
  swellComponents: WorkbenchSwell[];
  windSpeedKt: number | null;
  windGustKt: number | null;
  windDirectionDeg: number | null;
  windRelation: string;
  tideFt: number | null;
  tideTrend: string;
  condition: ReturnType<typeof surfaceCondition>;
  confidence: number;
  confidenceLabel: ReturnType<typeof confidenceLabel>;
  sourceFreshnessMinutes: number | null;
  dataHealth: "good" | "watch" | "limited";
  weatherSummary: string | null;
  explanation: string;
  caveats: string[];
};

export type TideEvent = {
  type: "high" | "low";
  at: string;
  heightFt: number;
};

export type SourceHealth = {
  id: string;
  label: string;
  ageMinutes: number | null;
  status: "fresh" | "stale" | "missing";
  issuedAt: string | null;
};

export type WorkbenchForecast = {
  interval: ForecastInterval;
  windows: WorkbenchWindow[];
  tideEvents: TideEvent[];
  sourceHealth: SourceHealth[];
  observations: WaveObservationSummary[];
  issueDelta: ForecastResponse["issueDelta"];
  generatedAt: string;
  sourceNote: string;
};

export type DailyBrief = {
  status: "model" | "deterministic_fallback" | "stale";
  provider: "google" | "deterministic";
  fallbackReason: string | null;
  availableRevisions: number | null;
  headline: string;
  setup: string;
  picks: Array<{ windowId: string | null; label: string | null; why: string; tradeoff: string | null }>;
  bustFactors: string[];
  lesson: { topic: string | null; text: string } | null;
  revision: number | null;
  generatedAt: string | null;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nestedValue(source: UnknownRecord, ...paths: string[][]): unknown {
  for (const path of paths) {
    let current: unknown = source;
    for (const key of path) {
      current = record(current)?.[key];
    }
    if (current !== undefined && current !== null) return current;
  }
  return null;
}

function addHours(value: string, hours: number): string {
  return new Date(new Date(value).getTime() + hours * 60 * 60 * 1000).toISOString();
}

function waveSemanticsFor(window: ScoredForecastWindow, raw: UnknownRecord): WaveSemantics {
  const explicit = stringValue(nestedValue(raw, ["waveState", "semantics"], ["waveSemantics"]));
  if (explicit === "direct_nearshore" || explicit === "cove_proxy" || explicit === "nws_fallback") {
    return explicit;
  }
  const relationship = window.waveProvenance?.pointRelationship;
  if (relationship === "direct_nearshore_point") return "direct_nearshore";
  if (relationship === "outside_cove_approach_proxy") return "cove_proxy";
  if (window.waveHeightFt !== null || window.waveProvenance || window.primarySwell || window.secondarySwell) {
    return "nws_fallback";
  }
  return "unavailable";
}

function semanticsLabel(semantics: WaveSemantics): string {
  if (semantics === "direct_nearshore") return "Modeled nearshore Hs";
  if (semantics === "cove_proxy") return "Nearby approach proxy";
  if (semantics === "nws_fallback") return "NWS coastal fallback";
  return "Wave state unavailable";
}

function calibrationLabel(semantics: WaveSemantics, raw: UnknownRecord): string {
  const explicit = stringValue(
    nestedValue(raw, ["waveState", "calibrationStatus"], ["calibrationStatus"])
  );
  if (explicit === "modeled_uncalibrated") return "Modeled · not spot-calibrated";
  if (explicit === "proxy_uncalibrated") return "Proxy · not spot-calibrated";
  if (explicit === "cold_start_uncalibrated") return "Cold-start · not spot-calibrated";
  if (explicit === "unavailable") return "Calibration unavailable";
  if (explicit) return explicit.replaceAll("_", " ");
  if (semantics === "direct_nearshore") return "Direct model point";
  if (semantics === "cove_proxy") return "Proxy — interpret cautiously";
  if (semantics === "nws_fallback") return "Cold-start fallback";
  return "Calibration unavailable";
}

function swellFromUnknown(value: unknown, label: string): WorkbenchSwell | null {
  const source = record(value);
  if (!source) return null;
  const heightFt = finiteNumber(source.heightFt);
  const periodSec = finiteNumber(source.periodSec);
  const directionDeg = finiteNumber(source.directionDeg);
  if (heightFt === null && periodSec === null && directionDeg === null) return null;
  return { label, heightFt, periodSec, directionDeg };
}

function currentSwellComponents(window: ScoredForecastWindow, semantics: WaveSemantics): WorkbenchSwell[] {
  if (semantics !== "nws_fallback") return [];
  return [
    swellFromUnknown(window.primarySwell satisfies SwellComponent | null, "Primary"),
    swellFromUnknown(window.secondarySwell satisfies SwellComponent | null, "Secondary")
  ].filter((value): value is WorkbenchSwell => value !== null);
}

function swellComponentsFor(window: ScoredForecastWindow, raw: UnknownRecord, semantics: WaveSemantics): WorkbenchSwell[] {
  const explicit = nestedValue(raw, ["waveState", "swellComponents"], ["swellComponents"]);
  if (Array.isArray(explicit)) {
    return explicit
      .map((value, index) => swellFromUnknown(value, index === 0 ? "Primary" : `Component ${index + 1}`))
      .filter((value): value is WorkbenchSwell => value !== null);
  }
  return currentSwellComponents(window, semantics);
}

function inferTideTrend(windows: WorkbenchWindow[], index: number): string {
  const current = windows[index];
  if (!current || current.tideFt === null) return "Trend unavailable";
  const next = windows[index + 1]?.tideFt;
  const previous = windows[index - 1]?.tideFt;
  const comparison = next ?? previous ?? null;
  if (comparison === null) return "Trend unavailable";
  const delta = next !== null && next !== undefined ? comparison - current.tideFt : current.tideFt - comparison;
  if (Math.abs(delta) < 0.08) return "Steady";
  return delta > 0 ? "Rising" : "Falling";
}

function dataHealthFor(
  window: ScoredForecastWindow,
  modeledHeightFt: number | null,
  resolutionMethod: WaveResolutionMethod,
  sourceAge: number | null,
  waveVerdict: FreshnessVerdict
): WorkbenchWindow["dataHealth"] {
  if (window.ratingStatus !== "scored" || modeledHeightFt === null || resolutionMethod === "unavailable") {
    return "limited";
  }
  if (sourceAge === null || waveVerdict === "late" || window.confidence < 50) return "limited";
  if (waveVerdict === "aging" || window.confidence < 75 || window.caveats.length > 0) return "watch";
  return "good";
}

// Verdict for the window's wave age. Cadence-bearing entries judge themselves
// via the shared contracts function; legacy payloads without an entry use the
// contracts-owned fallback expectations (the historical 360-minute boundary).
function waveVerdictFor(waveFreshness: SourceFreshness | undefined, sourceAge: number | null): FreshnessVerdict {
  if (waveFreshness && waveFreshness.expectedCadenceMinutes !== null && waveFreshness.expectedCadenceMinutes !== undefined) {
    return sourceFreshnessVerdict(waveFreshness) ?? "late";
  }
  return freshnessVerdict({
    ageMinutes: sourceAge,
    expectedCadenceMinutes: LEGACY_WAVE_FALLBACK_CADENCE_MINUTES,
    graceMinutes: LEGACY_WAVE_FALLBACK_GRACE_MINUTES
  });
}

function localMinuteOfDay(value: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone
  }).formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function phaseMinuteOfDay(value: string, timeZone: string): number | null {
  const clock = value.match(/^(\d{1,2}):(\d{2})/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : localMinuteOfDay(value, timeZone);
}

function adaptWindow(window: ScoredForecastWindow, spot: ApiSpot): WorkbenchWindow {
  const raw = window as unknown as UnknownRecord;
  const waveState = record(raw.waveState);
  const semantics = waveSemanticsFor(window, raw);
  const explicitResolutionMethod = stringValue(nestedValue(raw, ["resolution", "wave", "method"]));
  const waveResolutionMethod: WaveResolutionMethod =
    explicitResolutionMethod === "exact" ||
    explicitResolutionMethod === "held" ||
    explicitResolutionMethod === "aggregated" ||
    explicitResolutionMethod === "unavailable"
      ? explicitResolutionMethod
      : semantics === "unavailable"
        ? "unavailable"
        : "exact";
  const sourceIntervalMinutes = finiteNumber(
    nestedValue(raw, ["resolution", "wave", "sourceIntervalMinutes"])
  );
  const waveStateResolutionHours = finiteNumber(
    nestedValue(
      raw,
      ["waveState", "sourceResolutionHours"],
      ["waveState", "resolutionHours"],
      ["resolution", "waveHours"],
      ["fieldResolution", "waveHours"],
      ["waveResolutionHours"]
    )
  );
  const resolutionHours = sourceIntervalMinutes !== null
    ? sourceIntervalMinutes / 60
    : waveStateResolutionHours ?? (semantics === "unavailable" ? null : 3);
  const waveFreshness = window.sourceFreshness?.find(
    (source) => source.capability === "forecast_wave_nearshore" || source.capability === "forecast_wave_offshore"
  );
  const sourceAge = waveFreshness
    ? waveFreshness.freshnessMinutes
    : finiteNumber(
        nestedValue(
          raw,
          ["waveState", "sourceFreshnessMinutes"],
          ["sourceFreshnessMinutes"]
        )
      );
  const local = localDateParts(window.forecastAt, spot.timezone);
  const isDaylightValue = nestedValue(raw, ["daylight", "isDaylight"], ["isDaylight"]);
  const explicitTrend = stringValue(nestedValue(raw, ["tideState", "trend"], ["tideTrend"]));
  const modeledHeightFt =
    finiteNumber(waveState?.modeledNearshoreHeightFt) ?? finiteNumber(waveState?.heightFt) ?? window.waveHeightFt;
  const periodSec = finiteNumber(waveState?.periodSec) ?? window.peakPeriodSec;
  const directionDeg = finiteNumber(waveState?.directionDeg) ?? window.primaryDirectionDeg;
  const windGustKt = finiteNumber(nestedValue(raw, ["windState", "gustKt"], ["windGustKt"]));
  const validFrom = stringValue(
    nestedValue(raw, ["waveState", "validFrom"], ["resolution", "wave", "validFrom"], ["waveValidFrom"])
  );
  const validTo = stringValue(
    nestedValue(raw, ["waveState", "validTo"], ["resolution", "wave", "validTo"], ["waveValidTo"])
  );
  const legacyValidFrom = waveResolutionMethod === "unavailable" ? null : window.forecastAt;
  const legacyValidTo = waveResolutionMethod === "unavailable" || resolutionHours === null
    ? null
    : addHours(window.forecastAt, resolutionHours);
  return {
    raw: window,
    forecastAt: window.forecastAt,
    localDateKey: local.key,
    localHour: local.hour,
    isDaylight: typeof isDaylightValue === "boolean" ? isDaylightValue : local.hour >= 6 && local.hour < 18,
    modeledHeightFt,
    periodSec,
    directionDeg,
    waveSemantics: semantics,
    waveSemanticsLabel: semanticsLabel(semantics),
    calibrationLabel: calibrationLabel(semantics, raw),
    waveResolutionMethod,
    resolutionHours,
    validFrom: validFrom ?? legacyValidFrom,
    validTo: validTo ?? legacyValidTo,
    swellComponents: swellComponentsFor(window, raw, semantics),
    windSpeedKt: window.windSpeedKt,
    windGustKt: windGustKt ?? window.windGustKt ?? null,
    windDirectionDeg: window.windDirectionDeg,
    windRelation: windRelation(spot, window),
    tideFt: window.tideFt,
    tideTrend: explicitTrend ? explicitTrend[0]!.toUpperCase() + explicitTrend.slice(1) : "",
    condition: window.surfaceCondition ?? surfaceCondition(spot, window),
    confidence: window.confidence,
    confidenceLabel: confidenceLabel(window.confidence),
    sourceFreshnessMinutes: sourceAge,
    dataHealth: dataHealthFor(
      window,
      modeledHeightFt,
      waveResolutionMethod,
      sourceAge,
      waveVerdictFor(waveFreshness, sourceAge)
    ),
    weatherSummary:
      stringValue(nestedValue(raw, ["weather", "summary"], ["weatherSummary"])) ?? window.weatherSummary ?? null,
    explanation: window.explanation,
    caveats: window.caveats
  };
}

function adaptTideEvents(response: UnknownRecord): TideEvent[] {
  const events = nestedValue(response, ["tideEvents"]);
  if (!Array.isArray(events)) return [];
  return events.flatMap((value) => {
    const item = record(value);
    if (!item) return [];
    const rawType = stringValue(item.type)?.toLowerCase() ?? stringValue(item.eventType)?.toLowerCase();
    const type = rawType?.includes("high") ? "high" : rawType?.includes("low") ? "low" : null;
    const at = stringValue(item.eventAt) ?? stringValue(item.at) ?? stringValue(item.predictedAt);
    const heightFt = finiteNumber(item.heightFtMllw) ?? finiteNumber(item.heightFt);
    return type && at && heightFt !== null ? [{ type, at, heightFt }] : [];
  });
}

const capabilityLabels: Record<string, string> = {
  forecast_wave_offshore: "Offshore wave model",
  forecast_wave_nearshore: "Nearshore wave model",
  observed_wave: "Buoy observation",
  tide: "NOAA tide",
  wind: "NWS wind",
  hazard: "NWS hazards",
  bathymetry: "Bathymetry",
  quality_label: "Quality label",
  comparison_forecast: "Comparison forecast"
};

export function sourceHealthForWindow(window: WorkbenchWindow): SourceHealth[] {
  const exact = window.raw.sourceFreshness ?? [];
  if (exact.length > 0) {
    return exact.map((source) => ({
      id: `${source.capability}:${source.sourceId}`,
      label: capabilityLabels[source.capability] ?? source.capability.replaceAll("_", " "),
      ageMinutes: source.freshnessMinutes,
      status: source.status,
      issuedAt: source.updatedAt
    }));
  }
  if (window.raw.waveProvenance) {
    return [{
      id: `forecast_wave_nearshore:${window.raw.waveProvenance.sourceId}`,
      label: window.raw.waveProvenance.provider,
      ageMinutes: window.sourceFreshnessMinutes,
      status: legacyAgeStatus(window.sourceFreshnessMinutes),
      issuedAt: window.raw.waveProvenance.sourceUpdatedAt
    }];
  }
  return [];
}

// Legacy provenance/untyped rows carry an age but no cadence; the boundary
// comes from the contracts fallback constants, never a local threshold.
function legacyAgeStatus(ageMinutes: number | null): SourceHealth["status"] {
  if (ageMinutes === null) return "missing";
  const verdict = freshnessVerdict({
    ageMinutes,
    expectedCadenceMinutes: LEGACY_WAVE_FALLBACK_CADENCE_MINUTES,
    graceMinutes: LEGACY_WAVE_FALLBACK_GRACE_MINUTES
  });
  return verdict === "late" ? "stale" : "fresh";
}

function adaptSourceHealth(response: UnknownRecord, windows: WorkbenchWindow[]): SourceHealth[] {
  const exact = windows.flatMap((window) => window.raw.sourceFreshness ?? []);
  if (exact.length > 0) {
    const bySource = new Map<string, SourceHealth>();
    for (const source of exact) {
      const id = `${source.capability}:${source.sourceId}`;
      if (bySource.has(id)) continue;
      bySource.set(id, {
        id,
        label: capabilityLabels[source.capability] ?? source.capability.replaceAll("_", " "),
        ageMinutes: source.freshnessMinutes,
        status: source.status,
        issuedAt: source.updatedAt
      });
    }
    return [...bySource.values()];
  }
  const values = nestedValue(response, ["sourceFreshness"], ["sourceHealth"], ["sources"]);
  if (Array.isArray(values)) {
    const mapped = values.flatMap((value, index) => {
      const item = record(value);
      if (!item) return [];
      const ageMinutes = finiteNumber(item.ageMinutes) ?? finiteNumber(item.freshnessMinutes);
      return [{
        id: stringValue(item.id) ?? `source-${index}`,
        label: stringValue(item.label) ?? stringValue(item.provider) ?? `Source ${index + 1}`,
        ageMinutes,
        status: legacyAgeStatus(ageMinutes),
        issuedAt: stringValue(item.issuedAt) ?? stringValue(item.sourceUpdatedAt)
      }];
    });
    if (mapped.length > 0) return mapped;
  }
  return windows[0] ? sourceHealthForWindow(windows[0]) : [];
}

function adaptObservations(response: ForecastResponse, raw: UnknownRecord): WaveObservationSummary[] {
  const observations = nestedValue(raw, ["observations"], ["recentObservations"]);
  if (Array.isArray(observations)) return observations as WaveObservationSummary[];
  return response.observation ? [response.observation] : [];
}

export function adaptForecastResponse(
  response: ForecastResponse,
  spot: ApiSpot,
  requestedInterval: ForecastInterval
): WorkbenchForecast {
  const raw = response as unknown as UnknownRecord;
  const explicitInterval = stringValue(raw.interval);
  const interval = explicitInterval === "1h" || explicitInterval === "3h" ? explicitInterval : requestedInterval;
  const windows = response.windows
    .map((window) => adaptWindow(window, spot))
    .sort((left, right) => left.forecastAt.localeCompare(right.forecastAt));
  for (const window of windows) {
    const phase = response.sunPhases?.find((candidate) => candidate.localDate === window.localDateKey);
    if (!phase) continue;
    const firstLight = phaseMinuteOfDay(phase.firstLight, spot.timezone);
    const lastLight = phaseMinuteOfDay(phase.lastLight, spot.timezone);
    const windowMinute = localMinuteOfDay(window.forecastAt, spot.timezone);
    if (firstLight !== null && lastLight !== null) {
      window.isDaylight = windowMinute >= firstLight && windowMinute <= lastLight;
    }
  }
  windows.forEach((window, index) => {
    if (!window.tideTrend) window.tideTrend = inferTideTrend(windows, index);
  });
  return {
    interval,
    windows,
    tideEvents: adaptTideEvents(raw),
    sourceHealth: adaptSourceHealth(raw, windows),
    observations: adaptObservations(response, raw),
    issueDelta: response.issueDelta,
    generatedAt: response.generatedAt,
    sourceNote: response.sourceNote
  };
}

export function availableWorkbenchDates(windows: WorkbenchWindow[]): string[] {
  return [...new Set(windows.map((window) => window.localDateKey))].sort().slice(0, 5);
}

export function formatSwell(component: WorkbenchSwell): string {
  const height = component.heightFt === null ? "—" : `${component.heightFt.toFixed(1)} ft`;
  const period = component.periodSec === null ? "—" : `${component.periodSec.toFixed(0)}s`;
  return `${height} @ ${period} ${cardinalDirection(component.directionDeg)}`;
}

export function parseBriefResponse(payload: unknown): DailyBrief | null {
  const envelope = record(payload);
  if (!envelope) return null;
  const source = record(envelope.brief) ?? envelope;
  const headline = stringValue(source.headline);
  const setup = stringValue(source.setup) ?? stringValue(source.summary);
  if (!headline || !setup) return null;
  const picks = Array.isArray(source.picks)
    ? source.picks.flatMap((value) => {
        const pick = record(value);
        const why = pick ? stringValue(pick.why) ?? stringValue(pick.explanation) : null;
        return why
          ? [{
              windowId: stringValue(pick?.windowId),
              label: stringValue(pick?.label),
              why,
              tradeoff: stringValue(pick?.tradeoff)
            }]
          : [];
      })
    : [];
  const bustFactors = Array.isArray(source.bustFactors)
    ? source.bustFactors
        .map((value) => stringValue(value) ?? stringValue(record(value)?.text))
        .filter((value): value is string => value !== null)
    : [];
  const lessonRecord = record(source.lesson) ?? record(source.learningNote);
  const lessonText = lessonRecord
    ? stringValue(lessonRecord.text) ?? stringValue(lessonRecord.explanation)
    : stringValue(source.lesson);
  const rawStatus = stringValue(envelope.status);
  const rawProvider = stringValue(source.provider);
  const status = rawStatus === "model" || rawStatus === "deterministic_fallback" || rawStatus === "stale"
    ? rawStatus
    : rawProvider === "google"
      ? "model"
      : "deterministic_fallback";
  const provider = rawProvider === "google" && status === "model" ? "google" : "deterministic";
  return {
    status,
    provider,
    fallbackReason: stringValue(envelope.fallbackReason),
    availableRevisions: finiteNumber(envelope.availableRevisions),
    headline,
    setup,
    picks,
    bustFactors,
    lesson: lessonText
      ? { topic: lessonRecord ? stringValue(lessonRecord.topic) : null, text: lessonText }
      : null,
    revision: finiteNumber(source.revision),
    generatedAt: (() => {
      const value = stringValue(source.generatedAt);
      return value && Number.isFinite(new Date(value).getTime()) ? value : null;
    })()
  };
}

export function readWorkbenchUrl(search: string): {
  interval: ForecastInterval;
  view: WorkbenchView;
  tab: SpotTab;
  date: string | null;
  at: string | null;
} {
  const params = new URLSearchParams(search);
  return {
    interval: params.get("interval") === "1h" ? "1h" : "3h",
    view: params.get("view") === "graph" ? "graph" : "table",
    tab: params.get("tab") === "analysis" ? "analysis" : "forecast",
    // Only a well-formed date key may become workbench state; anything else is
    // discarded so the normal date-selection effect picks a real day.
    date: /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date") : null,
    at: params.get("at")
  };
}

export function replaceWorkbenchUrl(
  patch: Partial<{
    interval: ForecastInterval;
    view: WorkbenchView;
    tab: string | null;
    date: string | null;
    at: string | null;
  }>
): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
