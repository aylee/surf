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
  notes: z.string()
});

export type SpotProfile = z.infer<typeof SpotProfileSchema>;

export const ForecastWindowInputSchema = z.object({
  spotId: SpotIdSchema,
  forecastAt: z.string(),
  waveHeightFt: z.number().nonnegative(),
  peakPeriodSec: z.number().nonnegative(),
  primaryDirectionDeg: z.number().min(0).max(360),
  tideFt: z.number(),
  windSpeedKt: z.number().nonnegative(),
  windDirectionDeg: z.number().min(0).max(360),
  sourceFreshnessMinutes: z.number().nonnegative(),
  activeCapabilities: z.array(SourceCapabilitySchema)
});

export type ForecastWindowInput = z.infer<typeof ForecastWindowInputSchema>;

export const QualityLabelSchema = z.enum([
  "poor",
  "fair",
  "fun",
  "good",
  "excellent"
]);

export type QualityLabel = z.infer<typeof QualityLabelSchema>;

export const SurfScoreSchema = z.object({
  spotId: SpotIdSchema,
  forecastAt: z.string(),
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

export const ForecastResponseSchema = z.object({
  spot: SpotProfileSchema,
  windows: z.array(SurfScoreSchema),
  generatedAt: z.string(),
  sourceNote: z.string()
});

export type ForecastResponse = z.infer<typeof ForecastResponseSchema>;

export const ReportResponseSchema = z.object({
  enabled: z.boolean(),
  generatedAt: z.string().nullable(),
  reportMarkdown: z.string().nullable(),
  reason: z.string().nullable()
});

export type ReportResponse = z.infer<typeof ReportResponseSchema>;

