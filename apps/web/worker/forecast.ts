import {
  ForecastResponseSchema,
  freshnessVerdict,
  type CalibrationStatus,
  type FieldResolution,
  type ForecastInterval,
  type ForecastIssueDelta,
  type ForecastResponse,
  type ForecastWindowInput,
  type ScoredForecastWindow,
  type SourceCapability,
  type SourceFreshness,
  type SpotId,
  type SwellComponent,
  type TideEvent,
  type WaveObservationSummary,
  type WaveProvenance,
  type WaveSemantics,
  type WaveState
} from "@surf/contracts";
import {
  getOperationalObservedWaveSources,
  getSpotProfile,
  scoreSpotWindow,
  surfaceConditionForWind,
  type NorcalSpotProfile
} from "@surf/forecast-core";
import {
  CDIP_MOP_EXPECTED_CADENCE_MINUTES,
  CDIP_MOP_GRACE_MINUTES,
  CDIP_MOP_SOURCE_ID
} from "./adapters/cdip-mop";
import {
  COOPS_TIDE_EXPECTED_CADENCE_MINUTES,
  COOPS_TIDE_GRACE_MINUTES,
  COOPS_TIDE_SOURCE_ID
} from "./adapters/coops";
import {
  NDBC_EXPECTED_CADENCE_MINUTES,
  NDBC_GRACE_MINUTES,
  NDBC_STALE_AFTER_MINUTES
} from "./adapters/ndbc";
import {
  NWS_POINT_EXPECTED_CADENCE_MINUTES,
  NWS_POINT_GRACE_MINUTES,
  NWS_POINT_SOURCE_ID
} from "./adapters/nws";
import {
  NWS_GRID_WAVE_EXPECTED_CADENCE_MINUTES,
  NWS_GRID_WAVE_GRACE_MINUTES,
  NWS_GRID_WAVE_SOURCE_ID
} from "./adapters/nws-grid-wave";
import type { Env } from "./index";
import { boundedErrorName } from "./logging";
import {
  localDateForTime,
  solarPhasesForDates,
  stableHourlyForecastTimes,
  stableThreeHourForecastTimes,
  threeHourValidityFor
} from "./time";

/*
 * Keep the wire response projected through the public schema. Internal spot
 * source maps are exposed only by /api/spots through its dedicated summary.
 */
const publicForecastResponse = (value: ForecastResponse): ForecastResponse =>
  ForecastResponseSchema.parse(value);

type TideRow = {
  forecast_at: string;
  tide_ft_mllw: number;
  tide_trend: string | null;
  source_run_id: string | null;
};

type TideEventRow = {
  station_id: string;
  event_at: string;
  tide_ft_mllw: number;
  event_type: string;
  source_run_id: string | null;
};

type WindRow = {
  forecast_at: string;
  model_cycle_at: string | null;
  wind_speed_ms: number | null;
  wind_direction_deg: number | null;
  gust_ms: number | null;
  weather_summary: string | null;
  source_run_id: string | null;
};

type WaveRow = {
  source_id: string;
  forecast_at: string;
  model_cycle_at: string;
  nearshore_height_m: number | null;
  offshore_height_m: number | null;
  significant_height_m: number | null;
  peak_period_s: number | null;
  primary_direction_deg: number | null;
  swell_height_m: number | null;
  swell_period_s: number | null;
  swell_direction_deg: number | null;
  payload_json: string | null;
  source_run_id: string | null;
};

type HazardRow = {
  starts_at: string | null;
  ends_at: string | null;
  headline: string;
  source_run_id: string | null;
};

type ObservationRow = {
  source_id: string;
  source_run_id: string | null;
  observed_at: string;
  wave_height_m: number;
  peak_period_s: number | null;
  mean_period_s: number | null;
  primary_direction_deg: number | null;
  water_temp_c: number | null;
};

type SourceRunRow = {
  id: string;
  source_id: string;
  status: string;
  completed_at: string | null;
};

type ForecastIssueRow = {
  issue_id: string;
  issued_at: string;
};

type ForecastSnapshotRow = {
  issue_id: string;
  valid_at: string;
  raw_facts_json: string;
};

type WavePayload = {
  sourceUrl?: unknown;
  sourceUpdatedAt?: unknown;
  modelCycleAt?: unknown;
  breakingHeightScale?: unknown;
  nearshoreHeightScale?: unknown;
  significantHeightM?: unknown;
  nearshoreHeightM?: unknown;
  exposureAdjustedPointHeightM?: unknown;
  estimatedBreakingHeightM?: unknown;
  experimentalBreakingHeightM?: unknown;
  breakingDepthM?: unknown;
  shoalingFactor?: unknown;
  totalHeightFactor?: unknown;
  breakerIndex?: unknown;
  incidenceAngleDeg?: unknown;
  transformMethod?: unknown;
  transformVersion?: unknown;
  modelPointId?: unknown;
  modelPointWaterDepthM?: unknown;
  modelPointShoreNormalDeg?: unknown;
  pointRelationship?: unknown;
  sourceTimestampSemantics?: unknown;
  heightSemantics?: unknown;
  primarySwellHeightM?: unknown;
  primarySwellPeriodS?: unknown;
  primarySwellDirectionDeg?: unknown;
  secondarySwellHeightM?: unknown;
  secondarySwellPeriodS?: unknown;
  secondarySwellDirectionDeg?: unknown;
};

function asRows<T>(result: D1Result<T>): T[] {
  return Array.isArray(result.results) ? result.results : [];
}

async function queryRows<T>(db: D1Database, sql: string, ...bindings: unknown[]): Promise<T[]> {
  const statement = db.prepare(sql);
  const bound = bindings.length > 0 ? statement.bind(...bindings) : statement;
  return asRows(await bound.all<T>());
}

const HOUR_MS = 60 * 60 * 1000;

type TimedRow<T> = {
  row: T;
  timeMs: number;
  order: number;
};

type TimeIndex<T> = {
  /** All valid rows, ordered by timestamp and then original query order. */
  rows: TimedRow<T>[];
  /** The first row at each timestamp, preserving Array.find/nearest tie semantics. */
  uniqueRows: TimedRow<T>[];
  exact: Map<number, T>;
  timeByRow: Map<T, number>;
};

function lowerBoundByTime<T>(rows: ArrayLike<TimedRow<T>>, targetMs: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (rows[middle]!.timeMs < targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function createTimeIndex<T>(rows: T[], timeOf: (row: T) => string): TimeIndex<T> {
  const timedRows: TimedRow<T>[] = [];
  const exact = new Map<number, T>();
  const timeByRow = new Map<T, number>();
  rows.forEach((row, order) => {
    const timeMs = Date.parse(timeOf(row));
    if (!Number.isFinite(timeMs)) return;
    timedRows.push({ row, timeMs, order });
    timeByRow.set(row, timeMs);
    if (!exact.has(timeMs)) exact.set(timeMs, row);
  });
  timedRows.sort((left, right) => left.timeMs - right.timeMs || left.order - right.order);

  const uniqueRows: TimedRow<T>[] = [];
  for (const timedRow of timedRows) {
    if (uniqueRows.at(-1)?.timeMs !== timedRow.timeMs) uniqueRows.push(timedRow);
  }
  return { rows: timedRows, uniqueRows, exact, timeByRow };
}

function closestByTimeIndex<T>(
  index: TimeIndex<T>,
  targetMs: number,
  maxDistanceMs: number
): T | null {
  if (!Number.isFinite(targetMs) || index.uniqueRows.length === 0) return null;
  const insertion = lowerBoundByTime(index.uniqueRows, targetMs);
  let best: { timedRow: TimedRow<T>; distance: number } | null = null;
  for (const candidateIndex of [insertion - 1, insertion]) {
    const timedRow = index.uniqueRows[candidateIndex];
    if (!timedRow) continue;
    const distance = Math.abs(timedRow.timeMs - targetMs);
    if (distance > maxDistanceMs) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && timedRow.order < best.timedRow.order)
    ) {
      best = { timedRow, distance };
    }
  }
  return best?.timedRow.row ?? null;
}

