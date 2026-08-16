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

export const NARRATIVE_PROTOCOL_FAMILY = "surf.narrative" as const;
export const NARRATIVE_PROTOCOL_VERSION = 1 as const;
// Increment this revision for a behavioral compatibility change that does not
// alter a JSON wire schema. Schema changes still require a new protocol
// version; this revision keeps non-schema semantics inside the fingerprint.
export const NARRATIVE_PROTOCOL_SEMANTIC_REVISION = 1 as const;
export const NARRATIVE_PROTOCOL_CAPABILITIES = [
  "openai-chat-completions",
  "json-schema"
] as const;

export const NarrativeProtocolDescriptorSchema = z
  .object({
    family: z.literal(NARRATIVE_PROTOCOL_FAMILY),
    version: z.literal(NARRATIVE_PROTOCOL_VERSION),
    semanticRevision: z.literal(NARRATIVE_PROTOCOL_SEMANTIC_REVISION),
    fingerprint: FingerprintSchema,
    wireSchemaVersions: z
      .object({
        job: z.literal(1),
        resultSubmission: z.literal(1),
        resultResponse: z.literal(1)
      })
      .strict(),
    capabilities: z.tuple([
      z.literal(NARRATIVE_PROTOCOL_CAPABILITIES[0]),
      z.literal(NARRATIVE_PROTOCOL_CAPABILITIES[1])
    ]),
    limits: z
      .object({
        jobBytes: z.literal(NARRATIVE_JOB_MAX_BYTES),
        resultBytes: z.literal(NARRATIVE_RESULT_MAX_BYTES)
      })
      .strict()
  })
  .strict();

export type NarrativeProtocolDescriptor = z.infer<
  typeof NarrativeProtocolDescriptorSchema
>;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJsonValue(nested)])
  );
}

/**
 * Canonical input for the protocol fingerprint. The fallback-watchdog schema
 * is intentionally excluded: it is a Worker-owned delayed-Queue contract, not
 * part of the Worker-to-runner job/result protocol.
 */
export function canonicalNarrativeProtocolDefinition(): string {
  return JSON.stringify(
    canonicalJsonValue({
      family: NARRATIVE_PROTOCOL_FAMILY,
      version: NARRATIVE_PROTOCOL_VERSION,
      semanticRevision: NARRATIVE_PROTOCOL_SEMANTIC_REVISION,
      wireSchemaVersions: {
        job: 1,
        resultSubmission: 1,
        resultResponse: 1
      },
      capabilities: NARRATIVE_PROTOCOL_CAPABILITIES,
      limits: {
        jobBytes: NARRATIVE_JOB_MAX_BYTES,
        resultBytes: NARRATIVE_RESULT_MAX_BYTES
      },
      wireSchemas: {
        job: z.toJSONSchema(NarrativeJobSchema),
        resultSubmission: z.toJSONSchema(NarrativeResultSubmissionSchema),
        resultResponse: z.toJSONSchema(NarrativeResultResponseSchema)
      }
    })
  );
}

// This checked golden is intentionally static. Tests recompute SHA-256 from
// canonicalNarrativeProtocolDefinition(), so a wire or semantic change cannot
// silently retain the old compatibility identity.
export const NARRATIVE_PROTOCOL_FINGERPRINT =
  "3956bce39909ae82fd1e81591698f1ecc7c28d6b05f9a2a53e99f5a80218f041" as const;

export const NARRATIVE_PROTOCOL_DESCRIPTOR: NarrativeProtocolDescriptor =
  NarrativeProtocolDescriptorSchema.parse({
    family: NARRATIVE_PROTOCOL_FAMILY,
    version: NARRATIVE_PROTOCOL_VERSION,
    semanticRevision: NARRATIVE_PROTOCOL_SEMANTIC_REVISION,
    fingerprint: NARRATIVE_PROTOCOL_FINGERPRINT,
    wireSchemaVersions: {
      job: 1,
      resultSubmission: 1,
      resultResponse: 1
    },
    capabilities: NARRATIVE_PROTOCOL_CAPABILITIES,
    limits: {
      jobBytes: NARRATIVE_JOB_MAX_BYTES,
      resultBytes: NARRATIVE_RESULT_MAX_BYTES
    }
  });

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
