import { getOperationalObservedWaveSources, NORCAL_SPOTS } from "@surf/forecast-core";
import type { CdipMopForecastRow } from "../adapters/cdip-mop";
import { CDIP_MOP_SOURCE_ID } from "../adapters/cdip-mop";
import type { TidePredictionRow } from "../adapters/coops";
import type { NdbcObservationRow } from "../adapters/ndbc";
import type { NwsContextRow } from "../adapters/nws";
import type { NwsGridWaveForecastRow } from "../adapters/nws-grid-wave";
import { NWS_GRID_WAVE_SOURCE_ID } from "../adapters/nws-grid-wave";
import { errorMessage } from "../adapters/types";
import { buildForecastResponse } from "../forecast";
import { persistForecastSnapshots, sha256StableJson } from "../forecast-history";
import type { Env } from "../index";
import { runPendingStatements } from "./database";
import type { PendingStatement, PersistenceResult } from "./types";

function isDaylightForecastAt(spotId: string, forecastAt: string): boolean {
  const spot = NORCAL_SPOTS.find((candidate) => candidate.id === spotId);
  if (!spot) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: spot.timezone
  }).formatToParts(new Date(forecastAt));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) && hour >= 6 && hour < 18;
}

function ktToMs(value: number | null): number | null {
  return value === null ? null : Math.round(value * 0.514444 * 1000) / 1000;
}

export async function persistTideForecasts(
  db: D1Database,
  sourceRunId: string,
  rows: TidePredictionRow[],
  createdAt: string
): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["DB binding does not expose prepare() for tide_forecasts."] };
  }

  const statement = db.prepare(
    `insert into tide_forecasts (
      spot_id,
      source_id,
      source_run_id,
      station_id,
      forecast_at,
      tide_ft_mllw,
      tide_m_mllw,
      tide_trend,
      high_low,
      payload_json,
      created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(spot_id, station_id, forecast_at) do update set
      source_id = excluded.source_id,
      source_run_id = excluded.source_run_id,
      tide_ft_mllw = excluded.tide_ft_mllw,
      tide_m_mllw = excluded.tide_m_mllw,
      tide_trend = excluded.tide_trend,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  );

  const pending = rows.map((row) => ({
    label: `tide_forecasts ${row.spotId} ${row.forecastAt}`,
    statement: statement.bind(
      row.spotId,
      "coops:tide-predictions",
      sourceRunId,
      row.stationId,
      row.forecastAt,
      row.tideFtMllw,
      Math.round(row.tideFtMllw * 0.3048 * 1000) / 1000,
      row.tideTrend,
      null,
      JSON.stringify(row),
      createdAt
    )
  }));

  return runPendingStatements(db, pending);
}

export async function persistWaveForecasts(
  db: D1Database,
  sourceRunId: string,
  rows: NwsGridWaveForecastRow[],
  createdAt: string
): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["DB binding does not expose prepare() for wave_forecasts."] };
  }

  const statement = db.prepare(
    `insert into wave_forecasts (
      spot_id,
      source_id,
      source_run_id,
      model_cycle_at,
      forecast_at,
      lead_hour,
      offshore_height_m,
      nearshore_height_m,
      significant_height_m,
      peak_period_s,
      mean_period_s,
      primary_direction_deg,
      wind_wave_height_m,
      wind_wave_period_s,
      wind_wave_direction_deg,
      swell_height_m,
      swell_period_s,
      swell_direction_deg,
      payload_json,
      created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(spot_id, source_id, model_cycle_at, forecast_at) do update set
      source_run_id = excluded.source_run_id,
      nearshore_height_m = excluded.nearshore_height_m,
      significant_height_m = excluded.significant_height_m,
      peak_period_s = excluded.peak_period_s,
      primary_direction_deg = excluded.primary_direction_deg,
      wind_wave_height_m = excluded.wind_wave_height_m,
      swell_height_m = excluded.swell_height_m,
      swell_period_s = excluded.swell_period_s,
      swell_direction_deg = excluded.swell_direction_deg,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  );

  const pending = rows.map((row) => ({
    label: `wave_forecasts ${row.spotId} ${row.forecastAt}`,
    statement: statement.bind(
      row.spotId,
      NWS_GRID_WAVE_SOURCE_ID,
      sourceRunId,
      row.modelCycleAt,
      row.forecastAt,
      row.leadHour,
      null,
      row.estimatedBreakingHeightM,
      row.significantHeightM,
      row.primarySwellPeriodS,
      null,
      row.primarySwellDirectionDeg,
      row.windWaveHeightM,
      null,
      null,
      row.primarySwellHeightM,
      row.primarySwellPeriodS,
      row.primarySwellDirectionDeg,
      JSON.stringify(row),
      createdAt
    )
  }));

  return runPendingStatements(db, pending);
}

