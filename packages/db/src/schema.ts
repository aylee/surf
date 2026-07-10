import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const spots = sqliteTable("spots", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region").notNull().default("norcal"),
  lat: real("lat").notNull(),
  lon: real("lon").notNull(),
  timezone: text("timezone").notNull(),
  shoreNormalDeg: integer("shore_normal_deg"),
  configJson: text("config_json").notNull(),
  active: integer("active").notNull().default(1)
});

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  externalId: text("external_id"),
  url: text("url"),
  format: text("format").notNull(),
  parserRuntime: text("parser_runtime").notNull(),
  attribution: text("attribution").notNull(),
  licenseNote: text("license_note"),
  refreshMinutes: integer("refresh_minutes").notNull(),
  active: integer("active").notNull().default(1),
  metadataJson: text("metadata_json")
});

export const spotSourceMap = sqliteTable(
  "spot_source_map",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    role: text("role").notNull(),
    distanceKm: real("distance_km"),
    weight: real("weight"),
    priority: integer("priority").notNull().default(100),
    coverageStatus: text("coverage_status").notNull().default("active"),
    notes: text("notes"),
    metadataJson: text("metadata_json")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.sourceId, table.role] }),
    spotRoleIdx: index("spot_source_map_spot_role_idx").on(table.spotId, table.role),
    sourceIdx: index("spot_source_map_source_idx").on(table.sourceId)
  })
);

export const sourceRuns = sqliteTable("source_runs", {
  id: text("id").primaryKey(),
  runKey: text("run_key").notNull(),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id),
  runKind: text("run_kind").notNull(),
  cycleAt: text("cycle_at"),
  forecastHour: integer("forecast_hour"),
  validStartAt: text("valid_start_at"),
  validEndAt: text("valid_end_at"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
  rawR2Key: text("raw_r2_key"),
  artifactManifestJson: text("artifact_manifest_json"),
  metadataJson: text("metadata_json"),
  error: text("error")
}, (table) => ({
  runKeyIdx: uniqueIndex("source_runs_run_key_idx").on(table.runKey),
  sourceStatusIdx: index("source_runs_source_status_idx").on(table.sourceId, table.status),
  cycleIdx: index("source_runs_cycle_idx").on(table.cycleAt)
}));

export const sourceArtifacts = sqliteTable(
  "source_artifacts",
  {
    id: text("id").primaryKey(),
    sourceRunId: text("source_run_id")
      .notNull()
      .references(() => sourceRuns.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    r2Key: text("r2_key").notNull(),
    artifactType: text("artifact_type").notNull(),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    checksumSha256: text("checksum_sha256"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json")
  },
  (table) => ({
    r2KeyIdx: uniqueIndex("source_artifacts_r2_key_idx").on(table.r2Key),
    sourceRunIdx: index("source_artifacts_source_run_idx").on(table.sourceRunId)
  })
);

export const waveForecasts = sqliteTable(
  "wave_forecasts",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRunId: text("source_run_id").references(() => sourceRuns.id),
    modelCycleAt: text("model_cycle_at").notNull(),
    forecastAt: text("forecast_at").notNull(),
    leadHour: integer("lead_hour").notNull(),
    offshoreHeightM: real("offshore_height_m"),
    nearshoreHeightM: real("nearshore_height_m"),
    significantHeightM: real("significant_height_m"),
    peakPeriodS: real("peak_period_s"),
    meanPeriodS: real("mean_period_s"),
    primaryDirectionDeg: integer("primary_direction_deg"),
    windWaveHeightM: real("wind_wave_height_m"),
    windWavePeriodS: real("wind_wave_period_s"),
    windWaveDirectionDeg: integer("wind_wave_direction_deg"),
    swellHeightM: real("swell_height_m"),
    swellPeriodS: real("swell_period_s"),
    swellDirectionDeg: integer("swell_direction_deg"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.sourceId, table.modelCycleAt, table.forecastAt] }),
    spotForecastAtIdx: index("wave_forecasts_spot_forecast_at_idx").on(table.spotId, table.forecastAt),
    sourceRunIdx: index("wave_forecasts_source_run_idx").on(table.sourceRunId)
  })
);

