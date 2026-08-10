import {
  getOperationalObservedWaveSources,
  NORCAL_SPOTS,
  type NorcalSpotProfile
} from "@surf/forecast-core";
import type { CdipMopForecastRow } from "../adapters/cdip-mop";
import { CDIP_MOP_SOURCE_ID } from "../adapters/cdip-mop";
import type { TideEventRow, TidePredictionRow } from "../adapters/coops";
import type { NdbcObservationRow } from "../adapters/ndbc";
import type { NwsContextRow } from "../adapters/nws";
import type { NwsGridWaveForecastRow } from "../adapters/nws-grid-wave";
import { NWS_GRID_WAVE_SOURCE_ID } from "../adapters/nws-grid-wave";
import { errorMessage } from "../adapters/types";
import { buildForecastResponse } from "../forecast";
import { persistForecastSnapshots, sha256StableJson } from "../forecast-history";
import type { Env } from "../index";
import { runBulkStatements, type BulkStatement } from "./database";
import type { PersistenceResult } from "./types";

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
  if (rows.length === 0) return { rowsWritten: 0, errors: [] };

  const values = rows.map((row) => ({
    spotId: row.spotId,
    sourceRunId,
    stationId: row.stationId,
    forecastAt: row.forecastAt,
    tideFtMllw: row.tideFtMllw,
    tideMMllw: Math.round(row.tideFtMllw * 0.3048 * 1000) / 1000,
    tideTrend: row.tideTrend,
    payloadJson: JSON.stringify(row),
    createdAt
  }));
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
    )
    select
      json_extract(item.value, '$.spotId'),
      'coops:tide-predictions',
      json_extract(item.value, '$.sourceRunId'),
      json_extract(item.value, '$.stationId'),
      json_extract(item.value, '$.forecastAt'),
      json_extract(item.value, '$.tideFtMllw'),
      json_extract(item.value, '$.tideMMllw'),
      json_extract(item.value, '$.tideTrend'),
      null,
      json_extract(item.value, '$.payloadJson'),
      json_extract(item.value, '$.createdAt')
    from json_each(?) as item
    where 1
    on conflict(spot_id, station_id, forecast_at) do update set
      source_id = excluded.source_id,
      source_run_id = excluded.source_run_id,
      tide_ft_mllw = excluded.tide_ft_mllw,
      tide_m_mllw = excluded.tide_m_mllw,
      tide_trend = excluded.tide_trend,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  ).bind(JSON.stringify(values));

  return runBulkStatements(db, [{ label: "bulk tide_forecasts", statement, rowsWritten: rows.length }]);
}