function waveSourcePriority(sourceId: string): number {
  if (sourceId === CDIP_MOP_SOURCE_ID) return 0;
  if (sourceId === NWS_GRID_WAVE_SOURCE_ID) return 1;
  return 2;
}

type WaveSelection = {
  row: WaveRow;
  validFrom: string;
  validTo: string;
  sourceResolutionMinutes: number;
};

type IndexedWaveSelection = WaveSelection & {
  validFromMs: number;
  validToMs: number;
  order: number;
};

function waveValidityForRow(
  row: WaveRow,
  timeZone: string
): Omit<WaveSelection, "row"> | null {
  const validFromMs = new Date(row.forecast_at).getTime();
  if (!Number.isFinite(validFromMs)) return null;
  let validToMs = validFromMs + 3 * 60 * 60 * 1000;
  if (row.source_id === NWS_GRID_WAVE_SOURCE_ID) {
    const localValidity = threeHourValidityFor(row.forecast_at, timeZone);
    if (new Date(localValidity.validFrom).getTime() === validFromMs) {
      validToMs = new Date(localValidity.validTo).getTime();
    }
  }
  if (!Number.isFinite(validToMs) || validToMs <= validFromMs) return null;
  return {
    validFrom: new Date(validFromMs).toISOString(),
    validTo: new Date(validToMs).toISOString(),
    sourceResolutionMinutes: Math.round((validToMs - validFromMs) / 60_000)
  };
}

function compareWaveSelections(
  left: IndexedWaveSelection,
  right: IndexedWaveSelection
): number {
  const leftComplete =
    left.row.nearshore_height_m !== null &&
    left.row.peak_period_s !== null &&
    left.row.primary_direction_deg !== null;
  const rightComplete =
    right.row.nearshore_height_m !== null &&
    right.row.peak_period_s !== null &&
    right.row.primary_direction_deg !== null;
  if (leftComplete !== rightComplete) return Number(rightComplete) - Number(leftComplete);
  const sourceDelta = waveSourcePriority(left.row.source_id) - waveSourcePriority(right.row.source_id);
  if (sourceDelta !== 0) return sourceDelta;
  const cycleDelta = right.row.model_cycle_at.localeCompare(left.row.model_cycle_at);
  if (cycleDelta !== 0) return cycleDelta;
  const forecastDelta = right.row.forecast_at.localeCompare(left.row.forecast_at);
  if (forecastDelta !== 0) return forecastDelta;
  return left.order - right.order;
}

function preferredWaveSelectionsAt(
  rows: WaveRow[],
  forecastTimes: Array<{ forecastAt: string; timeMs: number }>,
  timeZone: string
): Map<number, WaveSelection> {
  const sortedForecastTimes = [...forecastTimes]
    .filter((entry) => Number.isFinite(entry.timeMs))
    .sort((left, right) => left.timeMs - right.timeMs);
  const indexedTimes = sortedForecastTimes.map((entry, order) => ({
    row: entry,
    timeMs: entry.timeMs,
    order
  }));
  const selectedByTime = new Map<number, IndexedWaveSelection>();

  rows.forEach((row, order) => {
    const validity = waveValidityForRow(row, timeZone);
    if (!validity) return;
    const validFromMs = Date.parse(validity.validFrom);
    const validToMs = Date.parse(validity.validTo);
    if (!Number.isFinite(validFromMs) || !Number.isFinite(validToMs)) return;
    const candidate: IndexedWaveSelection = {
      row,
      ...validity,
      validFromMs,
      validToMs,
      order
    };
    const firstTarget = lowerBoundByTime(indexedTimes, validFromMs);
    for (let index = firstTarget; index < indexedTimes.length; index += 1) {
      const targetMs = indexedTimes[index]!.timeMs;
      if (targetMs >= validToMs) break;
      const current = selectedByTime.get(targetMs);
      if (!current || compareWaveSelections(candidate, current) < 0) {
        selectedByTime.set(targetMs, candidate);
      }
    }
  });

  return selectedByTime;
}

export function preferredWaveAt(
  rows: WaveRow[],
  forecastAt: string,
  timeZone = "America/Los_Angeles"
): WaveRow | null {
  const timeMs = Date.parse(forecastAt);
  if (!Number.isFinite(timeMs)) return null;
  return preferredWaveSelectionsAt(rows, [{ forecastAt, timeMs }], timeZone).get(timeMs)?.row ?? null;
}

function worstWindInWindowFromIndex(
  index: TimeIndex<WindRow>,
  startMs: number,
  spot: NorcalSpotProfile
): WindRow | null {
  if (!Number.isFinite(startMs)) return null;
  const endMs = startMs + 3 * HOUR_MS;
  const first = lowerBoundByTime(index.rows, startMs);
  const severity = { unknown: -1, clean: 0, fair: 1, choppy: 2 } as const;
  let worstComplete: { timedRow: TimedRow<WindRow>; severity: number; speedMs: number } | null = null;
  let fastest: { timedRow: TimedRow<WindRow>; speedMs: number } | null = null;

  for (let rowIndex = first; rowIndex < index.rows.length; rowIndex += 1) {
    const timedRow = index.rows[rowIndex]!;
    if (timedRow.timeMs >= endMs) break;
    const speedMs = timedRow.row.wind_speed_ms ?? Number.NEGATIVE_INFINITY;
    if (
      !fastest ||
      speedMs > fastest.speedMs ||
      (speedMs === fastest.speedMs && timedRow.order < fastest.timedRow.order)
    ) {
      fastest = { timedRow, speedMs };
    }
    if (timedRow.row.wind_speed_ms === null || timedRow.row.wind_direction_deg === null) continue;
    const surface = surfaceConditionForWind(spot, {
      windSpeedKt: timedRow.row.wind_speed_ms * 1.94384,
      windDirectionDeg: timedRow.row.wind_direction_deg
    });
    const surfaceSeverity = severity[surface];
    if (
      !worstComplete ||
      surfaceSeverity > worstComplete.severity ||
      (surfaceSeverity === worstComplete.severity && speedMs > worstComplete.speedMs) ||
      (surfaceSeverity === worstComplete.severity &&
        speedMs === worstComplete.speedMs &&
        timedRow.order < worstComplete.timedRow.order)
    ) {
      worstComplete = { timedRow, severity: surfaceSeverity, speedMs };
    }
  }

  return worstComplete?.timedRow.row ??
    fastest?.timedRow.row ??
    closestByTimeIndex(index, startMs, 90 * 60 * 1000);
}

type SourceRunIndex = {
  updatedAtById: Map<string, string | null>;
  oldestCompletedAtMsById: Map<string, number>;
};

function createSourceRunIndex(sourceRuns: SourceRunRow[]): SourceRunIndex {
  const updatedAtById = new Map<string, string | null>();
  const oldestCompletedAtMsById = new Map<string, number>();
  for (const run of sourceRuns) {
    const completedAtMs = run.completed_at ? Date.parse(run.completed_at) : Number.NaN;
    const usable = run.status !== "failure" && Number.isFinite(completedAtMs);
    if (!updatedAtById.has(run.id)) {
      updatedAtById.set(run.id, usable ? run.completed_at : null);
    }
    if (!usable) continue;
    const currentOldest = oldestCompletedAtMsById.get(run.id);
    if (currentOldest === undefined || completedAtMs < currentOldest) {
      oldestCompletedAtMsById.set(run.id, completedAtMs);
    }
  }
  return { updatedAtById, oldestCompletedAtMsById };
}

