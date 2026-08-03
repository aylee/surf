import type { ForecastInterval, ForecastResponse, SpotId } from "@surf/contracts";
import { NORCAL_SPOTS } from "@surf/forecast-core";
import { errorMessage } from "./adapters/types";
import {
  buildForecastFactBundle,
  ForecastFactBundleSchema,
  type ForecastFactBundle
} from "./brief";
import { buildSynchronizedForecastResponses } from "./forecast";
import {
  forecastSourceIssueFingerprint,
  persistForecastSnapshots,
  sha256StableJson,
  stableJson
} from "./forecast-history";
import type { Env } from "./index";
import { localDateForTime } from "./time";

export const FORECAST_READ_MODEL_SCHEMA_VERSION = 1 as const;
// D1 rejects strings/rows at 2,000,000 bytes. Production-shaped hourly rows
// are currently about 519 kB. A 768 KiB cap
// leaves growth room while remaining well below half of D1's 2,000,000-byte
// string/row ceiling and still bounds request-time result serialization.
export const MAX_FORECAST_READ_MODEL_BYTES = 768 * 1024;
export const MAX_FORECAST_FACT_BUNDLE_BYTES = 256 * 1024;

const textEncoder = new TextEncoder();

type ForecastReadModelRow = {
  generation_id: string;
  generated_at: string;
  schema_version: number;
  forecast_json: string;
  materialized_at: string;
};

type ForecastFactBundleRow = {
  generation_id: string;
  schema_version: number;
  fact_bundle_json: string;
};

export type MaterializedForecastJson = {
  generationId: string;
  ingestId: string | null;
  generatedAt: string;
  materializedAt: string;
  forecastJson: string;
};

export type ForecastSpotMaterializationOptions = {
  materializedAt?: string;
  captureHistory?: boolean;
  ingestId?: string;
};

export type ForecastReadModelPersistenceResult = {
  rowsWritten: number;
  forecastRowsWritten: number;
  factBundleRowsWritten: number;
  errors: string[];
  snapshotRowsWritten?: number;
  historyErrors?: string[];
};

