import type { SpotId } from "@surf/contracts";
import type { NorcalSpotProfile } from "@surf/forecast-core";
import type { AdapterOutcome, AdapterStatus, SourceCaveat, SourceFetch } from "./types";
import { combineStatus, errorMessage } from "./types";

export type TideTrend = "rising" | "falling" | "steady" | "unknown";

export type TidePredictionRow = {
  spotId: SpotId;
  stationId: string;
  forecastAt: string;
  tideFtMllw: number;
  tideTrend: TideTrend;
};

export type TideEventRow = {
  spotId: SpotId;
  stationId: string;
  eventAt: string;
  tideFtMllw: number;
  eventType: "high" | "low";
};

type CoopsPrediction = {
  t?: unknown;
  v?: unknown;
  type?: unknown;
};

type CoopsResponse = {
  predictions?: CoopsPrediction[];
  error?: { message?: unknown } | string;
};

export type CoopsTideMetadata = {
  stationIds: string[];
  requestUrls: string[];
  rowCountByStation: Record<string, number>;
  eventCountByStation: Record<string, number>;
  windowStart: string;
  windowEnd: string;
};

export const COOPS_TIDE_SOURCE_ID = "coops:tide-predictions";
// CO-OPS tide predictions are precomputed astronomical tables: the data does
// not change between fetches, so the declared cadence tracks fetch recency
// (ingest health), not provider updates. The scheduled ingest is hourly; a
// full day of missed fetches plus grace marks the source late.
export const COOPS_TIDE_EXPECTED_CADENCE_MINUTES = 1440;
export const COOPS_TIDE_GRACE_MINUTES = 360;

const COOPS_DATAGETTER_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

function coopsDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}${month}${day} ${hour}:${minute}`;
}

export function buildCoopsTidePredictionsUrl(stationId: string, start: Date, end: Date): string {
  const params = new URLSearchParams({
    begin_date: coopsDate(start),
    end_date: coopsDate(end),
    station: stationId,
    product: "predictions",
    datum: "MLLW",
    time_zone: "gmt",
    interval: "h",
    units: "english",
    application: "surf",
    format: "json"
  });

  return `${COOPS_DATAGETTER_URL}?${params.toString()}`;
}

export function buildCoopsTideEventsUrl(stationId: string, start: Date, end: Date): string {
  const url = new URL(buildCoopsTidePredictionsUrl(stationId, start, end));
  url.searchParams.set("interval", "hilo");
  return url.toString();
}

function parseCoopsTime(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const normalized = value.trim().replace(" ", "T");
  const date = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseCoopsHeightFt(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function trendFor(index: number, heights: number[]): TideTrend {
  const previous = heights[index - 1];
  const current = heights[index];
  const next = heights[index + 1];
  if (current === undefined) return "unknown";
  if (previous === undefined && next === undefined) return "unknown";
  const delta = previous === undefined ? next! - current : current - previous;
  if (Math.abs(delta) < 0.05) return "steady";
  return delta > 0 ? "rising" : "falling";
}

function coopsErrorMessage(payload: CoopsResponse): string | null {
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error.message === "string") return payload.error.message;
  return null;
}

async function fetchStationPredictions(
  fetcher: SourceFetch,
  stationId: string,
  start: Date,
  end: Date
): Promise<{
  rows: Array<Omit<TidePredictionRow, "spotId">>;
  events: Array<Omit<TideEventRow, "spotId">>;
  requestUrls: string[];
  eventStatus: "success" | "partial";
  caveats: SourceCaveat[];
  errors: string[];
}> {
  const requestUrl = buildCoopsTidePredictionsUrl(stationId, start, end);
  const eventRequestUrl = buildCoopsTideEventsUrl(stationId, start, end);
  const [responseResult, eventResponseResult] = await Promise.allSettled([
    fetcher(requestUrl, { headers: { Accept: "application/json" } }),
    fetcher(eventRequestUrl, { headers: { Accept: "application/json" } })
  ]);
  if (responseResult.status === "rejected") throw responseResult.reason;
  const response = responseResult.value;

  if (!response.ok) {
    return {
      rows: [],
      events: [],
      requestUrls: [requestUrl, eventRequestUrl],
      eventStatus: "partial",
      caveats: [],
      errors: [`CO-OPS ${stationId} returned HTTP ${response.status}`]
    };
  }

  const payload = (await response.json()) as CoopsResponse;
  const apiError = coopsErrorMessage(payload);
  if (apiError) {
    return {
      rows: [],
      events: [],
      requestUrls: [requestUrl, eventRequestUrl],
      eventStatus: "partial",
      caveats: [],
      errors: [`CO-OPS ${stationId}: ${apiError}`]
    };
  }

  if (!Array.isArray(payload.predictions) || payload.predictions.length === 0) {
    return {
      rows: [],
      events: [],
      requestUrls: [requestUrl, eventRequestUrl],
      eventStatus: "partial",
      caveats: [{ code: "coops_empty_predictions", message: `CO-OPS returned no tide predictions for ${stationId}.` }],
      errors: []
    };
  }

  const caveats: SourceCaveat[] = [];
  const parsedRows = payload.predictions.flatMap((prediction) => {
    const forecastAt = parseCoopsTime(prediction.t);
    const tideFtMllw = parseCoopsHeightFt(prediction.v);
    if (!forecastAt || tideFtMllw === null) {
      caveats.push({
        code: "coops_invalid_prediction",
        message: `Skipped a malformed CO-OPS tide prediction for ${stationId}.`
      });
      return [];
    }
    return [{ stationId, forecastAt, tideFtMllw }];
  });

  const rowsSorted = parsedRows.sort((a, b) => a.forecastAt.localeCompare(b.forecastAt));
  const heights = rowsSorted.map((row) => row.tideFtMllw);
  const rows = rowsSorted.map((row, index) => ({
    ...row,
    tideTrend: trendFor(index, heights)
  }));

  const events: Array<Omit<TideEventRow, "spotId">> = [];
  let eventStatus: "success" | "partial" = "success";
  const eventUnavailable = (message: string) => {
    eventStatus = "partial";
    caveats.push({ code: "coops_tide_events_unavailable", message });
  };
  if (eventResponseResult.status === "rejected") {
    eventUnavailable(
      `CO-OPS ${stationId} high/low predictions could not be fetched: ${errorMessage(eventResponseResult.reason)}`
    );
  } else if (!eventResponseResult.value.ok) {
    eventUnavailable(
      `CO-OPS ${stationId} high/low predictions returned HTTP ${eventResponseResult.value.status}.`
    );
  } else {
    try {
      const eventPayload = (await eventResponseResult.value.json()) as CoopsResponse;
      const eventApiError = coopsErrorMessage(eventPayload);
      if (eventApiError) {
        eventUnavailable(`CO-OPS ${stationId} high/low predictions: ${eventApiError}`);
      } else if (!Array.isArray(eventPayload.predictions)) {
        eventUnavailable(`CO-OPS ${stationId} high/low predictions omitted the predictions array.`);
      } else {
        for (const prediction of eventPayload.predictions) {
          const eventAt = parseCoopsTime(prediction.t);
          const tideFtMllw = parseCoopsHeightFt(prediction.v);
          const eventType = prediction.type === "H" ? "high" : prediction.type === "L" ? "low" : null;
          if (!eventAt || tideFtMllw === null || !eventType) {
            eventStatus = "partial";
            caveats.push({
              code: "coops_invalid_tide_event",
              message: `Skipped a malformed CO-OPS high/low prediction for ${stationId}.`
            });
            continue;
          }
          events.push({ stationId, eventAt, tideFtMllw, eventType });
        }
      }
    } catch (error) {
      eventUnavailable(
        `CO-OPS ${stationId} high/low predictions returned invalid JSON: ${errorMessage(error)}`
      );
    }
  }

  return {
    rows,
    events: events.sort((left, right) => left.eventAt.localeCompare(right.eventAt)),
    requestUrls: [requestUrl, eventRequestUrl],
    eventStatus,
    caveats,
    errors: []
  };
}

export async function fetchCoopsTidePredictionsForSpots(
  spots: NorcalSpotProfile[],
  options: {
    fetcher?: SourceFetch;
    now?: Date;
    horizonHours?: number;
    horizonEndAt?: string;
  } = {}
): Promise<AdapterOutcome<TidePredictionRow, CoopsTideMetadata> & { events: TideEventRow[] }> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? new Date();
  const start = new Date(now);
  const explicitEndMs = options.horizonEndAt === undefined
    ? null
    : Date.parse(options.horizonEndAt);
  if (
    explicitEndMs !== null &&
    (!Number.isFinite(explicitEndMs) || explicitEndMs <= now.getTime())
  ) {
    throw new Error("CO-OPS horizonEndAt must be a valid instant after now");
  }
  const end = explicitEndMs === null
    ? new Date(now.getTime() + (options.horizonHours ?? 72) * 60 * 60 * 1000)
    : new Date(explicitEndMs);
  const stationIds = [
    ...new Set(spots.map((spot) => spot.sourceMap.coopsTide.stationId).filter(Boolean))
  ].sort();
  const rows: TidePredictionRow[] = [];
  const events: TideEventRow[] = [];
  const caveats: SourceCaveat[] = [];
  const errors: string[] = [];
  const requestUrls: string[] = [];
  const rowCountByStation: Record<string, number> = {};
  const eventCountByStation: Record<string, number> = {};
  const statuses: AdapterStatus[] = [];

  for (const stationId of stationIds) {
    try {
      const stationResult = await fetchStationPredictions(fetcher, stationId, start, end);
      requestUrls.push(...stationResult.requestUrls);
      caveats.push(...stationResult.caveats);
      errors.push(...stationResult.errors);
      rowCountByStation[stationId] = stationResult.rows.length;
      eventCountByStation[stationId] = stationResult.events.length;
      statuses.push(
        stationResult.errors.length > 0 || stationResult.rows.length === 0
          ? "failure"
          : stationResult.eventStatus
      );

      const stationSpots = spots.filter(
        (spot) => spot.sourceMap.coopsTide.stationId === stationId
      );
      for (const spot of stationSpots) {
        rows.push(...stationResult.rows.map((row) => ({ ...row, spotId: spot.id })));
        events.push(...stationResult.events.map((event) => ({ ...event, spotId: spot.id })));
      }
    } catch (error) {
      rowCountByStation[stationId] = 0;
      eventCountByStation[stationId] = 0;
      errors.push(`CO-OPS ${stationId}: ${errorMessage(error)}`);
      statuses.push("failure");
    }
  }

  if (stationIds.length === 0) {
    caveats.push({ code: "coops_no_station_mapping", message: "No v1 spots have CO-OPS tide station mappings." });
  }

  const status = rows.length === 0 ? "failure" : combineStatus(statuses);
  return {
    sourceId: "coops:tide-predictions",
    provider: "NOAA CO-OPS",
    capabilities: ["tide"],
    status,
    rows,
    events,
    caveats,
    errors,
    fetchedAt: new Date().toISOString(),
    metadata: {
      stationIds,
      requestUrls,
      rowCountByStation,
      eventCountByStation,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString()
    }
  };
}