function freshnessMinutes(sourceRuns: SourceRunIndex, runIds: string[], now: Date): number {
  let oldestCompletedAtMs: number | null = null;
  for (const runId of runIds) {
    const completedAtMs = sourceRuns.oldestCompletedAtMsById.get(runId);
    if (completedAtMs === undefined) continue;
    oldestCompletedAtMs = oldestCompletedAtMs === null
      ? completedAtMs
      : Math.min(oldestCompletedAtMs, completedAtMs);
  }
  if (oldestCompletedAtMs === null) return 24 * 60;
  return Math.max(0, Math.round((now.getTime() - oldestCompletedAtMs) / 60000));
}

function sourceRunUpdatedAt(
  sourceRuns: SourceRunIndex,
  sourceRunId: string | null | undefined
): string | null {
  return sourceRunId ? sourceRuns.updatedAtById.get(sourceRunId) ?? null : null;
}

function sourceFreshnessEntry(input: {
  capability: SourceCapability;
  sourceId: string;
  sourceRunId: string | null | undefined;
  updatedAt: string | null | undefined;
  now: Date;
  expectedCadenceMinutes: number;
  graceMinutes: number;
}): SourceFreshness {
  const updatedAt = input.updatedAt ?? null;
  const freshness = ageMinutes(updatedAt, input.now);
  // The status enum stays fresh|stale|missing for existing consumers; its
  // boundary now derives from the same contracts verdict every surface uses
  // ("late" is surfaced as "stale"; "aging" remains quiet-fresh).
  const verdict = freshnessVerdict({
    ageMinutes: freshness,
    expectedCadenceMinutes: input.expectedCadenceMinutes,
    graceMinutes: input.graceMinutes
  });
  return {
    capability: input.capability,
    sourceId: input.sourceId,
    sourceRunId: input.sourceRunId ?? null,
    updatedAt,
    freshnessMinutes: freshness,
    status: freshness === null ? "missing" : verdict === "late" ? "stale" : "fresh",
    expectedCadenceMinutes: input.expectedCadenceMinutes,
    graceMinutes: input.graceMinutes
  };
}

function ageMinutes(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round((now.getTime() - time) / 60_000));
}

function metersToFeet(value: number | null): number | null {
  return value === null ? null : value * 3.28084;
}

function msToKt(value: number | null): number | null {
  return value === null ? null : value * 1.94384;
}

function celsiusToFahrenheit(value: number | null): number | null {
  return value === null ? null : value * 1.8 + 32;
}

function sourceRunIds(...values: Array<string | null | undefined>): string[] {
  return values.filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWavePayload(value: string | null): WavePayload {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as WavePayload) : {};
  } catch {
    return {};
  }
}

function classifyWave(
  wave: WaveRow | null,
  payload: WavePayload
): { semantics: WaveSemantics; calibrationStatus: CalibrationStatus } | null {
  if (!wave) return null;
  if (wave.source_id === CDIP_MOP_SOURCE_ID) {
    if (payload.pointRelationship === "direct_nearshore_point") {
      return { semantics: "direct_nearshore", calibrationStatus: "modeled_uncalibrated" };
    }
    if (payload.pointRelationship === "outside_cove_approach_proxy") {
      return { semantics: "cove_proxy", calibrationStatus: "proxy_uncalibrated" };
    }
    return null;
  }
  if (wave.source_id === NWS_GRID_WAVE_SOURCE_ID) {
    return { semantics: "nws_fallback", calibrationStatus: "cold_start_uncalibrated" };
  }
  return null;
}

function swellComponent(heightM: unknown, periodS: unknown, directionDeg: unknown): SwellComponent | null {
  const heightFt = metersToFeet(finiteNumber(heightM));
  const parsedPeriod = finiteNumber(periodS);
  const parsedDirection = finiteNumber(directionDeg);
  if (heightFt === null && parsedPeriod === null && parsedDirection === null) return null;
  return { heightFt, periodSec: parsedPeriod, directionDeg: parsedDirection };
}

function activeHazardsAt(
  rows: HazardRow[],
  forecastTimes: Array<{ forecastAt: string; timeMs: number }>
): Map<number, HazardRow> {
  const sortedForecastTimes = [...forecastTimes]
    .filter((entry) => Number.isFinite(entry.timeMs))
    .sort((left, right) => left.timeMs - right.timeMs);
  const indexedTimes = sortedForecastTimes.map((entry, order) => ({
    row: entry,
    timeMs: entry.timeMs,
    order
  }));
  const hazardsByTime = new Map<number, HazardRow>();

  for (const row of rows) {
    const startsAtMs = row.starts_at ? Date.parse(row.starts_at) : Number.NEGATIVE_INFINITY;
    const endsAtMs = row.ends_at ? Date.parse(row.ends_at) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(startsAtMs) || Number.isNaN(endsAtMs)) continue;
    const firstTarget = lowerBoundByTime(indexedTimes, startsAtMs);
    for (let index = firstTarget; index < indexedTimes.length; index += 1) {
      const targetMs = indexedTimes[index]!.timeMs;
      if (targetMs >= endsAtMs) break;
      if (!hazardsByTime.has(targetMs)) hazardsByTime.set(targetMs, row);
    }
  }

  return hazardsByTime;
}

type WaveRowDetails = {
  payload: WavePayload;
  classification: ReturnType<typeof classifyWave>;
  sourceUpdatedAt: string | null;
  modelCycleMs: number;
};

function createWaveDetailsLookup(): (row: WaveRow) => WaveRowDetails {
  const detailsByRow = new Map<WaveRow, WaveRowDetails>();
  return (row) => {
    const cached = detailsByRow.get(row);
    if (cached) return cached;
    const payload = parseWavePayload(row.payload_json);
    const payloadSourceUpdatedAtMs = typeof payload.sourceUpdatedAt === "string"
      ? Date.parse(payload.sourceUpdatedAt)
      : Number.NaN;
    const sourceUpdatedAt = Number.isFinite(payloadSourceUpdatedAtMs)
      ? new Date(payloadSourceUpdatedAtMs).toISOString()
      : null;
    const details = {
      payload,
      classification: classifyWave(row, payload),
      sourceUpdatedAt,
      modelCycleMs: Date.parse(row.model_cycle_at)
    };
    detailsByRow.set(row, details);
    return details;
  };
}

function observationSummary(row: ObservationRow, now: Date): WaveObservationSummary {
  return {
    stationId: row.source_id.replace(/^ndbc-/, ""),
    observedAt: row.observed_at,
    waveHeightFt: row.wave_height_m * 3.28084,
    dominantPeriodSec: row.peak_period_s,
    averagePeriodSec: row.mean_period_s,
    meanWaveDirectionDeg: row.primary_direction_deg,
    waterTempF: celsiusToFahrenheit(row.water_temp_c),
    sourceFreshnessMinutes: Math.max(
      0,
      Math.round((now.getTime() - new Date(row.observed_at).getTime()) / 60_000)
    )
  };
}

function recentObservationSummaries(
  observedSources: Array<{ stationId: string }>,
  rows: ObservationRow[],
  now: Date
): WaveObservationSummary[] {
  const stationIds = new Set(observedSources.map((source) => source.stationId));
  return rows
    .filter(
      (row) =>
        stationIds.has(row.source_id.replace(/^ndbc-/, "")) &&
        Number.isFinite(new Date(row.observed_at).getTime()) &&
        Number.isFinite(row.wave_height_m)
    )
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at))
    .slice(0, 48)
    .map((row) => observationSummary(row, now));
}

