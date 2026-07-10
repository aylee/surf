import type { SpotId } from "@surf/contracts";
import type { NorcalSpotProfile } from "@surf/forecast-core";
import type { AdapterOutcome, SourceCaveat, SourceFetch } from "./types";
import { combineStatus, errorMessage } from "./types";

export type TideTrend = "rising" | "falling" | "steady" | "unknown";

export type TidePredictionRow = {
  spotId: SpotId;
  stationId: string;
  forecastAt: string;
  tideFtMllw: number;
  tideTrend: TideTrend;
};

type CoopsPrediction = {
  t?: unknown;
  v?: unknown;
};

type CoopsResponse = {
  predictions?: CoopsPrediction[];
  error?: { message?: unknown } | string;
};

export type CoopsTideMetadata = {
  stationIds: string[];
  requestUrls: string[];
  rowCountByStation: Record<string, number>;
  windowStart: string;
  windowEnd: string;
};

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
  requestUrl: string;
  caveats: SourceCaveat[];
  errors: string[];
}> {
  const requestUrl = buildCoopsTidePredictionsUrl(stationId, start, end);
  const response = await fetcher(requestUrl, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    return {
      rows: [],
      requestUrl,
      caveats: [],
      errors: [`CO-OPS ${stationId} returned HTTP ${response.status}`]
    };
  }

  const payload = (await response.json()) as CoopsResponse;
  const apiError = coopsErrorMessage(payload);
  if (apiError) {
    return {
      rows: [],
      requestUrl,
      caveats: [],
      errors: [`CO-OPS ${stationId}: ${apiError}`]
    };
  }

  if (!Array.isArray(payload.predictions) || payload.predictions.length === 0) {
    return {
      rows: [],
      requestUrl,
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

  return { rows, requestUrl, caveats, errors: [] };
}

export async function fetchCoopsTidePredictionsForSpots(
  spots: NorcalSpotProfile[],
  options: {
    fetcher?: SourceFetch;
    now?: Date;
    horizonHours?: number;
  } = {}
): Promise<AdapterOutcome<TidePredictionRow, CoopsTideMetadata>> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? new Date();
  const start = new Date(now);
  const end = new Date(now.getTime() + (options.horizonHours ?? 72) * 60 * 60 * 1000);
  const stationIds = [
    ...new Set(spots.map((spot) => spot.sourceMap.coopsTide.stationId).filter(Boolean))
  ].sort();
  const rows: TidePredictionRow[] = [];
  const caveats: SourceCaveat[] = [];
  const errors: string[] = [];
  const requestUrls: string[] = [];
  const rowCountByStation: Record<string, number> = {};
  const statuses: Array<"success" | "failure"> = [];

  for (const stationId of stationIds) {
    try {
      const stationResult = await fetchStationPredictions(fetcher, stationId, start, end);
      requestUrls.push(stationResult.requestUrl);
      caveats.push(...stationResult.caveats);
      errors.push(...stationResult.errors);
      rowCountByStation[stationId] = stationResult.rows.length;
      statuses.push(stationResult.errors.length > 0 || stationResult.rows.length === 0 ? "failure" : "success");

      const stationSpots = spots.filter(
        (spot) => spot.sourceMap.coopsTide.stationId === stationId
      );
      for (const spot of stationSpots) {
        rows.push(...stationResult.rows.map((row) => ({ ...row, spotId: spot.id })));
      }
    } catch (error) {
      rowCountByStation[stationId] = 0;
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
    caveats,
    errors,
    fetchedAt: new Date().toISOString(),
    metadata: {
      stationIds,
      requestUrls,
      rowCountByStation,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString()
    }
  };
}