export async function persistCdipMopForecasts(
  db: D1Database,
  sourceRunId: string,
  rows: CdipMopForecastRow[],
  createdAt: string
): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["DB binding does not expose prepare() for CDIP wave_forecasts."] };
  }

  const statement = db.prepare(
    `insert into wave_forecasts (
      spot_id,
      source_id,
      source_run_id,
      model_cycle_at,
      forecast_at,
      lead_hour,
      offshore_height_m,
      nearshore_height_m,
      significant_height_m,
      peak_period_s,
      mean_period_s,
      primary_direction_deg,
      wind_wave_height_m,
      wind_wave_period_s,
      wind_wave_direction_deg,
      swell_height_m,
      swell_period_s,
      swell_direction_deg,
      payload_json,
      created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(spot_id, source_id, model_cycle_at, forecast_at) do update set
      source_run_id = excluded.source_run_id,
      nearshore_height_m = excluded.nearshore_height_m,
      significant_height_m = excluded.significant_height_m,
      peak_period_s = excluded.peak_period_s,
      primary_direction_deg = excluded.primary_direction_deg,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  );

  const pending = rows.map((row) => ({
    label: `wave_forecasts CDIP ${row.spotId} ${row.forecastAt}`,
    statement: statement.bind(
      row.spotId,
      CDIP_MOP_SOURCE_ID,
      sourceRunId,
      row.modelCycleAt,
      row.forecastAt,
      row.leadHour,
      null,
      row.nearshoreHeightM,
      row.significantHeightM,
      row.peakPeriodS,
      null,
      row.peakDirectionDeg,
      null,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify(row),
      createdAt
    )
  }));

  return runPendingStatements(db, pending);
}

export async function persistWaveObservations(
  db: D1Database,
  sourceRunId: string,
  rows: NdbcObservationRow[],
  createdAt: string
): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["DB binding does not expose prepare() for wave_observations."] };
  }

  const statement = db.prepare(
    `insert into wave_observations (
      spot_id,
      source_id,
      source_run_id,
      observed_at,
      wave_height_m,
      peak_period_s,
      mean_period_s,
      primary_direction_deg,
      wind_wave_height_m,
      swell_height_m,
      water_temp_c,
      payload_json,
      created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(spot_id, source_id, observed_at) do update set
      source_run_id = excluded.source_run_id,
      wave_height_m = excluded.wave_height_m,
      peak_period_s = excluded.peak_period_s,
      mean_period_s = excluded.mean_period_s,
      primary_direction_deg = excluded.primary_direction_deg,
      water_temp_c = excluded.water_temp_c,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  );

  const pending: PendingStatement[] = [];
  for (const row of rows) {
    for (const spot of NORCAL_SPOTS.filter((candidate) =>
      getOperationalObservedWaveSources(candidate).some(
        (source) => source.stationId === row.stationId
      )
    )) {
      pending.push({
        label: `wave_observations ${spot.id} ${row.stationId} ${row.observedAt}`,
        statement: statement.bind(
          spot.id,
          `ndbc-${row.stationId}`,
          sourceRunId,
          row.observedAt,
          row.waveHeightM,
          row.dominantPeriodS,
          row.averagePeriodS,
          row.meanWaveDirectionDeg,
          null,
          null,
          row.waterTempC,
          JSON.stringify(row),
          createdAt
        )
      });
    }
  }

  return runPendingStatements(db, pending);
}

