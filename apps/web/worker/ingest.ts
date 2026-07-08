import { NORCAL_SPOTS } from "@surf/forecast-core";
import type { TidePredictionRow } from "./adapters/coops";
import { fetchCoopsTidePredictionsForSpots } from "./adapters/coops";
import type { NwsContextRow } from "./adapters/nws";
import { fetchNwsContextForSpots } from "./adapters/nws";
import type { AdapterOutcome, AdapterStatus, SourceCaveat, SourceFetch } from "./adapters/types";
import { combineStatus, errorMessage } from "./adapters/types";
import type { Env } from "./index";

export type IngestKind = "manual-ingest" | "scheduled-ingest" | "queued-ingest";

export type IngestQueueMessage = {
  kind: "manual-ingest" | "scheduled-ingest";
  requestedAt: string;
  region: string;
};

type SourceRunRecord = {
  id: string;
  sourceId: string;
  status: AdapterStatus;
  recorded: boolean;
  rowCount: number;
  caveatCount: number;
  errorCount: number;
  error: string | null;
};

type PersistenceResult = {
  rowsWritten: number;
  errors: string[];
};

type PendingStatement = {
  label: string;
  statement: D1PreparedStatement;
};

export type IngestSummary = {
  kind: IngestKind;
  region: string;
  requestedAt: string;
  startedAt: string;
  completedAt: string;
  status: AdapterStatus;
  sourceRuns: SourceRunRecord[];
  counts: {
    tidePredictionRows: number;
    nwsSpotContexts: number;
    nwsWindForecastRows: number;
    nwsHazards: number;
  };
  caveats: SourceCaveat[];
  errors: string[];
  dbContract: string;
};

const SOURCE_RUNS_CONTRACT =
  "D1 binding DB must expose source_runs with run_key/run_kind plus normalized tide_forecasts, wind_forecasts, and hazard_events v1 tables.";