function preferredObservation(
  observedSources: Array<{ stationId: string }>,
  rows: ObservationRow[],
  now: Date
): { row: ObservationRow; summary: WaveObservationSummary; isFresh: boolean } | null {
  const priorityByStation = new Map(
    observedSources.map((source, index) => [source.stationId, index])
  );
  const sorted = rows
    .filter(
      (row) =>
        typeof row.source_id === "string" &&
        priorityByStation.has(row.source_id.replace(/^ndbc-/, "")) &&
        typeof row.observed_at === "string" &&
        Number.isFinite(new Date(row.observed_at).getTime()) &&
        typeof row.wave_height_m === "number" &&
        Number.isFinite(row.wave_height_m)
    )
    .sort((left, right) => {
      const leftAge = Math.max(0, (now.getTime() - new Date(left.observed_at).getTime()) / 60_000);
      const rightAge = Math.max(0, (now.getTime() - new Date(right.observed_at).getTime()) / 60_000);
      const freshnessDelta =
        Number(rightAge <= NDBC_STALE_AFTER_MINUTES) -
        Number(leftAge <= NDBC_STALE_AFTER_MINUTES);
      if (freshnessDelta !== 0) return freshnessDelta;

      const leftStation = left.source_id.replace(/^ndbc-/, "");
      const rightStation = right.source_id.replace(/^ndbc-/, "");
      const priorityDelta =
        priorityByStation.get(leftStation)! - priorityByStation.get(rightStation)!;
      if (priorityDelta !== 0) return priorityDelta;
      return right.observed_at.localeCompare(left.observed_at);
    });
  const row = sorted[0];
  if (!row) return null;
  const summary = observationSummary(row, now);
  return {
    row,
    isFresh: summary.sourceFreshnessMinutes <= NDBC_STALE_AFTER_MINUTES,
    summary
  };
}

function resolutionFor(input: {
  available: boolean;
  sourceIntervalMinutes: number | null;
  displayIntervalMinutes: number;
  method: FieldResolution["method"];
  validFrom: string;
  validTo: string;
}): FieldResolution {
  return {
    sourceIntervalMinutes: input.available ? input.sourceIntervalMinutes : null,
    displayIntervalMinutes: input.displayIntervalMinutes,
    method: input.available ? input.method : "unavailable",
    validFrom: input.available ? input.validFrom : null,
    validTo: input.available ? input.validTo : null
  };
}

function issueDelta(
  issues: ForecastIssueRow[],
  snapshots: ForecastSnapshotRow[]
): ForecastIssueDelta | null {
  const [current, previous] = issues;
  if (!current || !previous) return null;
  const currentByTime = new Map(
    snapshots
      .filter((row) => row.issue_id === current.issue_id)
      .map((row) => [row.valid_at, row.raw_facts_json])
  );
  const previousByTime = new Map(
    snapshots
      .filter((row) => row.issue_id === previous.issue_id)
      .map((row) => [row.valid_at, row.raw_facts_json])
  );
  const validTimes = new Set([...currentByTime.keys(), ...previousByTime.keys()]);
  const changedWindowCount = [...validTimes].filter(
    (validAt) => currentByTime.get(validAt) !== previousByTime.get(validAt)
  ).length;
  return {
    currentIssueId: current.issue_id,
    previousIssueId: previous.issue_id,
    currentIssuedAt: current.issued_at,
    previousIssuedAt: previous.issued_at,
    changedWindowCount
  };
}

function unavailableWindows(
  spotId: SpotId,
  now: Date,
  caveat: string,
  interval: ForecastInterval
): ScoredForecastWindow[] {
  const spot = getSpotProfile(spotId);
  const forecastTimes = interval === "1h"
    ? stableHourlyForecastTimes(now, 120)
    : stableThreeHourForecastTimes(now, 120, spot.timezone);
  return forecastTimes.map((forecastAt) => {
    const displayIntervalMinutes = interval === "1h" ? 60 : 180;
    const validTo = new Date(
      new Date(forecastAt).getTime() + displayIntervalMinutes * 60_000
    ).toISOString();
    const input: ForecastWindowInput = {
      spotId,
      forecastAt,
      waveHeightFt: null,
      peakPeriodSec: null,
      primaryDirectionDeg: null,
      tideFt: null,
      windSpeedKt: null,
      windDirectionDeg: null,
      sourceFreshnessMinutes: 24 * 60,
      activeCapabilities: []
    };
    return {
      ...scoreSpotWindow(spot, input),
      waveHeightFt: null,
      peakPeriodSec: null,
      primaryDirectionDeg: null,
      tideFt: null,
      windSpeedKt: null,
      windGustKt: null,
      windDirectionDeg: null,
      weatherSummary: null,
      surfaceCondition: "unknown",
      sourceFreshnessMinutes: input.sourceFreshnessMinutes,
      activeCapabilities: [],
      sourceRunIds: [],
      caveats: [caveat],
      primarySwell: null,
      secondarySwell: null,
      waveProvenance: null,
      waveState: null,
      resolution: {
        wave: resolutionFor({ available: false, sourceIntervalMinutes: null, displayIntervalMinutes, method: "unavailable", validFrom: forecastAt, validTo }),
        wind: resolutionFor({ available: false, sourceIntervalMinutes: null, displayIntervalMinutes, method: "unavailable", validFrom: forecastAt, validTo }),
        tide: resolutionFor({ available: false, sourceIntervalMinutes: null, displayIntervalMinutes, method: "unavailable", validFrom: forecastAt, validTo })
      },
      sourceFreshness: []
    };
  });
}

function unavailableForecast(
  spotId: SpotId,
  now: Date,
  sourceNote: string,
  caveat: string,
  interval: ForecastInterval
): ForecastResponse {
  return publicForecastResponse({
    spot: getSpotProfile(spotId),
    windows: unavailableWindows(spotId, now, caveat, interval),
    interval,
    generatedAt: now.toISOString(),
    sourceNote,
    observation: null,
    observations: [],
    tideEvents: [],
    sunPhases: [],
    issueDelta: null
  });
}

type ForecastSourceRows = {
  tideRows: TideRow[];
  tideEventRows: TideEventRow[];
  windRows: WindRow[];
  waveRows: WaveRow[];
  observationRows: ObservationRow[];
  hazardRows: HazardRow[];
  sourceRuns: SourceRunRow[];
  forecastIssues: ForecastIssueRow[];
  forecastSnapshotRows: ForecastSnapshotRow[];
};

type BuildForecastOptions = {
  failOnReadError?: boolean;
  sourceRows?: ForecastSourceRows;
};

function preparedQuery(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): D1PreparedStatement {
  const statement = db.prepare(sql);
  return bindings.length > 0 ? statement.bind(...bindings) : statement;
}

