import {
  ForecastIntervalSchema,
  SpotIdSchema,
  type ForecastInterval,
  type SpotId
} from "@surf/contracts";
import {
  FORECAST_READ_MODEL_SCHEMA_VERSION,
  ingestIdFromGenerationId
} from "./forecast-read-model";

type ForecastReadinessDatabaseRow = {
  spot_id: unknown;
  interval: unknown;
  generation_id: unknown;
  schema_version: unknown;
  generated_at: unknown;
  materialized_at: unknown;
};

export type ForecastReadinessRow = {
  spotId: SpotId;
  interval: ForecastInterval;
  generationId: string | null;
  ingestId: string | null;
  generatedAt: string | null;
  materializedAt: string | null;
};

export type ForecastReadinessResponse = {
  forecastReadModels: ForecastReadinessRow[];
};

const FORECAST_GENERATION_PATTERN =
  /^sha256:[a-f0-9]{64}(?::ingest:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function parseReadinessRow(row: ForecastReadinessDatabaseRow): ForecastReadinessRow {
  const spotId = SpotIdSchema.safeParse(row.spot_id);
  const interval = ForecastIntervalSchema.safeParse(row.interval);
  if (!spotId.success || !interval.success) {
    throw new Error("Stored forecast readiness target identity is invalid");
  }

  const metadata = [
    row.generation_id,
    row.schema_version,
    row.generated_at,
    row.materialized_at
  ];
  if (metadata.every((value) => value === null)) {
    return {
      spotId: spotId.data,
      interval: interval.data,
      generationId: null,
      ingestId: null,
      generatedAt: null,
      materializedAt: null
    };
  }

  if (
    typeof row.generation_id !== "string" ||
    !FORECAST_GENERATION_PATTERN.test(row.generation_id) ||
    row.schema_version !== FORECAST_READ_MODEL_SCHEMA_VERSION ||
    !validIso(row.generated_at) ||
    !validIso(row.materialized_at) ||
    new Date(row.materialized_at).getTime() < new Date(row.generated_at).getTime()
  ) {
    throw new Error("Stored forecast readiness metadata is invalid");
  }

  return {
    spotId: spotId.data,
    interval: interval.data,
    generationId: row.generation_id,
    ingestId: ingestIdFromGenerationId(row.generation_id),
    generatedAt: row.generated_at,
    materializedAt: row.materialized_at
  };
}

export async function getForecastReadiness(
  db: D1Database,
  region: string
): Promise<ForecastReadinessResponse> {
  const result = await db
    .prepare(
      `select target_spot.id as spot_id,
              target_interval.interval as interval,
              model.generation_id,
              model.schema_version,
              model.generated_at,
              model.materialized_at
       from spots as target_spot
       cross join (
         select '3h' as interval, 0 as sort_order
         union all
         select '1h', 1
       ) as target_interval
       left join forecast_read_models as model
         on model.spot_id = target_spot.id
        and model.interval = target_interval.interval
       where target_spot.region = ?
         and target_spot.active = 1
       order by target_spot.id asc, target_interval.sort_order asc`
    )
    .bind(region)
    .all<ForecastReadinessDatabaseRow>();

  if (!result.success) {
    throw new Error("Forecast readiness query was not successful");
  }

  return {
    forecastReadModels: result.results.map(parseReadinessRow)
  };
}
