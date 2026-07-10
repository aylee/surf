import { z } from "zod";

export const SourceCapabilitySchema = z.enum([
  "forecast_wave_offshore",
  "forecast_wave_nearshore",
  "observed_wave",
  "tide",
  "wind",
  "hazard",
  "bathymetry",
  "quality_label",
  "comparison_forecast"
]);

export type SourceCapability = z.infer<typeof SourceCapabilitySchema>;

export const SourceStatusSchema = z.enum([
  "planned",
  "live",
  "stale",
  "unavailable",
  "blocked",
  "failed"
]);

export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const SourceMappingSchema = z.object({
  sourceId: z.string(),
  capability: SourceCapabilitySchema,
  provider: z.string(),
  name: z.string(),
  url: z.string().url().optional(),
  stationId: z.string().optional(),
  modelPointId: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  distanceKm: z.number().nonnegative().optional(),
  weight: z.number().nonnegative().optional(),
  status: SourceStatusSchema,
  notes: z.string()
});

export type SourceMapping = z.infer<typeof SourceMappingSchema>;

export const SpotIdSchema = z.enum([
  "obsf-north",
  "obsf-central",
  "obsf-south",
  "linda-mar",
  "stinson",
  "bolinas"
]);

export type SpotId = z.infer<typeof SpotIdSchema>;

export const DirectionWindowSchema = z.object({
  minDeg: z.number().min(0).max(360),
  maxDeg: z.number().min(0).max(360)
});

export const RangeSchema = z.object({
  min: z.number(),
  max: z.number()
});

export const SpotProfileSchema = z.object({
  id: SpotIdSchema,
  name: z.string(),
  region: z.literal("norcal"),
  lat: z.number(),
  lon: z.number(),
  timezone: z.string(),
  shoreNormalDeg: z.number().min(0).max(360),
  bestSwellDeg: DirectionWindowSchema,
  workableSwellDeg: DirectionWindowSchema,
  bestPeriodSec: RangeSchema,
  bestTideFt: RangeSchema,
  offshoreWindFromDeg: DirectionWindowSchema,
  maxGoodWindKt: z.number(),
  maxOkWindKt: z.number(),
  referenceBuoys: z.array(z.string()),
  cdipStations: z.array(z.string()),
  tideStation: z.string(),
  sourceMappings: z.array(SourceMappingSchema).optional(),
  notes: z.string()
});

export type SpotProfile = z.infer<typeof SpotProfileSchema>;

export const ForecastWindowInputSchema = z.object({
  spotId: SpotIdSchema,
  forecastAt: z.string(),
  waveHeightFt: z.number().nonnegative().nullable(),
  peakPeriodSec: z.number().nonnegative().nullable(),
  primaryDirectionDeg: z.number().min(0).max(360).nullable(),
  tideFt: z.number().nullable(),
  windSpeedKt: z.number().nonnegative().nullable(),
  windDirectionDeg: z.number().min(0).max(360).nullable(),
  sourceFreshnessMinutes: z.number().nonnegative(),
  forecastLeadHours: z.number().nonnegative().optional(),
  usesColdStartTransform: z.boolean().optional(),
  activeCapabilities: z.array(SourceCapabilitySchema)
});

export type ForecastWindowInput = z.infer<typeof ForecastWindowInputSchema>;

export const QualityLabelSchema = z.enum([
  "unknown",
  "poor",
  "fair",
  "fun",
  "good",
  "excellent"
]);

export type QualityLabel = z.infer<typeof QualityLabelSchema>;

export const RatingStatusSchema = z.enum(["scored", "unknown"]);

export type RatingStatus = z.infer<typeof RatingStatusSchema>;

export const SwellComponentSchema = z.object({
  heightFt: z.number().nonnegative().nullable(),
  periodSec: z.number().nonnegative().nullable(),
  directionDeg: z.number().min(0).max(360).nullable()
});

export type SwellComponent = z.infer<typeof SwellComponentSchema>;

