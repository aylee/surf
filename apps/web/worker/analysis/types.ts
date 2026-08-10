import { SurfAnalysisReportV3Schema } from "@surf/contracts";
import { z } from "zod";
import { ForecastFactSchema } from "../brief/types";

export const SURF_ANALYSIS_PROMPT_VERSION = "surf-analysis-v3-natural-3" as const;
export const SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION = 4 as const;
export const SURF_ANALYSIS_RESULT_TARGET = "surf.analysis.v3" as const;

const FactRefSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/i);
function analysisBlockSchema(minLength: number) {
  return z
  .object({
    template: z.string().min(minLength).max(1_000)
  })
  .strict();
}

export const SurfAnalysisBlockSchema = analysisBlockSchema(1);
const SurfAnalysisSetupBlockSchema = analysisBlockSchema(60);
const SurfAnalysisPlanBlockSchema = analysisBlockSchema(145);
const SurfAnalysisConfidenceBlockSchema = analysisBlockSchema(70);

export const SurfAnalysisDraftV3Schema = z
  .object({
    paragraphs: z
      .object({
        setup: SurfAnalysisSetupBlockSchema,
        plan: SurfAnalysisPlanBlockSchema,
        confidence: SurfAnalysisConfidenceBlockSchema
      })
      .strict()
  })
  .strict();

export type SurfAnalysisDraftV3 = z.infer<typeof SurfAnalysisDraftV3Schema>;
export type SurfAnalysisBlockName = "headline" | "setup" | "plan" | "confidence";

export const SurfAnalysisValueSlotSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z_]*$/),
    value: z.string().min(1).max(500),
    description: z.string().min(1).max(240),
    block: z.enum(["headline", "setup", "plan", "confidence"]),
    factRefs: z.array(FactRefSchema).min(1).max(12),
    required: z.boolean()
  })
  .strict();

export type SurfAnalysisValueSlot = z.infer<typeof SurfAnalysisValueSlotSchema>;

export const SurfAnalysisValidationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    spotId: z.string().min(1).max(80),
    spotName: z.string().min(1).max(120),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    factFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    materialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    deadlineAt: z.string().datetime({ offset: true }),
    recommendationWindowIds: z.array(z.string().min(1).max(160)).max(3),
    facts: z.array(ForecastFactSchema).min(1).max(320),
    slots: z.array(SurfAnalysisValueSlotSchema).min(8).max(20),
    allowedFactRefs: z
      .object({
        headline: z.array(FactRefSchema),
        setup: z.array(FactRefSchema),
        plan: z.array(FactRefSchema),
        confidence: z.array(FactRefSchema)
      })
      .strict()
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
    usedSlotIds: z.array(z.string().regex(/^[a-z][a-z_]*$/))
  })
  .strict();

export type SurfAnalysisValidation = z.infer<typeof SurfAnalysisValidationSchema>;

export { SurfAnalysisReportV3Schema };
