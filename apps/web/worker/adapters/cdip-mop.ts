import type { SpotId } from "@surf/contracts";
import { estimateBreakingWaveHeight, type NorcalSpotProfile } from "@surf/forecast-core";
import type { AdapterOutcome, AdapterStatus, SourceCaveat, SourceFetch } from "./types";
import { combineStatus, errorMessage } from "./types";
import { PUBLIC_FEED_USER_AGENT } from "./http";

export const CDIP_MOP_SOURCE_ID = "cdip:mop-forecast";
export const CDIP_MOP_DOCUMENTATION_URL =
  "https://cdip.ucsd.edu/documents/index/product_docs/mops/mop_intro.html";

const MAX_RESPONSE_BYTES = 64 * 1024;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const ARRAY_NAMES = ["waveTime", "waveHs", "waveTp", "waveDp", "waveDm"] as const;

type CdipArrayName = (typeof ARRAY_NAMES)[number];

export type ParsedCdipMopSample = {
  epochSeconds: number;
  significantHeightM: number;
  peakPeriodS: number;
  peakDirectionDeg: number;
  meanDirectionDeg: number | null;
};

export type ParsedCdipMopAscii = {
  declaredRowCount: number;
  skippedRowCount: number;
  missingMeanDirectionCount: number;
  samples: ParsedCdipMopSample[];
};

export type CdipMopForecastRow = {
  spotId: SpotId;
  sourceId: typeof CDIP_MOP_SOURCE_ID;
  sourceUrl: string;
  metadataUrl: string;
  sourceFileUrl: string;
  sourceUpdatedAt: string;
  sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle";
  modelCycleAt: string;
  modelPointId: string;
  modelPointLat: number;
  modelPointLon: number;
  modelPointWaterDepthM: number;
  modelPointShoreNormalDeg: number;
  pointRelationship: "direct_nearshore_point" | "outside_cove_approach_proxy";
  forecastAt: string;
  leadHour: number;
  significantHeightM: number;
  nearshoreHeightM: number;
  exposureAdjustedPointHeightM: number;
  experimentalBreakingHeightM: number | null;
  breakingDepthM: number | null;
  shoalingFactor: number | null;
  totalHeightFactor: number | null;
  breakerIndex: number | null;
  incidenceAngleDeg: number | null;
  transformMethod: "linear-energy-flux-snell-depth-limited" | null;
  transformVersion: "bulk-hs-linear-shoaling-v1";
  nearshoreHeightScale: number;
  peakPeriodS: number;
  peakDirectionDeg: number;
  meanDirectionDeg: number | null;
  heightSemantics: "modeled_significant_wave_height_not_breaking_face_height";
};

export type CdipMopMetadata = {
  configuredSpotIds: SpotId[];
  unavailableSpotIds: SpotId[];
  requestUrls: string[];
  metadataUrls: string[];
  sourceFileUrls: string[];
  rowCountBySpot: Record<string, number>;
  sourceUpdatedAtBySpot: Record<string, string>;
  modelCycleAtBySpot: Record<string, string>;
  modelPointBySpot: Record<string, string>;
  documentationUrl: string;
  sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle";
};

type SpotFetchResult = {
  spotId: SpotId;
  status: AdapterStatus;
  rows: CdipMopForecastRow[];
  sourceUpdatedAt: string | null;
  modelCycleAt: string | null;
  requestUrl: string;
  metadataUrl: string;
  sourceFileUrl: string;
  caveats: SourceCaveat[];
  errors: string[];
};