export async function persistTideEvents(
  db: D1Database,
  sourceRunId: string,
  rows: TideEventRow[],
  createdAt: string
): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["DB binding does not expose prepare() for tide_events."] };
  }
  if (rows.length === 0) return { rowsWritten: 0, errors: [] };

  const values = rows.map((row) => ({
    spotId: row.spotId,
    sourceRunId,
    stationId: row.stationId,
    eventAt: row.eventAt,
    tideFtMllw: row.tideFtMllw,
    eventType: row.eventType,
    payloadJson: JSON.stringify(row),
    createdAt
  }));
  const statement = db.prepare(
    `insert into tide_events (
      spot_id,
      source_id,
      source_run_id,
      station_id,
      event_at,
      tide_ft_mllw,
      event_type,
      payload_json,
      created_at
    )
    select
      json_extract(item.value, '$.spotId'),
      'coops:tide-predictions',
      json_extract(item.value, '$.sourceRunId'),
      json_extract(item.value, '$.stationId'),
      json_extract(item.value, '$.eventAt'),
      json_extract(item.value, '$.tideFtMllw'),
      json_extract(item.value, '$.eventType'),
      json_extract(item.value, '$.payloadJson'),
      json_extract(item.value, '$.createdAt')
    from json_each(?) as item
    where 1
    on conflict(spot_id, station_id, event_at) do update set
      source_id = excluded.source_id,
      source_run_id = excluded.source_run_id,
      tide_ft_mllw = excluded.tide_ft_mllw,
      event_type = excluded.event_type,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  ).bind(JSON.stringify(values));

  return runBulkStatements(db, [{ label: "bulk tide_events", statement, rowsWritten: rows.length }]);
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
  if (rows.length === 0) return { rowsWritten: 0, errors: [] };

  const values = rows.map((row) => ({
    spotId: row.spotId,
    sourceRunId,
    modelCycleAt: row.modelCycleAt,
    forecastAt: row.forecastAt,
    leadHour: row.leadHour,
    nearshoreHeightM: row.estimatedBreakingHeightM,
    significantHeightM: row.significantHeightM,
    peakPeriodS: row.primarySwellPeriodS,
    primaryDirectionDeg: row.primarySwellDirectionDeg,
    windWaveHeightM: row.windWaveHeightM,
    swellHeightM: row.primarySwellHeightM,
    swellPeriodS: row.primarySwellPeriodS,
    swellDirectionDeg: row.primarySwellDirectionDeg,
    payloadJson: JSON.stringify(row),
    createdAt
  }));
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
    )
    select
      json_extract(item.value, '$.spotId'),
      '${NWS_GRID_WAVE_SOURCE_ID}',
      json_extract(item.value, '$.sourceRunId'),
      json_extract(item.value, '$.modelCycleAt'),
      json_extract(item.value, '$.forecastAt'),
      json_extract(item.value, '$.leadHour'),
      null,
      json_extract(item.value, '$.nearshoreHeightM'),
      json_extract(item.value, '$.significantHeightM'),
      json_extract(item.value, '$.peakPeriodS'),
      null,
      json_extract(item.value, '$.primaryDirectionDeg'),
      json_extract(item.value, '$.windWaveHeightM'),
      null,
      null,
      json_extract(item.value, '$.swellHeightM'),
      json_extract(item.value, '$.swellPeriodS'),
      json_extract(item.value, '$.swellDirectionDeg'),
      json_extract(item.value, '$.payloadJson'),
      json_extract(item.value, '$.createdAt')
    from json_each(?) as item
    where 1
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
  ).bind(JSON.stringify(values));

  return runBulkStatements(db, [{ label: "bulk NWS wave_forecasts", statement, rowsWritten: rows.length }]);
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
  if (rows.length === 0) return { rowsWritten: 0, errors: [] };

  const values = rows.map((row) => ({
    spotId: row.spotId,
    sourceRunId,
    modelCycleAt: row.modelCycleAt,
    forecastAt: row.forecastAt,
    leadHour: row.leadHour,
    nearshoreHeightM: row.nearshoreHeightM,
    significantHeightM: row.significantHeightM,
    peakPeriodS: row.peakPeriodS,
    primaryDirectionDeg: row.peakDirectionDeg,
    payloadJson: JSON.stringify(row),
    createdAt
  }));
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
    )
    select
      json_extract(item.value, '$.spotId'),
      '${CDIP_MOP_SOURCE_ID}',
      json_extract(item.value, '$.sourceRunId'),
      json_extract(item.value, '$.modelCycleAt'),
      json_extract(item.value, '$.forecastAt'),
      json_extract(item.value, '$.leadHour'),
      null,
      json_extract(item.value, '$.nearshoreHeightM'),
      json_extract(item.value, '$.significantHeightM'),
      json_extract(item.value, '$.peakPeriodS'),
      null,
      json_extract(item.value, '$.primaryDirectionDeg'),
      null,
      null,
      null,
      null,
      null,
      null,
      json_extract(item.value, '$.payloadJson'),
      json_extract(item.value, '$.createdAt')
    from json_each(?) as item
    where 1
    on conflict(spot_id, source_id, model_cycle_at, forecast_at) do update set
      source_run_id = excluded.source_run_id,
      nearshore_height_m = excluded.nearshore_height_m,
      significant_height_m = excluded.significant_height_m,
      peak_period_s = excluded.peak_period_s,
      primary_direction_deg = excluded.primary_direction_deg,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  ).bind(JSON.stringify(values));

  return runBulkStatements(db, [{ label: "bulk CDIP wave_forecasts", statement, rowsWritten: rows.length }]);
}

export async function persistWaveObservations(
  db: D1Database,
  sourceRunId: string,
  rows: NdbcObservationRow[],
  createdAt: string,
  targetSpots: readonly NorcalSpotProfile[]
): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["DB binding does not expose prepare() for wave_observations."] };
  }
  const values = rows.flatMap((row) =>
    targetSpots
      .filter((candidate) =>
        getOperationalObservedWaveSources(candidate).some(
          (source) => source.stationId === row.stationId
        )
      )
      .map((spot) => ({
        spotId: spot.id,
        sourceId: `ndbc-${row.stationId}`,
        sourceRunId,
        observedAt: row.observedAt,
        waveHeightM: row.waveHeightM,
        peakPeriodS: row.dominantPeriodS,
        meanPeriodS: row.averagePeriodS,
        primaryDirectionDeg: row.meanWaveDirectionDeg,
        waterTempC: row.waterTempC,
        payloadJson: JSON.stringify(row),
        createdAt
      }))
  );
  if (values.length === 0) return { rowsWritten: 0, errors: [] };

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
    )
    select
      json_extract(item.value, '$.spotId'),
      json_extract(item.value, '$.sourceId'),
      json_extract(item.value, '$.sourceRunId'),
      json_extract(item.value, '$.observedAt'),
      json_extract(item.value, '$.waveHeightM'),
      json_extract(item.value, '$.peakPeriodS'),
      json_extract(item.value, '$.meanPeriodS'),
      json_extract(item.value, '$.primaryDirectionDeg'),
      null,
      null,
      json_extract(item.value, '$.waterTempC'),
      json_extract(item.value, '$.payloadJson'),
      json_extract(item.value, '$.createdAt')
    from json_each(?) as item
    where 1
    on conflict(spot_id, source_id, observed_at) do update set
      source_run_id = excluded.source_run_id,
      wave_height_m = excluded.wave_height_m,
      peak_period_s = excluded.peak_period_s,
      mean_period_s = excluded.mean_period_s,
      primary_direction_deg = excluded.primary_direction_deg,
      water_temp_c = excluded.water_temp_c,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
  ).bind(JSON.stringify(values));

  return runBulkStatements(db, [{ label: "bulk wave_observations", statement, rowsWritten: values.length }]);
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
  const windValues: Array<Record<string, unknown>> = [];
  const windIssueValues: Array<Record<string, unknown>> = [];
  const hazardValues: Array<Record<string, unknown>> = [];
  const successfulAlertSpotIds: string[] = [];
  for (const context of rows) {
    if (context.alertsFetchSucceeded) successfulAlertSpotIds.push(context.spotId);
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
      windValues.push({
        spotId: wind.spotId,
        sourceRunId,
        modelCycleAt: officialIssuedAt,
        forecastAt: wind.forecastAt,
        leadHour: Number.isFinite(leadHours) ? Math.round(leadHours) : null,
        windSpeedMs: ktToMs(wind.windSpeedKt),
        windDirectionDeg: wind.windDirectionDeg,
        gustMs: ktToMs(wind.gustKt),
        weatherSummary: wind.shortForecast,
        payloadJson: JSON.stringify(wind),
        createdAt
      });
      if (captureHistory && isDaylightForecastAt(wind.spotId, wind.forecastAt)) {
        windIssueValues.push({
          spotId: wind.spotId,
          sourceRunId,
          issueKey,
          issuedAt,
          modelCycleAt: officialIssuedAt,
          forecastAt: wind.forecastAt,
          leadHours: Number.isFinite(leadHours) ? leadHours : null,
          windSpeedMs: ktToMs(wind.windSpeedKt),
          windDirectionDeg: wind.windDirectionDeg,
          gustMs: ktToMs(wind.gustKt),
          weatherSummary: wind.shortForecast,
          capturedAt: createdAt
        });
      }
    }

    if (!context.alertsFetchSucceeded) continue;
    for (const hazard of context.hazards) {
      const eventId = `${hazard.spotId}:${hazard.event}:${hazard.effectiveAt ?? "unknown"}:${hazard.expiresAt ?? "unknown"}`;
      hazardValues.push({
        spotId: hazard.spotId,
        sourceRunId,
        eventId,
        eventType: hazard.event,
        severity: hazard.severity,
        certainty: hazard.certainty,
        urgency: hazard.urgency,
        startsAt: hazard.effectiveAt,
        endsAt: hazard.expiresAt,
        headline: hazard.headline ?? hazard.event,
        payloadJson: JSON.stringify(hazard),
        updatedAt: createdAt
      });
    }
  }

  const pending: BulkStatement[] = [];
  if (windValues.length > 0) {
    pending.push({
      label: "bulk wind_forecasts",
      rowsWritten: windValues.length,
      statement: db.prepare(
        `insert into wind_forecasts (
          spot_id, source_id, source_run_id, model_cycle_at, forecast_at,
          lead_hour, wind_speed_ms, wind_direction_deg, gust_ms,
          weather_summary, payload_json, created_at
        )
        select
          json_extract(item.value, '$.spotId'),
          'nws:point-forecast-alerts',
          json_extract(item.value, '$.sourceRunId'),
          json_extract(item.value, '$.modelCycleAt'),
          json_extract(item.value, '$.forecastAt'),
          json_extract(item.value, '$.leadHour'),
          json_extract(item.value, '$.windSpeedMs'),
          json_extract(item.value, '$.windDirectionDeg'),
          json_extract(item.value, '$.gustMs'),
          json_extract(item.value, '$.weatherSummary'),
          json_extract(item.value, '$.payloadJson'),
          json_extract(item.value, '$.createdAt')
        from json_each(?) as item
        where 1
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
      ).bind(JSON.stringify(windValues))
    });
  }
  if (windIssueValues.length > 0) {
    pending.push({
      label: "bulk wind_forecast_issues",
      rowsWritten: windIssueValues.length,
      statement: db.prepare(
        `insert into wind_forecast_issues (
          spot_id, source_id, source_run_id, issue_key, issued_at,
          model_cycle_at, forecast_at, lead_hours, wind_speed_ms,
          wind_direction_deg, gust_ms, weather_summary, payload_json, captured_at
        )
        select
          json_extract(item.value, '$.spotId'),
          'nws:point-forecast-alerts',
          json_extract(item.value, '$.sourceRunId'),
          json_extract(item.value, '$.issueKey'),
          json_extract(item.value, '$.issuedAt'),
          json_extract(item.value, '$.modelCycleAt'),
          json_extract(item.value, '$.forecastAt'),
          json_extract(item.value, '$.leadHours'),
          json_extract(item.value, '$.windSpeedMs'),
          json_extract(item.value, '$.windDirectionDeg'),
          json_extract(item.value, '$.gustMs'),
          json_extract(item.value, '$.weatherSummary'),
          null,
          json_extract(item.value, '$.capturedAt')
        from json_each(?) as item
        where 1
        on conflict(spot_id, source_id, issue_key, forecast_at) do nothing`
      ).bind(JSON.stringify(windIssueValues))
    });
  }
  if (hazardValues.length > 0) {
    pending.push({
      label: "bulk hazard_events",
      rowsWritten: hazardValues.length,
      statement: db.prepare(
        `insert into hazard_events (
          spot_id, source_id, source_run_id, event_id, event_type, severity,
          certainty, urgency, starts_at, ends_at, headline, description,
          instruction, payload_json, updated_at
        )
        select
          json_extract(item.value, '$.spotId'),
          'nws:point-forecast-alerts',
          json_extract(item.value, '$.sourceRunId'),
          json_extract(item.value, '$.eventId'),
          json_extract(item.value, '$.eventType'),
          json_extract(item.value, '$.severity'),
          json_extract(item.value, '$.certainty'),
          json_extract(item.value, '$.urgency'),
          json_extract(item.value, '$.startsAt'),
          json_extract(item.value, '$.endsAt'),
          json_extract(item.value, '$.headline'),
          null,
          null,
          json_extract(item.value, '$.payloadJson'),
          json_extract(item.value, '$.updatedAt')
        from json_each(?) as item
        where 1
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
      ).bind(JSON.stringify(hazardValues))
    });
  }
  if (successfulAlertSpotIds.length > 0) {
    pending.push({
      label: "reconcile withdrawn hazard_events",
      rowsWritten: 0,
      statement: db.prepare(
        `delete from hazard_events
         where source_id = 'nws:point-forecast-alerts'
           and spot_id in (select value from json_each(?))
           and not exists (
             select 1
             from json_each(?) as active
             where json_extract(active.value, '$.spotId') = hazard_events.spot_id
               and json_extract(active.value, '$.eventId') = hazard_events.event_id
           )`
      ).bind(
        JSON.stringify([...new Set(successfulAlertSpotIds)]),
        JSON.stringify(hazardValues)
      )
    });
  }

  return runBulkStatements(db, pending);
}

export async function persistIssuedForecasts(
  env: Env,
  now: Date,
  capturedAt: string
): Promise<PersistenceResult> {
  let rowsWritten = 0;
  const errors: string[] = [];

  for (const spot of NORCAL_SPOTS) {
    try {
      const response = await buildForecastResponse(env, spot.id, now);
      const result = await persistForecastSnapshots(env.DB, response, {
        capturedAt,
        issuedAt: now.toISOString()
      });
      rowsWritten += result.rowsWritten;
      errors.push(...result.errors.map((error) => `${spot.id}: ${error}`));
    } catch (error) {
      errors.push(`${spot.id}: forecast snapshot failed: ${errorMessage(error)}`);
    }
  }

  return { rowsWritten, errors };
}
