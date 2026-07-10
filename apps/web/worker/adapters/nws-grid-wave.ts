import type { SpotId } from "@surf/contracts";
import type { NorcalSpotProfile } from "@surf/forecast-core";
import type { AdapterOutcome, AdapterStatus, SourceCaveat, SourceFetch } from "./types";
import { combineStatus, errorMessage } from "./types";
import { stableThreeHourForecastTimes } from "../time";

export const NWS_GRID_WAVE_SOURCE_ID = "nws:mtr-grid-wave";

type NwsGridValue = {
  validTime?: unknown;
  value?: unknown;
};

type NwsGridLayer = {
  uom?: unknown;
  values?: unknown;
};

type NwsGridWaveProperties = {
  updateTime?: unknown;
  validTimes?: unknown;
  waveHeight?: NwsGridLayer;
  wavePeriod?: NwsGridLayer;
  wavePeriod2?: NwsGridLayer;
  primarySwellHeight?: NwsGridLayer;
  primarySwellDirection?: NwsGridLayer;
  secondarySwellHeight?: NwsGridLayer;
  secondarySwellDirection?: NwsGridLayer;
  windWaveHeight?: NwsGridLayer;
};

type NwsGridWaveResponse = {
  properties?: NwsGridWaveProperties;
};

export type NwsGridWaveForecastRow = {
  spotId: SpotId;
  sourceId: typeof NWS_GRID_WAVE_SOURCE_ID;
  sourceUrl: string;
  modelCycleAt: string;
  forecastAt: string;
  leadHour: number;
  significantHeightM: number;
  estimatedBreakingHeightM: number;
  breakingHeightScale: number;
  primarySwellHeightM: number | null;
  primarySwellPeriodS: number | null;
  primarySwellDirectionDeg: number | null;
  secondarySwellHeightM: number | null;
  secondarySwellPeriodS: number | null;
  secondarySwellDirectionDeg: number | null;
  windWaveHeightM: number | null;
};

export type NwsGridWaveMetadata = {
  spotCount: number;
  rowCount: number;
  requestUrls: string[];
  rowCountBySpot: Record<string, number>;
  modelCycleBySpot: Record<string, string>;
};

export type ParsedNwsValidTime = {
  startMs: number;
  endMs: number;
};

const EXPECTED_UNITS = {
  waveHeight: "wmoUnit:m",
  wavePeriod: "nwsUnit:s",
  wavePeriod2: "nwsUnit:s",
  primarySwellHeight: "wmoUnit:m",
  primarySwellDirection: "wmoUnit:degree_(angle)",
  secondarySwellHeight: "wmoUnit:m",
  secondarySwellDirection: "wmoUnit:degree_(angle)",
  windWaveHeight: "wmoUnit:m"
} as const;

