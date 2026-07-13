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

// Spot identifiers are part of the public data contract, not a closed list of
// the reference deployment's six spots. Deployments validate membership
// against their configured registry at the API boundary.
export const SpotIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Spot IDs must be lowercase kebab-case slugs");

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
  notes: z.string()
});

export type SpotProfile = z.infer<typeof SpotProfileSchema>;

export const SpotSourceSummarySchema = z.object({
  nwsWaveGrid: z.object({
    provider: z.string(),
    forecastGridData: z.string().url(),
    breakingHeightScale: z.number().positive(),
    notes: z.string()
  }),
  observedWave: z.array(
    z.object({
      provider: z.string(),
      stationId: z.string(),
      name: z.string()
    })
  ),
  coopsTide: z.object({
    stationId: z.string(),
    name: z.string()
  })
});

export const ApiSpotSchema = SpotProfileSchema.extend({
  sourceMap: SpotSourceSummarySchema
});

export type ApiSpot = z.infer<typeof ApiSpotSchema>;

export const SpotsResponseSchema = z.object({
  spots: z.array(ApiSpotSchema),
  sourceNote: z.string()
});

export type SpotsResponse = z.infer<typeof SpotsResponseSchema>;

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
  exposureScale: z.number().positive().optional(),
  shoalingFactor: z.number().positive().optional(),
  totalHeightFactor: z.number().positive().optional(),
  breakerIndex: z.number().min(0.5).max(1).optional(),
  breakingDepthM: z.number().positive().optional(),
  incidenceAngleDeg: z.number().min(0).max(180).optional(),
  experimentalBreakingHeightFt: z.number().nonnegative().nullable().optional(),
  transformMethod: z.literal("linear-energy-flux-snell-depth-limited").optional(),
  transformVersion: z.literal("bulk-hs-linear-shoaling-v1").optional(),
  estimatedBreakingHeightFt: z.number().nonnegative().nullable(),
  modeledNearshoreSignificantHeightFt: z.number().nonnegative().nullable().optional(),
  heightSemantics: z.enum([
    "estimated_breaking_height",
    "modeled_significant_wave_height_not_breaking_face_height"
  ]).optional(),
  modelPointId: z.string().optional(),
  modelPointWaterDepthM: z.number().positive().optional(),
  modelPointShoreNormalDeg: z.number().min(0).max(360).optional(),
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
