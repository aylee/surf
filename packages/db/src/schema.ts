import { integer, real, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const spots = sqliteTable("spots", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lat: real("lat").notNull(),
  lon: real("lon").notNull(),
  timezone: text("timezone").notNull(),
  shoreNormalDeg: integer("shore_normal_deg"),
  configJson: text("config_json").notNull(),
  active: integer("active").notNull().default(1)
});

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  url: text("url"),
  licenseNote: text("license_note"),
  refreshMinutes: integer("refresh_minutes").notNull()
});

export const spotSourceMap = sqliteTable(
  "spot_source_map",
  {
    spotId: text("spot_id").notNull(),
    sourceId: text("source_id").notNull(),
    role: text("role").notNull(),
    distanceKm: real("distance_km"),
    weight: real("weight"),
    metadataJson: text("metadata_json")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.sourceId, table.role] })
  })
);

export const sourceRuns = sqliteTable("source_runs", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  cycleAt: text("cycle_at"),
  forecastHour: integer("forecast_hour"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
  rawR2Key: text("raw_r2_key"),
  metadataJson: text("metadata_json"),
  error: text("error")
});

export const spotScores = sqliteTable(
  "spot_scores",
  {
    spotId: text("spot_id").notNull(),
    forecastAt: text("forecast_at").notNull(),
    qualityLabel: text("quality_label").notNull(),
    score: integer("score").notNull(),
    confidence: integer("confidence").notNull(),
    waveScore: integer("wave_score").notNull(),
    windScore: integer("wind_score").notNull(),
    tideScore: integer("tide_score").notNull(),
    sourceScore: integer("source_score").notNull(),
    explanation: text("explanation").notNull(),
    computedAt: text("computed_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.forecastAt] })
  })
);