function isoInstantMs(value: string): number | null {
  if (value === "NOW") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDurationMs(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const durationMs = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
}

export function parseNwsValidTime(value: unknown): ParsedNwsValidTime | null {
  if (typeof value !== "string") return null;
  const [left, right, extra] = value.split("/");
  if (!left || !right || extra !== undefined) return null;

  const leftDuration = left.startsWith("P") ? isoDurationMs(left) : null;
  const rightDuration = right.startsWith("P") ? isoDurationMs(right) : null;
  if (leftDuration !== null && rightDuration !== null) return null;

  if (rightDuration !== null) {
    const startMs = isoInstantMs(left);
    return startMs === null ? null : { startMs, endMs: startMs + rightDuration };
  }

  if (leftDuration !== null) {
    const endMs = isoInstantMs(right);
    return endMs === null ? null : { startMs: endMs - leftDuration, endMs };
  }

  const startMs = isoInstantMs(left);
  const endMs = isoInstantMs(right);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { startMs, endMs };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function layerValues(layer: NwsGridLayer | undefined): NwsGridValue[] {
  return Array.isArray(layer?.values) ? (layer.values as NwsGridValue[]) : [];
}

export function nwsGridLayerValueAt(layer: NwsGridLayer | undefined, forecastAt: string): number | null {
  const targetMs = new Date(forecastAt).getTime();
  if (!Number.isFinite(targetMs)) return null;
  for (const item of layerValues(layer)) {
    const interval = parseNwsValidTime(item.validTime);
    if (!interval || targetMs < interval.startMs || targetMs >= interval.endMs) continue;
    return finiteNumber(item.value);
  }
  return null;
}

function isoString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function unitCaveats(properties: NwsGridWaveProperties, spotId: SpotId): SourceCaveat[] {
  return Object.entries(EXPECTED_UNITS).flatMap(([field, expected]) => {
    const actual = properties[field as keyof NwsGridWaveProperties];
    if (!actual || typeof actual !== "object" || !("uom" in actual) || actual.uom === expected) return [];
    return [
      {
        code: "nws_grid_wave_unit_mismatch",
        message: `NWS ${spotId} ${field} used ${String(actual.uom)}; expected ${expected}.`
      }
    ];
  });
}

async function fetchSpotGridWave(
  fetcher: SourceFetch,
  spot: NorcalSpotProfile,
  now: Date,
  horizonHours: number
): Promise<{
  rows: NwsGridWaveForecastRow[];
  modelCycleAt: string | null;
  requestUrl: string;
  caveats: SourceCaveat[];
  errors: string[];
}> {
  const mapping = spot.sourceMap.nwsWaveGrid;
  const requestUrl = mapping.forecastGridData;
  const response = await fetcher(requestUrl, {
    headers: {
      Accept: "application/geo+json",
      "User-Agent": "surf/0.0.0 (https://github.com/aylee/surf)"
    }
  });
  if (!response.ok) {
    return {
      rows: [],
      modelCycleAt: null,
      requestUrl,
      caveats: [],
      errors: [`NWS grid wave ${spot.id} returned HTTP ${response.status}`]
    };
  }

  const payload = (await response.json()) as NwsGridWaveResponse;
  const properties = payload.properties;
  const modelCycleAt = isoString(properties?.updateTime);
  if (!properties || !modelCycleAt) {
    return {
      rows: [],
      modelCycleAt,
      requestUrl,
      caveats: [],
      errors: [`NWS grid wave ${spot.id} omitted a valid properties.updateTime.`]
    };
  }

  const caveats = unitCaveats(properties, spot.id);
  if (caveats.length > 0) {
    return {
      rows: [],
      modelCycleAt,
      requestUrl,
      caveats,
      errors: [`NWS grid wave ${spot.id} used unexpected units; refusing to score the response.`]
    };
  }
  const rows = stableThreeHourForecastTimes(now, horizonHours, spot.timezone).flatMap((forecastAt) => {
    const significantHeightM = nwsGridLayerValueAt(properties.waveHeight, forecastAt);
    if (significantHeightM === null || significantHeightM < 0) return [];

    const row: NwsGridWaveForecastRow = {
      spotId: spot.id,
      sourceId: NWS_GRID_WAVE_SOURCE_ID,
      sourceUrl: requestUrl,
      modelCycleAt,
      forecastAt,
      leadHour: Math.max(
        0,
        Math.round((new Date(forecastAt).getTime() - new Date(modelCycleAt).getTime()) / 3_600_000)
      ),
      significantHeightM,
      estimatedBreakingHeightM: round(significantHeightM * mapping.breakingHeightScale),
      breakingHeightScale: mapping.breakingHeightScale,
      primarySwellHeightM: nwsGridLayerValueAt(properties.primarySwellHeight, forecastAt),
      primarySwellPeriodS: nwsGridLayerValueAt(properties.wavePeriod, forecastAt),
      primarySwellDirectionDeg: nwsGridLayerValueAt(properties.primarySwellDirection, forecastAt),
      secondarySwellHeightM: nwsGridLayerValueAt(properties.secondarySwellHeight, forecastAt),
      secondarySwellPeriodS: nwsGridLayerValueAt(properties.wavePeriod2, forecastAt),
      secondarySwellDirectionDeg: nwsGridLayerValueAt(properties.secondarySwellDirection, forecastAt),
      windWaveHeightM: nwsGridLayerValueAt(properties.windWaveHeight, forecastAt)
    };
    return [row];
  });

  if (rows.length === 0) {
    return {
      rows,
      modelCycleAt,
      requestUrl,
      caveats,
      errors: [`NWS grid wave ${spot.id} returned no usable waveHeight values for the ${horizonHours}-hour horizon.`]
    };
  }

  if (rows.every((row) => row.significantHeightM === 0)) {
    return {
      rows: [],
      modelCycleAt,
      requestUrl,
      caveats: [
        ...caveats,
        {
          code: "nws_grid_wave_all_zero",
          message: `NWS grid ${mapping.office}/${mapping.gridX},${mapping.gridY} returned all-zero wave heights for ${spot.id}; treating the marine mapping as unavailable.`
        }
      ],
      errors: [`NWS grid wave ${spot.id} returned all-zero wave heights.`]
    };
  }

  return { rows, modelCycleAt, requestUrl, caveats, errors: [] };
}

export async function fetchNwsGridWaveForSpots(
  spots: NorcalSpotProfile[],
  options: {
    fetcher?: SourceFetch;
    now?: Date;
    horizonHours?: number;
  } = {}
): Promise<AdapterOutcome<NwsGridWaveForecastRow, NwsGridWaveMetadata>> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? new Date();
  const horizonHours = options.horizonHours ?? 120;
  const outcomes = await Promise.all(
    spots.map(async (spot) => {
      try {
        return await fetchSpotGridWave(fetcher, spot, now, horizonHours);
      } catch (error) {
        return {
          rows: [],
          modelCycleAt: null,
          requestUrl: spot.sourceMap.nwsWaveGrid.forecastGridData,
          caveats: [],
          errors: [`NWS grid wave ${spot.id}: ${errorMessage(error)}`]
        };
      }
    })
  );

  const rows = outcomes.flatMap((outcome) => outcome.rows);
  const caveats = outcomes.flatMap((outcome) => outcome.caveats);
  const errors = outcomes.flatMap((outcome) => outcome.errors);
  const statuses: AdapterStatus[] = outcomes.map((outcome) =>
    outcome.rows.length > 0 && outcome.errors.length === 0 ? "success" : "failure"
  );
  const rowCountBySpot = Object.fromEntries(spots.map((spot, index) => [spot.id, outcomes[index]?.rows.length ?? 0]));
  const modelCycleBySpot = Object.fromEntries(
    spots.flatMap((spot, index) => {
      const modelCycleAt = outcomes[index]?.modelCycleAt;
      return modelCycleAt ? [[spot.id, modelCycleAt]] : [];
    })
  );

  return {
    sourceId: NWS_GRID_WAVE_SOURCE_ID,
    provider: "NOAA/NWS MTR coastal grid",
    capabilities: ["forecast_wave_nearshore"],
    status: rows.length === 0 ? "failure" : combineStatus(statuses),
    rows,
    caveats,
    errors,
    fetchedAt: new Date().toISOString(),
    metadata: {
      spotCount: spots.length,
      rowCount: rows.length,
      requestUrls: outcomes.map((outcome) => outcome.requestUrl),
      rowCountBySpot,
      modelCycleBySpot
    }
  };
}
