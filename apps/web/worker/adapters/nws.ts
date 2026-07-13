import type { SpotId, SpotProfile } from "@surf/contracts";
import type { AdapterOutcome, SourceCaveat, SourceFetch } from "./types";
import { combineStatus, errorMessage } from "./types";
import { PUBLIC_FEED_USER_AGENT } from "./http";

export type NwsWindForecastRow = {
  spotId: SpotId;
  issuedAt: string | null;
  forecastAt: string;
  periodEndAt: string | null;
  windSpeedKt: number | null;
  windDirectionDeg: number | null;
  gustKt: number | null;
  shortForecast: string | null;
  sourceUrl: string;
};

export type NwsHazard = {
  spotId: SpotId;
  event: string;
  severity: string | null;
  urgency: string | null;
  certainty: string | null;
  headline: string | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  sourceUrl: string;
};

export type NwsContextRow = {
  spotId: SpotId;
  pointUrl: string;
  forecastUrl: string | null;
  alertsUrl: string;
  office: string | null;
  gridX: number | null;
  gridY: number | null;
  forecastZone: string | null;
  windForecasts: NwsWindForecastRow[];
  hazards: NwsHazard[];
};

type NwsPointResponse = {
  properties?: {
    forecast?: unknown;
    forecastHourly?: unknown;
    forecastGridData?: unknown;
    forecastZone?: unknown;
    gridId?: unknown;
    gridX?: unknown;
    gridY?: unknown;
  };
};

type NwsForecastPeriod = {
  startTime?: unknown;
  endTime?: unknown;
  windSpeed?: unknown;
  windGust?: unknown;
  windDirection?: unknown;
  shortForecast?: unknown;
};

type NwsForecastResponse = {
  properties?: {
    updated?: unknown;
    generatedAt?: unknown;
    periods?: NwsForecastPeriod[];
  };
};

type NwsAlertFeature = {
  properties?: {
    event?: unknown;
    severity?: unknown;
    urgency?: unknown;
    certainty?: unknown;
    headline?: unknown;
    effective?: unknown;
    expires?: unknown;
  };
};

type NwsAlertsResponse = {
  features?: NwsAlertFeature[];
};

export type NwsMetadata = {
  spotCount: number;
  windRowCount: number;
  hazardCount: number;
  requestUrls: string[];
};

const NWS_BASE_URL = "https://api.weather.gov";
const MPH_TO_KT = 0.868976;

