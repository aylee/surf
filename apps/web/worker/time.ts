const ONE_HOUR_MS = 60 * 60 * 1000;
const DEG_TO_RAD = Math.PI / 180;

export type SolarPhases = {
  localDate: string;
  firstLight: string;
  sunrise: string;
  sunset: string;
  lastLight: string;
};

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function localDateAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function solarUtcHour(
  year: number,
  month: number,
  day: number,
  lat: number,
  lon: number,
  zenithDeg: number,
  rising: boolean
): number | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const startOfYear = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000) + 1;
  const longitudeHour = lon / 15;
  const approximateTime =
    dayOfYear + ((rising ? 6 : 18) - longitudeHour) / 24;
  const meanAnomaly = 0.9856 * approximateTime - 3.289;
  const trueLongitude = normalizeDegrees(
    meanAnomaly +
      1.916 * Math.sin(meanAnomaly * DEG_TO_RAD) +
      0.02 * Math.sin(2 * meanAnomaly * DEG_TO_RAD) +
      282.634
  );
  let rightAscension = normalizeDegrees(
    Math.atan(0.91764 * Math.tan(trueLongitude * DEG_TO_RAD)) / DEG_TO_RAD
  );
  rightAscension +=
    Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;

  const sinDeclination = 0.39782 * Math.sin(trueLongitude * DEG_TO_RAD);
  const cosDeclination = Math.cos(Math.asin(sinDeclination));
  const cosHour =
    (Math.cos(zenithDeg * DEG_TO_RAD) -
      sinDeclination * Math.sin(lat * DEG_TO_RAD)) /
    (cosDeclination * Math.cos(lat * DEG_TO_RAD));
  if (cosHour < -1 || cosHour > 1) return null;

  const hourAngle = rising
    ? 360 - Math.acos(cosHour) / DEG_TO_RAD
    : Math.acos(cosHour) / DEG_TO_RAD;
  const localMeanTime =
    hourAngle / 15 + rightAscension - 0.06571 * approximateTime - 6.622;
  return ((localMeanTime - longitudeHour) % 24 + 24) % 24;
}

function solarInstant(
  localDate: string,
  lat: number,
  lon: number,
  timeZone: string,
  zenithDeg: number,
  rising: boolean
): string | null {
  const [year, month, day] = localDate.split("-").map(Number);
  if (!year || !month || !day) return null;
  const utcHour = solarUtcHour(year, month, day, lat, lon, zenithDeg, rising);
  if (utcHour === null) return null;
  const baseMs = Date.UTC(year, month - 1, day) + utcHour * ONE_HOUR_MS;
  for (const dayOffset of [-1, 0, 1]) {
    const candidate = new Date(baseMs + dayOffset * 24 * ONE_HOUR_MS);
    if (localDateAt(candidate, timeZone) === localDate) return candidate.toISOString();
  }
  return null;
}

export function solarPhasesForDates(
  localDates: string[],
  location: { lat: number; lon: number; timeZone: string }
): SolarPhases[] {
  return [...new Set(localDates)].sort().flatMap((localDate) => {
    const firstLight = solarInstant(localDate, location.lat, location.lon, location.timeZone, 96, true);
    const sunrise = solarInstant(localDate, location.lat, location.lon, location.timeZone, 90.833, true);
    const sunset = solarInstant(localDate, location.lat, location.lon, location.timeZone, 90.833, false);
    const lastLight = solarInstant(localDate, location.lat, location.lon, location.timeZone, 96, false);
    if (!firstLight || !sunrise || !sunset || !lastLight) return [];
    return [{ localDate, firstLight, sunrise, sunset, lastLight }];
  });
}

export function localDateForTime(forecastAt: string, timeZone: string): string {
  return localDateAt(new Date(forecastAt), timeZone);
}

export function stableHourlyForecastTimes(now: Date, horizonHours = 120): string[] {
  const count = Math.floor(horizonHours) + 1;
  const firstHourMs = Math.ceil(now.getTime() / ONE_HOUR_MS) * ONE_HOUR_MS;
  return Array.from({ length: count }, (_, index) =>
    new Date(firstHourMs + index * ONE_HOUR_MS).toISOString()
  );
}

export function stableThreeHourForecastTimes(
  now: Date,
  horizonHours = 120,
  timeZone = "America/Los_Angeles"
): string[] {
  const count = Math.floor(horizonHours / 3) + 1;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23"
  });
  let candidateMs = Math.ceil(now.getTime() / ONE_HOUR_MS) * ONE_HOUR_MS;
  const times: string[] = [];

  // Iterating UTC hours keeps this correct through local daylight-saving gaps and folds.
  while (times.length < count) {
    const candidate = new Date(candidateMs);
    const hour = Number(formatter.formatToParts(candidate).find((part) => part.type === "hour")?.value);
    if (Number.isInteger(hour) && hour % 3 === 0) times.push(candidate.toISOString());
    candidateMs += ONE_HOUR_MS;
  }

  return times;
}

export function threeHourValidityFor(
  forecastAt: string,
  timeZone = "America/Los_Angeles"
): { validFrom: string; validTo: string } {
  const targetMs = new Date(forecastAt).getTime();
  if (!Number.isFinite(targetMs)) throw new Error("forecastAt must be an ISO-8601 timestamp");

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23"
  });
  let validFromMs = Math.floor(targetMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  for (let searched = 0; searched < 4; searched += 1) {
    const candidate = new Date(validFromMs);
    const hour = Number(
      formatter.formatToParts(candidate).find((part) => part.type === "hour")?.value
    );
    if (Number.isInteger(hour) && hour % 3 === 0) {
      let validToMs = validFromMs + 3 * ONE_HOUR_MS;
      for (let ahead = 1; ahead <= 5; ahead += 1) {
        const nextMs = validFromMs + ahead * ONE_HOUR_MS;
        const nextHour = Number(
          formatter
            .formatToParts(new Date(nextMs))
            .find((part) => part.type === "hour")?.value
        );
        if (Number.isInteger(nextHour) && nextHour % 3 === 0) {
          validToMs = nextMs;
          break;
        }
      }
      return {
        validFrom: candidate.toISOString(),
        validTo: new Date(validToMs).toISOString()
      };
    }
    validFromMs -= ONE_HOUR_MS;
  }

  throw new Error(`Could not resolve a three-hour validity interval for ${forecastAt}.`);
}
