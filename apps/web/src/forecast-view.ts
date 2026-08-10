import type {
  ForecastRecommendationWindow,
  ForecastResponse,
  ScoredForecastWindow,
  SpotId,
  SpotProfile
} from "@surf/contracts";
import {
  directionInCircularWindow,
  selectCanonicalRecommendationWindows,
  surfSizeRange,
  surfaceConditionForWind,
  type SurfaceCondition as CoreSurfaceCondition
} from "@surf/forecast-core";

export type SurfaceCondition = CoreSurfaceCondition;

export type LocalDateParts = {
  key: string;
  year: number;
  month: number;
  day: number;
  hour: number;
};

const DAYTIME_START_HOUR = 6;
const DAYTIME_END_HOUR = 18;

export function selectedSpotIdFromSearch(
  search: string,
  availableSpotIds: readonly SpotId[]
): SpotId | null {
  const value = new URLSearchParams(search).get("spot");
  return value && availableSpotIds.some((spotId) => spotId === value) ? value : null;
}

export function localDateParts(value: string | Date, timeZone: string): LocalDateParts {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    timeZone
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? Number.NaN);
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const hour = part("hour");
  return {
    key: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
      .toString()
      .padStart(2, "0")}`,
    year,
    month,
    day,
    hour
  };
}

export function isPlanningWindow(
  window: ScoredForecastWindow,
  timeZone: string,
  now = new Date(),
  sunPhases?: ForecastResponse["sunPhases"]
): boolean {
  const forecastAt = new Date(window.forecastAt);
  if (Number.isNaN(forecastAt.getTime()) || forecastAt.getTime() < now.getTime()) return false;
  const local = localDateParts(forecastAt, timeZone);
  const phase = sunPhases?.find((candidate) => candidate.localDate === local.key);
  if (!phase) return local.hour >= DAYTIME_START_HOUR && local.hour < DAYTIME_END_HOUR;
  const minute = localMinuteOfDay(forecastAt, timeZone);
  const firstLight = phaseMinuteOfDay(phase.firstLight, timeZone);
  const lastLight = phaseMinuteOfDay(phase.lastLight, timeZone);
  return firstLight !== null && lastLight !== null && minute >= firstLight && minute <= lastLight;
}

function localMinuteOfDay(value: string | Date, timeZone: string): number {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? Number.NaN);
  return part("hour") * 60 + part("minute");
}

function phaseMinuteOfDay(value: string, timeZone: string): number | null {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return localMinuteOfDay(parsed, timeZone);
  const clock = value.match(/^(\d{1,2}):(\d{2})/);
  return clock ? Number(clock[1]) * 60 + Number(clock[2]) : null;
}

export function surfaceCondition(
  spot: SpotProfile,
  window: Pick<ScoredForecastWindow, "windSpeedKt" | "windDirectionDeg">
): SurfaceCondition {
  return surfaceConditionForWind(spot, window);
}

export function windRelation(
  spot: SpotProfile,
  window: Pick<ScoredForecastWindow, "windSpeedKt" | "windDirectionDeg">
): string {
  const speed = window.windSpeedKt;
  const direction = window.windDirectionDeg;
  if (speed === null || direction === null) return "Wind unavailable";
  if (speed <= 3) return "Light / glassy";
  if (directionInCircularWindow(direction, spot.offshoreWindFromDeg.minDeg, spot.offshoreWindFromDeg.maxDeg)) {
    return speed <= spot.maxOkWindKt ? "Offshore" : "Strong offshore";
  }
  return surfaceCondition(spot, window) === "choppy" ? "Onshore" : "Cross-shore";
}

export function cardinalDirection(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const labels = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW"
  ];
  return labels[Math.round((((value % 360) + 360) % 360) / 22.5) % 16] ?? "—";
}

export function surfHeightRange(value: number | null): string {
  return surfSizeRange(value);
}

export function confidenceLabel(value: number): "High" | "Medium" | "Low" {
  if (value >= 75) return "High";
  if (value >= 50) return "Medium";
  return "Low";
}

export type BestWindowSelection = {
  window: ScoredForecastWindow;
  constituentWindowIds: string[];
  startAt: string;
  endAt: string;
};

export function bestWindowSelection(
  spot: SpotProfile,
  windows: ScoredForecastWindow[],
  now = new Date(),
  dateKey?: string,
  sunPhases?: ForecastResponse["sunPhases"],
  recommendations?: ForecastRecommendationWindow[]
): BestWindowSelection | undefined {
  const published = recommendations?.find(
    (recommendation) =>
      (!dateKey || recommendation.localDate === dateKey) &&
      new Date(recommendation.endAt).getTime() >= now.getTime()
  );
  if (published) {
    return {
      window: published.representative,
      constituentWindowIds: published.constituentWindowIds,
      startAt: published.startAt,
      endAt: published.endAt
    };
  }
  // A present recommendation projection is authoritative, including an empty
  // list or a date with no remaining recommendation. Only legacy payloads
  // which omit the field entirely may derive a coarse fallback in the client.
  if (recommendations !== undefined) return undefined;

  const candidates = windows
    .filter(
      (window) =>
        !dateKey || localDateParts(window.forecastAt, spot.timezone).key === dateKey
    )
    .map((window) => {
      const localDate = localDateParts(window.forecastAt, spot.timezone).key;
      const phase = sunPhases?.find((candidate) => candidate.localDate === localDate);
      return {
        windowId: window.forecastAt,
        forecastAt: window.forecastAt,
        isDaylight: isPlanningWindow(window, spot.timezone, new Date(0), sunPhases),
        civilLightStartAt: phase?.firstLight ?? null,
        civilLightEndAt: phase?.lastLight ?? null,
        ratingStatus: window.ratingStatus,
        surfaceCondition: window.surfaceCondition ?? surfaceCondition(spot, window),
        score: window.score,
        confidence: window.confidence
      };
    });
  const selection = selectCanonicalRecommendationWindows(candidates, now)[0];
  const window = selection
    ? windows.find((candidate) => candidate.forecastAt === selection.representativeWindowId)
    : undefined;
  if (!selection || !window) return undefined;

  // Compatibility for a pre-recommendation 3h payload: core grouping is
  // intentionally hourly, so preserve the coarser row's actual display span
  // only when no published hourly boundaries were available.
  const sortedTimes = windows
    .map((candidate) => new Date(candidate.forecastAt).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const positiveGaps = sortedTimes.flatMap((time, index) => {
    const next = sortedTimes[index + 1];
    return next !== undefined && next > time ? [next - time] : [];
  });
  const roundedGapHours = positiveGaps.map((gap) => Math.round(gap / (60 * 60 * 1000)));
  const commonGapHours = [...new Set(roundedGapHours)]
    .map((hours) => ({
      hours,
      count: roundedGapHours.filter((candidate) => candidate === hours).length
    }))
    .sort((left, right) => right.count - left.count || left.hours - right.hours)[0]?.hours ?? 3;
  const isHourlyPayload = commonGapHours <= 1;
  const localDate = localDateParts(window.forecastAt, spot.timezone).key;
  const windowStartMs = new Date(window.forecastAt).getTime();
  const nextSameDateMs = sortedTimes.find(
    (candidate) =>
      candidate > windowStartMs &&
      localDateParts(new Date(candidate), spot.timezone).key === localDate
  );
  // For coarse local-time rows, the next row is the correct boundary across
  // 23/25-hour DST days (00:00→03:00 can be two or four real hours). Hourly
  // payloads retain a one-hour display interval even when a row is missing.
  const inferredEndMs = isHourlyPayload
    ? windowStartMs + 60 * 60 * 1000
    : nextSameDateMs ?? windowStartMs + 3 * 60 * 60 * 1000;
  const phaseEndMs = sunPhases
    ?.find((phase) => phase.localDate === localDate)
    ?.lastLight;
  const clippedFallbackEndMs = phaseEndMs
    ? Math.min(inferredEndMs, new Date(phaseEndMs).getTime())
    : inferredEndMs;
  return {
    window,
    constituentWindowIds: selection.constituentWindowIds,
    startAt: selection.startAt,
    endAt:
      selection.constituentWindowIds.length === 1 && !isHourlyPayload
        ? new Date(clippedFallbackEndMs).toISOString()
        : selection.endAt
  };
}

export function bestWindow(
  spot: SpotProfile,
  windows: ScoredForecastWindow[],
  now = new Date(),
  dateKey?: string,
  sunPhases?: ForecastResponse["sunPhases"],
  recommendations?: ForecastRecommendationWindow[]
): ScoredForecastWindow | undefined {
  return bestWindowSelection(
    spot,
    windows,
    now,
    dateKey,
    sunPhases,
    recommendations
  )?.window;
}

export function availableLocalDateKeys(
  spot: SpotProfile,
  windows: ScoredForecastWindow[],
  now = new Date(),
  sunPhases?: ForecastResponse["sunPhases"]
): string[] {
  return [...new Set(windows.filter((window) => isPlanningWindow(window, spot.timezone, now, sunPhases)).map((window) =>
    localDateParts(window.forecastAt, spot.timezone).key
  ))].sort();
}

/**
 * Dates that can be inspected in the workbench, including elapsed dates whose
 * rows remain useful context. Recommendation eligibility is intentionally a
 * separate concern handled by `availableLocalDateKeys`.
 */
export function availableDisplayLocalDateKeys(
  spot: SpotProfile,
  windows: ScoredForecastWindow[]
): string[] {
  return [...new Set(windows.map((window) =>
    localDateParts(window.forecastAt, spot.timezone).key
  ))].sort();
}

export function earliestAvailableLocalDateKey(
  forecasts: Array<{
    spot: SpotProfile;
    windows: ScoredForecastWindow[];
    sunPhases?: ForecastResponse["sunPhases"];
  }>,
  now = new Date()
): string | null {
  return forecasts
    .flatMap(({ spot, windows, sunPhases }) =>
      availableLocalDateKeys(
        spot,
        windows.filter((window) => window.ratingStatus === "scored"),
        now,
        sunPhases
      )
    )
    .sort()[0] ?? null;
}

export function formatDay(value: string, timeZone: string, includeDate = true): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    ...(includeDate ? { month: "short", day: "numeric" } : {}),
    timeZone
  }).format(new Date(value));
}

export function formatClock(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    timeZone
  }).format(new Date(value));
}

export function formatWindowSpan(value: string, timeZone: string, endAt?: string): string {
  const start = new Date(value);
  const end = endAt ? new Date(endAt) : new Date(start.getTime() + 3 * 60 * 60 * 1000);
  const minute = (date: Date) => Number(
    new Intl.DateTimeFormat("en-US", {
      minute: "2-digit",
      timeZone
    }).formatToParts(date).find((part) => part.type === "minute")?.value ?? 0
  );
  const showMinutes = minute(start) !== 0 || minute(end) !== 0;
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    ...(showMinutes ? { minute: "2-digit" as const } : {}),
    timeZone
  });
  return `${formatter.format(start)}–${formatter.format(end)}`;
}
