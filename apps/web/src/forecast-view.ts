import type { ForecastResponse, ScoredForecastWindow, SpotId, SpotProfile } from "@surf/contracts";
import {
  directionInCircularWindow,
  selectCanonicalRecommendationIds,
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
  if (value === null || !Number.isFinite(value)) return "Size unavailable";
  if (value < 1) return "0–1 ft";
  if (value >= 10) return `${Math.round(value)} ft+`;
  const rounded = Math.round(value * 10) / 10;
  const lower = Number.isInteger(rounded) ? Math.max(0, rounded - 1) : Math.floor(rounded);
  const upper = Math.max(lower + 1, Math.ceil(rounded));
  return `${lower}–${upper} ft`;
}

export function confidenceLabel(value: number): "High" | "Medium" | "Low" {
  if (value >= 75) return "High";
  if (value >= 50) return "Medium";
  return "Low";
}

export function calmestWindow(
  spot: SpotProfile,
  windows: ScoredForecastWindow[],
  now = new Date(),
  dateKey?: string,
  sunPhases?: ForecastResponse["sunPhases"]
): ScoredForecastWindow | undefined {
  const eligible = windows.filter(
    (window) =>
      (!dateKey || localDateParts(window.forecastAt, spot.timezone).key === dateKey) &&
      isPlanningWindow(window, spot.timezone, now, sunPhases)
  );
  const selectedId = selectCanonicalRecommendationIds(
    eligible.map((window) => ({
      windowId: window.forecastAt,
      forecastAt: window.forecastAt,
      isDaylight: true,
      ratingStatus: window.ratingStatus,
      surfaceCondition: window.surfaceCondition ?? surfaceCondition(spot, window),
      score: window.score,
      confidence: window.confidence
    })),
    now
  )[0];
  return eligible.find((window) => window.forecastAt === selectedId);
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

export function formatWindowSpan(value: string, timeZone: string): string {
  const start = new Date(value);
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    timeZone
  });
  return `${formatter.format(start)}–${formatter.format(end)}`;
}