function validIso(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function serializedBytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

const INGEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INGEST_GENERATION_PATTERN = /^sha256:[a-f0-9]{64}:ingest:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

export function ingestIdFromGenerationId(generationId: string): string | null {
  return INGEST_GENERATION_PATTERN.exec(generationId)?.[1] ?? null;
}

async function forecastGenerationId(options: {
  threeHour: ForecastResponse;
  sourceIssueFingerprint: string;
  ingestId?: string;
}): Promise<string> {
  const digest = await sha256StableJson({
    spotId: options.threeHour.spot.id,
    generatedAt: options.threeHour.generatedAt,
    sourceIssueFingerprint: options.sourceIssueFingerprint
  });
  return options.ingestId
    ? `sha256:${digest}:ingest:${options.ingestId}`
    : `sha256:${digest}`;
}

function oversizedPayloadError(options: {
  spotId: SpotId;
  payload: string;
  bytes: number;
  limit: number;
}): string {
  return `${options.spotId}: forecast read model publication rejected because the serialized ${options.payload} payload is ${options.bytes} bytes (limit ${options.limit}); the previous materialization remains active.`;
}

function assertReadModelRow(row: ForecastReadModelRow): void {
  if (
    row.schema_version !== FORECAST_READ_MODEL_SCHEMA_VERSION ||
    !row.generation_id ||
    !validIso(row.generated_at) ||
    !validIso(row.materialized_at) ||
    !row.forecast_json.trim().startsWith("{")
  ) {
    throw new Error("Stored forecast read model metadata is invalid");
  }
}

export async function getMaterializedForecastJson(
  db: D1Database,
  spotId: SpotId,
  interval: ForecastInterval
): Promise<MaterializedForecastJson | null> {
  const row = await db
    .prepare(
      `select generation_id, generated_at, schema_version, forecast_json, materialized_at
       from forecast_read_models
       where spot_id = ? and interval = ?
       limit 1`
    )
    .bind(spotId, interval)
    .first<ForecastReadModelRow>();
  if (!row) return null;
  assertReadModelRow(row);
  return {
    generationId: row.generation_id,
    ingestId: ingestIdFromGenerationId(row.generation_id),
    generatedAt: row.generated_at,
    materializedAt: row.materialized_at,
    forecastJson: row.forecast_json
  };
}

export async function getMaterializedForecastFactBundle(
  db: D1Database,
  spotId: SpotId,
  localDate: string
): Promise<ForecastFactBundle | null> {
  const row = await db
    .prepare(
      `select bundle.generation_id, bundle.schema_version, bundle.fact_bundle_json
       from forecast_fact_bundles as bundle
       join forecast_read_models as model
         on model.spot_id = bundle.spot_id
        and model.interval = '3h'
        and model.generation_id = bundle.generation_id
       where bundle.spot_id = ? and bundle.local_date = ?
       limit 1`
    )
    .bind(spotId, localDate)
    .first<ForecastFactBundleRow>();
  if (!row) return null;
  if (row.schema_version !== FORECAST_READ_MODEL_SCHEMA_VERSION || !row.generation_id) {
    throw new Error("Stored forecast fact bundle metadata is invalid");
  }
  const bundle = ForecastFactBundleSchema.parse(JSON.parse(row.fact_bundle_json));
  if (bundle.input.spotId !== spotId || bundle.input.localDate !== localDate) {
    throw new Error("Stored forecast fact bundle identity does not match its row");
  }
  return bundle;
}

async function executeMaterialization(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<void> {
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

export async function persistForecastMaterialization(options: {
  db: D1Database;
  threeHour: ForecastResponse;
  hourly: ForecastResponse;
  factBundles: ForecastFactBundle[];
  sourceIssueFingerprint: string;
  materializedAt: string;
  ingestId?: string;
}): Promise<ForecastReadModelPersistenceResult> {
  const { threeHour, hourly } = options;
  if (
    threeHour.spot.id !== hourly.spot.id ||
    threeHour.interval !== "3h" ||
    hourly.interval !== "1h" ||
    threeHour.generatedAt !== hourly.generatedAt
  ) {
    return {
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: ["Forecast read model inputs do not describe one synchronized spot generation."]
    };
  }
  const missingScoredIntervals = [threeHour, hourly]
    .filter((forecast) => !forecast.windows.some((window) => window.ratingStatus === "scored"))
    .map((forecast) => forecast.interval ?? "unknown");
  if (missingScoredIntervals.length > 0) {
    return {
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: [
        `Forecast read model publication rejected because ${missingScoredIntervals.join(
          ", "
        )} contained no scored windows; the previous materialization remains active.`
      ]
    };
  }
  if (
    !validIso(options.materializedAt) ||
    !options.sourceIssueFingerprint ||
    (options.ingestId !== undefined && !INGEST_ID_PATTERN.test(options.ingestId))
  ) {
    return {
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: ["Forecast read model materialization metadata is invalid."]
    };
  }

  for (const bundle of options.factBundles) {
    if (
      bundle.input.spotId !== threeHour.spot.id ||
      bundle.input.generatedAt !== threeHour.generatedAt
    ) {
      throw new Error("Forecast fact bundle does not match its materialized forecast generation");
    }
  }

  // Serialize and enforce every row budget before preparing any D1 statement.
  // The generation is atomic: one oversized forecast or fact bundle rejects all
  // rows for the spot, leaving the prior synchronized generation untouched.
  const serializedForecasts = [threeHour, hourly].map((forecast) => {
    const json = stableJson(forecast);
    return { forecast, json, bytes: serializedBytes(json) };
  });
  const serializedFactBundles = options.factBundles.map((bundle) => {
    const json = stableJson(bundle);
    return { bundle, json, bytes: serializedBytes(json) };
  });
  const payloadErrors = [
    ...serializedForecasts.flatMap(({ forecast, bytes }) =>
      bytes > MAX_FORECAST_READ_MODEL_BYTES
        ? [
            oversizedPayloadError({
              spotId: threeHour.spot.id,
              payload: `${forecast.interval ?? "unknown"} forecast`,
              bytes,
              limit: MAX_FORECAST_READ_MODEL_BYTES
            })
          ]
        : []
    ),
    ...serializedFactBundles.flatMap(({ bundle, bytes }) =>
      bytes > MAX_FORECAST_FACT_BUNDLE_BYTES
        ? [
            oversizedPayloadError({
              spotId: threeHour.spot.id,
              payload: `${bundle.input.localDate} fact bundle`,
              bytes,
              limit: MAX_FORECAST_FACT_BUNDLE_BYTES
            })
          ]
        : []
    )
  ];
  if (payloadErrors.length > 0) {
    return {
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: payloadErrors
    };
  }

  const generationId = await forecastGenerationId({
    threeHour,
    sourceIssueFingerprint: options.sourceIssueFingerprint,
    ingestId: options.ingestId
  });
  const forecastStatement = options.db.prepare(
    `insert into forecast_read_models (
       spot_id, interval, generation_id, generated_at, source_issue_fingerprint,
       schema_version, forecast_json, materialized_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(spot_id, interval) do update set
       generation_id = excluded.generation_id,
       generated_at = excluded.generated_at,
       source_issue_fingerprint = excluded.source_issue_fingerprint,
       schema_version = excluded.schema_version,
       forecast_json = excluded.forecast_json,
       materialized_at = excluded.materialized_at
     where excluded.generated_at >= forecast_read_models.generated_at`
  );
  const factStatement = options.db.prepare(
    `insert into forecast_fact_bundles (
       spot_id, local_date, generation_id, generated_at, input_fingerprint,
       material_fingerprint, schema_version, fact_bundle_json, materialized_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(spot_id, local_date) do update set
       generation_id = excluded.generation_id,
       generated_at = excluded.generated_at,
       input_fingerprint = excluded.input_fingerprint,
       material_fingerprint = excluded.material_fingerprint,
       schema_version = excluded.schema_version,
       fact_bundle_json = excluded.fact_bundle_json,
       materialized_at = excluded.materialized_at
     where excluded.generated_at >= forecast_fact_bundles.generated_at`
  );
  const forecastStatements = serializedForecasts.map(({ forecast, json }) =>
    forecastStatement.bind(
      forecast.spot.id,
      forecast.interval,
      generationId,
      forecast.generatedAt,
      options.sourceIssueFingerprint,
      FORECAST_READ_MODEL_SCHEMA_VERSION,
      json,
      options.materializedAt
    )
  );
  const factStatements = serializedFactBundles.map(({ bundle, json }) => {
    return factStatement.bind(
      bundle.input.spotId,
      bundle.input.localDate,
      generationId,
      bundle.input.generatedAt,
      bundle.inputFingerprint,
      bundle.materialFingerprint,
      FORECAST_READ_MODEL_SCHEMA_VERSION,
      json,
      options.materializedAt
    );
  });

  try {
    await executeMaterialization(options.db, [...forecastStatements, ...factStatements]);
    return {
      rowsWritten: forecastStatements.length + factStatements.length,
      forecastRowsWritten: forecastStatements.length,
      factBundleRowsWritten: factStatements.length,
      errors: []
    };
  } catch (error) {
    return {
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: [`${threeHour.spot.id}: forecast read model persistence failed: ${errorMessage(error)}`]
    };
  }
}

export async function materializeForecastReadModels(
  env: Env,
  now: Date,
  _sourceIssueFingerprint: string,
  materializedAt = new Date().toISOString()
): Promise<ForecastReadModelPersistenceResult> {
  let rowsWritten = 0;
  let forecastRowsWritten = 0;
  let factBundleRowsWritten = 0;
  const errors: string[] = [];

  for (const spot of NORCAL_SPOTS) {
    const result = await materializeForecastReadModelForSpot(
      env,
      spot.id,
      now,
      {
        materializedAt
      }
    );
    rowsWritten += result.rowsWritten;
    forecastRowsWritten += result.forecastRowsWritten;
    factBundleRowsWritten += result.factBundleRowsWritten;
    errors.push(...result.errors);
  }

  return { rowsWritten, forecastRowsWritten, factBundleRowsWritten, errors };
}

export async function materializeForecastReadModelForSpot(
  env: Env,
  spotId: SpotId,
  now: Date,
  options: ForecastSpotMaterializationOptions = {}
): Promise<ForecastReadModelPersistenceResult> {
  try {
    const materializedAt = options.materializedAt ?? new Date().toISOString();
    const { threeHour, hourly } = await buildSynchronizedForecastResponses(env, spotId, now, {
      failOnReadError: true
    });
    const sourceIssueFingerprint = await forecastSourceIssueFingerprint(threeHour);
    const localDates = [
      ...new Set(
        threeHour.windows.map((window) =>
          localDateForTime(window.forecastAt, threeHour.spot.timezone)
        )
      )
    ];
    const factBundles = await Promise.all(
      localDates.map((localDate) => buildForecastFactBundle(threeHour, { localDate }))
    );
    const materialization = await persistForecastMaterialization({
      db: env.DB,
      threeHour,
      hourly,
      factBundles,
      sourceIssueFingerprint,
      materializedAt,
      ingestId: options.ingestId
    });
    if (!options.captureHistory || materialization.errors.length > 0) return materialization;
    const history = await persistForecastSnapshots(env.DB, threeHour, {
      capturedAt: materializedAt,
      issuedAt: now.toISOString(),
      sourceIssueFingerprint
    });
    return {
      ...materialization,
      snapshotRowsWritten: history.rowsWritten,
      historyErrors: history.errors.map((error) => `${spotId}: ${error}`)
    };
  } catch (error) {
    return {
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: [`${spotId}: forecast read model assembly failed: ${errorMessage(error)}`]
    };
  }
}
