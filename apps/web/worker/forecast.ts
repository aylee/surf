import {
  ForecastResponseSchema,
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
import { CDIP_MOP_SOURCE_ID } from "./adapters/cdip-mop";
import { NDBC_STALE_AFTER_MINUTES } from "./adapters/ndbc";
import { NWS_GRID_WAVE_SOURCE_ID } from "./adapters/nws-grid-wave";
import type { Env } from "./index";
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

function closestByTime<T>(rows: T[], forecastAt: string, timeOf: (row: T) => string, maxDistanceMs: number): T | null {
  const target = new Date(forecastAt).getTime();
  let best: { row: T; distance: number } | null = null;
  for (const row of rows) {
    const distance = Math.abs(new Date(timeOf(row)).getTime() - target);
    if (!Number.isFinite(distance) || distance > maxDistanceMs) continue;
    if (!best || distance < best.distance) best = { row, distance };
  }
  return best?.row ?? null;
}

function exactByTime<T>(rows: T[], forecastAt: string, timeOf: (row: T) => string): T | null {
  const target = new Date(forecastAt).getTime();
  if (!Number.isFinite(target)) return null;
  return rows.find((row) => new Date(timeOf(row)).getTime() === target) ?? null;
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

function preferredWaveSelectionAt(
  rows: WaveRow[],
  forecastAt: string,
  timeZone: string
): WaveSelection | null {
  const target = new Date(forecastAt).getTime();
  if (!Number.isFinite(target)) return null;
  return (
    rows
      .flatMap((row) => {
        const validity = waveValidityForRow(row, timeZone);
        if (!validity) return [];
        const validFrom = new Date(validity.validFrom).getTime();
        const validTo = new Date(validity.validTo).getTime();
        return target >= validFrom && target < validTo ? [{ row, ...validity }] : [];
      })
      .sort((left, right) => {
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
        return right.row.forecast_at.localeCompare(left.row.forecast_at);
      })[0] ?? null
  );
}

export function preferredWaveAt(
  rows: WaveRow[],
  forecastAt: string,
  timeZone = "America/Los_Angeles"
): WaveRow | null {
  return preferredWaveSelectionAt(rows, forecastAt, timeZone)?.row ?? null;
}

function worstWindInWindow(
  rows: WindRow[],
  forecastAt: string,
  spot: NorcalSpotProfile
): WindRow | null {
  const start = new Date(forecastAt).getTime();
  const end = start + 3 * 60 * 60 * 1000;
  const inWindow = rows.filter((row) => {
    const time = new Date(row.forecast_at).getTime();
    return Number.isFinite(time) && time >= start && time < end;
  });
  const complete = inWindow.filter(
    (row) => row.wind_speed_ms !== null && row.wind_direction_deg !== null
  );
  const severity = { unknown: -1, clean: 0, fair: 1, choppy: 2 } as const;
  const worstComplete = complete.sort((left, right) => {
    const leftSurface = surfaceConditionForWind(spot, {
      windSpeedKt: left.wind_speed_ms! * 1.94384,
      windDirectionDeg: left.wind_direction_deg
    });
    const rightSurface = surfaceConditionForWind(spot, {
      windSpeedKt: right.wind_speed_ms! * 1.94384,
      windDirectionDeg: right.wind_direction_deg
    });
    const surfaceDelta = severity[rightSurface] - severity[leftSurface];
    if (surfaceDelta !== 0) return surfaceDelta;
    return right.wind_speed_ms! - left.wind_speed_ms!;
  })[0];
  return (
    worstComplete ?? inWindow.sort(
      (left, right) =>
        (right.wind_speed_ms ?? Number.NEGATIVE_INFINITY) -
        (left.wind_speed_ms ?? Number.NEGATIVE_INFINITY)
    )[0] ?? closestByTime(rows, forecastAt, (row) => row.forecast_at, 90 * 60 * 1000)
  );
}

function freshnessMinutes(sourceRuns: SourceRunRow[], runIds: string[], now: Date): number {
  const completedTimes = sourceRuns.flatMap((run) => {
    if (!runIds.includes(run.id) || !run.completed_at || run.status === "failure") return [];
    const time = new Date(run.completed_at).getTime();
    return Number.isFinite(time) ? [time] : [];
  });
  if (completedTimes.length === 0) return 24 * 60;
  return Math.max(0, Math.round((now.getTime() - Math.min(...completedTimes)) / 60000));
}

function sourceRunUpdatedAt(
  sourceRuns: SourceRunRow[],
  sourceRunId: string | null | undefined
): string | null {
  if (!sourceRunId) return null;
  const run = sourceRuns.find((candidate) => candidate.id === sourceRunId);
  if (!run?.completed_at || run.status === "failure") return null;
  return Number.isFinite(new Date(run.completed_at).getTime()) ? run.completed_at : null;
}

function sourceFreshnessEntry(input: {
  capability: SourceCapability;
  sourceId: string;
  sourceRunId: string | null | undefined;
  updatedAt: string | null | undefined;
  now: Date;
  staleAfterMinutes: number;
}): SourceFreshness {
  const updatedAt = input.updatedAt ?? null;
  const freshness = ageMinutes(updatedAt, input.now);
  return {
    capability: input.capability,
    sourceId: input.sourceId,
    sourceRunId: input.sourceRunId ?? null,
    updatedAt,
    freshnessMinutes: freshness,
    status: freshness === null ? "missing" : freshness <= input.staleAfterMinutes ? "fresh" : "stale"
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

function activeHazardAt(rows: HazardRow[], forecastAt: string): HazardRow | null {
  const target = new Date(forecastAt).getTime();
  return (
    rows.find((row) => {
      const startsAt = row.starts_at ? new Date(row.starts_at).getTime() : Number.NEGATIVE_INFINITY;
      const endsAt = row.ends_at ? new Date(row.ends_at).getTime() : Number.POSITIVE_INFINITY;
      return Number.isFinite(target) && target >= startsAt && target < endsAt;
    }) ?? null
  );
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

export async function buildForecastResponse(
  env: Env,
  spotId: SpotId,
  now = new Date(),
  interval: ForecastInterval = "3h"
): Promise<ForecastResponse> {
  if (typeof env.DB?.prepare !== "function") {
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
    const horizonStart = forecastTimes[0]!;
    const horizonEnd = forecastTimes.at(-1)!;
    const waveHorizonStart = new Date(
      new Date(horizonStart).getTime() - 3 * 60 * 60 * 1000
    ).toISOString();
    const waveHorizonEnd = new Date(new Date(horizonEnd).getTime() + 90 * 60 * 1000).toISOString();
    const [
      tideRows,
      tideEventRows,
      windRows,
      waveRows,
      observationRows,
      hazardRows,
      sourceRuns,
      forecastIssues
    ] = await Promise.all([
      queryRows<TideRow>(
        env.DB,
        `select forecast_at, tide_ft_mllw, tide_trend, source_run_id
         from tide_forecasts
         where spot_id = ? and forecast_at >= ? and forecast_at <= ?
         order by forecast_at asc`,
        spotId,
        horizonStart,
        horizonEnd
      ),
      queryRows<TideEventRow>(
        env.DB,
        `select station_id, event_at, tide_ft_mllw, event_type, source_run_id
         from tide_events
         where spot_id = ? and event_at >= ? and event_at <= ?
         order by event_at asc`,
        spotId,
        horizonStart,
        horizonEnd
      ),
      queryRows<WindRow>(
        env.DB,
        `select forecast_at, model_cycle_at, wind_speed_ms, wind_direction_deg, gust_ms, weather_summary, source_run_id
         from wind_forecasts
         where spot_id = ? and forecast_at >= ? and forecast_at <= ?
         order by forecast_at asc`,
        spotId,
        horizonStart,
        horizonEnd
      ),
      queryRows<WaveRow>(
        env.DB,
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
      queryRows<ObservationRow>(
        env.DB,
        `select source_id, source_run_id, observed_at, wave_height_m, peak_period_s,
                mean_period_s, primary_direction_deg, water_temp_c
         from wave_observations
         where spot_id = ? and observed_at >= ?
         order by observed_at desc`,
        spotId,
        new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
      ),
      queryRows<HazardRow>(
        env.DB,
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
      queryRows<SourceRunRow>(
        env.DB,
        `select id, source_id, status, completed_at
         from source_runs
         order by completed_at desc
         limit 100`
      ),
      queryRows<ForecastIssueRow>(
        env.DB,
        `select issue_id, issued_at
         from forecast_issues
         where spot_id = ?
         order by issued_at desc
         limit 2`,
        spotId
      )
    ]);

    const forecastSnapshotRows = forecastIssues.length >= 2
      ? await queryRows<ForecastSnapshotRow>(
          env.DB,
          `select issue_id, valid_at, raw_facts_json
           from forecast_snapshots
           where spot_id = ? and issue_id in (?, ?)`,
          spotId,
          forecastIssues[0]!.issue_id,
          forecastIssues[1]!.issue_id
        )
      : [];

    const observedSources = getOperationalObservedWaveSources(spot);
    const observation = preferredObservation(observedSources, observationRows, now);
    const observations = recentObservationSummaries(observedSources, observationRows, now);
    const sunPhases = solarPhasesForDates(
      forecastTimes.map((forecastAt) => localDateForTime(forecastAt, spot.timezone)),
      { lat: spot.lat, lon: spot.lon, timeZone: spot.timezone }
    );

    const windows: ScoredForecastWindow[] = forecastTimes.map((forecastAt) => {
      const displayIntervalMinutes = interval === "1h" ? 60 : 180;
      const displayValidTo = new Date(
        new Date(forecastAt).getTime() + displayIntervalMinutes * 60_000
      ).toISOString();
      const tide = interval === "1h"
        ? exactByTime(tideRows, forecastAt, (row) => row.forecast_at)
        : closestByTime(tideRows, forecastAt, (row) => row.forecast_at, 90 * 60 * 1000);
      const wind = interval === "1h"
        ? exactByTime(windRows, forecastAt, (row) => row.forecast_at)
        : worstWindInWindow(windRows, forecastAt, spot);
      const waveSelection = preferredWaveSelectionAt(waveRows, forecastAt, spot.timezone);
      const selectedWave = waveSelection?.row ?? null;
      const hazard = activeHazardAt(hazardRows, forecastAt);
      const payload = parseWavePayload(selectedWave?.payload_json ?? null);
      const waveClassification = classifyWave(selectedWave, payload);
      // Unknown or malformed semantics fail closed: the raw row remains visible
      // through freshness/caveats, but it cannot produce a numeric surf call.
      const wave = waveClassification ? selectedWave : null;
      const pointRelationship =
        payload.pointRelationship === "direct_nearshore_point" ||
        payload.pointRelationship === "outside_cove_approach_proxy"
          ? payload.pointRelationship
          : null;
      const payloadSourceUpdatedAt =
        typeof payload.sourceUpdatedAt === "string" &&
        Number.isFinite(new Date(payload.sourceUpdatedAt).getTime())
          ? new Date(payload.sourceUpdatedAt).toISOString()
          : null;
      const waveSourceUpdatedAt = payloadSourceUpdatedAt ?? selectedWave?.model_cycle_at ?? null;
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
          Math.abs(new Date(forecastAt).getTime() - new Date(observation.row.observed_at).getTime()) <=
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
      const sourceFreshness: SourceFreshness[] = [
        sourceFreshnessEntry({
          capability:
            selectedWave && selectedWave.nearshore_height_m !== null
              ? "forecast_wave_nearshore"
              : selectedWave
                ? "forecast_wave_offshore"
                : "forecast_wave_nearshore",
          sourceId: selectedWave?.source_id ?? "wave:unavailable",
          sourceRunId: selectedWave?.source_run_id,
          updatedAt:
            waveSourceUpdatedAt ?? sourceRunUpdatedAt(sourceRuns, selectedWave?.source_run_id),
          now,
          staleAfterMinutes: 12 * 60
        }),
        sourceFreshnessEntry({
          capability: "wind",
          sourceId: "nws:point-forecast-alerts",
          sourceRunId: wind?.source_run_id,
          updatedAt:
            wind?.model_cycle_at ?? sourceRunUpdatedAt(sourceRuns, wind?.source_run_id),
          now,
          staleAfterMinutes: 6 * 60
        }),
        sourceFreshnessEntry({
          capability: "tide",
          sourceId: "coops:tide-predictions",
          sourceRunId: tide?.source_run_id,
          updatedAt: sourceRunUpdatedAt(sourceRuns, tide?.source_run_id),
          now,
          staleAfterMinutes: 12 * 60
        }),
        sourceFreshnessEntry({
          capability: "observed_wave",
          sourceId: observation ? `ndbc-${observation.summary.stationId}` : "ndbc:preferred",
          sourceRunId: observation?.row.source_run_id,
          updatedAt: observation?.row.observed_at,
          now,
          staleAfterMinutes: NDBC_STALE_AFTER_MINUTES
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
        : freshnessMinutes(sourceRuns, runIds, now);
      const cdipNearshoreHeightScale = finiteNumber(payload.nearshoreHeightScale);
      const usesColdStartTransform =
        waveClassification?.calibrationStatus === "cold_start_uncalibrated" ||
        waveClassification?.calibrationStatus === "proxy_uncalibrated";
      const modelCycleMs = wave ? new Date(wave.model_cycle_at).getTime() : Number.NaN;
      const forecastLeadHours = Number.isFinite(modelCycleMs)
        ? Math.max(0, (new Date(forecastAt).getTime() - modelCycleMs) / (60 * 60 * 1000))
        : Math.max(0, (new Date(forecastAt).getTime() - now.getTime()) / (60 * 60 * 1000));
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
      const tideValidTo = new Date(
        new Date(tideValidFrom).getTime() + 60 * 60_000
      ).toISOString();

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
    console.error(
      JSON.stringify({
        message: "forecast assembly failed",
        spotId,
        error: error instanceof Error ? error.message : String(error)
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
