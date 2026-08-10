import { SurfAnalysisReportV3Schema } from "@surf/contracts";
import { z } from "zod";
import { ForecastFactSchema } from "../brief/types";
import { SURF_ANALYSIS_RESULT_TARGET } from "./runtime-constants.mjs";

export const SURF_ANALYSIS_PROMPT_VERSION = "surf-analysis-v5-editorial-1" as const;
export const SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION = 6 as const;
export { SURF_ANALYSIS_RESULT_TARGET };

export const SurfAnalysisCardIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/i);

export const SurfAnalysisPlanV5Schema = z
  .object({
    schemaVersion: z.literal(1),
    outlook: z
      .object({
        leadCardId: SurfAnalysisCardIdSchema,
        supportingCardId: SurfAnalysisCardIdSchema
      })
      .strict(),
    call: z
      .object({
        primarySupportCardId: SurfAnalysisCardIdSchema.nullable(),
        primaryTradeoffCardId: SurfAnalysisCardIdSchema.nullable(),
        alternateCardId: SurfAnalysisCardIdSchema.nullable()
      })
      .strict(),
    close: z
      .object({
        watchCardId: SurfAnalysisCardIdSchema
      })
      .strict()
  })
  .strict();

export type SurfAnalysisPlanV5 = z.infer<typeof SurfAnalysisPlanV5Schema>;

// Transitional aliases avoid widening the repository/fallback change. The
// output is now an editorial plan, not model-authored prose.
export const SurfAnalysisDraftV4Schema = SurfAnalysisPlanV5Schema;
export type SurfAnalysisDraftV4 = SurfAnalysisPlanV5;
export const SurfAnalysisDraftV3Schema = SurfAnalysisPlanV5Schema;
export type SurfAnalysisDraftV3 = SurfAnalysisPlanV5;

export const SurfAnalysisClaimNameSchema = z.enum([
  "headline",
  "outlook_wave",
  "outlook_surface",
  "primary",
  "alternate",
  "confidence"
]);
export type SurfAnalysisClaimName = z.infer<typeof SurfAnalysisClaimNameSchema>;

export const SurfAnalysisDomainSchema = z.enum([
  "recommendation",
  "wave",
  "surface",
  "wind",
  "tide",
  "confidence",
  "source"
]);
export type SurfAnalysisDomain = z.infer<typeof SurfAnalysisDomainSchema>;

const FactRefSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/i);

/** Code-owned values used by code-owned render templates. */
export const SurfAnalysisValueSlotSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z_]*$/),
    value: z.string().min(1).max(600),
    description: z.string().min(1).max(320),
    claim: SurfAnalysisClaimNameSchema,
    factRefs: z.array(FactRefSchema).min(1).max(64),
    domains: z.array(SurfAnalysisDomainSchema).min(1).max(4),
    syntax: z.enum(["headline", "noun_phrase", "predicate", "clause", "sentence"]),
    authorship: z.literal("code"),
    required: z.boolean()
  })
  .strict();

export type SurfAnalysisValueSlot = z.infer<typeof SurfAnalysisValueSlotSchema>;

export const SurfAnalysisCardPlacementSchema = z.enum([
  "outlook",
  "primary_support",
  "primary_tradeoff",
  "alternate",
  "watch"
]);
export type SurfAnalysisCardPlacement = z.infer<typeof SurfAnalysisCardPlacementSchema>;

/**
 * A card is a complete, code-authored editorial option. The model may select
 * only its ID. Its rendered preview, prose template, and provenance are all
 * fingerprinted in the validation snapshot.
 */
export const SurfAnalysisEditorialCardSchema = z
  .object({
    id: SurfAnalysisCardIdSchema,
    placement: SurfAnalysisCardPlacementSchema,
    stance: z.enum(["support", "tradeoff", "context"]),
    semanticKey: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9:._-]*$/i),
    windowId: z.string().min(1).max(160).nullable(),
    template: z.string().min(1).max(1_200),
    preview: z.string().min(1).max(1_200),
    factRefs: z.array(FactRefSchema).min(1).max(64),
    domains: z.array(SurfAnalysisDomainSchema).min(1).max(4)
  })
  .strict();

export type SurfAnalysisEditorialCard = z.infer<typeof SurfAnalysisEditorialCardSchema>;

const AllowedFactRefsSchema = z
  .object({
    headline: z.array(FactRefSchema),
    outlook_wave: z.array(FactRefSchema),
    outlook_surface: z.array(FactRefSchema),
    primary: z.array(FactRefSchema),
    alternate: z.array(FactRefSchema),
    confidence: z.array(FactRefSchema)
  })
  .strict();

export const SurfAnalysisValidationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(3),
    spotId: z.string().min(1).max(80),
    spotName: z.string().min(1).max(120),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    factFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    materialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    deadlineAt: z.string().datetime({ offset: true }),
    recommendationWindowIds: z.array(z.string().min(1).max(160)).max(3),
    callMode: z.enum(["primary_only", "primary_and_alternate"]),
    facts: z.array(ForecastFactSchema).min(1).max(320),
    slots: z.array(SurfAnalysisValueSlotSchema).min(7).max(24),
    cards: z.array(SurfAnalysisEditorialCardSchema).min(5).max(48),
    allowedFactRefs: AllowedFactRefsSchema
  })
  .strict();

export type SurfAnalysisValidationSnapshot = z.infer<
  typeof SurfAnalysisValidationSnapshotSchema
>;

export const SurfAnalysisValidationSchema = z
  .object({
    valid: z.literal(true),
    checkedAt: z.string().datetime({ offset: true }),
    referencedFactIds: z.array(FactRefSchema),
    usedCardIds: z.array(SurfAnalysisCardIdSchema),
    claimRefs: z.array(
      z
        .object({
          path: z.string().min(1).max(160),
          factRefs: z.array(FactRefSchema).min(1).max(64)
        })
        .strict()
    )
  })
  .strict();

export type SurfAnalysisValidation = z.infer<typeof SurfAnalysisValidationSchema>;

export { SurfAnalysisReportV3Schema };
