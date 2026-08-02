import { assembleModelForecastBrief } from "./brief";
import {
  ForecastBriefSchema,
  ForecastBriefValidationSchema,
  type ForecastBrief,
  type ForecastBriefDraft,
  type ForecastBriefValidation,
  type ForecastFactBundle
} from "./types";

type ForecastBriefRevisionRow = {
  spot_id: string;
  local_date: string;
  revision: number;
  input_fingerprint: string;
  material_fingerprint: string;
  status: string;
  generated_at: string;
  expires_at: string | null;
  provider: string;
  model_id: string;
  prompt_version: string;
  schema_version: number;
  brief_json: string;
  fact_refs_json: string;
  validation_json: string;
  created_at: string;
};

export type PersistedForecastBriefRevision = {
  brief: ForecastBrief;
  materialFingerprint: string;
  expiresAt: string | null;
  validation: ForecastBriefValidation;
  createdAt: string;
};

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Stored ${label} is not valid JSON`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseRevision(row: ForecastBriefRevisionRow): PersistedForecastBriefRevision {
  if (row.status !== "validated") throw new Error(`Unsupported brief status: ${row.status}`);
  const brief = ForecastBriefSchema.parse(parseJson(row.brief_json, "forecast brief"));
  const validation = ForecastBriefValidationSchema.parse(
    parseJson(row.validation_json, "forecast brief validation")
  );
  const factRefs = parseJson(row.fact_refs_json, "forecast brief fact references");
  if (
    !isStringArray(factRefs) ||
    JSON.stringify([...factRefs].sort()) !==
      JSON.stringify([...validation.referencedFactIds].sort())
  ) {
    throw new Error("Stored forecast brief fact references do not match validation metadata");
  }
  if (validation.claimRefs) {
    const claimFactRefs = [
      ...new Set(validation.claimRefs.flatMap((claim) => claim.factRefs))
    ].sort();
    if (
      JSON.stringify(claimFactRefs) !==
      JSON.stringify([...validation.referencedFactIds].sort())
    ) {
      throw new Error("Stored forecast brief claim references do not match validation metadata");
    }
  }
  if (row.expires_at !== null && !Number.isFinite(new Date(row.expires_at).getTime())) {
    throw new Error("Stored forecast brief expiration is invalid");
  }
  if (
    brief.spotId !== row.spot_id ||
    brief.localDate !== row.local_date ||
    brief.revision !== row.revision ||
    brief.inputFingerprint !== row.input_fingerprint ||
    brief.generatedAt !== row.generated_at ||
    brief.provider !== "google" ||
    brief.provider !== row.provider ||
    brief.modelId !== row.model_id ||
    brief.promptVersion !== row.prompt_version ||
    brief.schemaVersion !== row.schema_version
  ) {
    throw new Error("Stored forecast brief metadata does not match its revision row");
  }
  return {
    brief,
    materialFingerprint: row.material_fingerprint,
    expiresAt: row.expires_at,
    validation,
    createdAt: row.created_at
  };
}

const SELECT_COLUMNS = `spot_id, local_date, revision, input_fingerprint, material_fingerprint,
  status, generated_at, expires_at, provider, model_id, prompt_version, schema_version,
  brief_json, fact_refs_json, validation_json, created_at`;

export async function getLatestValidatedForecastBrief(
  db: D1Database,
  spotId: string,
  localDate: string
): Promise<PersistedForecastBriefRevision | null> {
  const row = await db
    .prepare(
      `select ${SELECT_COLUMNS}
       from forecast_brief_revisions
       where spot_id = ? and local_date = ? and status = 'validated'
       order by revision desc
       limit 1`
    )
    .bind(spotId, localDate)
    .first<ForecastBriefRevisionRow>();
  return row ? parseRevision(row) : null;
}

export async function getLatestValidatedForecastBriefForMaterialFingerprint(
  db: D1Database,
  spotId: string,
  localDate: string,
  materialFingerprint: string
): Promise<PersistedForecastBriefRevision | null> {
  const row = await db
    .prepare(
      `select ${SELECT_COLUMNS}
       from forecast_brief_revisions
       where spot_id = ? and local_date = ? and material_fingerprint = ?
         and status = 'validated'
       order by revision desc
       limit 1`
    )
    .bind(spotId, localDate, materialFingerprint)
    .first<ForecastBriefRevisionRow>();
  return row ? parseRevision(row) : null;
}

export async function getValidatedForecastBriefByFingerprint(
  db: D1Database,
  spotId: string,
  localDate: string,
  inputFingerprint: string
): Promise<PersistedForecastBriefRevision | null> {
  const row = await db
    .prepare(
      `select ${SELECT_COLUMNS}
       from forecast_brief_revisions
       where spot_id = ? and local_date = ? and input_fingerprint = ? and status = 'validated'
       limit 1`
    )
    .bind(spotId, localDate, inputFingerprint)
    .first<ForecastBriefRevisionRow>();
  return row ? parseRevision(row) : null;
}

export async function countValidatedForecastBriefRevisions(
  db: D1Database,
  spotId: string,
  localDate: string
): Promise<number> {
  const row = await db
    .prepare(
      `select count(*) as count
       from forecast_brief_revisions
       where spot_id = ? and local_date = ? and status = 'validated'`
    )
    .bind(spotId, localDate)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function nextRevision(db: D1Database, spotId: string, localDate: string): Promise<number> {
  const row = await db
    .prepare(
      `select coalesce(max(revision), 0) + 1 as revision
       from forecast_brief_revisions
       where spot_id = ? and local_date = ?`
    )
    .bind(spotId, localDate)
    .first<{ revision: number }>();
  return row?.revision ?? 1;
}

export async function persistValidatedForecastBrief(options: {
  db: D1Database;
  bundle: ForecastFactBundle;
  draft: ForecastBriefDraft;
  validation: ForecastBriefValidation;
  generatedAt?: string;
}): Promise<PersistedForecastBriefRevision> {
  const existing = await getValidatedForecastBriefByFingerprint(
    options.db,
    options.bundle.input.spotId,
    options.bundle.input.localDate,
    options.bundle.inputFingerprint
  );
  if (existing) return existing;

  const revision = await nextRevision(
    options.db,
    options.bundle.input.spotId,
    options.bundle.input.localDate
  );
  const brief = assembleModelForecastBrief({
    draft: options.draft,
    bundle: options.bundle,
    revision,
    generatedAt: options.generatedAt
  });
  if (brief.provider !== "google" || brief.modelId === null) {
    throw new Error("Only validated Google model briefs may be persisted");
  }
  const createdAt = new Date().toISOString();
  try {
    await options.db
      .prepare(
        `insert into forecast_brief_revisions (
           spot_id, local_date, revision, input_fingerprint, material_fingerprint,
           status, generated_at, expires_at, provider, model_id, prompt_version,
           schema_version, brief_json, fact_refs_json, validation_json, created_at
         ) values (?, ?, ?, ?, ?, 'validated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        brief.spotId,
        brief.localDate,
        brief.revision,
        brief.inputFingerprint,
        options.bundle.materialFingerprint,
        brief.generatedAt,
        options.bundle.input.expiresAt,
        brief.provider,
        brief.modelId,
        brief.promptVersion,
        brief.schemaVersion,
        JSON.stringify(brief),
        JSON.stringify(options.validation.referencedFactIds),
        JSON.stringify(options.validation),
        createdAt
      )
      .run();
  } catch (error) {
    const raced = await getValidatedForecastBriefByFingerprint(
      options.db,
      options.bundle.input.spotId,
      options.bundle.input.localDate,
      options.bundle.inputFingerprint
    );
    if (raced) return raced;
    throw error;
  }
  return { brief, materialFingerprint: options.bundle.materialFingerprint, expiresAt: options.bundle.input.expiresAt, validation: options.validation, createdAt };
}
