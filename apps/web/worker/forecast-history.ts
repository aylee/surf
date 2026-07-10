import type { ForecastResponse, ScoredForecastWindow, SpotProfile } from "@surf/contracts";

export const FORECAST_ENGINE_VERSION = "nws-mtr-cold-start-v1+objective-score-v1";
export const FORECAST_PRESENTATION_VERSION = "surf-height-range-v1+surface-condition-v1";
export const FORECAST_SNAPSHOT_SCHEMA_VERSION = 1;

export type ForecastSnapshotPersistenceResult = {
  issueId: string;
  rowsWritten: number;
  errors: string[];
};

type SnapshotOptions = {
  capturedAt: string;
  issuedAt: string;
  sourceIssueFingerprint?: string;
};

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return null;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256StableJson(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(stableJson(value));
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoded));
}

function circularDistance(left: number, right: number): number {
  return Math.abs((((left - right) % 360) + 540) % 360 - 180);
}

function directionInWindow(value: number, min: number, max: number): boolean {
  return min <= max ? value >= min && value <= max : value >= min || value <= max;
}

export function snapshotSurfaceCondition(
  spot: SpotProfile,
  window: Pick<ScoredForecastWindow, "windSpeedKt" | "windDirectionDeg">
): "clean" | "fair" | "choppy" | "unknown" {
  const speed = window.windSpeedKt;
  const direction = window.windDirectionDeg;
  if (speed === null || direction === null) return "unknown";
  if (speed <= 3) return "clean";
  if (
    directionInWindow(direction, spot.offshoreWindFromDeg.minDeg, spot.offshoreWindFromDeg.maxDeg) &&
    speed <= spot.maxOkWindKt
  ) {
    return "clean";
  }
  if (speed <= spot.maxGoodWindKt) return "fair";

  const offshoreCenter =
    spot.offshoreWindFromDeg.minDeg <= spot.offshoreWindFromDeg.maxDeg
      ? (spot.offshoreWindFromDeg.minDeg + spot.offshoreWindFromDeg.maxDeg) / 2
      : (spot.offshoreWindFromDeg.minDeg +
          (spot.offshoreWindFromDeg.maxDeg + 360 - spot.offshoreWindFromDeg.minDeg) / 2) %
        360;
  const onshoreCenter = (offshoreCenter + 180) % 360;
  return circularDistance(direction, onshoreCenter) <= 75 ? "choppy" : "fair";
}

export function snapshotHeightLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Size unavailable";
  if (value < 1) return "0–1 ft";
  if (value >= 10) return `${Math.round(value)} ft+`;
  const rounded = Math.round(value * 10) / 10;
  const lower = Number.isInteger(rounded) ? Math.max(0, rounded - 1) : Math.floor(rounded);
  const upper = Math.max(lower + 1, Math.ceil(rounded));
  return `${lower}–${upper} ft`;
}

function iso(label: string, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return date.toISOString();
}

function issueIdentityWindow(spot: SpotProfile, window: ScoredForecastWindow): unknown {
  return {
    forecastAt: window.forecastAt,
    ratingStatus: window.ratingStatus,
    qualityLabel: window.qualityLabel,
    score: window.score,
    waveScore: window.waveScore,
    windScore: window.windScore,
    tideScore: window.tideScore,
    waveHeightFt: window.waveHeightFt,
    peakPeriodSec: window.peakPeriodSec,
    primaryDirectionDeg: window.primaryDirectionDeg,
    tideFt: window.tideFt,
    tideTrend: window.tideTrend ?? null,
    windSpeedKt: window.windSpeedKt,
    windDirectionDeg: window.windDirectionDeg,
    activeCapabilities: window.activeCapabilities,
    primarySwell: window.primarySwell,
    secondarySwell: window.secondarySwell,
    waveProvenance: window.waveProvenance,
    displayedHeightLabel: snapshotHeightLabel(window.waveHeightFt),
    surfaceCondition: snapshotSurfaceCondition(spot, window)
  };
}

function changedRows(result: D1Result | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === "number" ? changes : 1;
}

