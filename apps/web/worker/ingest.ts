import { NORCAL_SPOTS } from "@surf/forecast-core";
import type { CdipMopForecastRow } from "./adapters/cdip-mop";
import { CDIP_MOP_SOURCE_ID, fetchCdipMopForecastsForSpots } from "./adapters/cdip-mop";
import type { TidePredictionRow } from "./adapters/coops";
import { fetchCoopsTidePredictionsForSpots } from "./adapters/coops";
import type { NdbcObservationRow } from "./adapters/ndbc";
import { fetchNdbcRealtimeObservationsForStations } from "./adapters/ndbc";
import type { NwsContextRow } from "./adapters/nws";
import { fetchNwsContextForSpots } from "./adapters/nws";
import type { NwsGridWaveForecastRow } from "./adapters/nws-grid-wave";
import { fetchNwsGridWaveForSpots, NWS_GRID_WAVE_SOURCE_ID } from "./adapters/nws-grid-wave";
import type { AdapterOutcome, AdapterStatus, SourceCaveat, SourceFetch } from "./adapters/types";
import { combineStatus, errorMessage } from "./adapters/types";
import { buildForecastResponse } from "./forecast";
import { persistForecastSnapshots, sha256StableJson } from "./forecast-history";
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

type RawCapture = {
  requestUrl: string;
  contentType: string;
  capturedAt: string;
  body: ArrayBuffer;
};

type CaptureBuffer = {
  items: RawCapture[];
  errors: string[];
};

type ArtifactPersistenceResult = PersistenceResult & {
  manifestKey: string | null;
  manifestJson: string | null;
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
    nwsWaveForecastRows: number;
    cdipMopWaveForecastRows: number;
    ndbcObservationRows: number;
    forecastSnapshotRows: number;
  };
  caveats: SourceCaveat[];
  errors: string[];
  dbContract: string;
};

const SOURCE_RUNS_CONTRACT =
  "D1 binding DB must expose source_runs with run_key/run_kind plus normalized wave_forecasts, wave_observations, tide_forecasts, wind_forecasts, wind_forecast_issues, hazard_events, forecast_configs, forecast_issues, and forecast_snapshots tables.";

const NDBC_REALTIME_STATIONS = ["46237", "46026", "46013", "46012"];
const DEFAULT_RAW_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
const CDIP_RAW_CAPTURE_LIMIT_BYTES = 64 * 1024;
export const FORECAST_HISTORY_RETENTION_DAYS = 400;

export function shouldCaptureForecastHistory(kind: IngestKind, requestedAt: string): boolean {
  if (kind === "manual-ingest") return true;
  const time = new Date(requestedAt);
  return !Number.isNaN(time.getTime()) && time.getUTCHours() % 6 === 0;
}

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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function arrayBufferWithLimit(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`response Content-Length ${contentLength} exceeds ${maxBytes}-byte raw capture limit`);
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("raw capture limit exceeded");
      throw new Error(`stream exceeds ${maxBytes}-byte raw capture limit`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

function capturingFetcher(
  fetcher: SourceFetch,
  captures: CaptureBuffer,
  maxCaptureBytes = DEFAULT_RAW_CAPTURE_LIMIT_BYTES
): SourceFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetcher(input, init);
    if (response.ok && (init?.method ?? "GET").toUpperCase() !== "HEAD") {
      try {
        const clone = response.clone();
        captures.items.push({
          requestUrl: requestUrl(input),
          contentType: clone.headers.get("content-type") ?? "application/octet-stream",
          capturedAt: new Date().toISOString(),
          body: await arrayBufferWithLimit(clone, maxCaptureBytes)
        });
      } catch (error) {
        captures.errors.push(`${requestUrl(input)} raw capture failed: ${errorMessage(error)}`);
      }
    }
    return response;
  }) as SourceFetch;
}

function safeKeyPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function artifactExtension(contentType: string): string {
  if (contentType.includes("json") || contentType.includes("geo+json")) return "json";
  if (contentType.includes("text")) return "txt";
  return "bin";
}

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

