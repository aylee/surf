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

type ActiveForecastGenerationRow = {
  interval: ForecastInterval;
  generation_id: string;
  generated_at: string;
};

export type MaterializedForecastJson = {
  generationId: string;
  ingestId: string | null;
  generatedAt: string;
  materializedAt: string;
  forecastJson: string;
};

export type ActiveMaterializedForecastFactBundle = {
  generationId: string;
  bundle: ForecastFactBundle;
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
  forecastOutcomes: ForecastMaterializationOutcome[];
  snapshotRowsWritten?: number;
  historyErrors?: string[];
};

// Repository helpers return terminal facts but never log them. Queue and
// inline orchestration own the single canonical log line for each interval.
export type ForecastMaterializationReasonCode =
  | "forecast_generation_published"
  | "forecast_generation_already_active"
  | "newer_generation_active"
  | "unsynchronized_inputs"
  | "no_scored_windows"
  | "synchronized_generation_rejected"
  | "invalid_materialization_metadata"
  | "forecast_payload_too_large"
  | "fact_bundle_payload_too_large"
  | "forecast_persistence_failed"
  | "forecast_assembly_failed"
  | "lineage_check_failed"
  | "newer_source_generation_active"
  | "materialization_threw"
  | "invalid_forecast_outcome_contract"
  | "incomplete_publication";

export type ForecastMaterializationOutcome = {
  ingestId: string | null;
  spotId: SpotId;
  interval: ForecastInterval;
  generationId: string | null;
  generatedAt: string;
  materializedAt: string | null;
  outcome: "publish" | "skip" | "supersede" | "failure";
  reasonCode: ForecastMaterializationReasonCode;
  retryable: boolean;
};

export function forecastGenerationBecameActive(
  outcomes: readonly ForecastMaterializationOutcome[]
): boolean {
  const generationIds = new Set(
    outcomes.flatMap(({ generationId }) => (generationId ? [generationId] : []))
  );
  return (
    outcomes.length === FORECAST_INTERVALS.length &&
    outcomes.some(({ outcome }) => outcome === "publish") &&
    outcomes.every(
      ({ outcome, reasonCode }) =>
        outcome === "publish" ||
        (outcome === "skip" && reasonCode === "forecast_generation_already_active")
    ) &&
    generationIds.size === 1
  );
}

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

export async function getActiveMaterializedForecastFactBundle(
  db: D1Database,
  spotId: SpotId,
  localDate: string
): Promise<ActiveMaterializedForecastFactBundle | null> {
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
  return { generationId: row.generation_id, bundle };
}

export async function getMaterializedForecastFactBundle(
  db: D1Database,
  spotId: SpotId,
  localDate: string
): Promise<ForecastFactBundle | null> {
  return (await getActiveMaterializedForecastFactBundle(db, spotId, localDate))?.bundle ?? null;
}

export async function getActiveMaterializedForecastFactBundlesForGeneration(
  db: D1Database,
  spotId: SpotId,
  generationId: string
): Promise<ActiveMaterializedForecastFactBundle[]> {
  const result = await db
    .prepare(
      `select bundle.generation_id, bundle.schema_version, bundle.fact_bundle_json
       from forecast_fact_bundles as bundle
       join forecast_read_models as model
         on model.spot_id = bundle.spot_id
        and model.interval = '3h'
        and model.generation_id = bundle.generation_id
       where bundle.spot_id = ? and bundle.generation_id = ?
       order by bundle.local_date asc`
    )
    .bind(spotId, generationId)
    .all<ForecastFactBundleRow>();
  return (result.results ?? []).map((row) => {
    if (row.schema_version !== FORECAST_READ_MODEL_SCHEMA_VERSION || !row.generation_id) {
      throw new Error("Stored forecast fact bundle metadata is invalid");
    }
    const bundle = ForecastFactBundleSchema.parse(JSON.parse(row.fact_bundle_json));
    if (bundle.input.spotId !== spotId || row.generation_id !== generationId) {
      throw new Error("Stored forecast fact bundle identity does not match its generation");
    }
    return { generationId: row.generation_id, bundle };
  });
}

