import type { ForecastInterval } from "./forecast-adapter";

const HOUR_MS = 60 * 60 * 1000;

export function nextLocalDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}

export function zonedLocalTimeMs(dateKey: string, hour: number, timezone: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: timezone
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
    const represented = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second")
    );
    const correction = target - represented;
    guess += correction;
    if (correction === 0) break;
  }
  return guess;
}

export function localHourForTimestamp(timestamp: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: timezone
  });
  return Number(
    formatter.formatToParts(new Date(timestamp)).find((part) => part.type === "hour")?.value
  );
}

export function localDayDomain(
  dateKey: string,
  timezone: string
): { start: number; end: number } {
  return {
    start: zonedLocalTimeMs(dateKey, 0, timezone),
    end: zonedLocalTimeMs(nextLocalDateKey(dateKey), 0, timezone)
  };
}

export function forecastSlotTimestamps(
  dateKey: string,
  interval: ForecastInterval,
  timezone: string
): number[] {
  const { start, end } = localDayDomain(dateKey, timezone);
  const hourlyInstants: number[] = [];
  for (let timestamp = start; timestamp < end; timestamp += HOUR_MS) {
    hourlyInstants.push(timestamp);
  }
  return interval === "1h"
    ? hourlyInstants
    : hourlyInstants.filter((timestamp) => localHourForTimestamp(timestamp, timezone) % 3 === 0);
}

export function expectedForecastSlotCount(
  dateKey: string,
  interval: ForecastInterval,
  timezone: string
): number {
  return forecastSlotTimestamps(dateKey, interval, timezone).length;
}
