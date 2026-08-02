import {
  ForecastBriefResponseSchema,
  ForecastBriefSchema,
  type ForecastBrief,
  type ForecastBriefResponse
} from "@surf/contracts";
import { z } from "zod";

export {
  ForecastBriefResponseSchema,
  ForecastBriefSchema,
  type ForecastBrief,
  type ForecastBriefResponse
};

export const FORECAST_BRIEF_SCHEMA_VERSION = 1 as const;
export const FORECAST_BRIEF_PROMPT_VERSION = "surf-brief-v1" as const;
export const FORECAST_BRIEF_MODEL_ID = "gemini-3.6-flash" as const;

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const IsoTimestampSchema = z.string().datetime({ offset: true });
const FactIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/i, "Fact IDs must be stable identifiers");

export const ForecastBriefDraftSchema = z
  .object({
    headline: z.string().min(1).max(220),
    setup: z.string().min(1).max(500),
    picks: z
      .array(
        z
          .object({
            windowId: z.string().min(1).max(160),
            label: z.string().min(1).max(100),
            why: z.string().min(1).max(420),
            tradeoff: z.string().min(1).max(420),
            factRefs: z.array(FactIdSchema).min(1).max(12)
          })
          .strict()
      )
      .max(3),
    bustFactors: z
      .array(
        z
          .object({
            text: z.string().min(1).max(420),
            factRefs: z.array(FactIdSchema).min(1).max(12)
          })
          .strict()
      )
      .min(1)
      .max(4),
    lesson: z
      .object({
        topic: z.string().min(1).max(80),
        text: z.string().min(1).max(420),
        factRefs: z.array(FactIdSchema).min(1).max(12)
      })
      .strict()
  })
  .strict();

export type ForecastBriefDraft = z.infer<typeof ForecastBriefDraftSchema>;

export const ForecastBriefWindowInputSchema = z
  .object({
    windowId: z.string().min(1).max(160),
    forecastAt: IsoTimestampSchema,
    validFrom: IsoTimestampSchema,
    validTo: IsoTimestampSchema,
    isDaylight: z.boolean(),
    ratingStatus: z.enum(["scored", "unknown"]),
    surfaceCondition: z.enum(["clean", "fair", "choppy", "unknown"]),
    qualityLabel: z.enum(["unknown", "poor", "fair", "fun", "good", "excellent"]),
    score: z.number().int().min(0).max(100),
    confidence: z.number().int().min(0).max(100),
    confidenceBand: z.enum(["low", "medium", "high"]),
    modeledHeightFt: z.number().nonnegative().nullable(),
    modeledHeightLabel: z.string().min(1).max(40).nullable(),
    waveSemantics: z.enum(["direct_nearshore", "cove_proxy", "nws_fallback", "unavailable"]),
    calibrationStatus: z.enum([
      "modeled_uncalibrated",
      "proxy_uncalibrated",
      "cold_start_uncalibrated",
      "unavailable"
    ]),
    peakPeriodSec: z.number().nonnegative().nullable(),
    primaryDirectionDeg: z.number().min(0).max(360).nullable(),
    windSpeedKt: z.number().nonnegative().nullable(),
    windGustKt: z.number().nonnegative().nullable(),
    windRelation: z.enum(["offshore", "cross-shore", "onshore", "variable", "unknown"]),
    tideFt: z.number().nullable(),
    tideTrend: z.enum(["rising", "falling", "steady", "unknown"]).nullable(),
    activeCapabilities: z.array(z.string().min(1).max(80)).max(16),
    caveats: z.array(z.string().min(1).max(500)).max(16),
    sourceFreshnessMinutes: z.number().nonnegative().nullable(),
    requiredSourceStatus: z.enum(["fresh", "stale", "missing", "unknown"])
  })
  .strict();

export type ForecastBriefWindowInput = z.infer<typeof ForecastBriefWindowInputSchema>;

export const ForecastBriefInputSchema = z
  .object({
    spotId: z.string().min(1).max(80),
    spotName: z.string().min(1).max(120),
    timezone: z.string().min(1).max(80),
    localDate: IsoDateSchema,
    generatedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema.nullable(),
    recommendationWindowIds: z.array(z.string().min(1).max(160)).max(3),
    windows: z.array(ForecastBriefWindowInputSchema).min(1).max(48),
    activeHazards: z.array(z.string().min(1).max(500)).max(12),
    sourceHealth: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(120),
            status: z.enum(["fresh", "stale", "missing"]),
            ageMinutes: z.number().nonnegative().nullable()
          })
          .strict()
      )
      .max(32),
    observation: z
      .object({
        stationId: z.string().min(1).max(120),
        observedAt: IsoTimestampSchema,
        waveHeightFt: z.number().nonnegative(),
        dominantPeriodSec: z.number().nonnegative().nullable(),
        directionDeg: z.number().min(0).max(360).nullable(),
        ageMinutes: z.number().nonnegative()
      })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((input, context) => {
    const ids = new Set(input.windows.map((window) => window.windowId));
    const uniqueRecommendations = new Set(input.recommendationWindowIds);
    if (uniqueRecommendations.size !== input.recommendationWindowIds.length) {
      context.addIssue({ code: "custom", message: "Recommendation window IDs must be unique" });
    }
    for (const windowId of input.recommendationWindowIds) {
      if (!ids.has(windowId)) {
        context.addIssue({
          code: "custom",
          message: `Recommendation window ${windowId} is not present in windows`
        });
      }
    }
  });

export type ForecastBriefInput = z.infer<typeof ForecastBriefInputSchema>;

export const ForecastFactSchema = z
  .object({
    id: FactIdSchema,
    kind: z.enum([
      "spot",
      "recommendation",
      "condition",
      "wave",
      "wind",
      "tide",
      "confidence",
      "source",
      "hazard",
      "observation",
      "caveat"
    ]),
    statement: z.string().min(1).max(600),
    windowId: z.string().min(1).max(160).nullable(),
    material: z.boolean()
  })
  .strict();

export type ForecastFact = z.infer<typeof ForecastFactSchema>;

export const ForecastFactBundleSchema = z
  .object({
    schemaVersion: z.literal(FORECAST_BRIEF_SCHEMA_VERSION),
    input: ForecastBriefInputSchema,
    facts: z.array(ForecastFactSchema).min(1).max(320),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    materialFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export type ForecastFactBundle = z.infer<typeof ForecastFactBundleSchema>;

export const ForecastBriefValidationSchema = z
  .object({
    valid: z.literal(true),
    checkedAt: IsoTimestampSchema,
    referencedFactIds: z.array(FactIdSchema)
  })
  .strict();

export type ForecastBriefValidation = z.infer<typeof ForecastBriefValidationSchema>;