function parseArraySection(text: string, name: CdipArrayName): { declaredLength: number; values: number[] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = new RegExp(`^${name}\\[(\\d+)\\]$`);
  const matches = lines.flatMap((line, index) => (header.test(line.trim()) ? [index] : []));
  if (matches.length !== 1) {
    throw new Error(`CDIP ASCII expected exactly one ${name}[n] data section; found ${matches.length}.`);
  }

  const headerMatch = header.exec(lines[matches[0]!]!.trim());
  const declaredLength = Number(headerMatch?.[1]);
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
    throw new Error(`CDIP ASCII ${name} declared an invalid length.`);
  }

  const valueLines: string[] = [];
  for (let index = matches[0]! + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.length === 0) break;
    if (ARRAY_NAMES.some((candidate) => new RegExp(`^${candidate}\\[\\d+\\]$`).test(trimmed))) break;
    valueLines.push(trimmed);
  }
  const tokens = valueLines.join(" ").split(",").map((token) => token.trim());
  if (tokens.length !== declaredLength || tokens.some((token) => token.length === 0)) {
    throw new Error(
      `CDIP ASCII ${name} declared ${declaredLength} values but contained ${tokens.length}.`
    );
  }
  const values = tokens.map((token) => Number(token));
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`CDIP ASCII ${name} contained a non-finite numeric value.`);
  }
  return { declaredLength, values };
}

function validDirection(value: number): boolean {
  return value >= 0 && value <= 360;
}

function isFill(value: number): boolean {
  return value <= -999;
}

export function parseCdipMopAscii(text: string): ParsedCdipMopAscii {
  const arrays = Object.fromEntries(
    ARRAY_NAMES.map((name) => [name, parseArraySection(text, name)])
  ) as Record<CdipArrayName, { declaredLength: number; values: number[] }>;
  const lengths = new Set(ARRAY_NAMES.map((name) => arrays[name].declaredLength));
  if (lengths.size !== 1) {
    throw new Error("CDIP ASCII bulk arrays declared different lengths.");
  }

  const declaredRowCount = arrays.waveTime.declaredLength;
  const samples: ParsedCdipMopSample[] = [];
  let skippedRowCount = 0;
  let missingMeanDirectionCount = 0;
  let previousEpochSeconds = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < declaredRowCount; index += 1) {
    const epochSeconds = arrays.waveTime.values[index]!;
    const significantHeightM = arrays.waveHs.values[index]!;
    const peakPeriodS = arrays.waveTp.values[index]!;
    const peakDirectionDeg = arrays.waveDp.values[index]!;
    const rawMeanDirection = arrays.waveDm.values[index]!;
    const timestampMs = epochSeconds * 1000;

    if (
      !Number.isSafeInteger(epochSeconds) ||
      !Number.isFinite(new Date(timestampMs).getTime()) ||
      epochSeconds <= previousEpochSeconds ||
      isFill(significantHeightM) ||
      significantHeightM < 0 ||
      isFill(peakPeriodS) ||
      peakPeriodS <= 0 ||
      isFill(peakDirectionDeg) ||
      !validDirection(peakDirectionDeg)
    ) {
      skippedRowCount += 1;
      continue;
    }

    previousEpochSeconds = epochSeconds;
    const meanDirectionDeg = isFill(rawMeanDirection) || !validDirection(rawMeanDirection)
      ? null
      : rawMeanDirection;
    if (meanDirectionDeg === null) missingMeanDirectionCount += 1;
    samples.push({
      epochSeconds,
      significantHeightM,
      peakPeriodS,
      peakDirectionDeg,
      meanDirectionDeg
    });
  }

  if (samples.length === 0) throw new Error("CDIP ASCII contained no usable bulk wave rows.");
  if (samples.every((sample) => sample.significantHeightM === 0)) {
    throw new Error("CDIP ASCII bulk wave rows were all zero height; refusing to treat them as a forecast.");
  }
  return { declaredRowCount, skippedRowCount, missingMeanDirectionCount, samples };
}