async function loadForecastSourceRows(
  db: D1Database,
  spotId: SpotId,
  now: Date,
  forecastTimes: string[]
): Promise<ForecastSourceRows> {
  const horizonStart = forecastTimes[0]!;
  const horizonEnd = forecastTimes.at(-1)!;
  const waveHorizonStart = new Date(
    new Date(horizonStart).getTime() - 3 * 60 * 60 * 1000
  ).toISOString();
  const waveHorizonEnd = new Date(new Date(horizonEnd).getTime() + 90 * 60 * 1000).toISOString();
  const statements = [
    preparedQuery(
      db,
      `select forecast_at, tide_ft_mllw, tide_trend, source_run_id
       from tide_forecasts
       where spot_id = ? and forecast_at >= ? and forecast_at <= ?
       order by forecast_at asc`,
      spotId,
      horizonStart,
      horizonEnd
    ),
    preparedQuery(
      db,
      `select station_id, event_at, tide_ft_mllw, event_type, source_run_id
       from tide_events
       where spot_id = ? and event_at >= ? and event_at <= ?
       order by event_at asc`,
      spotId,
      horizonStart,
      horizonEnd
    ),
    preparedQuery(
      db,
      `select forecast_at, model_cycle_at, wind_speed_ms, wind_direction_deg, gust_ms, weather_summary, source_run_id
       from wind_forecasts
       where spot_id = ? and forecast_at >= ? and forecast_at <= ?
       order by forecast_at asc`,
      spotId,
      horizonStart,
      horizonEnd
    ),
    preparedQuery(
      db,
      `select source_id, forecast_at, model_cycle_at, nearshore_height_m, offshore_height_m,
              significant_height_m, peak_period_s, primary_direction_deg, swell_height_m,
              swell_period_s, swell_direction_deg, payload_json, source_run_id
       from (
         select source_id, forecast_at, model_cycle_at, nearshore_height_m, offshore_height_m,
                significant_height_m, peak_period_s, primary_direction_deg, swell_height_m,
                swell_period_s, swell_direction_deg, payload_json, source_run_id, created_at,
                row_number() over (
                  partition by source_id, forecast_at
                  order by case when nearshore_height_m is not null then 0 else 1 end,
                           model_cycle_at desc, created_at desc
                ) as source_rank
         from wave_forecasts
         where spot_id = ? and forecast_at >= ? and forecast_at <= ?
      )
       where source_rank = 1
       order by forecast_at asc`,
      spotId,
      waveHorizonStart,
      waveHorizonEnd
    ),
    preparedQuery(
      db,
      `select source_id, source_run_id, observed_at, wave_height_m, peak_period_s,
              mean_period_s, primary_direction_deg, water_temp_c
       from wave_observations
       where spot_id = ? and observed_at >= ?
       order by observed_at desc`,
      spotId,
      new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    ),
    preparedQuery(
      db,
      `select starts_at, ends_at, headline, source_run_id
       from hazard_events
       where spot_id = ?
         and (ends_at is null or ends_at >= ?)
         and (starts_at is null or starts_at <= ?)
       order by starts_at asc`,
      spotId,
      horizonStart,
      horizonEnd
    ),
    preparedQuery(
      db,
      // The recent-runs window alone can evict a still-referenced old run:
      // five runs land per hourly cycle, so 100 rows span ~20 hours, while
      // the slowest declared late boundary (tide, cadence+grace) is 30 hours.
      // The union keeps every source's newest completed non-failure run
      // resolvable — partial runs also write referenced rows, so the
      // retention predicate must match createSourceRunIndex's usability rule
      // — letting a single-source outage age to "late" instead of flipping
      // to "missing".
      `select id, source_id, status, completed_at
       from source_runs
       where id in (
         select id from source_runs order by completed_at desc limit 100
       )
       or id in (
         select runs.id
         from source_runs runs
         join (
           select source_id, max(completed_at) as newest_completed_at
           from source_runs
           where status != 'failure' and completed_at is not null
           group by source_id
         ) newest
           on newest.source_id = runs.source_id
          and newest.newest_completed_at = runs.completed_at
         where runs.status != 'failure'
       )`
    ),
    preparedQuery(
      db,
      `select issue_id, issued_at
       from forecast_issues
       where spot_id = ?
       order by issued_at desc
       limit 2`,
      spotId
    )
  ];

  const results = typeof db.batch === "function"
    ? await db.batch(statements)
    : await Promise.all(statements.map((statement) => statement.all()));
  if (results.length !== statements.length) {
    throw new Error(
      `Forecast source read returned ${results.length} results for ${statements.length} statements`
    );
  }
  const tideRows = asRows(results[0] as D1Result<TideRow>);
  const tideEventRows = asRows(results[1] as D1Result<TideEventRow>);
  const windRows = asRows(results[2] as D1Result<WindRow>);
  const waveRows = asRows(results[3] as D1Result<WaveRow>);
  const observationRows = asRows(results[4] as D1Result<ObservationRow>);
  const hazardRows = asRows(results[5] as D1Result<HazardRow>);
  const sourceRuns = asRows(results[6] as D1Result<SourceRunRow>);
  const forecastIssues = asRows(results[7] as D1Result<ForecastIssueRow>);
  const forecastSnapshotRows = forecastIssues.length >= 2
    ? await queryRows<ForecastSnapshotRow>(
        db,
        `select issue_id, valid_at, raw_facts_json
         from forecast_snapshots
         where spot_id = ? and issue_id in (?, ?)`,
        spotId,
        forecastIssues[0]!.issue_id,
        forecastIssues[1]!.issue_id
      )
    : [];

  return {
    tideRows,
    tideEventRows,
    windRows,
    waveRows,
    observationRows,
    hazardRows,
    sourceRuns,
    forecastIssues,
    forecastSnapshotRows
  };
}