function outcomeCycleAt(outcome: AdapterOutcome<unknown, unknown>): string | null {
  if (outcome.sourceId !== CDIP_MOP_SOURCE_ID) return null;
  const metadata = outcome.metadata as { modelCycleAtBySpot?: unknown };
  if (!metadata.modelCycleAtBySpot || typeof metadata.modelCycleAtBySpot !== "object") return null;
  const cycles = [
    ...new Set(
      Object.values(metadata.modelCycleAtBySpot as Record<string, unknown>).flatMap((value) =>
        typeof value === "string" && Number.isFinite(new Date(value).getTime())
          ? [new Date(value).toISOString()]
          : []
      )
    )
  ];
  return cycles.length === 1 ? cycles[0]! : null;
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
  const cycleAt = outcomeCycleAt(outcome as AdapterOutcome<unknown>);
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
          cycle_at = excluded.cycle_at,
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
        cycleAt,
        null,
        null,
        null,
        options.startedAt,
        null,
        "running",
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

async function persistRawArtifacts(
  bucket: R2Bucket,
  db: D1Database,
  run: SourceRunRecord,
  captures: CaptureBuffer,
  idSuffix: string,
  createdAt: string
): Promise<ArtifactPersistenceResult> {
  const errors = [...captures.errors];
  if (captures.items.length === 0) {
    return { rowsWritten: 0, errors, manifestKey: null, manifestJson: null };
  }
  if (typeof bucket.put !== "function") {
    return {
      rowsWritten: 0,
      errors: [...errors, `${run.sourceId}: R2 binding does not expose put().`],
      manifestKey: null,
      manifestJson: null
    };
  }
  if (typeof db.prepare !== "function") {
    return {
      rowsWritten: 0,
      errors: [...errors, `${run.sourceId}: D1 binding does not expose source_artifacts.`],
      manifestKey: null,
      manifestJson: null
    };
  }

  const date = createdAt.slice(0, 10).replaceAll("-", "/");
  const prefix = `raw/${safeKeyPart(run.sourceId)}/${date}/${safeKeyPart(idSuffix)}`;
  const artifacts: Array<{
    id: string;
    r2Key: string;
    requestUrl: string;
    contentType: string;
    byteSize: number;
    checksumSha256: string;
    capturedAt: string;
  }> = [];

  for (const [index, capture] of captures.items.entries()) {
    try {
      const checksumSha256 = hex(await crypto.subtle.digest("SHA-256", capture.body));
      const r2Key = `${prefix}/${String(index + 1).padStart(2, "0")}-${checksumSha256.slice(0, 12)}.${artifactExtension(capture.contentType)}`;
      const id = `${run.id}-artifact-${index + 1}`;
      await bucket.put(r2Key, capture.body, {
        httpMetadata: { contentType: capture.contentType },
        customMetadata: {
          sourceId: run.sourceId,
          sourceRunId: run.id,
          requestUrl: capture.requestUrl,
          checksumSha256
        }
      });
      await db
        .prepare(
          `insert into source_artifacts (
            id, source_run_id, source_id, r2_key, artifact_type, content_type,
            byte_size, checksum_sha256, created_at, metadata_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            r2_key = excluded.r2_key,
            content_type = excluded.content_type,
            byte_size = excluded.byte_size,
            checksum_sha256 = excluded.checksum_sha256,
            metadata_json = excluded.metadata_json`
        )
        .bind(
          id,
          run.id,
          run.sourceId,
          r2Key,
          "upstream_response",
          capture.contentType,
          capture.body.byteLength,
          checksumSha256,
          createdAt,
          JSON.stringify({ requestUrl: capture.requestUrl, capturedAt: capture.capturedAt })
        )
        .run();
      artifacts.push({
        id,
        r2Key,
        requestUrl: capture.requestUrl,
        contentType: capture.contentType,
        byteSize: capture.body.byteLength,
        checksumSha256,
        capturedAt: capture.capturedAt
      });
    } catch (error) {
      errors.push(`${run.sourceId} raw artifact ${index + 1}: ${errorMessage(error)}`);
    }
  }

  const manifestJson = JSON.stringify({
    sourceId: run.sourceId,
    sourceRunId: run.id,
    createdAt,
    artifacts
  });
  const manifestKey = `${prefix}/manifest.json`;
  try {
    await bucket.put(manifestKey, manifestJson, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sourceId: run.sourceId, sourceRunId: run.id }
    });
  } catch (error) {
    errors.push(`${run.sourceId} raw manifest: ${errorMessage(error)}`);
    return { rowsWritten: artifacts.length, errors, manifestKey: null, manifestJson: null };
  }

  return {
    rowsWritten: artifacts.length,
    errors,
    manifestKey,
    manifestJson
  };
}

