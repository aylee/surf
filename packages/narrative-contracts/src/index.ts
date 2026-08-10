import { z } from "zod";

// Cloudflare Queues bills in decimal 64,000-byte chunks and adds message
// metadata. Keep the serialized application envelope below 60,000 bytes so a
// normal job remains one billed chunk after transport overhead.
export const NARRATIVE_JOB_MAX_BYTES = 60_000;
export const NARRATIVE_RESULT_MAX_BYTES = 64 * 1024;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/i);
const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
// D1 deadline predicates compare stored timestamps lexicographically. Require
// the one canonical representation emitted by Date#toISOString so equivalent
// instants with offsets or mixed precision cannot be misordered.
const IsoTimestampSchema = z.string().datetime({ offset: false, precision: 3 });
const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const NarrativeProviderIdSchema = IdentifierSchema;
export const NarrativeInferenceRouteSchema = z.enum(["primary", "fallback"]);
export type NarrativeInferenceRoute = z.infer<typeof NarrativeInferenceRouteSchema>;

export const NarrativeMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(48_000)
  })
  .strict();

export const NarrativeJobSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: IdentifierSchema,
    domain: IdentifierSchema,
    entity: z
      .object({
        id: IdentifierSchema,
        localDate: LocalDateSchema
      })
      .strict(),
    factFingerprint: FingerprintSchema,
    materialFingerprint: FingerprintSchema,
    generationFingerprint: FingerprintSchema,
    promptVersion: IdentifierSchema,
    outputSchemaVersion: z.number().int().positive().max(10_000),
    deadlineAt: IsoTimestampSchema,
    capability: z
      .object({
        protocol: z.literal("openai-chat-completions"),
        structuredOutput: z.literal("json-schema")
      })
      .strict(),
    result: z
      .object({
        target: IdentifierSchema,
        submissionId: IdentifierSchema
      })
      .strict(),
    inference: z
      .object({
        messages: z.array(NarrativeMessageSchema).min(2).max(8),
        responseSchema: JsonObjectSchema,
        maxOutputTokens: z.number().int().min(64).max(8_192),
        temperature: z.number().min(0).max(2)
      })
      .strict()
  })
  .strict();

export type NarrativeJob = z.infer<typeof NarrativeJobSchema>;

export const NarrativeGeneratedResultSubmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: IdentifierSchema,
    submissionId: IdentifierSchema,
    providerId: NarrativeProviderIdSchema,
    route: NarrativeInferenceRouteSchema,
    modelId: z.string().min(1).max(200),
    output: JsonValueSchema
  })
  .strict();

export type NarrativeGeneratedResultSubmission = z.infer<
  typeof NarrativeGeneratedResultSubmissionSchema
>;

export const NarrativeTerminalReasonCodeSchema = z.enum([
  "job_expired",
  "deadline_budget_insufficient",
  "inference_output_invalid",
  "inference_request_rejected"
]);
export type NarrativeTerminalReasonCode = z.infer<typeof NarrativeTerminalReasonCodeSchema>;

export const NarrativeTerminalResultSubmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: IdentifierSchema,
    submissionId: IdentifierSchema,
    terminal: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("expired"),
          reasonCode: z.literal("job_expired")
        })
        .strict(),
      z
        .object({
          status: z.literal("rejected"),
          reasonCode: z.enum([
            "deadline_budget_insufficient",
            "inference_output_invalid",
            "inference_request_rejected"
          ])
        })
        .strict()
    ])
  })
  .strict();
export type NarrativeTerminalResultSubmission = z.infer<
  typeof NarrativeTerminalResultSubmissionSchema
>;

export const NarrativeResultSubmissionSchema = z.union([
  NarrativeGeneratedResultSubmissionSchema,
  NarrativeTerminalResultSubmissionSchema
]);
export type NarrativeResultSubmission = z.infer<typeof NarrativeResultSubmissionSchema>;

export const NarrativeResultDispositionSchema = z.enum([
  "published",
  "duplicate",
  "fallback_requested",
  "fallback_failed",
  "rejected",
  "expired",
  "superseded"
]);
export type NarrativeResultDisposition = z.infer<typeof NarrativeResultDispositionSchema>;

export const NarrativeResultResponseSchema = z
  .object({
    disposition: NarrativeResultDispositionSchema,
    jobId: IdentifierSchema
  })
  .strict();
export type NarrativeResultResponse = z.infer<typeof NarrativeResultResponseSchema>;

export const NarrativeFallbackWatchdogSchema = z
  .object({
    schemaVersion: z.literal(1),
    job: z.literal("narrative-fallback-watchdog"),
    jobId: IdentifierSchema,
    submissionId: IdentifierSchema,
    eligibleAt: IsoTimestampSchema,
    trigger: z.enum(["delayed_watchdog", "primary_validation_failed"]),
    preclaimRetryCount: z.number().int().min(0).max(1)
  })
  .strict();
export type NarrativeFallbackWatchdog = z.infer<typeof NarrativeFallbackWatchdogSchema>;

export function serializedNarrativeJobBytes(job: NarrativeJob): number {
  return new TextEncoder().encode(JSON.stringify(NarrativeJobSchema.parse(job))).byteLength;
}

export function assertNarrativeJobSize(job: NarrativeJob): NarrativeJob {
  const parsed = NarrativeJobSchema.parse(job);
  const bytes = serializedNarrativeJobBytes(parsed);
  if (bytes > NARRATIVE_JOB_MAX_BYTES) {
    throw new Error(`Narrative job is ${bytes} bytes; maximum is ${NARRATIVE_JOB_MAX_BYTES}`);
  }
  return parsed;
}

export function serializedNarrativeResultBytes(result: NarrativeResultSubmission): number {
  return new TextEncoder().encode(JSON.stringify(NarrativeResultSubmissionSchema.parse(result)))
    .byteLength;
}

export function assertNarrativeResultSize(
  result: NarrativeResultSubmission
): NarrativeResultSubmission {
  const parsed = NarrativeResultSubmissionSchema.parse(result);
  const bytes = serializedNarrativeResultBytes(parsed);
  if (bytes > NARRATIVE_RESULT_MAX_BYTES) {
    throw new Error(`Narrative result is ${bytes} bytes; maximum is ${NARRATIVE_RESULT_MAX_BYTES}`);
  }
  return parsed;
}