export async function buildForecastResponse(
  env: Env,
  spotId: SpotId,
  now = new Date(),
  interval: ForecastInterval = "3h",
  options: BuildForecastOptions = {}
): Promise<ForecastResponse> {
  if (typeof env.DB?.prepare !== "function") {
    if (options.failOnReadError) {
      throw new Error("D1 binding does not expose prepare() for forecast assembly");
    }
    return unavailableForecast(
      spotId,
      now,
      "Forecast unavailable because the D1 binding could not be read.",
      "No sourced wave forecast is available; surf rating is unknown.",
      interval
    );
  }

  try {
    const spot = getSpotProfile(spotId);
    const forecastTimes = interval === "1h"
      ? stableHourlyForecastTimes(now, 120)
      : stableThreeHourForecastTimes(now, 120, spot.timezone);
    const {
      tideRows: loadedTideRows,
      tideEventRows: loadedTideEventRows,
      windRows: loadedWindRows,
      waveRows: loadedWaveRows,
      observationRows,
      hazardRows,
      sourceRuns,
      forecastIssues,
      forecastSnapshotRows
    } = options.sourceRows ?? await loadForecastSourceRows(env.DB, spotId, now, forecastTimes);
    const horizonStartMs = Date.parse(forecastTimes[0]!);
    const horizonEndMs = Date.parse(forecastTimes.at(-1)!);
    const waveHorizonStartMs = horizonStartMs - 3 * HOUR_MS;
    const waveHorizonEndMs = horizonEndMs + 90 * 60 * 1000;
    const within = (timestamp: string, startMs: number, endMs: number): boolean => {
      const timestampMs = Date.parse(timestamp);
      return Number.isFinite(timestampMs) && timestampMs >= startMs && timestampMs <= endMs;
    };
    // A synchronized build loads the union horizon once, then restores each
    // interval's original query bounds before deterministic assembly.
    const tideRows = loadedTideRows.filter((row) =>
      within(row.forecast_at, horizonStartMs, horizonEndMs)
    );
    const tideEventRows = loadedTideEventRows.filter((row) =>
      within(row.event_at, horizonStartMs, horizonEndMs)
    );
    const windRows = loadedWindRows.filter((row) =>
      within(row.forecast_at, horizonStartMs, horizonEndMs)
    );
    const waveRows = loadedWaveRows.filter((row) =>
      within(row.forecast_at, waveHorizonStartMs, waveHorizonEndMs)
    );

    const observedSources = getOperationalObservedWaveSources(spot);
    const observation = preferredObservation(observedSources, observationRows, now);
    const observations = recentObservationSummaries(observedSources, observationRows, now);
    const displayIntervalMinutes = interval === "1h" ? 60 : 180;
    const forecastSlots = forecastTimes.map((forecastAt) => {
      const timeMs = Date.parse(forecastAt);
      return {
        forecastAt,
        timeMs,
        displayValidTo: new Date(timeMs + displayIntervalMinutes * 60_000).toISOString()
      };
    });
    const tideIndex = createTimeIndex(tideRows, (row) => row.forecast_at);
    const windIndex = createTimeIndex(windRows, (row) => row.forecast_at);
    const waveSelectionsByTime = preferredWaveSelectionsAt(waveRows, forecastSlots, spot.timezone);
    const waveDetailsFor = createWaveDetailsLookup();
    const hazardsByTime = activeHazardsAt(hazardRows, forecastSlots);
    const sourceRunIndex = createSourceRunIndex(sourceRuns);
    const observationTimeMs = observation ? Date.parse(observation.row.observed_at) : Number.NaN;
    const sourceFreshnessCache = new Map<string, SourceFreshness>();
    const cachedSourceFreshness = (
      input: Omit<Parameters<typeof sourceFreshnessEntry>[0], "now">
    ): SourceFreshness => {
      const key = [
        input.capability,
        input.sourceId,
        input.sourceRunId ?? "",
        input.updatedAt ?? "",
        input.expectedCadenceMinutes,
        input.graceMinutes
      ].join("\u0000");
      const cached = sourceFreshnessCache.get(key);
      if (cached) return cached;
      const entry = sourceFreshnessEntry({ ...input, now });
      sourceFreshnessCache.set(key, entry);
      return entry;
    };
    const sunPhases = solarPhasesForDates(
      forecastTimes.map((forecastAt) => localDateForTime(forecastAt, spot.timezone)),
      { lat: spot.lat, lon: spot.lon, timeZone: spot.timezone }
    );

    const windows: ScoredForecastWindow[] = forecastSlots.map(({ forecastAt, timeMs, displayValidTo }) => {
      const tide = interval === "1h"
        ? tideIndex.exact.get(timeMs) ?? null
        : closestByTimeIndex(tideIndex, timeMs, 90 * 60 * 1000);
      const wind = interval === "1h"
        ? windIndex.exact.get(timeMs) ?? null
        : worstWindInWindowFromIndex(windIndex, timeMs, spot);
      const waveSelection = waveSelectionsByTime.get(timeMs) ?? null;
      const selectedWave = waveSelection?.row ?? null;
      const hazard = hazardsByTime.get(timeMs) ?? null;
      const waveDetails = selectedWave ? waveDetailsFor(selectedWave) : null;
      const payload = waveDetails?.payload ?? {};
      const waveClassification = waveDetails?.classification ?? null;
      // Unknown or malformed semantics fail closed: the raw row remains visible
      // through freshness/caveats, but it cannot produce a numeric surf call.
      const wave = waveClassification ? selectedWave : null;
      const pointRelationship =
        payload.pointRelationship === "direct_nearshore_point" ||
        payload.pointRelationship === "outside_cove_approach_proxy"
          ? payload.pointRelationship
          : null;
      const waveSourceUpdatedAt = waveDetails?.sourceUpdatedAt ?? selectedWave?.model_cycle_at ?? null;
      const waveHeightFt = metersToFeet(wave?.nearshore_height_m ?? null);
      const peakPeriodSec = wave?.swell_period_s ?? wave?.peak_period_s ?? null;
      const primaryDirectionDeg = wave?.swell_direction_deg ?? wave?.primary_direction_deg ?? null;
      const windSpeedKt = msToKt(wind?.wind_speed_ms ?? null);
      const windGustKt = msToKt(wind?.gust_ms ?? null);
      const windDirectionDeg = wind?.wind_direction_deg ?? null;
      const weatherSummary = wind?.weather_summary ?? null;
      const activeCapabilities: SourceCapability[] = [];
      const caveats: string[] = [];

      if (selectedWave && !waveClassification) {
        caveats.push(
          `Wave source ${selectedWave.source_id} omitted recognized nearshore semantics; the row was ignored and the surf rating is unknown.`
        );
      } else if (wave && waveHeightFt !== null && peakPeriodSec !== null && primaryDirectionDeg !== null) {
        activeCapabilities.push(wave.nearshore_height_m !== null ? "forecast_wave_nearshore" : "forecast_wave_offshore");
      } else {
        caveats.push("No sourced wave height, period, and direction are available for this window; surf rating is unknown.");
      }
      if (tide) activeCapabilities.push("tide");
      else caveats.push("CO-OPS tide row missing near this window.");
      if (wind && windSpeedKt !== null && windDirectionDeg !== null) activeCapabilities.push("wind");
      else caveats.push("NWS wind row missing or incomplete near this window.");
      const observationSupportsWindow = Boolean(
        observation?.isFresh &&
          Math.abs(timeMs - observationTimeMs) <=
            3 * 60 * 60 * 1000
      );
      if (observationSupportsWindow) activeCapabilities.push("observed_wave");
      else if (observation && !observation.isFresh) {
        caveats.push(`Buoy ${observation.summary.stationId} observation is stale.`);
      }
      if (hazard) {
        activeCapabilities.push("hazard");
        caveats.push(`Active NWS hazard: ${hazard.headline}`);
      }

      const runIds = sourceRunIds(
        tide?.source_run_id,
        wind?.source_run_id,
        wave?.source_run_id,
        observationSupportsWindow ? observation?.row.source_run_id : null,
        hazard?.source_run_id
      );
      // Wave cadence follows the selected source; a window with no wave row
      // declares the CDIP expectation so its missing/late judgment reflects
      // the preferred source for the spot.
      const waveIsGridSource = selectedWave?.source_id === NWS_GRID_WAVE_SOURCE_ID;
      const sourceFreshness: SourceFreshness[] = [
        cachedSourceFreshness({
          capability:
            selectedWave && selectedWave.nearshore_height_m !== null
              ? "forecast_wave_nearshore"
              : selectedWave
                ? "forecast_wave_offshore"
                : "forecast_wave_nearshore",
          sourceId: selectedWave?.source_id ?? "wave:unavailable",
          sourceRunId: selectedWave?.source_run_id,
          updatedAt:
            waveSourceUpdatedAt ?? sourceRunUpdatedAt(sourceRunIndex, selectedWave?.source_run_id),
          expectedCadenceMinutes: waveIsGridSource
            ? NWS_GRID_WAVE_EXPECTED_CADENCE_MINUTES
            : CDIP_MOP_EXPECTED_CADENCE_MINUTES,
          graceMinutes: waveIsGridSource ? NWS_GRID_WAVE_GRACE_MINUTES : CDIP_MOP_GRACE_MINUTES
        }),
        cachedSourceFreshness({
          capability: "wind",
          sourceId: NWS_POINT_SOURCE_ID,
          sourceRunId: wind?.source_run_id,
          updatedAt:
            wind?.model_cycle_at ?? sourceRunUpdatedAt(sourceRunIndex, wind?.source_run_id),
          expectedCadenceMinutes: NWS_POINT_EXPECTED_CADENCE_MINUTES,
          graceMinutes: NWS_POINT_GRACE_MINUTES
        }),
        cachedSourceFreshness({
          capability: "tide",
          sourceId: COOPS_TIDE_SOURCE_ID,
          sourceRunId: tide?.source_run_id,
          updatedAt: sourceRunUpdatedAt(sourceRunIndex, tide?.source_run_id),
          expectedCadenceMinutes: COOPS_TIDE_EXPECTED_CADENCE_MINUTES,
          graceMinutes: COOPS_TIDE_GRACE_MINUTES
        }),
        cachedSourceFreshness({
          capability: "observed_wave",
          sourceId: observation ? `ndbc-${observation.summary.stationId}` : "ndbc:preferred",
          sourceRunId: observation?.row.source_run_id,
          updatedAt: observation?.row.observed_at,
          expectedCadenceMinutes: NDBC_EXPECTED_CADENCE_MINUTES,
          graceMinutes: NDBC_GRACE_MINUTES
        })
      ];
      const availableFreshness = sourceFreshness.flatMap((item) =>
        item.freshnessMinutes === null ||
        (item.capability === "observed_wave" && !observationSupportsWindow)
          ? []
          : [item.freshnessMinutes]
      );
      const sourceFreshnessMinutes = availableFreshness.length > 0
        ? Math.max(...availableFreshness)
        : freshnessMinutes(sourceRunIndex, runIds, now);
      const cdipNearshoreHeightScale = finiteNumber(payload.nearshoreHeightScale);
      const usesColdStartTransform =
        waveClassification?.calibrationStatus === "cold_start_uncalibrated" ||
        waveClassification?.calibrationStatus === "proxy_uncalibrated";
      const modelCycleMs = wave ? waveDetails?.modelCycleMs ?? Number.NaN : Number.NaN;
      const forecastLeadHours = Number.isFinite(modelCycleMs)
        ? Math.max(0, (timeMs - modelCycleMs) / HOUR_MS)
        : Math.max(0, (timeMs - now.getTime()) / HOUR_MS);
      if (waveClassification?.calibrationStatus === "modeled_uncalibrated") {
        caveats.push(
          "Direct CDIP confidence uses the source model cycle and an uncalibrated-model cap of 89; it does not use the NWS cold-start penalty."
        );
      }
      const input: ForecastWindowInput = {
        spotId,
        forecastAt,
        waveHeightFt,
        peakPeriodSec,
        primaryDirectionDeg,
        tideFt: tide?.tide_ft_mllw ?? null,
        windSpeedKt,
        windDirectionDeg,
        sourceFreshnessMinutes,
        forecastLeadHours,
        usesColdStartTransform,
        calibrationStatus: waveClassification?.calibrationStatus ?? "unavailable",
        activeCapabilities
      };
      const score = scoreSpotWindow(spot, input);

      const rawSignificantHeightFt = metersToFeet(wave?.significant_height_m ?? finiteNumber(payload.significantHeightM));
      const breakingHeightScale = finiteNumber(payload.breakingHeightScale);
      const sourceUrl = typeof payload.sourceUrl === "string" ? payload.sourceUrl : null;
      let waveProvenance: WaveProvenance | null = null;
      if (
        wave?.source_id === NWS_GRID_WAVE_SOURCE_ID &&
        rawSignificantHeightFt !== null &&
        waveHeightFt !== null &&
        breakingHeightScale !== null &&
        sourceUrl
      ) {
        waveProvenance = {
          sourceId: wave.source_id,
          provider: "NOAA/NWS MTR coastal grid",
          sourceUrl,
          sourceUpdatedAt: wave.model_cycle_at,
          rawSignificantHeightFt,
          breakingHeightScale,
          estimatedBreakingHeightFt: waveHeightFt,
          heightSemantics: "estimated_breaking_height",
          derivation: "nws_coastal_grid_spot_scale"
        };
        caveats.push(
          `Breaking height is a cold-start estimate from NWS coastal-grid significant wave height × ${breakingHeightScale.toFixed(2)} spot scale.`
        );
      }
      const modelPointId = typeof payload.modelPointId === "string" ? payload.modelPointId : null;
      const modelPointWaterDepthM = finiteNumber(payload.modelPointWaterDepthM);
      const modelPointShoreNormalDeg = finiteNumber(payload.modelPointShoreNormalDeg);
      const exposureAdjustedPointHeightM = finiteNumber(payload.exposureAdjustedPointHeightM);
      const experimentalBreakingHeightM = finiteNumber(payload.experimentalBreakingHeightM);
      const shoalingFactor = finiteNumber(payload.shoalingFactor);
      const totalHeightFactor = finiteNumber(payload.totalHeightFactor);
      const breakerIndex = finiteNumber(payload.breakerIndex);
      const breakingDepthM = finiteNumber(payload.breakingDepthM);
      const incidenceAngleDeg = finiteNumber(payload.incidenceAngleDeg);
      if (
        wave?.source_id === CDIP_MOP_SOURCE_ID &&
        rawSignificantHeightFt !== null &&
        waveHeightFt !== null &&
        cdipNearshoreHeightScale !== null &&
        exposureAdjustedPointHeightM !== null &&
        sourceUrl &&
        waveSourceUpdatedAt &&
        modelPointId &&
        modelPointWaterDepthM !== null &&
        pointRelationship
      ) {
        waveProvenance = {
          sourceId: wave.source_id,
          provider: "CDIP MOP nearshore model",
          sourceUrl,
          sourceUpdatedAt: waveSourceUpdatedAt,
          modelCycleAt: wave.model_cycle_at,
          rawSignificantHeightFt,
          breakingHeightScale: cdipNearshoreHeightScale,
          exposureScale: cdipNearshoreHeightScale,
          shoalingFactor: shoalingFactor ?? undefined,
          totalHeightFactor: totalHeightFactor ?? undefined,
          breakerIndex: breakerIndex ?? undefined,
          breakingDepthM: breakingDepthM ?? undefined,
          incidenceAngleDeg: incidenceAngleDeg ?? undefined,
          experimentalBreakingHeightFt: metersToFeet(experimentalBreakingHeightM),
          transformMethod:
            payload.transformMethod === "linear-energy-flux-snell-depth-limited"
              ? payload.transformMethod
              : undefined,
          transformVersion:
            payload.transformVersion === "bulk-hs-linear-shoaling-v1"
              ? payload.transformVersion
              : undefined,
          estimatedBreakingHeightFt: null,
          modeledNearshoreSignificantHeightFt: waveHeightFt,
          heightSemantics: "modeled_significant_wave_height_not_breaking_face_height",
          modelPointId,
          modelPointWaterDepthM,
          modelPointShoreNormalDeg: modelPointShoreNormalDeg ?? undefined,
          pointRelationship,
          sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle",
          derivation:
            pointRelationship === "outside_cove_approach_proxy"
              ? "cdip_mop_point_hs_spot_scale"
              : "cdip_mop_point_hs"
        };
        caveats.push(
          pointRelationship === "outside_cove_approach_proxy"
            ? `Linda Mar uses CDIP ${modelPointId} modeled Hs outside the cove × ${cdipNearshoreHeightScale.toFixed(2)} final cove scale; this is not breaking-wave face truth.`
            : `CDIP ${modelPointId} is modeled significant wave height at ${modelPointWaterDepthM} m, not observed breaking-wave face height.`
        );
        if (experimentalBreakingHeightM !== null) {
          caveats.push(
            "An experimental bulk-Hs breaking proxy is retained for backtesting only and does not affect the displayed height or score."
          );
        }
        caveats.push("CDIP HTTP Last-Modified is the source-file update time, not an underlying model cycle.");
      }

      const waveState: WaveState | null = wave && waveClassification && waveSelection
        ? {
            semantics: waveClassification.semantics,
            calibrationStatus: waveClassification.calibrationStatus,
            validFrom: waveSelection.validFrom,
            validTo: waveSelection.validTo,
            sourceResolutionHours: waveSelection.sourceResolutionMinutes / 60,
            modeledNearshoreHeightFt:
              wave.source_id === CDIP_MOP_SOURCE_ID ? waveHeightFt : rawSignificantHeightFt,
            breakingSurfHeightFt:
              wave.source_id === NWS_GRID_WAVE_SOURCE_ID ? waveHeightFt : null,
            periodSec: peakPeriodSec,
            directionDeg: primaryDirectionDeg
          }
        : null;
      const surfaceCondition = surfaceConditionForWind(spot, {
        windSpeedKt,
        windDirectionDeg
      });
      const windAvailable = Boolean(wind && windSpeedKt !== null && windDirectionDeg !== null);
      const tideAvailable = Boolean(tide);
      const waveAvailable = Boolean(waveState);
      const primarySwell = wave?.source_id === CDIP_MOP_SOURCE_ID
        ? null
        : swellComponent(
            wave?.swell_height_m ?? payload.primarySwellHeightM,
            wave?.swell_period_s ?? payload.primarySwellPeriodS,
            wave?.swell_direction_deg ?? payload.primarySwellDirectionDeg
          );
      const secondarySwell = wave?.source_id === CDIP_MOP_SOURCE_ID
        ? null
        : swellComponent(
            payload.secondarySwellHeightM,
            payload.secondarySwellPeriodS,
            payload.secondarySwellDirectionDeg
          );
      const tideValidFrom = tide?.forecast_at ?? forecastAt;
      const tideValidFromMs = tide
        ? tideIndex.timeByRow.get(tide) ?? Date.parse(tideValidFrom)
        : timeMs;
      const tideValidTo = new Date(tideValidFromMs + HOUR_MS).toISOString();

      return {
        ...score,
        waveHeightFt,
        peakPeriodSec,
        primaryDirectionDeg,
        tideFt: input.tideFt,
        tideTrend:
          tide?.tide_trend === "rising" ||
          tide?.tide_trend === "falling" ||
          tide?.tide_trend === "steady" ||
          tide?.tide_trend === "unknown"
            ? tide.tide_trend
            : null,
        windSpeedKt,
        windGustKt,
        windDirectionDeg,
        weatherSummary,
        surfaceCondition,
        sourceFreshnessMinutes,
        activeCapabilities,
        sourceRunIds: runIds,
        caveats,
        primarySwell,
        secondarySwell,
        waveProvenance,
        waveState,
        resolution: {
          wave: resolutionFor({
            available: waveAvailable,
            sourceIntervalMinutes: waveSelection?.sourceResolutionMinutes ?? null,
            displayIntervalMinutes,
            method:
              interval === "1h" || waveSelection?.validFrom !== forecastAt
                ? "held"
                : "exact",
            validFrom: waveSelection?.validFrom ?? forecastAt,
            validTo: waveSelection?.validTo ?? displayValidTo
          }),
          wind: resolutionFor({
            available: windAvailable,
            sourceIntervalMinutes: 60,
            displayIntervalMinutes,
            method: interval === "1h" ? "exact" : "aggregated",
            validFrom: forecastAt,
            validTo: displayValidTo
          }),
          tide: resolutionFor({
            available: tideAvailable,
            sourceIntervalMinutes: 60,
            displayIntervalMinutes,
            method: "exact",
            validFrom: tideValidFrom,
            validTo: tideValidTo
          })
        },
        sourceFreshness
      };
    });
    const usesCdipMop = windows.some((window) => window.waveProvenance?.sourceId === CDIP_MOP_SOURCE_ID);
    const sourceNote = usesCdipMop
      ? "Wave conditions prefer public CDIP MOP modeled significant wave height at the mapped 10/15 m point, with NOAA/NWS MTR coastal-grid waves retained as fallback and NOAA/NDBC buoys as current context. CDIP Hs is not observed breaking-wave face height; Linda Mar alone keeps the visible 0.60 final cove scale. An experimental breaking proxy is retained for future evaluation but does not affect the displayed height or score. HTTP Last-Modified is a source-file update, not a model cycle."
      : spotId === "bolinas"
        ? "Bolinas has no safe direct CDIP MOP mapping and remains uncalibrated on official NOAA/NWS MTR coastal-grid data as the fallback. Its visible spot scale is a cold-start estimate, not breaking-wave truth; NOAA/NDBC buoys provide current context."
        : "CDIP MOP is mapped but no usable row was available for this window, so wave conditions use the official NOAA/NWS MTR coastal-grid fallback with NOAA/NDBC buoy context. The NWS spot scale is a visible cold-start breaking-height estimate. Missing wave data returns an unknown call.";
    const tideEvents: TideEvent[] = tideEventRows.flatMap((row) => {
      if (row.event_type !== "high" && row.event_type !== "low") return [];
      return [{
        stationId: row.station_id,
        eventAt: row.event_at,
        type: row.event_type,
        heightFtMllw: row.tide_ft_mllw,
        sourceRunId: row.source_run_id
      }];
    });

    return publicForecastResponse({
      spot,
      windows,
      interval,
      generatedAt: now.toISOString(),
      sourceNote,
      observation: observation?.summary ?? null,
      observations,
      tideEvents,
      sunPhases,
      issueDelta: issueDelta(forecastIssues, forecastSnapshotRows)
    });
  } catch (error) {
    if (options.failOnReadError) throw error;
    console.error(
      JSON.stringify({
        event: "forecast_assembly_failed",
        message: "forecast assembly failed",
        spotId,
        interval,
        reasonCode: "forecast_assembly_failed",
        errorName: boundedErrorName(error)
      })
    );
    return unavailableForecast(
      spotId,
      now,
      "Forecast unavailable because normalized source rows could not be read.",
      "Source read failed; no synthetic forecast was substituted and surf rating is unknown.",
      interval
    );
  }
}