async function finalizeSourceRun<Row>(
  db: D1Database,
  run: SourceRunRecord,
  outcome: AdapterOutcome<Row>,
  normalized: PersistenceResult,
  artifacts: ArtifactPersistenceResult,
  completedAt: string
): Promise<SourceRunRecord> {
  const errors = [...outcome.errors, ...normalized.errors, ...artifacts.errors];
  const status = combineStatus([
    outcome.status,
    errors.length > 0 ? "failure" : "success"
  ]);
  const error = errors.length > 0 ? errors.join("\n").slice(0, 2000) : null;
  const metadataJson = JSON.stringify({
    provider: outcome.provider,
    capabilities: outcome.capabilities,
    adapterStatus: outcome.status,
    adapterRows: outcomeRowCount(outcome as AdapterOutcome<unknown>),
    normalizedRowsWritten: normalized.rowsWritten,
    rawArtifactsWritten: artifacts.rowsWritten,
    caveats: outcome.caveats,
    metadata: outcome.metadata,
    dbContract: SOURCE_RUNS_CONTRACT
  });

  try {
    await db
      .prepare(
        `update source_runs
         set completed_at = ?, status = ?, raw_r2_key = ?, artifact_manifest_json = ?,
             metadata_json = ?, error = ?
         where id = ?`
      )
      .bind(
        completedAt,
        status,
        artifacts.manifestKey,
        artifacts.manifestJson,
        metadataJson,
        error,
        run.id
      )
      .run();
    return {
      ...run,
      status,
      recorded: true,
      rowCount: normalized.rowsWritten,
      errorCount: errors.length,
      error
    };
  } catch (caught) {
    return {
      ...run,
      status: "failure",
      recorded: false,
      rowCount: normalized.rowsWritten,
      errorCount: errors.length + 1,
      error: `source_runs finalization failed: ${errorMessage(caught)}`
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

async function persistWaveForecasts(
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

async function persistCdipMopForecasts(
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

async function persistWaveObservations(
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
    for (const spot of NORCAL_SPOTS.filter((candidate) => candidate.referenceBuoys.includes(row.stationId))) {
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

async function persistNwsRows(
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

async function persistIssuedForecasts(
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

async function pruneForecastHistory(db: D1Database, now: Date): Promise<PersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { rowsWritten: 0, errors: ["D1 binding does not expose prepare() for history retention."] };
  }
  const cutoff = new Date(
    now.getTime() - FORECAST_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  return runPendingStatements(db, [
    {
      label: "prune forecast_snapshots",
      statement: db.prepare("delete from forecast_snapshots where captured_at < ?").bind(cutoff)
    },
    {
      label: "prune forecast_issues",
      statement: db.prepare("delete from forecast_issues where captured_at < ?").bind(cutoff)
    },
    {
      label: "prune wind_forecast_issues",
      statement: db.prepare("delete from wind_forecast_issues where captured_at < ?").bind(cutoff)
    }
  ]);
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
  const captureHistory = shouldCaptureForecastHistory(options.kind, requestedAt);
  const horizonHours = 120;
  const caveats: SourceCaveat[] = [];

  if (region !== "norcal") {
    caveats.push({
      code: "ingest_region_unsupported",
      message: `Only norcal v1 spots are configured; received region ${region}.`
    });
  }

  const baseFetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const captures: [CaptureBuffer, CaptureBuffer, CaptureBuffer, CaptureBuffer, CaptureBuffer] = [
    { items: [], errors: [] },
    { items: [], errors: [] },
    { items: [], errors: [] },
    { items: [], errors: [] },
    { items: [], errors: [] }
  ];
  const [coops, nws, nwsWave, cdipMop, ndbc] = await Promise.all([
    fetchCoopsTidePredictionsForSpots(NORCAL_SPOTS, {
      fetcher: capturingFetcher(baseFetcher, captures[0]),
      now,
      horizonHours
    }),
    fetchNwsContextForSpots(NORCAL_SPOTS, {
      fetcher: capturingFetcher(baseFetcher, captures[1])
    }),
    fetchNwsGridWaveForSpots(NORCAL_SPOTS, {
      fetcher: capturingFetcher(baseFetcher, captures[2]),
      now,
      horizonHours
    }),
    fetchCdipMopForecastsForSpots(NORCAL_SPOTS, {
      fetcher: capturingFetcher(baseFetcher, captures[3], CDIP_RAW_CAPTURE_LIMIT_BYTES),
      now,
      horizonHours
    }),
    fetchNdbcRealtimeObservationsForStations(NDBC_REALTIME_STATIONS, {
      fetcher: capturingFetcher(baseFetcher, captures[4]),
      now
    })
  ]);

  const fetchedAt = new Date().toISOString();
  const outcomes = [coops, nws, nwsWave, cdipMop, ndbc] as const;
  const sourceIssueFingerprint = await sha256StableJson({
    coops: coops.rows,
    nws: nws.rows,
    nwsWave: nwsWave.rows,
    cdipMop: cdipMop.rows
  });
  const sourceRuns = [
    await recordSourceRun(env.DB, coops, {
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, nws, {
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, nwsWave, {
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, cdipMop, {
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, ndbc, {
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    })
  ];
  const coopsRun = sourceRuns[0]!;
  const nwsRun = sourceRuns[1]!;
  const nwsWaveRun = sourceRuns[2]!;
  const cdipMopRun = sourceRuns[3]!;
  const ndbcRun = sourceRuns[4]!;
  const tidePersistence = await persistTideForecasts(env.DB, coopsRun.id, coops.rows, fetchedAt);
  const nwsPersistence = await persistNwsRows(
    env.DB,
    nwsRun.id,
    nws.rows,
    fetchedAt,
    captureHistory
  );
  const wavePersistence = await persistWaveForecasts(env.DB, nwsWaveRun.id, nwsWave.rows, fetchedAt);
  const cdipMopPersistence = await persistCdipMopForecasts(env.DB, cdipMopRun.id, cdipMop.rows, fetchedAt);
  const observationPersistence = await persistWaveObservations(env.DB, ndbcRun.id, ndbc.rows, fetchedAt);
  const normalizedPersistence = [
    tidePersistence,
    nwsPersistence,
    wavePersistence,
    cdipMopPersistence,
    observationPersistence
  ];
  const artifactPersistence = [
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, coopsRun, captures[0], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, nwsRun, captures[1], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, nwsWaveRun, captures[2], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, cdipMopRun, captures[3], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, ndbcRun, captures[4], idSuffix, fetchedAt)
  ];
  const completedAt = new Date().toISOString();
  const finalizedRuns = [
    await finalizeSourceRun(env.DB, coopsRun, coops, normalizedPersistence[0]!, artifactPersistence[0]!, completedAt),
    await finalizeSourceRun(env.DB, nwsRun, nws, normalizedPersistence[1]!, artifactPersistence[1]!, completedAt),
    await finalizeSourceRun(env.DB, nwsWaveRun, nwsWave, normalizedPersistence[2]!, artifactPersistence[2]!, completedAt),
    await finalizeSourceRun(env.DB, cdipMopRun, cdipMop, normalizedPersistence[3]!, artifactPersistence[3]!, completedAt),
    await finalizeSourceRun(env.DB, ndbcRun, ndbc, normalizedPersistence[4]!, artifactPersistence[4]!, completedAt)
  ];
  const snapshotPersistence = captureHistory
    ? await persistIssuedForecasts(env, now, completedAt, sourceIssueFingerprint)
    : { rowsWritten: 0, errors: [] };
  const retentionPersistence = captureHistory
    ? await pruneForecastHistory(env.DB, now)
    : { rowsWritten: 0, errors: [] };

  const dbErrors = finalizedRuns.flatMap((run) => (run.recorded ? [] : [`${run.sourceId}: ${run.error}`]));
  const persistenceErrors = [
    ...tidePersistence.errors,
    ...nwsPersistence.errors,
    ...wavePersistence.errors,
    ...cdipMopPersistence.errors,
    ...observationPersistence.errors,
    ...artifactPersistence.flatMap((result) => result.errors),
    ...snapshotPersistence.errors,
    ...retentionPersistence.errors
  ];
  const adapterErrors = outcomes.flatMap((outcome) => outcome.errors);
  const dbCaveats = finalizedRuns.flatMap((run): SourceCaveat[] =>
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
    combineStatus(finalizedRuns.map((run) => run.status)),
    dbErrors.length > 0 || persistenceErrors.length > 0 ? "failure" : "success"
  ]);

  return {
    kind: options.kind,
    region,
    requestedAt,
    startedAt,
    completedAt,
    status,
    sourceRuns: finalizedRuns,
    counts: {
      tidePredictionRows: coops.rows.length,
      nwsSpotContexts: nws.rows.length,
      nwsWindForecastRows: nws.metadata.windRowCount,
      nwsHazards: nws.metadata.hazardCount,
      nwsWaveForecastRows: nwsWave.rows.length,
      cdipMopWaveForecastRows: cdipMop.rows.length,
      ndbcObservationRows: ndbc.rows.length,
      forecastSnapshotRows: snapshotPersistence.rowsWritten
    },
    caveats: [
      ...caveats,
      ...coops.caveats,
      ...nws.caveats,
      ...nwsWave.caveats,
      ...cdipMop.caveats,
      ...ndbc.caveats,
      ...dbCaveats,
      ...persistenceCaveats
    ],
    errors: [...adapterErrors, ...dbErrors, ...persistenceErrors],
    dbContract: SOURCE_RUNS_CONTRACT
  };
}