async function execute(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<{ rowsWritten: number; errors: string[] }> {
  let rowsWritten = 0;
  const errors: string[] = [];
  const chunkSize = 50;

  for (let start = 0; start < statements.length; start += chunkSize) {
    const chunk = statements.slice(start, start + chunkSize);
    try {
      if (typeof db.batch === "function") {
        const results = await db.batch(chunk);
        rowsWritten += results.reduce((sum, result) => sum + changedRows(result), 0);
      } else {
        for (const statement of chunk) {
          rowsWritten += changedRows(await statement.run());
        }
      }
    } catch (error) {
      errors.push(
        `forecast_snapshots batch starting at ${start}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { rowsWritten, errors };
}

export async function persistForecastSnapshots(
  db: D1Database,
  response: ForecastResponse,
  options: SnapshotOptions
): Promise<ForecastSnapshotPersistenceResult> {
  if (typeof db.prepare !== "function") {
    return { issueId: "", rowsWritten: 0, errors: ["D1 binding does not expose forecast_snapshots."] };
  }

  const capturedAt = iso("capturedAt", options.capturedAt);
  const issuedAt = iso("issuedAt", options.issuedAt);
  const spotConfigJson = stableJson(response.spot);
  const spotConfigHash = await sha256StableJson(response.spot);
  const sourceIssueFingerprint =
    options.sourceIssueFingerprint ??
    (await sha256StableJson(
      response.windows.map((window) => issueIdentityWindow(response.spot, window))
    ));
  const issueId = `sha256:${await sha256StableJson({
    spotId: response.spot.id,
    spotConfigHash,
    sourceIssueFingerprint,
    forecastEngineVersion: FORECAST_ENGINE_VERSION,
    presentationVersion: FORECAST_PRESENTATION_VERSION,
    windows: response.windows.map((window) => issueIdentityWindow(response.spot, window))
  })}`;

  const statement = db.prepare(
    `insert into forecast_snapshots (
      spot_id, issue_id, captured_at, issued_at, valid_at, lead_hours,
      rating_status, quality_label, surface_condition, displayed_height_ft,
      displayed_height_label, score, confidence, wave_score, wind_score,
      tide_score, source_score, peak_period_s, primary_direction_deg, tide_ft,
      tide_trend, wind_speed_kt, wind_direction_deg, source_updated_at,
      source_run_ids_json, source_versions_json, source_issue_fingerprint,
      raw_facts_json, spot_config_json, spot_config_hash,
      forecast_engine_version, presentation_version, snapshot_schema_version,
      created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(spot_id, issue_id, valid_at) do nothing`
  );

  const statements = response.windows.map((window) => {
    const validAt = iso("forecastAt", window.forecastAt);
    const surfaceCondition = snapshotSurfaceCondition(response.spot, window);
    const displayedHeightLabel = snapshotHeightLabel(window.waveHeightFt);
    const sourceRunIds = [...new Set(window.sourceRunIds)].sort();
    const sourceVersions = window.waveProvenance
      ? [
          {
            sourceId: window.waveProvenance.sourceId,
            sourceUpdatedAt: window.waveProvenance.sourceUpdatedAt,
            derivation: window.waveProvenance.derivation
          }
        ]
      : [];
    const rawFactsJson = stableJson({
      ...window,
      displayedHeightLabel,
      surfaceCondition,
      observation: response.observation ?? null,
      sourceNote: response.sourceNote
    });

    return statement.bind(
      response.spot.id,
      issueId,
      capturedAt,
      issuedAt,
      validAt,
      (new Date(validAt).getTime() - new Date(issuedAt).getTime()) / (60 * 60 * 1000),
      window.ratingStatus,
      window.qualityLabel,
      surfaceCondition,
      window.waveHeightFt,
      displayedHeightLabel,
      window.score,
      window.confidence,
      window.waveScore,
      window.windScore,
      window.tideScore,
      window.sourceScore,
      window.peakPeriodSec,
      window.primaryDirectionDeg,
      window.tideFt,
      window.tideTrend ?? null,
      window.windSpeedKt,
      window.windDirectionDeg,
      window.waveProvenance?.sourceUpdatedAt ?? null,
      stableJson(sourceRunIds),
      stableJson(sourceVersions),
      sourceIssueFingerprint,
      rawFactsJson,
      spotConfigJson,
      spotConfigHash,
      FORECAST_ENGINE_VERSION,
      FORECAST_PRESENTATION_VERSION,
      FORECAST_SNAPSHOT_SCHEMA_VERSION,
      capturedAt
    );
  });

  const result = await execute(db, statements);
  return { issueId, ...result };
}