export const tideForecasts = sqliteTable(
  "tide_forecasts",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRunId: text("source_run_id").references(() => sourceRuns.id),
    stationId: text("station_id").notNull(),
    forecastAt: text("forecast_at").notNull(),
    tideFtMllw: real("tide_ft_mllw").notNull(),
    tideMMllw: real("tide_m_mllw"),
    tideTrend: text("tide_trend"),
    highLow: text("high_low"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.stationId, table.forecastAt] }),
    spotForecastAtIdx: index("tide_forecasts_spot_forecast_at_idx").on(table.spotId, table.forecastAt),
    sourceRunIdx: index("tide_forecasts_source_run_idx").on(table.sourceRunId)
  })
);

export const windForecasts = sqliteTable(
  "wind_forecasts",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRunId: text("source_run_id").references(() => sourceRuns.id),
    modelCycleAt: text("model_cycle_at"),
    forecastAt: text("forecast_at").notNull(),
    leadHour: integer("lead_hour"),
    windSpeedMs: real("wind_speed_ms"),
    windDirectionDeg: integer("wind_direction_deg"),
    gustMs: real("gust_ms"),
    weatherSummary: text("weather_summary"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.sourceId, table.forecastAt] }),
    spotForecastAtIdx: index("wind_forecasts_spot_forecast_at_idx").on(table.spotId, table.forecastAt),
    sourceRunIdx: index("wind_forecasts_source_run_idx").on(table.sourceRunId)
  })
);

/**
 * Append-only wind issues used for forecast-as-issued evaluation. The
 * wind_forecasts table remains the compact latest-value read model.
 */
export const windForecastIssues = sqliteTable(
  "wind_forecast_issues",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRunId: text("source_run_id")
      .notNull()
      .references(() => sourceRuns.id),
    issueKey: text("issue_key").notNull(),
    issuedAt: text("issued_at").notNull(),
    modelCycleAt: text("model_cycle_at"),
    forecastAt: text("forecast_at").notNull(),
    leadHours: real("lead_hours"),
    windSpeedMs: real("wind_speed_ms"),
    windDirectionDeg: integer("wind_direction_deg"),
    gustMs: real("gust_ms"),
    weatherSummary: text("weather_summary"),
    payloadJson: text("payload_json"),
    capturedAt: text("captured_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.sourceId, table.issueKey, table.forecastAt] }),
    spotForecastAtIdx: index("wind_forecast_issues_spot_forecast_at_idx").on(
      table.spotId,
      table.forecastAt
    ),
    sourceIssuedAtIdx: index("wind_forecast_issues_source_issued_at_idx").on(
      table.sourceId,
      table.issuedAt
    ),
    sourceRunIdx: index("wind_forecast_issues_source_run_idx").on(table.sourceRunId)
  })
);

export const waveObservations = sqliteTable(
  "wave_observations",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRunId: text("source_run_id").references(() => sourceRuns.id),
    observedAt: text("observed_at").notNull(),
    waveHeightM: real("wave_height_m"),
    peakPeriodS: real("peak_period_s"),
    meanPeriodS: real("mean_period_s"),
    primaryDirectionDeg: integer("primary_direction_deg"),
    windWaveHeightM: real("wind_wave_height_m"),
    swellHeightM: real("swell_height_m"),
    waterTempC: real("water_temp_c"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.sourceId, table.observedAt] }),
    spotObservedAtIdx: index("wave_observations_spot_observed_at_idx").on(table.spotId, table.observedAt),
    sourceRunIdx: index("wave_observations_source_run_idx").on(table.sourceRunId)
  })
);

