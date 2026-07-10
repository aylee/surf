import type { AdapterOutcome, AdapterStatus, SourceCaveat, SourceFetch } from "./types";
import { combineStatus, errorMessage } from "./types";

export type NdbcObservationRow = {
  stationId: string;
  observedAt: string;
  waveHeightM: number | null;
  dominantPeriodS: number | null;
  averagePeriodS: number | null;
  meanWaveDirectionDeg: number | null;
  waterTempC: number | null;
};

export type NdbcObservationMetadata = {
  stationIds: string[];
  requestUrls: string[];
  latestObservationAtByStation: Record<string, string | null>;
  freshStationIds: string[];
  staleStationIds: string[];
  unavailableStationIds: string[];
  staleAfterMinutes: number;
  documentationUrl: string;
};

type ParsedNdbcText = {
  row: NdbcObservationRow | null;
  reason: "ok" | "header_missing" | "no_valid_wave_observation";
};

type StationFetchResult = {
  stationId: string;
  requestUrl: string;
  row: NdbcObservationRow | null;
  status: AdapterStatus;
  stale: boolean;
  caveats: SourceCaveat[];
  errors: string[];
};

const NDBC_REALTIME2_BASE_URL = "https://www.ndbc.noaa.gov/data/realtime2";
const NDBC_DOCUMENTATION_URL = "https://www.ndbc.noaa.gov/measdes.shtml";
export const NDBC_STALE_AFTER_MINUTES = 120;
// realtime2 files contain 45 days of rows and can exceed 500 KB. They are
// newest-first, so a bounded prefix contains the header and current reading.
const MAX_PREFIX_BYTES = 128 * 1024;
const MISSING_VALUES = new Set(["", "MM", "N/A", "NA", "NULL", "NAN"]);

function normalizeStationId(stationId: string): string {
  return stationId.trim().toUpperCase();
}

export function buildNdbcRealtimeUrl(stationId: string): string {
  return `${NDBC_REALTIME2_BASE_URL}/${encodeURIComponent(normalizeStationId(stationId))}.txt`;
}

function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

function headerTokens(line: string): string[] | null {
  const tokens = tokenize(line);
  if (tokens.length < 6 || !tokens[0]?.startsWith("#")) return null;

  const first = tokens[0].slice(1).toUpperCase();
  if (first !== "YY" && first !== "YYYY" && first !== "YR") return null;
  if (tokens[1]?.toUpperCase() !== "MM" || tokens[2]?.toUpperCase() !== "DD") return null;
  if (tokens[3]?.toLowerCase() !== "hh" || tokens[4]?.toLowerCase() !== "mm") return null;

  return [first, ...tokens.slice(1)];
}

function columnIndex(headers: string[], column: string): number {
  return headers.findIndex((header, index) => index >= 5 && header.toUpperCase() === column);
}

function integerToken(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseObservedAt(tokens: string[]): string | null {
  let year = integerToken(tokens[0]);
  const month = integerToken(tokens[1]);
  const day = integerToken(tokens[2]);
  const hour = integerToken(tokens[3]);
  const minute = integerToken(tokens[4]);
  if (year === null || month === null || day === null || hour === null || minute === null) return null;

  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    timestamp.getUTCFullYear() !== year ||
    timestamp.getUTCMonth() !== month - 1 ||
    timestamp.getUTCDate() !== day ||
    timestamp.getUTCHours() !== hour ||
    timestamp.getUTCMinutes() !== minute
  ) {
    return null;
  }

  return timestamp.toISOString();
}