export async function buildSynchronizedForecastResponses(
  env: Env,
  spotId: SpotId,
  now = new Date(),
  options: { failOnReadError?: boolean } = {}
): Promise<{ threeHour: ForecastResponse; hourly: ForecastResponse }> {
  const unavailable = () => ({
    threeHour: unavailableForecast(
      spotId,
      now,
      "Forecast unavailable because normalized source rows could not be read.",
      "Source read failed; no synthetic forecast was substituted and surf rating is unknown.",
      "3h"
    ),
    hourly: unavailableForecast(
      spotId,
      now,
      "Forecast unavailable because normalized source rows could not be read.",
      "Source read failed; no synthetic forecast was substituted and surf rating is unknown.",
      "1h"
    )
  });
  if (typeof env.DB?.prepare !== "function") {
    if (options.failOnReadError) {
      throw new Error("D1 binding does not expose prepare() for forecast assembly");
    }
    return unavailable();
  }

  try {
    const spot = getSpotProfile(spotId);
    const forecastTimes = [
      ...new Set([
        ...stableHourlyForecastTimes(now, 120),
        ...stableThreeHourForecastTimes(now, 120, spot.timezone)
      ])
    ].sort();
    const sourceRows = await loadForecastSourceRows(env.DB, spotId, now, forecastTimes);
    // Assembly is deterministic and read-free once the shared source snapshot
    // is loaded. Fail the pair together so 1h and 3h can never publish from
    // different D1 reads or generation times.
    const buildOptions: BuildForecastOptions = {
      failOnReadError: true,
      sourceRows
    };
    const threeHour = await buildForecastResponse(env, spotId, now, "3h", buildOptions);
    const hourly = await buildForecastResponse(env, spotId, now, "1h", buildOptions);
    return { threeHour, hourly };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "synchronized_forecast_assembly_failed",
        message: "synchronized forecast assembly failed",
        spotId,
        reasonCode: "synchronized_forecast_assembly_failed",
        errorName: boundedErrorName(error)
      })
    );
    if (options.failOnReadError) throw error;
    return unavailable();
  }
}