async function executeMaterialization(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<D1Result<unknown>[]> {
  if (typeof db.batch === "function") {
    return db.batch(statements);
  }
  const results: D1Result<unknown>[] = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

const FORECAST_INTERVALS = ["3h", "1h"] as const satisfies readonly ForecastInterval[];

async function activeForecastGenerations(
  db: D1Database,
  spotId: SpotId
): Promise<Map<ForecastInterval, ActiveForecastGenerationRow>> {
  const result = await db
    .prepare(
      `select interval, generation_id, generated_at
       from forecast_read_models
       where spot_id = ? and interval in ('3h', '1h')`
    )
    .bind(spotId)
    .all<ActiveForecastGenerationRow>();
  const active = new Map<ForecastInterval, ActiveForecastGenerationRow>();
  for (const row of result.results ?? []) {
    if (row.interval !== "3h" && row.interval !== "1h") continue;
    active.set(row.interval, row);
  }
  return active;
}

function forecastOutcomes(options: {
  spotId: SpotId;
  ingestId?: string;
  generatedAt: string;
  materializedAt: string | null;
  generationId?: string;
  outcome: ForecastMaterializationOutcome["outcome"];
  retryable: boolean;
  reasonCode:
    | ForecastMaterializationReasonCode
    | Partial<Record<ForecastInterval, ForecastMaterializationReasonCode>>;
}): ForecastMaterializationOutcome[] {
  return FORECAST_INTERVALS.map((interval) => ({
    ingestId: options.ingestId ?? null,
    spotId: options.spotId,
    interval,
    generationId: options.generationId ?? null,
    generatedAt: options.generatedAt,
    materializedAt: options.materializedAt,
    outcome: options.outcome,
    retryable: options.retryable,
    reasonCode:
      typeof options.reasonCode === "string"
        ? options.reasonCode
        : options.reasonCode[interval] ?? "synchronized_generation_rejected"
  }));
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
      errors: ["Forecast read model inputs do not describe one synchronized spot generation."],
      forecastOutcomes: forecastOutcomes({
        spotId: threeHour.spot.id,
        ingestId: options.ingestId,
        generatedAt: threeHour.generatedAt,
        materializedAt: options.materializedAt,
        outcome: "failure",
        retryable: true,
        reasonCode: "unsynchronized_inputs"
      })
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
      ],
      forecastOutcomes: forecastOutcomes({
        spotId: threeHour.spot.id,
        ingestId: options.ingestId,
        generatedAt: threeHour.generatedAt,
        materializedAt: options.materializedAt,
        outcome: "skip",
        retryable: false,
        reasonCode: Object.fromEntries(
          missingScoredIntervals.map((interval) => [interval, "no_scored_windows"])
        ) as Partial<Record<ForecastInterval, ForecastMaterializationReasonCode>>
      })
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
      errors: ["Forecast read model materialization metadata is invalid."],
      forecastOutcomes: forecastOutcomes({
        spotId: threeHour.spot.id,
        ingestId: options.ingestId,
        generatedAt: threeHour.generatedAt,
        materializedAt: options.materializedAt,
        outcome: "failure",
        retryable: true,
        reasonCode: "invalid_materialization_metadata"
      })
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
  const oversizedForecastIntervals = new Set<ForecastInterval>();
  const payloadErrors = [
    ...serializedForecasts.flatMap(({ forecast, bytes }) => {
      if (bytes <= MAX_FORECAST_READ_MODEL_BYTES) return [];
      if (forecast.interval === "1h" || forecast.interval === "3h") {
        oversizedForecastIntervals.add(forecast.interval);
      }
      return [
        oversizedPayloadError({
          spotId: threeHour.spot.id,
          payload: `${forecast.interval ?? "unknown"} forecast`,
          bytes,
          limit: MAX_FORECAST_READ_MODEL_BYTES
        })
      ];
    }),
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
      errors: payloadErrors,
      forecastOutcomes: forecastOutcomes({
        spotId: threeHour.spot.id,
        ingestId: options.ingestId,
        generatedAt: threeHour.generatedAt,
        materializedAt: options.materializedAt,
        outcome: "skip",
        retryable: false,
        reasonCode:
          oversizedForecastIntervals.size > 0
            ? Object.fromEntries(
                [...oversizedForecastIntervals].map((interval) => [
                  interval,
                  "forecast_payload_too_large"
                ])
              ) as Partial<Record<ForecastInterval, ForecastMaterializationReasonCode>>
            : "fact_bundle_payload_too_large"
      })
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
     where excluded.generated_at > forecast_read_models.generated_at`
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
     where excluded.generated_at > forecast_fact_bundles.generated_at`
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
    const results = await executeMaterialization(options.db, [
      ...forecastStatements,
      ...factStatements
    ]);
    if (
      results.length !== forecastStatements.length + factStatements.length ||
      results.some(
        (result) =>
          !Number.isInteger(result.meta.changes) ||
          result.meta.changes < 0
      )
    ) {
      throw new Error("D1 materialization result metadata is invalid");
    }
    const changes = results.map((result) => result.meta.changes);
    const forecastChanges = changes.slice(0, forecastStatements.length);
    const factBundleChanges = changes.slice(forecastStatements.length);
    const activeGenerations = forecastChanges.some((count) => count === 0)
      ? await activeForecastGenerations(options.db, threeHour.spot.id)
      : new Map<ForecastInterval, ActiveForecastGenerationRow>();
    // Strictly-newer conditional upserts make an equal-generation delivery a
    // real no-op. D1 changes remain publication authority; the active indexed
    // rows distinguish that idempotent duplicate from a genuinely newer winner.
    const outcomes = FORECAST_INTERVALS.map(
      (interval, index): ForecastMaterializationOutcome => {
        const published = (forecastChanges[index] ?? 0) > 0;
        const active = published ? null : activeGenerations.get(interval) ?? null;
        if (!published && !active) {
          throw new Error(`D1 omitted active ${interval} generation after a conditional no-op`);
        }
        const alreadyActive = active?.generated_at === threeHour.generatedAt;
        return {
          ingestId: options.ingestId ?? null,
          spotId: threeHour.spot.id,
          interval,
          generationId: alreadyActive ? active!.generation_id : generationId,
          generatedAt: threeHour.generatedAt,
          materializedAt: options.materializedAt,
          outcome: published ? "publish" : alreadyActive ? "skip" : "supersede",
          retryable: false,
          reasonCode: published
            ? "forecast_generation_published"
            : alreadyActive
              ? "forecast_generation_already_active"
              : "newer_generation_active"
        };
      }
    );
    return {
      rowsWritten: changes.reduce((total, count) => total + count, 0),
      forecastRowsWritten: forecastChanges.filter((count) => count > 0).length,
      factBundleRowsWritten: factBundleChanges.filter((count) => count > 0).length,
      errors: [],
      forecastOutcomes: outcomes
    };
  } catch (error) {
    return {
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: [`${threeHour.spot.id}: forecast read model persistence failed: ${errorMessage(error)}`],
      forecastOutcomes: forecastOutcomes({
        spotId: threeHour.spot.id,
        ingestId: options.ingestId,
        generatedAt: threeHour.generatedAt,
        materializedAt: options.materializedAt,
        generationId,
        outcome: "failure",
        retryable: true,
        reasonCode: "forecast_persistence_failed"
      })
    };
  }
}

export async function materializeForecastReadModels(
  env: Env,
  now: Date,
  _sourceIssueFingerprint: string,
  materializedAt = new Date().toISOString(),
  ingestId?: string,
  spotIds: readonly SpotId[] = NORCAL_SPOTS.map(({ id }) => id)
): Promise<ForecastReadModelPersistenceResult> {
  let rowsWritten = 0;
  let forecastRowsWritten = 0;
  let factBundleRowsWritten = 0;
  const errors: string[] = [];
  const outcomes: ForecastMaterializationOutcome[] = [];

  for (const spotId of spotIds) {
    const result = await materializeForecastReadModelForSpot(
      env,
      spotId,
      now,
      {
        materializedAt,
        ingestId
      }
    );
    rowsWritten += result.rowsWritten;
    forecastRowsWritten += result.forecastRowsWritten;
    factBundleRowsWritten += result.factBundleRowsWritten;
    errors.push(...result.errors);
    outcomes.push(...result.forecastOutcomes);
  }

  return {
    rowsWritten,
    forecastRowsWritten,
    factBundleRowsWritten,
    errors,
    forecastOutcomes: outcomes
  };
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
      localDates.map((localDate) => buildForecastFactBundle(hourly, { localDate }))
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
    const duplicateRows = materialization.forecastOutcomes.filter(
      ({ outcome, reasonCode }) =>
        outcome === "skip" && reasonCode === "forecast_generation_already_active"
    ).length;
    const publicationComplete =
      materialization.errors.length === 0 &&
      forecastGenerationBecameActive(materialization.forecastOutcomes) &&
      materialization.forecastRowsWritten === FORECAST_INTERVALS.length - duplicateRows &&
      (materialization.factBundleRowsWritten > 0 || duplicateRows > 0);
    if (!options.captureHistory || !publicationComplete) return materialization;
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
      errors: [`${spotId}: forecast read model assembly failed: ${errorMessage(error)}`],
      forecastOutcomes: forecastOutcomes({
        spotId,
        ingestId: options.ingestId,
        generatedAt: Number.isNaN(now.getTime()) ? "invalid" : now.toISOString(),
        materializedAt: options.materializedAt ?? null,
        outcome: "failure",
        retryable: true,
        reasonCode: "forecast_assembly_failed"
      })
    };
  }
}
