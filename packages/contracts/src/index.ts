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
// the reference deployment's curated spots. Deployments validate membership
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
  aliases: z.array(z.string().min(1).max(80)).max(20).default([]),
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

export const CalibrationStatusSchema = z.enum([
  "modeled_uncalibrated",
  "proxy_uncalibrated",
  "cold_start_uncalibrated",
  "unavailable"
]);

export type CalibrationStatus = z.infer<typeof CalibrationStatusSchema>;

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
  calibrationStatus: CalibrationStatusSchema.optional(),
  activeCapabilities: z.array(SourceCapabilitySchema)
});

export type ForecastWindowInput = z.infer<typeof ForecastWindowInputSchema>;

export const ForecastIntervalSchema = z.enum(["1h", "3h"]);

export type ForecastInterval = z.infer<typeof ForecastIntervalSchema>;

export const WaveSemanticsSchema = z.enum([
  "direct_nearshore",
  "cove_proxy",
  "nws_fallback"
]);

export type WaveSemantics = z.infer<typeof WaveSemanticsSchema>;

export const FieldResolutionSchema = z.object({
  sourceIntervalMinutes: z.number().int().positive().nullable(),
  displayIntervalMinutes: z.number().int().positive(),
  method: z.enum(["exact", "held", "aggregated", "unavailable"]),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable()
});

export type FieldResolution = z.infer<typeof FieldResolutionSchema>;

export const WindowResolutionSchema = z.object({
  wave: FieldResolutionSchema,
  wind: FieldResolutionSchema,
  tide: FieldResolutionSchema
});

export type WindowResolution = z.infer<typeof WindowResolutionSchema>;

export const WaveStateSchema = z.object({
  semantics: WaveSemanticsSchema,
  calibrationStatus: CalibrationStatusSchema,
  validFrom: z.string(),
  validTo: z.string(),
  sourceResolutionHours: z.number().positive(),
  modeledNearshoreHeightFt: z.number().nonnegative().nullable(),
  breakingSurfHeightFt: z.number().nonnegative().nullable(),
  periodSec: z.number().nonnegative().nullable(),
  directionDeg: z.number().min(0).max(360).nullable()
});

export type WaveState = z.infer<typeof WaveStateSchema>;

export const SourceFreshnessSchema = z.object({
  capability: SourceCapabilitySchema,
  sourceId: z.string(),
  sourceRunId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  freshnessMinutes: z.number().nonnegative().nullable(),
  status: z.enum(["fresh", "stale", "missing"]),
  // Adapter-declared expectations (additive; absent on pre-cadence payloads).
  // The verdict below is derived exclusively from these shipped values.
  expectedCadenceMinutes: z.number().positive().nullable().optional(),
  graceMinutes: z.number().nonnegative().nullable().optional()
});

export type SourceFreshness = z.infer<typeof SourceFreshnessSchema>;

export const FRESHNESS_VERDICTS = ["fresh", "aging", "late"] as const;
export const FreshnessVerdictSchema = z.enum(FRESHNESS_VERDICTS);
export type FreshnessVerdict = z.infer<typeof FreshnessVerdictSchema>;

/**
 * The single freshness authority. Every surface — worker status, header
 * chip, banner, workbench — derives fresh | aging | late from this pure
 * function over the adapter-declared cadence shipped in the payload; no
 * client may re-judge freshness with thresholds of its own.
 *
 * Total by construction: a missing or invalid age or cadence yields "late"
 * (freshness cannot be proven), never NaN and never a throw. Negative ages
 * (clock skew) clamp to zero. Boundaries are inclusive: age equal to the
 * cadence is still fresh; age equal to cadence + grace is still aging.
 */
export function freshnessVerdict(input: {
  ageMinutes: number | null | undefined;
  expectedCadenceMinutes: number | null | undefined;
  graceMinutes?: number | null | undefined;
}): FreshnessVerdict {
  const cadence =
    typeof input.expectedCadenceMinutes === "number" &&
    Number.isFinite(input.expectedCadenceMinutes) &&
    input.expectedCadenceMinutes > 0
      ? input.expectedCadenceMinutes
      : null;
  const grace =
    typeof input.graceMinutes === "number" &&
    Number.isFinite(input.graceMinutes) &&
    input.graceMinutes >= 0
      ? input.graceMinutes
      : 0;
  const age =
    typeof input.ageMinutes === "number" && Number.isFinite(input.ageMinutes)
      ? Math.max(0, input.ageMinutes)
      : null;
  if (age === null || cadence === null) return "late";
  if (age <= cadence) return "fresh";
  if (age <= cadence + grace) return "aging";
  return "late";
}

/**
 * Verdict for one payload source entry. Entries materialized before cadence
 * declarations existed return null; callers keep the entry's shipped status
 * and must not substitute local thresholds.
 */