function sourceRunId(sourceId: string, suffix: string): string {
  const prefix = sourceId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${prefix}-${suffix}`;
}

function defaultRunIdSuffix(): string {
  return crypto.randomUUID();
}

function outcomeRowCount(outcome: AdapterOutcome<unknown, unknown>): number {
  if (outcome.sourceId === "nws:point-forecast-alerts") {
    const metadata = outcome.metadata as { windRowCount?: unknown };
    const windRowCount = metadata.windRowCount;
    return typeof windRowCount === "number" ? windRowCount : outcome.rows.length;
  }
  return outcome.rows.length;
}

async function recordSourceRun<Row>(
  db: D1Database,
  outcome: AdapterOutcome<Row>,
  options: {
    startedAt: string;
    completedAt: string;
    idSuffix: string;
  }
): Promise<SourceRunRecord> {
  const id = sourceRunId(outcome.sourceId, options.idSuffix);
  const runKey = `${outcome.sourceId}:${options.idSuffix}`;
  const rowCount = outcomeRowCount(outcome as AdapterOutcome<unknown>);
  const error = outcome.errors.length > 0 ? outcome.errors.join("\n").slice(0, 2000) : null;
  const metadataJson = JSON.stringify({
    provider: outcome.provider,
    capabilities: outcome.capabilities,
    adapterStatus: outcome.status,
    rowCount,
    caveats: outcome.caveats,
    metadata: outcome.metadata,
    dbContract: SOURCE_RUNS_CONTRACT
  });

  if (typeof db.prepare !== "function") {
    return {
      id,
      sourceId: outcome.sourceId,
      status: outcome.status,
      recorded: false,
      rowCount,
      caveatCount: outcome.caveats.length,
      errorCount: outcome.errors.length,
      error: "DB binding does not expose prepare()."
    };
  }

  try {
    await db
      .prepare(
        `insert into source_runs (
          id,
          run_key,
          source_id,
          run_kind,
          cycle_at,
          forecast_hour,
          valid_start_at,
          valid_end_at,
          started_at,
          completed_at,
          status,
          raw_r2_key,
          metadata_json,
          error
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          run_key = excluded.run_key,
          run_kind = excluded.run_kind,
          valid_start_at = excluded.valid_start_at,
          valid_end_at = excluded.valid_end_at,
          completed_at = excluded.completed_at,
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          error = excluded.error`
      )
      .bind(
        id,
        runKey,
        outcome.sourceId,
        "ingest",
        null,
        null,
        null,
        null,
        options.startedAt,
        options.completedAt,
        outcome.status,
        null,
        metadataJson,
        error
      )
      .run();

    return {
      id,
      sourceId: outcome.sourceId,
      status: outcome.status,
      recorded: true,
      rowCount,
      caveatCount: outcome.caveats.length,
      errorCount: outcome.errors.length,
      error
    };
  } catch (caught) {
    return {
      id,
      sourceId: outcome.sourceId,
      status: outcome.status,
      recorded: false,
      rowCount,
      caveatCount: outcome.caveats.length,
      errorCount: outcome.errors.length,
      error: `source_runs write failed: ${errorMessage(caught)}`
    };
  }
}

function ktToMs(value: number | null): number | null {
  return value === null ? null : Math.round(value * 0.514444 * 1000) / 1000;
}

async function runPendingStatements(db: D1Database, pending: PendingStatement[]): Promise<PersistenceResult> {
  if (pending.length === 0) return { rowsWritten: 0, errors: [] };

  if (typeof db.batch === "function") {
    const chunkSize = 50;
    let rowsWritten = 0;
    const errors: string[] = [];
    for (let start = 0; start < pending.length; start += chunkSize) {
      const chunk = pending.slice(start, start + chunkSize);
      try {
        await db.batch(chunk.map((item) => item.statement));
        rowsWritten += chunk.length;
      } catch (error) {
        errors.push(`${chunk[0]?.label ?? "D1"} batch starting at ${start}: ${errorMessage(error)}`);
      }
    }
    return { rowsWritten, errors };
  }

  let rowsWritten = 0;
  const errors: string[] = [];
  for (const item of pending) {
    try {
      await item.statement.run();
      rowsWritten += 1;
    } catch (error) {
      errors.push(`${item.label}: ${errorMessage(error)}`);
    }
  }
  return { rowsWritten, errors };
}

async function persistTideForecasts(
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

async function persistNwsRows(
  db: D1Database,
  sourceRunId: string,
  rows: NwsContextRow[],
  createdAt: string
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
      wind_speed_ms = excluded.wind_speed_ms,
      wind_direction_deg = excluded.wind_direction_deg,
      gust_ms = excluded.gust_ms,
      weather_summary = excluded.weather_summary,
      payload_json = excluded.payload_json,
      created_at = excluded.created_at`
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
    for (const wind of context.windForecasts) {
      pending.push({
        label: `wind_forecasts ${wind.spotId} ${wind.forecastAt}`,
        statement: windStatement.bind(
            wind.spotId,
            "nws:point-forecast-alerts",
            sourceRunId,
            null,
            wind.forecastAt,
            null,
            ktToMs(wind.windSpeedKt),
            wind.windDirectionDeg,
            ktToMs(wind.gustKt),
            wind.shortForecast,
            JSON.stringify(wind),
            createdAt
          )
      });
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

function bodyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeIngestMessage(value: unknown, fallbackRegion: string): IngestQueueMessage {
  if (!value || typeof value !== "object") {
    return {
      kind: "scheduled-ingest",
      requestedAt: new Date().toISOString(),
      region: fallbackRegion
    };
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind === "manual-ingest" || record.kind === "scheduled-ingest" ? record.kind : "scheduled-ingest";
  return {
    kind,
    requestedAt: bodyString(record.requestedAt) ?? new Date().toISOString(),
    region: bodyString(record.region) ?? fallbackRegion
  };
}

export async function runNorcalIngest(
  env: Env,
  options: {
    kind: IngestKind;
    requestedAt?: string;
    region?: string;
    fetcher?: SourceFetch;
    now?: Date;
    idSuffix?: string;
  }
): Promise<IngestSummary> {
  const startedAt = new Date().toISOString();
  const requestedAt = options.requestedAt ?? startedAt;
  const region = options.region ?? env.SURF_REGION;
  const now = options.now ?? new Date();
  const idSuffix = options.idSuffix ?? defaultRunIdSuffix();
  const horizonHours = 72;
  const caveats: SourceCaveat[] = [];

  if (region !== "norcal") {
    caveats.push({
      code: "ingest_region_unsupported",
      message: `Only norcal v1 spots are configured; received region ${region}.`
    });
  }

  const coops = await fetchCoopsTidePredictionsForSpots(NORCAL_SPOTS, {
    fetcher: options.fetcher,
    now,
    horizonHours
  });
  const nws = await fetchNwsContextForSpots(NORCAL_SPOTS, {
    fetcher: options.fetcher
  });

  const completedAt = new Date().toISOString();
  const outcomes = [coops, nws] as const;
  const sourceRuns = [
    await recordSourceRun(env.DB, coops, {
      startedAt,
      completedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, nws, {
      startedAt,
      completedAt,
      idSuffix
    })
  ];
  const coopsRun = sourceRuns[0]!;
  const nwsRun = sourceRuns[1]!;
  const tidePersistence = await persistTideForecasts(env.DB, coopsRun.id, coops.rows, completedAt);
  const nwsPersistence = await persistNwsRows(env.DB, nwsRun.id, nws.rows, completedAt);

  const dbErrors = sourceRuns.flatMap((run) => (run.recorded ? [] : [`${run.sourceId}: ${run.error}`]));
  const persistenceErrors = [...tidePersistence.errors, ...nwsPersistence.errors];
  const adapterErrors = outcomes.flatMap((outcome) => outcome.errors);
  const dbCaveats = sourceRuns.flatMap((run): SourceCaveat[] =>
    run.recorded
      ? []
      : [
          {
            code: "source_run_not_recorded",
            message: `${run.sourceId} did not persist to source_runs: ${run.error}`
          }
        ]
  );
  const persistenceCaveats: SourceCaveat[] = persistenceErrors.map((error) => ({
    code: "normalized_row_not_recorded",
    message: error
  }));
  const status = combineStatus([
    combineStatus(outcomes.map((outcome) => outcome.status)),
    dbErrors.length > 0 || persistenceErrors.length > 0 ? "failure" : "success"
  ]);

  return {
    kind: options.kind,
    region,
    requestedAt,
    startedAt,
    completedAt,
    status,
    sourceRuns,
    counts: {
      tidePredictionRows: coops.rows.length,
      nwsSpotContexts: nws.rows.length,
      nwsWindForecastRows: nws.metadata.windRowCount,
      nwsHazards: nws.metadata.hazardCount
    },
    caveats: [...caveats, ...coops.caveats, ...nws.caveats, ...dbCaveats, ...persistenceCaveats],
    errors: [...adapterErrors, ...dbErrors, ...persistenceErrors],
    dbContract: SOURCE_RUNS_CONTRACT
  };
}