export async function persistNwsRows(
  db: D1Database,
  sourceRunId: string,
  rows: NwsContextRow[],
  createdAt: string,
  captureHistory: boolean
): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["DB binding does not expose prepare() for NWS rows."] };
  }

  const windStatement = db.prepare(
    `insert into wind_forecasts (
      spot_id,
      source_id,
      source_run_id,
      model_cycle_at,
      forecast_at,
      lead_hour,
      wind_speed_ms,
      wind_direction_deg,
      gust_ms,
      weather_summary,
      payload_json,
      created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(spot_id, source_id, forecast_at) do update set
      source_run_id = excluded.source_run_id,
      model_cycle_at = excluded.model_cycle_at,
      lead_hour = excluded.lead_hour,
      wind_speed_ms = excluded.wind_speed_ms,
      wind_direction_deg = excluded.wind_direction_deg,
      gust_ms = excluded.gust_ms,
      weather_summary = excluded.weather_summary,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  );
  const windIssueStatement = db.prepare(
    `insert into wind_forecast_issues (
      spot_id,
      source_id,
      source_run_id,
      issue_key,
      issued_at,
      model_cycle_at,
      forecast_at,
      lead_hours,
      wind_speed_ms,
      wind_direction_deg,
      gust_ms,
      weather_summary,
      payload_json,
      captured_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(spot_id, source_id, issue_key, forecast_at) do nothing`
  );
  const hazardStatement = db.prepare(
    `insert into hazard_events (
      spot_id,
      source_id,
      source_run_id,
      event_id,
      event_type,
      severity,
      certainty,
      urgency,
      starts_at,
      ends_at,
      headline,
      description,
      instruction,
      payload_json,
      updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(spot_id, source_id, event_id) do update set
      source_run_id = excluded.source_run_id,
      severity = excluded.severity,
      certainty = excluded.certainty,
      urgency = excluded.urgency,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      headline = excluded.headline,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at`
  );

  const pending: PendingStatement[] = [];
  for (const context of rows) {
    const officialIssuedAt = context.windForecasts.find((wind) => wind.issuedAt)?.issuedAt ?? null;
    const issuedAt = officialIssuedAt ?? createdAt;
    const issueKey = `sha256:${await sha256StableJson({
      sourceId: "nws:point-forecast-alerts",
      spotId: context.spotId,
      officialIssuedAt,
      windForecasts: context.windForecasts
    })}`;
    for (const wind of context.windForecasts) {
      const leadHours =
        (new Date(wind.forecastAt).getTime() - new Date(issuedAt).getTime()) /
        (60 * 60 * 1000);
      const payloadJson = JSON.stringify(wind);
      pending.push({
        label: `wind_forecasts ${wind.spotId} ${wind.forecastAt}`,
        statement: windStatement.bind(
          wind.spotId,
          "nws:point-forecast-alerts",
          sourceRunId,
          officialIssuedAt,
          wind.forecastAt,
          Number.isFinite(leadHours) ? Math.round(leadHours) : null,
          ktToMs(wind.windSpeedKt),
          wind.windDirectionDeg,
          ktToMs(wind.gustKt),
          wind.shortForecast,
          payloadJson,
          createdAt
        )
      });
      if (captureHistory && isDaylightForecastAt(wind.spotId, wind.forecastAt)) {
        pending.push({
          label: `wind_forecast_issues ${wind.spotId} ${wind.forecastAt}`,
          statement: windIssueStatement.bind(
            wind.spotId,
            "nws:point-forecast-alerts",
            sourceRunId,
            issueKey,
            issuedAt,
            officialIssuedAt,
            wind.forecastAt,
            Number.isFinite(leadHours) ? leadHours : null,
            ktToMs(wind.windSpeedKt),
            wind.windDirectionDeg,
            ktToMs(wind.gustKt),
            wind.shortForecast,
            null,
            createdAt
          )
        });
      }
    }

    for (const hazard of context.hazards) {
      const eventId = `${hazard.spotId}:${hazard.event}:${hazard.effectiveAt ?? "unknown"}:${hazard.expiresAt ?? "unknown"}`;
      pending.push({
        label: `hazard_events ${hazard.spotId} ${hazard.event}`,
        statement: hazardStatement.bind(
          hazard.spotId,
          "nws:point-forecast-alerts",
          sourceRunId,
          eventId,
          hazard.event,
          hazard.severity,
          hazard.certainty,
          hazard.urgency,
          hazard.effectiveAt,
          hazard.expiresAt,
          hazard.headline ?? hazard.event,
          null,
          null,
          JSON.stringify(hazard),
          createdAt
        )
      });
    }
  }

  return runPendingStatements(db, pending);
}

export async function persistIssuedForecasts(
  env: Env,
  now: Date,
  capturedAt: string,
  sourceIssueFingerprint: string
): Promise<PersistenceResult> {
  let rowsWritten = 0;
  const errors: string[] = [];

  for (const spot of NORCAL_SPOTS) {
    try {
      const response = await buildForecastResponse(env, spot.id, now);
      const result = await persistForecastSnapshots(env.DB, response, {
        capturedAt,
        issuedAt: now.toISOString(),
        sourceIssueFingerprint
      });
      rowsWritten += result.rowsWritten;
      errors.push(...result.errors.map((error) => `${spot.id}: ${error}`));
    } catch (error) {
      errors.push(`${spot.id}: forecast snapshot failed: ${errorMessage(error)}`);
    }
  }

  return { rowsWritten, errors };
}