export const WaveProvenanceSchema = z.object({
  sourceId: z.string(),
  provider: z.string(),
  sourceUrl: z.string().url(),
  sourceUpdatedAt: z.string(),
  modelCycleAt: z.string().nullable().optional(),
  rawSignificantHeightFt: z.number().nonnegative(),
  breakingHeightScale: z.number().positive(),
  estimatedBreakingHeightFt: z.number().nonnegative().nullable(),
  modeledNearshoreSignificantHeightFt: z.number().nonnegative().nullable().optional(),
  heightSemantics: z.enum([
    "estimated_breaking_height",
    "modeled_significant_wave_height_not_breaking_face_height"
  ]).optional(),
  modelPointId: z.string().optional(),
  modelPointWaterDepthM: z.number().positive().optional(),
  pointRelationship: z.enum(["direct_nearshore_point", "outside_cove_approach_proxy"]).optional(),
  sourceTimestampSemantics: z.literal("http_last_modified_source_update_not_model_cycle").optional(),
  derivation: z.enum([
    "nws_coastal_grid_spot_scale",
    "cdip_mop_point_hs",
    "cdip_mop_point_hs_spot_scale"
  ])
});

export type WaveProvenance = z.infer<typeof WaveProvenanceSchema>;

export const WaveObservationSummarySchema = z.object({
  stationId: z.string(),
  observedAt: z.string(),
  waveHeightFt: z.number().nonnegative(),
  dominantPeriodSec: z.number().nonnegative().nullable(),
  averagePeriodSec: z.number().nonnegative().nullable(),
  meanWaveDirectionDeg: z.number().min(0).max(360).nullable(),
  waterTempF: z.number().nullable(),
  sourceFreshnessMinutes: z.number().nonnegative()
});

export type WaveObservationSummary = z.infer<typeof WaveObservationSummarySchema>;

export const SurfScoreSchema = z.object({
  spotId: SpotIdSchema,
  forecastAt: z.string(),
  ratingStatus: RatingStatusSchema,
  qualityLabel: QualityLabelSchema,
  score: z.number().int().min(0).max(100),
  confidence: z.number().int().min(0).max(100),
  waveScore: z.number().int().min(0).max(100),
  windScore: z.number().int().min(0).max(100),
  tideScore: z.number().int().min(0).max(100),
  sourceScore: z.number().int().min(0).max(100),
  explanation: z.string()
});

export type SurfScore = z.infer<typeof SurfScoreSchema>;

export const ScoredForecastWindowSchema = SurfScoreSchema.extend({
  waveHeightFt: z.number().nonnegative().nullable(),
  peakPeriodSec: z.number().nonnegative().nullable(),
  primaryDirectionDeg: z.number().min(0).max(360).nullable(),
  tideFt: z.number().nullable(),
  tideTrend: z.enum(["rising", "falling", "steady", "unknown"]).nullable().optional(),
  windSpeedKt: z.number().nonnegative().nullable(),
  windDirectionDeg: z.number().min(0).max(360).nullable(),
  sourceFreshnessMinutes: z.number().nonnegative(),
  activeCapabilities: z.array(SourceCapabilitySchema),
  sourceRunIds: z.array(z.string()),
  caveats: z.array(z.string()),
  primarySwell: SwellComponentSchema.nullable(),
  secondarySwell: SwellComponentSchema.nullable(),
  waveProvenance: WaveProvenanceSchema.nullable()
});

export type ScoredForecastWindow = z.infer<typeof ScoredForecastWindowSchema>;

export const ForecastResponseSchema = z.object({
  spot: SpotProfileSchema,
  windows: z.array(ScoredForecastWindowSchema),
  generatedAt: z.string(),
  sourceNote: z.string(),
  observation: WaveObservationSummarySchema.nullable().optional()
});

export type ForecastResponse = z.infer<typeof ForecastResponseSchema>;

export const SourceRunSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  capability: SourceCapabilitySchema,
  provider: z.string(),
  status: SourceStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  cycleAt: z.string().nullable(),
  forecastHour: z.number().int().nullable(),
  rawR2Key: z.string().nullable(),
  recordsWritten: z.number().int().nonnegative(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type SourceRun = z.infer<typeof SourceRunSchema>;

export const IngestResponseSchema = z.object({
  enqueued: z.boolean(),
  processed: z.boolean(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  region: z.literal("norcal"),
  sourceRuns: z.array(SourceRunSchema),
  caveats: z.array(z.string())
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

export const ReportResponseSchema = z.object({
  enabled: z.boolean(),
  generatedAt: z.string().nullable(),
  reportMarkdown: z.string().nullable(),
  reason: z.string().nullable(),
  sourceRunIds: z.array(z.string()).optional(),
  caveats: z.array(z.string()).optional()
});

export type ReportResponse = z.infer<typeof ReportResponseSchema>;