export function parseCdipMopModelCycleAt(text: string): string {
  const historyMatches = [
    ...text.matchAll(/String\s+history\s+"((?:[^"\\]|\\.)*)"\s*;/g)
  ];
  if (historyMatches.length !== 1) {
    throw new Error(`CDIP DAS expected exactly one NC_GLOBAL history attribute; found ${historyMatches.length}.`);
  }
  const history = historyMatches[0]?.[1] ?? "";
  const cycleMatches = [
    ...history.matchAll(/(?:^|\s)-s\s+(\d{12})(?=\s|$)/g)
  ];
  if (cycleMatches.length !== 1) {
    throw new Error(`CDIP DAS expected exactly one runtime -s YYYYMMDDHHMM cycle; found ${cycleMatches.length}.`);
  }

  const value = cycleMatches[0]?.[1] ?? "";
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const cycle = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    cycle.getUTCFullYear() !== year ||
    cycle.getUTCMonth() !== month - 1 ||
    cycle.getUTCDate() !== day ||
    cycle.getUTCHours() !== hour ||
    cycle.getUTCMinutes() !== minute
  ) {
    throw new Error(`CDIP DAS runtime cycle ${value} is not a valid UTC timestamp.`);
  }
  return cycle.toISOString();
}

async function readTextWithLimit(response: Response, label: string): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("iso-8859-1");
  const parts: string[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel(`${label} response exceeded bounded payload limit`);
      throw new Error(`${label} response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function sourceUpdatedAtFromHeader(response: Response): string | null {
  const value = response.headers.get("last-modified");
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function round(value: number, digits = 5): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function fetchSpotForecast(
  fetcher: SourceFetch,
  spot: NorcalSpotProfile,
  now: Date,
  horizonHours: number
): Promise<SpotFetchResult> {
  const point = spot.sourceMap.cdipMop.modelPoint;
  if (!point) throw new Error(`CDIP MOP fetch called for unmapped spot ${spot.id}.`);
  const requestUrl = point.forecastAsciiUrl;
  const metadataUrl = point.forecastDasUrl;
  const sourceFileUrl = point.forecastFileUrl;
  const failed = (
    errors: string[],
    caveats: SourceCaveat[] = [],
    sourceUpdatedAt: string | null = null,
    modelCycleAt: string | null = null
  ): SpotFetchResult => ({
    spotId: spot.id,
    status: "failure",
    rows: [],
    sourceUpdatedAt,
    modelCycleAt,
    requestUrl,
    metadataUrl,
    sourceFileUrl,
    caveats,
    errors
  });

  try {
    const response = await fetcher(requestUrl, {
      headers: {
        Accept: "text/plain",
        "User-Agent": PUBLIC_FEED_USER_AGENT
      }
    });
    if (!response.ok) {
      return failed([`CDIP MOP ${point.id} bulk forecast returned HTTP ${response.status}`]);
    }

    const dasResponse = await fetcher(metadataUrl, {
      headers: {
        Accept: "text/plain",
        "User-Agent": PUBLIC_FEED_USER_AGENT
      }
    });
    if (!dasResponse.ok) {
      return failed([`CDIP MOP ${point.id} DAS metadata returned HTTP ${dasResponse.status}`]);
    }
    const [asciiText, dasText] = await Promise.all([
      readTextWithLimit(response, "CDIP ASCII"),
      readTextWithLimit(dasResponse, "CDIP DAS")
    ]);
    const modelCycleAt = parseCdipMopModelCycleAt(dasText);

    let sourceUpdatedAt = sourceUpdatedAtFromHeader(response);
    if (!sourceUpdatedAt) {
      const fileResponse = await fetcher(sourceFileUrl, {
        method: "HEAD",
        headers: { "User-Agent": PUBLIC_FEED_USER_AGENT }
      });
      if (!fileResponse.ok) {
        return failed(
          [`CDIP MOP ${point.id} source-file metadata returned HTTP ${fileResponse.status}`],
          [],
          null,
          modelCycleAt
        );
      }
      sourceUpdatedAt = sourceUpdatedAtFromHeader(fileResponse);
    }
    if (!sourceUpdatedAt) {
      return failed(
        [],
        [
          {
            code: "cdip_mop_source_update_missing",
            message: `CDIP MOP ${point.id} omitted a valid Last-Modified source-file timestamp.`
          }
        ],
        null,
        modelCycleAt
      );
    }

    const parsed = parseCdipMopAscii(asciiText);
    const startMs = now.getTime() - THREE_HOURS_MS;
    const endMs = now.getTime() + horizonHours * 60 * 60 * 1000 + THREE_HOURS_MS;
    const modelCycleMs = new Date(modelCycleAt).getTime();
    if (parsed.samples.some((sample) => sample.epochSeconds * 1000 < modelCycleMs)) {
      throw new Error(`CDIP MOP ${point.id} contained a forecast time before its runtime cycle.`);
    }
    let transformFailureCount = 0;
    const rows = parsed.samples.flatMap((sample): CdipMopForecastRow[] => {
      const forecastMs = sample.epochSeconds * 1000;
      if (forecastMs < startMs || forecastMs > endMs) return [];
      let breaking: ReturnType<typeof estimateBreakingWaveHeight> | null = null;
      try {
        breaking = estimateBreakingWaveHeight({
          significantHeightM: sample.significantHeightM,
          peakPeriodSec: sample.peakPeriodS,
          pointDepthM: point.waterDepthM,
          waveFromDirectionDeg: sample.peakDirectionDeg,
          shoreNormalDeg: point.shoreNormalDeg,
          exposureScale: point.nearshoreHeightScale
        });
      } catch {
        transformFailureCount += 1;
      }
      const exposureAdjustedPointHeightM = round(
        sample.significantHeightM * point.nearshoreHeightScale
      );
      const nearshoreHeightM = exposureAdjustedPointHeightM;
      return [
        {
          spotId: spot.id,
          sourceId: CDIP_MOP_SOURCE_ID,
          sourceUrl: requestUrl,
          metadataUrl,
          sourceFileUrl,
          sourceUpdatedAt,
          sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle",
          modelCycleAt,
          modelPointId: point.id,
          modelPointLat: point.lat,
          modelPointLon: point.lon,
          modelPointWaterDepthM: point.waterDepthM,
          modelPointShoreNormalDeg: point.shoreNormalDeg,
          pointRelationship: point.relationship,
          forecastAt: new Date(forecastMs).toISOString(),
          leadHour: Math.round((forecastMs - modelCycleMs) / (60 * 60 * 1000)),
          significantHeightM: sample.significantHeightM,
          nearshoreHeightM,
          exposureAdjustedPointHeightM,
          experimentalBreakingHeightM: breaking ? round(breaking.estimatedBreakingHeightM) : null,
          breakingDepthM: breaking ? round(breaking.breakingDepthM) : null,
          shoalingFactor: breaking ? round(breaking.shoalingFactor) : null,
          totalHeightFactor: breaking ? round(breaking.totalHeightFactor) : null,
          breakerIndex: breaking?.breakerIndex ?? null,
          incidenceAngleDeg: breaking ? round(breaking.incidenceAngleDeg) : null,
          transformMethod: breaking?.method ?? null,
          transformVersion: "bulk-hs-linear-shoaling-v1",
          nearshoreHeightScale: point.nearshoreHeightScale,
          peakPeriodS: sample.peakPeriodS,
          peakDirectionDeg: sample.peakDirectionDeg,
          meanDirectionDeg: sample.meanDirectionDeg,
          heightSemantics: "modeled_significant_wave_height_not_breaking_face_height"
        }
      ];
    });
    if (rows.length === 0) {
      return failed(
        [`CDIP MOP ${point.id} returned no usable rows for the ${horizonHours}-hour horizon.`],
        [],
        sourceUpdatedAt,
        modelCycleAt
      );
    }

    const caveats: SourceCaveat[] = [
      {
        code: "cdip_mop_hs_not_breaking_truth",
        message: `CDIP MOP ${point.id} reports modeled significant wave height at ${point.waterDepthM} m; that exposure-adjusted Hs drives the displayed estimate and is not observed breaking-wave face height.`
      },
      {
        code: "cdip_mop_bulk_breaking_diagnostic",
        message: `An experimental bulk-Hs breaking proxy is retained only for future evaluation; it does not affect displayed height or scoring.`
      },
      {
        code: "cdip_mop_last_modified_not_cycle",
        message: `CDIP MOP ${point.id} Last-Modified is retained as source-file update time, not an underlying model cycle.`
      }
    ];
    if (point.relationship === "outside_cove_approach_proxy") {
      caveats.push({
        code: "cdip_mop_linda_mar_cove_scale",
        message: `Linda Mar uses outside-cove point ${point.id} Hs × ${point.nearshoreHeightScale.toFixed(2)} as the explicit final cove exposure scale.`
      });
    }
    if (transformFailureCount > 0) {
      caveats.push({
        code: "cdip_mop_breaking_diagnostic_unavailable",
        message: `CDIP MOP ${point.id} could not compute the experimental breaking diagnostic for ${transformFailureCount} rows; primary Hs rows remain available.`
      });
    }
    if (parsed.skippedRowCount > 0) {
      caveats.push({
        code: "cdip_mop_rows_skipped",
        message: `CDIP MOP ${point.id} skipped ${parsed.skippedRowCount} invalid or fill-valued bulk rows.`
      });
    }
    if (parsed.missingMeanDirectionCount > 0) {
      caveats.push({
        code: "cdip_mop_mean_direction_missing",
        message: `CDIP MOP ${point.id} omitted valid waveDm for ${parsed.missingMeanDirectionCount} rows; peak direction remains available.`
      });
    }
    return {
      spotId: spot.id,
      status: "success",
      rows,
      sourceUpdatedAt,
      modelCycleAt,
      requestUrl,
      metadataUrl,
      sourceFileUrl,
      caveats,
      errors: []
    };
  } catch (error) {
    return failed([`CDIP MOP ${point.id}: ${errorMessage(error)}`]);
  }
}

export async function fetchCdipMopForecastsForSpots(
  spots: NorcalSpotProfile[],
  options: {
    fetcher?: SourceFetch;
    now?: Date;
    horizonHours?: number;
  } = {}
): Promise<AdapterOutcome<CdipMopForecastRow, CdipMopMetadata>> {
  const fetchedAt = new Date().toISOString();
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? new Date();
  const horizonHours = options.horizonHours ?? 120;
  const configured = spots.filter((spot) => spot.sourceMap.cdipMop.modelPoint !== null);
  const unavailable = spots.filter((spot) => spot.sourceMap.cdipMop.modelPoint === null);
  const results = await Promise.all(
    configured.map((spot) => fetchSpotForecast(fetcher, spot, now, horizonHours))
  );
  const caveats: SourceCaveat[] = results.flatMap((result) => result.caveats);
  if (unavailable.some((spot) => spot.id === "bolinas")) {
    caveats.push({
      code: "cdip_mop_bolinas_unmapped",
      message: "Bolinas has no safe direct CDIP MOP mapping and remains uncalibrated on the NWS fallback."
    });
  }

  return {
    sourceId: CDIP_MOP_SOURCE_ID,
    provider: "CDIP/MOP",
    capabilities: ["forecast_wave_nearshore"],
    status: combineStatus(results.map((result) => result.status)),
    rows: results.flatMap((result) => result.rows),
    caveats,
    errors: results.flatMap((result) => result.errors),
    fetchedAt,
    metadata: {
      configuredSpotIds: configured.map((spot) => spot.id),
      unavailableSpotIds: unavailable.map((spot) => spot.id),
      requestUrls: results.map((result) => result.requestUrl),
      metadataUrls: results.map((result) => result.metadataUrl),
      sourceFileUrls: results.map((result) => result.sourceFileUrl),
      rowCountBySpot: Object.fromEntries(results.map((result) => [result.spotId, result.rows.length])),
      sourceUpdatedAtBySpot: Object.fromEntries(
        results.flatMap((result) => result.sourceUpdatedAt ? [[result.spotId, result.sourceUpdatedAt]] : [])
      ),
      modelCycleAtBySpot: Object.fromEntries(
        results.flatMap((result) => result.modelCycleAt ? [[result.spotId, result.modelCycleAt]] : [])
      ),
      modelPointBySpot: Object.fromEntries(
        configured.flatMap((spot) => {
          const point = spot.sourceMap.cdipMop.modelPoint;
          return point ? [[spot.id, point.id]] : [];
        })
      ),
      documentationUrl: CDIP_MOP_DOCUMENTATION_URL,
      sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle"
    }
  };
}