function finiteMetric(value: string | undefined): number | null {
  if (value === undefined || MISSING_VALUES.has(value.trim().toUpperCase())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeMetric(value: string | undefined): number | null {
  const parsed = finiteMetric(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function positiveMetric(value: string | undefined): number | null {
  const parsed = finiteMetric(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function directionMetric(value: string | undefined): number | null {
  const parsed = finiteMetric(value);
  return parsed !== null && parsed >= 0 && parsed <= 360 ? parsed : null;
}

function parseNdbcRealtimeTextDetailed(stationId: string, text: string): ParsedNdbcText {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerLineIndex = lines.findIndex((line) => headerTokens(line) !== null);
  if (headerLineIndex < 0) return { row: null, reason: "header_missing" };

  const headers = headerTokens(lines[headerLineIndex]!);
  if (!headers) return { row: null, reason: "header_missing" };

  const waveHeightIndex = columnIndex(headers, "WVHT");
  const dominantPeriodIndex = columnIndex(headers, "DPD");
  const averagePeriodIndex = columnIndex(headers, "APD");
  const meanWaveDirectionIndex = columnIndex(headers, "MWD");
  const waterTempIndex = columnIndex(headers, "WTMP");
  if (waveHeightIndex < 0) return { row: null, reason: "header_missing" };

  const rows: NdbcObservationRow[] = [];
  for (const line of lines.slice(headerLineIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const tokens = tokenize(trimmed);
    const observedAt = parseObservedAt(tokens);
    const waveHeightM = nonNegativeMetric(tokens[waveHeightIndex]);
    if (!observedAt || waveHeightM === null) continue;

    rows.push({
      stationId: normalizeStationId(stationId),
      observedAt,
      waveHeightM,
      dominantPeriodS: positiveMetric(tokens[dominantPeriodIndex]),
      averagePeriodS: positiveMetric(tokens[averagePeriodIndex]),
      meanWaveDirectionDeg: directionMetric(tokens[meanWaveDirectionIndex]),
      waterTempC: finiteMetric(tokens[waterTempIndex])
    });
  }

  rows.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const row = rows[0] ?? null;
  return { row, reason: row ? "ok" : "no_valid_wave_observation" };
}

export function parseNdbcRealtimeText(stationId: string, text: string): NdbcObservationRow | null {
  return parseNdbcRealtimeTextDetailed(stationId, text).row;
}

async function readTextWithLimit(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_PREFIX_BYTES - totalBytes;
    if (remaining <= 0) {
      await reader.cancel("NDBC prefix complete");
      break;
    }
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    totalBytes += chunk.byteLength;
    parts.push(decoder.decode(chunk, { stream: true }));
    if (totalBytes >= MAX_PREFIX_BYTES) {
      await reader.cancel("NDBC prefix complete");
      break;
    }
  }

  parts.push(decoder.decode());
  return parts.join("");
}

function missingMetricNames(row: NdbcObservationRow): string[] {
  const metrics: Array<[keyof NdbcObservationRow, string]> = [
    ["dominantPeriodS", "DPD"],
    ["averagePeriodS", "APD"],
    ["meanWaveDirectionDeg", "MWD"],
    ["waterTempC", "WTMP"]
  ];
  return metrics.flatMap(([key, name]) => (row[key] === null ? [name] : []));
}

async function fetchStationObservation(
  fetcher: SourceFetch,
  stationId: string,
  now: Date,
  staleAfterMinutes: number
): Promise<StationFetchResult> {
  const requestUrl = buildNdbcRealtimeUrl(stationId);
  try {
    const response = await fetcher(requestUrl, {
      headers: {
        Accept: "text/plain"
      }
    });
    if (!response.ok) {
      return {
        stationId,
        requestUrl,
        row: null,
        status: "failure",
        stale: false,
        caveats: [],
        errors: [`NDBC ${stationId} returned HTTP ${response.status}`]
      };
    }

    const parsed = parseNdbcRealtimeTextDetailed(stationId, await readTextWithLimit(response));
    if (!parsed.row) {
      const headerMissing = parsed.reason === "header_missing";
      return {
        stationId,
        requestUrl,
        row: null,
        status: "failure",
        stale: false,
        caveats: [
          {
            code: headerMissing ? "ndbc_invalid_header" : "ndbc_no_valid_wave_observation",
            message: headerMissing
              ? `NDBC ${stationId} did not return a recognizable realtime2 standard meteorological header.`
              : `NDBC ${stationId} returned no timestamped observation with a valid WVHT value.`
          }
        ],
        errors: []
      };
    }

    const caveats: SourceCaveat[] = [];
    const missingMetrics = missingMetricNames(parsed.row);
    if (missingMetrics.length > 0) {
      caveats.push({
        code: "ndbc_partial_observation",
        message: `NDBC ${stationId} reported MM or invalid values for ${missingMetrics.join(", ")}; those metrics are null.`
      });
    }

    const ageMinutes = Math.max(0, (now.getTime() - new Date(parsed.row.observedAt).getTime()) / 60_000);
    const stale = ageMinutes > staleAfterMinutes;
    if (stale) {
      caveats.push({
        code: "ndbc_stale_observation",
        message: `NDBC ${stationId}'s newest valid wave observation is ${Math.floor(ageMinutes)} minutes old (limit ${staleAfterMinutes}).`
      });
    }

    return {
      stationId,
      requestUrl,
      row: parsed.row,
      status: stale ? "failure" : "success",
      stale,
      caveats,
      errors: []
    };
  } catch (error) {
    return {
      stationId,
      requestUrl,
      row: null,
      status: "failure",
      stale: false,
      caveats: [],
      errors: [`NDBC ${stationId}: ${errorMessage(error)}`]
    };
  }
}

export async function fetchNdbcRealtimeObservationsForStations(
  requestedStationIds: string[],
  options: {
    fetcher?: SourceFetch;
    now?: Date;
    staleAfterMinutes?: number;
  } = {}
): Promise<AdapterOutcome<NdbcObservationRow, NdbcObservationMetadata>> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? new Date();
  const staleAfterMinutes = options.staleAfterMinutes ?? NDBC_STALE_AFTER_MINUTES;
  const stationIds = [...new Set(requestedStationIds.map(normalizeStationId).filter(Boolean))].sort();

  const results = await Promise.all(
    stationIds.map((stationId) => fetchStationObservation(fetcher, stationId, now, staleAfterMinutes))
  );
  const rows = results.flatMap((result) => (result.row ? [result.row] : []));
  const caveats = results.flatMap((result) => result.caveats);
  const errors = results.flatMap((result) => result.errors);

  if (stationIds.length === 0) {
    caveats.push({
      code: "ndbc_no_station_ids",
      message: "No NDBC station IDs were provided."
    });
  }

  const latestObservationAtByStation = Object.fromEntries(
    results.map((result) => [result.stationId, result.row?.observedAt ?? null])
  );
  const freshStationIds = results.filter((result) => result.status === "success").map((result) => result.stationId);
  const staleStationIds = results.filter((result) => result.stale).map((result) => result.stationId);
  const unavailableStationIds = results
    .filter((result) => result.row === null)
    .map((result) => result.stationId);

  return {
    sourceId: "ndbc:realtime2-standard-meteorological",
    provider: "NOAA NDBC",
    capabilities: ["observed_wave"],
    status: stationIds.length === 0 ? "failure" : combineStatus(results.map((result) => result.status)),
    rows,
    caveats,
    errors,
    fetchedAt: now.toISOString(),
    metadata: {
      stationIds,
      requestUrls: results.map((result) => result.requestUrl),
      latestObservationAtByStation,
      freshStationIds,
      staleStationIds,
      unavailableStationIds,
      staleAfterMinutes,
      documentationUrl: NDBC_DOCUMENTATION_URL
    }
  };
}