export function sourceFreshnessVerdict(entry: SourceFreshness): FreshnessVerdict | null {
  if (entry.expectedCadenceMinutes === null || entry.expectedCadenceMinutes === undefined) {
    return null;
  }
  return freshnessVerdict({
    ageMinutes: entry.freshnessMinutes,
    expectedCadenceMinutes: entry.expectedCadenceMinutes,
    graceMinutes: entry.graceMinutes
  });
}

/**
 * Fallback expectations for legacy wave ages that arrive without a per-source
 * entry (pre-cadence read models and provenance-only history rows). Preserves
 * the historical 360-minute fresh boundary while keeping the constant here so
 * no web module owns a freshness threshold.
 */
export const LEGACY_WAVE_FALLBACK_CADENCE_MINUTES = 240;
export const LEGACY_WAVE_FALLBACK_GRACE_MINUTES = 120;

export const TideEventSchema = z.object({
  stationId: z.string(),
  eventAt: z.string(),
  type: z.enum(["high", "low"]),
  heightFtMllw: z.number(),
  sourceRunId: z.string().nullable()
});

export type TideEvent = z.infer<typeof TideEventSchema>;

const ForecastHazardTimestampSchema = z.string().datetime({ offset: true });

export const ForecastHazardSchema = z
  .object({
    headline: z.string().min(1).max(500),
    startsAt: ForecastHazardTimestampSchema.nullable(),
    endsAt: ForecastHazardTimestampSchema.nullable(),
    sourceId: z.string().min(1).max(160),
    sourceRunId: z.string().nullable()
  })
  .superRefine((hazard, context) => {
    if (
      hazard.startsAt !== null &&
      hazard.endsAt !== null &&
      Date.parse(hazard.endsAt) <= Date.parse(hazard.startsAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "Forecast hazard end must follow its start"
      });
    }
  });

export type ForecastHazard = z.infer<typeof ForecastHazardSchema>;

export const SunPhasesSchema = z.object({
  localDate: z.string(),
  firstLight: z.string(),
  sunrise: z.string(),
  sunset: z.string(),
  lastLight: z.string()
});

export type SunPhases = z.infer<typeof SunPhasesSchema>;

export const ForecastIssueDeltaSchema = z.object({
  currentIssueId: z.string(),
  previousIssueId: z.string(),
  currentIssuedAt: z.string(),
  previousIssuedAt: z.string(),
  changedWindowCount: z.number().int().nonnegative()
});

export type ForecastIssueDelta = z.infer<typeof ForecastIssueDeltaSchema>;

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
  windGustKt: z.number().nonnegative().nullable().optional(),
  windDirectionDeg: z.number().min(0).max(360).nullable(),
  weatherSummary: z.string().nullable().optional(),
  surfaceCondition: z.enum(["clean", "fair", "choppy", "unknown"]).optional(),
  sourceFreshnessMinutes: z.number().nonnegative(),
  activeCapabilities: z.array(SourceCapabilitySchema),
  sourceRunIds: z.array(z.string()),
  caveats: z.array(z.string()),
  primarySwell: SwellComponentSchema.nullable(),
  secondarySwell: SwellComponentSchema.nullable(),
  waveProvenance: WaveProvenanceSchema.nullable(),
  waveState: WaveStateSchema.nullable().optional(),
  resolution: WindowResolutionSchema.optional(),
  sourceFreshness: z.array(SourceFreshnessSchema).optional()
});

export type ScoredForecastWindow = z.infer<typeof ScoredForecastWindowSchema>;

const ForecastRecommendationTimestampSchema = z.string().datetime({ offset: true });

export const ForecastRecommendationWindowSchema = z
  .object({
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    representative: ScoredForecastWindowSchema.extend({
      forecastAt: ForecastRecommendationTimestampSchema
    }),
    constituentWindowIds: z.array(ForecastRecommendationTimestampSchema).min(1).max(24),
    startAt: ForecastRecommendationTimestampSchema,
    endAt: ForecastRecommendationTimestampSchema
  })
  .superRefine((recommendation, context) => {
    const uniqueIds = new Set(recommendation.constituentWindowIds);
    if (uniqueIds.size !== recommendation.constituentWindowIds.length) {
      context.addIssue({
        code: "custom",
        path: ["constituentWindowIds"],
        message: "Recommendation constituent window IDs must be unique"
      });
    }
    if (!uniqueIds.has(recommendation.representative.forecastAt)) {
      context.addIssue({
        code: "custom",
        path: ["constituentWindowIds"],
        message: "Recommendation constituents must include the representative window"
      });
    }
    if (Date.parse(recommendation.endAt) <= Date.parse(recommendation.startAt)) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Recommendation end must follow its start"
      });
    }
  });

export type ForecastRecommendationWindow = z.infer<
  typeof ForecastRecommendationWindowSchema
>;