export const tideObservations = sqliteTable(
  "tide_observations",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRunId: text("source_run_id").references(() => sourceRuns.id),
    stationId: text("station_id").notNull(),
    observedAt: text("observed_at").notNull(),
    waterLevelFtMllw: real("water_level_ft_mllw"),
    waterLevelMMllw: real("water_level_m_mllw"),
    sigmaFt: real("sigma_ft"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.stationId, table.observedAt] }),
    spotObservedAtIdx: index("tide_observations_spot_observed_at_idx").on(table.spotId, table.observedAt),
    sourceRunIdx: index("tide_observations_source_run_idx").on(table.sourceRunId)
  })
);

export const windObservations = sqliteTable(
  "wind_observations",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRunId: text("source_run_id").references(() => sourceRuns.id),
    observedAt: text("observed_at").notNull(),
    windSpeedMs: real("wind_speed_ms"),
    windDirectionDeg: integer("wind_direction_deg"),
    gustMs: real("gust_ms"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.sourceId, table.observedAt] }),
    spotObservedAtIdx: index("wind_observations_spot_observed_at_idx").on(table.spotId, table.observedAt),
    sourceRunIdx: index("wind_observations_source_run_idx").on(table.sourceRunId)
  })
);

export const hazardEvents = sqliteTable(
  "hazard_events",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceRunId: text("source_run_id").references(() => sourceRuns.id),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    severity: text("severity"),
    certainty: text("certainty"),
    urgency: text("urgency"),
    startsAt: text("starts_at"),
    endsAt: text("ends_at"),
    headline: text("headline").notNull(),
    description: text("description"),
    instruction: text("instruction"),
    payloadJson: text("payload_json"),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.sourceId, table.eventId] }),
    spotStartsAtIdx: index("hazard_events_spot_starts_at_idx").on(table.spotId, table.startsAt),
    sourceRunIdx: index("hazard_events_source_run_idx").on(table.sourceRunId)
  })
);

export const spotScores = sqliteTable(
  "spot_scores",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    forecastAt: text("forecast_at").notNull(),
    qualityLabel: text("quality_label").notNull(),
    score: integer("score").notNull(),
    confidence: integer("confidence").notNull(),
    waveScore: integer("wave_score").notNull(),
    windScore: integer("wind_score").notNull(),
    tideScore: integer("tide_score").notNull(),
    sourceScore: integer("source_score").notNull(),
    explanation: text("explanation").notNull(),
    componentsJson: text("components_json"),
    caveatsJson: text("caveats_json"),
    sourceFreshnessMinutes: integer("source_freshness_minutes"),
    computedFromRunId: text("computed_from_run_id").references(() => sourceRuns.id),
    computedAt: text("computed_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.forecastAt] }),
    computedAtIdx: index("spot_scores_computed_at_idx").on(table.computedAt),
    sourceRunIdx: index("spot_scores_source_run_idx").on(table.computedFromRunId)
  })
);

export const sessionFeedback = sqliteTable("session_feedback", {
  id: text("id").primaryKey(),
  spotId: text("spot_id")
    .notNull()
    .references(() => spots.id),
  forecastAt: text("forecast_at"),
  occurredAt: text("occurred_at").notNull(),
  rating: integer("rating"),
  notes: text("notes"),
  conditionsJson: text("conditions_json"),
  sourceSnapshotJson: text("source_snapshot_json"),
  createdAt: text("created_at").notNull()
}, (table) => ({
  spotOccurredAtIdx: index("session_feedback_spot_occurred_at_idx").on(table.spotId, table.occurredAt)
}));

export const backtestRuns = sqliteTable("backtest_runs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  spotId: text("spot_id").references(() => spots.id),
  sourceId: text("source_id").references(() => sources.id),
  comparisonSourceId: text("comparison_source_id").references(() => sources.id),
  validStartAt: text("valid_start_at").notNull(),
  validEndAt: text("valid_end_at").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
  metricSummaryJson: text("metric_summary_json"),
  metadataJson: text("metadata_json"),
  error: text("error")
}, (table) => ({
  statusIdx: index("backtest_runs_status_idx").on(table.status),
  spotIdx: index("backtest_runs_spot_idx").on(table.spotId)
}));