const DIRECTION_DEGREES: Record<string, number> = {
  N: 0,
  NNE: 23,
  NE: 45,
  ENE: 68,
  E: 90,
  ESE: 113,
  SE: 135,
  SSE: 158,
  S: 180,
  SSW: 203,
  SW: 225,
  WSW: 248,
  W: 270,
  WNW: 293,
  NW: 315,
  NNW: 338
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoOrNull(value: unknown): string | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function buildNwsPointUrl(lat: number, lon: number): string {
  return `${NWS_BASE_URL}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
}

export function buildNwsAlertsUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({ point: `${lat.toFixed(4)},${lon.toFixed(4)}` });
  return `${NWS_BASE_URL}/alerts/active?${params.toString()}`;
}

function nwsHeaders(): HeadersInit {
  return {
    Accept: "application/geo+json",
    "User-Agent": PUBLIC_FEED_USER_AGENT
  };
}

function parseWindDirectionDeg(value: unknown): number | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const compact = text.trim().toUpperCase();
  return DIRECTION_DEGREES[compact] ?? null;
}

function parseSpeedKt(value: unknown): number | null {
  const text = stringOrNull(value);
  if (!text) return null;
  const numbers = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  const finite = numbers.filter((candidate) => Number.isFinite(candidate));
  if (finite.length === 0) return null;
  const averageMph = finite.reduce((sum, candidate) => sum + candidate, 0) / finite.length;
  return Math.round(averageMph * MPH_TO_KT * 10) / 10;
}

async function readJson<T>(fetcher: SourceFetch, url: string): Promise<T> {
  const response = await fetcher(url, { headers: nwsHeaders() });
  if (!response.ok) {
    throw new Error(`NWS returned HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

function forecastUrlFromPoint(point: NwsPointResponse, caveats: SourceCaveat[]): string | null {
  const forecastHourly = stringOrNull(point.properties?.forecastHourly);
  if (forecastHourly) return forecastHourly;

  const forecast = stringOrNull(point.properties?.forecast);
  if (forecast) {
    caveats.push({
      code: "nws_forecast_hourly_missing",
      message: "NWS point metadata did not include forecastHourly; using period forecast instead."
    });
    return forecast;
  }

  return null;
}

async function fetchSpotContext(fetcher: SourceFetch, spot: SpotProfile): Promise<{
  row: NwsContextRow | null;
  requestUrls: string[];
  caveats: SourceCaveat[];
  errors: string[];
}> {
  const pointUrl = buildNwsPointUrl(spot.lat, spot.lon);
  const alertsUrl = buildNwsAlertsUrl(spot.lat, spot.lon);
  const requestUrls = [pointUrl, alertsUrl];
  const caveats: SourceCaveat[] = [];
  const errors: string[] = [];

  try {
    const point = await readJson<NwsPointResponse>(fetcher, pointUrl);
    const forecastUrl = forecastUrlFromPoint(point, caveats);
    if (forecastUrl) requestUrls.push(forecastUrl);

    let windForecasts: NwsWindForecastRow[] = [];
    if (!forecastUrl) {
      caveats.push({
        code: "nws_forecast_url_missing",
        message: `NWS point metadata did not include a forecast URL for ${spot.id}.`
      });
    } else {
      const forecast = await readJson<NwsForecastResponse>(fetcher, forecastUrl);
      const periods = forecast.properties?.periods;
      if (!Array.isArray(periods) || periods.length === 0) {
        caveats.push({ code: "nws_empty_forecast", message: `NWS returned no forecast periods for ${spot.id}.` });
      } else {
        const issuedAt =
          isoOrNull(forecast.properties?.updated) ?? isoOrNull(forecast.properties?.generatedAt);
        windForecasts = periods.flatMap((period) => {
          const forecastAt = isoOrNull(period.startTime);
          if (!forecastAt) {
            caveats.push({
              code: "nws_invalid_period",
              message: `Skipped a malformed NWS forecast period for ${spot.id}.`
            });
            return [];
          }
          return [
            {
              spotId: spot.id,
              issuedAt,
              forecastAt,
              periodEndAt: isoOrNull(period.endTime),
              windSpeedKt: parseSpeedKt(period.windSpeed),
              windDirectionDeg: parseWindDirectionDeg(period.windDirection),
              gustKt: parseSpeedKt(period.windGust),
              shortForecast: stringOrNull(period.shortForecast),
              sourceUrl: forecastUrl
            }
          ];
        });
      }
    }

    let hazards: NwsHazard[] = [];
    try {
      const alerts = await readJson<NwsAlertsResponse>(fetcher, alertsUrl);
      hazards = Array.isArray(alerts.features)
        ? alerts.features.flatMap((feature) => {
            const event = stringOrNull(feature.properties?.event);
            if (!event) {
              caveats.push({
                code: "nws_invalid_alert",
                message: `Skipped a malformed NWS alert for ${spot.id}.`
              });
              return [];
            }
            return [
              {
                spotId: spot.id,
                event,
                severity: stringOrNull(feature.properties?.severity),
                urgency: stringOrNull(feature.properties?.urgency),
                certainty: stringOrNull(feature.properties?.certainty),
                headline: stringOrNull(feature.properties?.headline),
                effectiveAt: isoOrNull(feature.properties?.effective),
                expiresAt: isoOrNull(feature.properties?.expires),
                sourceUrl: alertsUrl
              }
            ];
          })
        : [];
    } catch (error) {
      caveats.push({
        code: "nws_alerts_unavailable",
        message: `NWS alerts context unavailable for ${spot.id}: ${errorMessage(error)}`
      });
    }

    const row: NwsContextRow = {
      spotId: spot.id,
      pointUrl,
      forecastUrl,
      alertsUrl,
      office: stringOrNull(point.properties?.gridId),
      gridX: numberOrNull(point.properties?.gridX),
      gridY: numberOrNull(point.properties?.gridY),
      forecastZone: stringOrNull(point.properties?.forecastZone),
      windForecasts,
      hazards
    };

    if (windForecasts.length === 0) {
      errors.push(`NWS ${spot.id}: no wind forecast rows were available.`);
    }

    return { row, requestUrls, caveats, errors };
  } catch (error) {
    errors.push(`NWS ${spot.id}: ${errorMessage(error)}`);
    return { row: null, requestUrls, caveats, errors };
  }
}

export async function fetchNwsContextForSpots(
  spots: SpotProfile[],
  options: {
    fetcher?: SourceFetch;
  } = {}
): Promise<AdapterOutcome<NwsContextRow, NwsMetadata>> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const rows: NwsContextRow[] = [];
  const caveats: SourceCaveat[] = [];
  const errors: string[] = [];
  const requestUrls: string[] = [];
  const statuses: Array<"success" | "failure"> = [];

  for (const spot of spots) {
    const result = await fetchSpotContext(fetcher, spot);
    requestUrls.push(...result.requestUrls);
    caveats.push(...result.caveats);
    errors.push(...result.errors);
    if (result.row) rows.push(result.row);
    statuses.push(result.row && result.errors.length === 0 ? "success" : "failure");
  }

  const windRowCount = rows.reduce((sum, row) => sum + row.windForecasts.length, 0);
  const hazardCount = rows.reduce((sum, row) => sum + row.hazards.length, 0);
  const status = rows.length === 0 || windRowCount === 0 ? "failure" : combineStatus(statuses);

  return {
    sourceId: "nws:point-forecast-alerts",
    provider: "NOAA NWS",
    capabilities: ["wind", "hazard"],
    status,
    rows,
    caveats,
    errors,
    fetchedAt: new Date().toISOString(),
    metadata: {
      spotCount: spots.length,
      windRowCount,
      hazardCount,
      requestUrls
    }
  };
}