function localDateInTimeZone(value: string, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

export const ForecastResponseSchema = z
  .object({
    spot: SpotProfileSchema,
    windows: z.array(ScoredForecastWindowSchema),
    interval: ForecastIntervalSchema.optional(),
    generatedAt: z.string(),
    sourceNote: z.string(),
    observation: WaveObservationSummarySchema.nullable().optional(),
    observations: z.array(WaveObservationSummarySchema).optional(),
    tideEvents: z.array(TideEventSchema).optional(),
    hazards: z.array(ForecastHazardSchema).max(50).optional(),
    sunPhases: z.array(SunPhasesSchema).optional(),
    recommendations: z.array(ForecastRecommendationWindowSchema).max(10).optional(),
    issueDelta: ForecastIssueDeltaSchema.nullable().optional()
  })
  .superRefine((response, context) => {
    response.recommendations?.forEach((recommendation, recommendationIndex) => {
      const timestamps = [
        recommendation.representative.forecastAt,
        recommendation.startAt,
        recommendation.endAt,
        ...recommendation.constituentWindowIds
      ];
      if (
        timestamps.some(
          (timestamp) =>
            localDateInTimeZone(timestamp, response.spot.timezone) !== recommendation.localDate
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["recommendations", recommendationIndex, "localDate"],
          message: "Recommendation timestamps must match its local date in the spot timezone"
        });
      }
    });
  });

export type ForecastResponse = z.infer<typeof ForecastResponseSchema>;

export const ForecastBriefFactRefSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/i, "Fact references must be stable identifiers");

export const ForecastBriefPickSchema = z.object({
  windowId: z.string(),
  label: z.string(),
  why: z.string(),
  tradeoff: z.string(),
  factRefs: z.array(ForecastBriefFactRefSchema).min(1)
});

export const ForecastBriefBustFactorSchema = z.object({
  text: z.string(),
  factRefs: z.array(ForecastBriefFactRefSchema).min(1)
});

export const ForecastBriefLessonSchema = z.object({
  topic: z.string(),
  text: z.string(),
  factRefs: z.array(ForecastBriefFactRefSchema).min(1)
});

export const ForecastBriefSchema = z.object({
  schemaVersion: z.number().int().positive(),
  spotId: SpotIdSchema,
  localDate: z.string(),
  revision: z.number().int().positive(),
  inputFingerprint: z.string(),
  headline: z.string(),
  setup: z.string(),
  picks: z.array(ForecastBriefPickSchema).max(3),
  bustFactors: z.array(ForecastBriefBustFactorSchema).max(4),
  lesson: ForecastBriefLessonSchema,
  provider: z.enum(["google", "deterministic"]),
  modelId: z.string().nullable(),
  promptVersion: z.string(),
  generatedAt: z.string()
});

export type ForecastBrief = z.infer<typeof ForecastBriefSchema>;

export const ForecastBriefResponseSchema = z.object({
  status: z.enum(["model", "deterministic_fallback", "stale"]),
  brief: ForecastBriefSchema,
  fallbackReason: z.string().nullable(),
  availableRevisions: z.number().int().nonnegative()
});

export type ForecastBriefResponse = z.infer<typeof ForecastBriefResponseSchema>;

export const SurfAnalysisReportV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    spotId: SpotIdSchema,
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    revisionId: z.string().min(1).max(160),
    headline: z.string().min(1).max(180),
    paragraphs: z.array(z.string().min(1).max(1_200)).min(2).max(3),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export type SurfAnalysisReportV3 = z.infer<typeof SurfAnalysisReportV3Schema>;

export const SurfAnalysisPublishedResponseSchema = z
  .object({
    schemaVersion: z.literal(3),
    status: z.literal("published"),
    report: SurfAnalysisReportV3Schema,
    availableRevisions: z.number().int().nonnegative()
  })
  .strict();

export const SurfAnalysisPendingResponseSchema = z
  .object({
    schemaVersion: z.literal(3),
    status: z.literal("pending"),
    report: z.null(),
    message: z.literal("Analysis is being prepared."),
    availableRevisions: z.number().int().nonnegative()
  })
  .strict();

export const SurfAnalysisUnavailableResponseSchema = z
  .object({
    schemaVersion: z.literal(3),
    status: z.literal("unavailable"),
    report: z.null(),
    message: z.literal("Analysis unavailable"),
    detail: z.literal("No validated report is available for this forecast."),
    availableRevisions: z.number().int().nonnegative()
  })
  .strict();

export const SurfAnalysisResponseV3Schema = z.discriminatedUnion("status", [
  SurfAnalysisPublishedResponseSchema,
  SurfAnalysisPendingResponseSchema,
  SurfAnalysisUnavailableResponseSchema
]);

export type SurfAnalysisResponseV3 = z.infer<typeof SurfAnalysisResponseV3Schema>;