export const backtestMetrics = sqliteTable(
  "backtest_metrics",
  {
    backtestRunId: text("backtest_run_id")
      .notNull()
      .references(() => backtestRuns.id),
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    unit: text("unit"),
    sampleCount: integer("sample_count").notNull(),
    metadataJson: text("metadata_json")
  },
  (table) => ({
    pk: primaryKey({ columns: [table.backtestRunId, table.spotId, table.sourceId, table.metric] }),
    spotMetricIdx: index("backtest_metrics_spot_metric_idx").on(table.spotId, table.metric)
  })
);

/**
 * Immutable per-window product snapshots. These rows preserve exactly what
 * the app issued so later backtests do not accidentally compare observations
 * against today's recomputation of an old forecast.
 */
export const forecastSnapshots = sqliteTable(
  "forecast_snapshots",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spots.id),
    issueId: text("issue_id").notNull(),
    capturedAt: text("captured_at").notNull(),
    issuedAt: text("issued_at").notNull(),
    validAt: text("valid_at").notNull(),
    leadHours: real("lead_hours").notNull(),
    ratingStatus: text("rating_status").notNull(),
    qualityLabel: text("quality_label").notNull(),
    surfaceCondition: text("surface_condition").notNull(),
    displayedHeightFt: real("displayed_height_ft"),
    displayedHeightLabel: text("displayed_height_label").notNull(),
    score: integer("score").notNull(),
    confidence: integer("confidence").notNull(),
    waveScore: integer("wave_score").notNull(),
    windScore: integer("wind_score").notNull(),
    tideScore: integer("tide_score").notNull(),
    sourceScore: integer("source_score").notNull(),
    peakPeriodS: real("peak_period_s"),
    primaryDirectionDeg: integer("primary_direction_deg"),
    tideFt: real("tide_ft"),
    tideTrend: text("tide_trend"),
    windSpeedKt: real("wind_speed_kt"),
    windDirectionDeg: integer("wind_direction_deg"),
    sourceUpdatedAt: text("source_updated_at"),
    sourceRunIdsJson: text("source_run_ids_json").notNull(),
    sourceVersionsJson: text("source_versions_json").notNull(),
    sourceIssueFingerprint: text("source_issue_fingerprint").notNull(),
    rawFactsJson: text("raw_facts_json").notNull(),
    spotConfigJson: text("spot_config_json").notNull(),
    spotConfigHash: text("spot_config_hash").notNull(),
    forecastEngineVersion: text("forecast_engine_version").notNull(),
    presentationVersion: text("presentation_version").notNull(),
    snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spotId, table.issueId, table.validAt] }),
    spotValidAtIdx: index("forecast_snapshots_spot_valid_at_idx").on(table.spotId, table.validAt),
    spotIssuedAtIdx: index("forecast_snapshots_spot_issued_at_idx").on(table.spotId, table.issuedAt),
    issueIdx: index("forecast_snapshots_issue_idx").on(table.issueId)
  })
);

export const forecastReports = sqliteTable("forecast_reports", {
  id: text("id").primaryKey(),
  regionId: text("region_id").notNull(),
  issuedAt: text("issued_at").notNull(),
  validStartAt: text("valid_start_at").notNull(),
  validEndAt: text("valid_end_at").notNull(),
  status: text("status").notNull(),
  modelSummaryJson: text("model_summary_json").notNull(),
  sourceRunIdsJson: text("source_run_ids_json"),
  scoreSnapshotJson: text("score_snapshot_json"),
  reportMarkdown: text("report_markdown"),
  generatedBy: text("generated_by").notNull(),
  disabledReason: text("disabled_reason"),
  createdAt: text("created_at").notNull()
}, (table) => ({
  regionIssuedAtIdx: index("forecast_reports_region_issued_at_idx").on(table.regionId, table.issuedAt),
  statusIdx: index("forecast_reports_status_idx").on(table.status)
}));
