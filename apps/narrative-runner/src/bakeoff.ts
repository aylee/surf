import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  NARRATIVE_JOB_MAX_BYTES,
  serializedNarrativeJobBytes,
  type NarrativeJob
} from "@surf/narrative-contracts";
import { z } from "zod";
import {
  SURF_ANALYSIS_RESPONSE_JSON_SCHEMA,
  buildSurfAnalysisSnapshot,
  buildSurfNarrativeJob
} from "../../web/worker/analysis/snapshot";
import {
  SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
  SURF_ANALYSIS_PROMPT_VERSION,
  SurfAnalysisPlanV5Schema
} from "../../web/worker/analysis/types";
import { renderSurfAnalysisReport } from "../../web/worker/analysis/renderer";
import { validateSurfAnalysisDraft } from "../../web/worker/analysis/validator";
import {
  ForecastFactBundleSchema,
  type ForecastFactBundle
} from "../../web/worker/brief/types";
import {
  redactedBakeoffConfig,
  resolveEndpointToken,
  type BakeoffConfig,
  type BakeoffModel
} from "./bakeoff-config";
import { readBoundedJson, ResponseBodyTooLargeError } from "./bounded-json";

export const BAKEOFF_ARTIFACT_VERSION = 1 as const;
export const BAKEOFF_THINKING_ENABLED = false as const;
export const BAKEOFF_REQUEST_MAX_BYTES = 128 * 1_024;
export const BAKEOFF_JUDGE_PROMPT_VERSION =
  "analysis-bakeoff-judge-v2-consistent-scores" as const;
const BAKEOFF_JUDGE_REQUEST_CONTRACT = {
  responseSchemaName: "analysis_bakeoff_pairwise_judge_v4",
  maxOutputTokens: 700,
  temperature: 0,
  enableThinking: BAKEOFF_THINKING_ENABLED,
  stream: false
} as const;
const BAKEOFF_JUDGE_SYSTEM_PROMPT =
  "You are a blinded pairwise editorial judge for a local surf forecast. Both candidates already passed the absolute deterministic production schema, card-selection, provenance, and renderer gates. The user payload explicitly marks code-owned recommendation order, values, facts, card previews/templates, and evidence as authoritative: never dispute, recompute, or call those measurements, times, or claims hallucinations. Score only how well each rendered report selects and sequences the supplied editorial cards. Score A and B independently from 1 (poor) to 5 (excellent) on every requested rubric field, then compare usefulness to a surfer, natural forecaster voice, clarity of the primary/alternate call, synthesis instead of inventory, factual fidelity to the authoritative frame, and lack of repetition. Candidate labels are randomized and contain no model identity. Return one strict JSON object, never an array. Use each reason code at most once. Use tie_equivalent if and only if winner is tie; a winner of A or B requires at least one non-tie reason code. The rationale must be one or more complete sentences ending in punctuation. Choose tie when neither is materially better.";

const UsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().nullable().optional(),
    completion_tokens: z.number().int().nonnegative().nullable().optional(),
    total_tokens: z.number().int().nonnegative().nullable().optional()
  })
  .passthrough();

const CompletionSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().min(1) }).passthrough()
          })
          .passthrough()
      )
      .min(1),
    usage: UsageSchema.optional()
  })
  .passthrough();

const ModelListSchema = z
  .object({
    data: z.array(z.object({ id: z.string().min(1) }).passthrough())
  })
  .passthrough();

const JudgeRubricScoresSchema = z
  .object({
    actionableSessionCall: z.number().int().min(1).max(5),
    daylightEvolutionClarity: z.number().int().min(1).max(5),
    reasonAndTradeoff: z.number().int().min(1).max(5),
    primaryAlternateDistinction: z.number().int().min(1).max(5),
    uncertaintyCalibration: z.number().int().min(1).max(5),
    naturalForecasterVoice: z.number().int().min(1).max(5),
    concisionAndNonRepetition: z.number().int().min(1).max(5),
    factualFidelity: z.number().int().min(1).max(5)
  })
  .strict();

const JUDGE_RUBRIC_KEYS = [
  "actionableSessionCall",
  "daylightEvolutionClarity",
  "reasonAndTradeoff",
  "primaryAlternateDistinction",
  "uncertaintyCalibration",
  "naturalForecasterVoice",
  "concisionAndNonRepetition",
  "factualFidelity"
] as const;

const JudgeDecisionSchema = z
  .object({
    winner: z.enum(["A", "B", "tie"]),
    reasonCodes: z
      .array(
        z.enum([
          "more_useful",
          "more_natural",
          "clearer_call",
          "better_synthesis",
          "less_repetitive",
          "material_problem",
          "tie_equivalent"
        ])
      )
      .min(1)
      .max(3)
      .refine((reasonCodes) => new Set(reasonCodes).size === reasonCodes.length, {
        message: "reason codes must be unique"
      }),
    scores: z
      .object({
        A: JudgeRubricScoresSchema,
        B: JudgeRubricScoresSchema
      })
      .strict(),
    rationale: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .regex(/[A-Za-z0-9]/, "rationale must contain an explanatory word")
      .regex(/[.!?](?:["')\]]+)?$/u, "rationale must end as a complete sentence")
  })
  .strict()
  .superRefine((decision, context) => {
    const hasTieReason = decision.reasonCodes.includes("tie_equivalent");
    const hasPreferenceReason = decision.reasonCodes.some(
      (reasonCode) => reasonCode !== "tie_equivalent"
    );
    if (decision.winner === "tie" && (!hasTieReason || hasPreferenceReason)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCodes"],
        message: "tie winner requires only tie_equivalent"
      });
    }
    if (decision.winner !== "tie" && (hasTieReason || !hasPreferenceReason)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCodes"],
        message: "A or B winner requires non-tie reason codes and forbids tie_equivalent"
      });
    }
  });

export function parseBakeoffJudgeDecision(value: unknown) {
  return JudgeDecisionSchema.parse(value);
}

export const BAKEOFF_JUDGE_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["winner", "reasonCodes", "scores", "rationale"],
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    reasonCodes: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: {
        type: "string",
        enum: [
          "more_useful",
          "more_natural",
          "clearer_call",
          "better_synthesis",
          "less_repetitive",
          "material_problem",
          "tie_equivalent"
        ]
      }
    },
    scores: {
      type: "object",
      additionalProperties: false,
      required: ["A", "B"],
      properties: {
        A: { $ref: "#/$defs/rubricScores" },
        B: { $ref: "#/$defs/rubricScores" }
      }
    },
    rationale: {
      type: "string",
      minLength: 1,
      maxLength: 600,
      pattern: "[A-Za-z0-9][\\s\\S]*[.!?](?:[\\\"')\\]]+)?$"
    }
  },
  $defs: {
    rubricScores: {
      type: "object",
      additionalProperties: false,
      required: [
        "actionableSessionCall",
        "daylightEvolutionClarity",
        "reasonAndTradeoff",
        "primaryAlternateDistinction",
        "uncertaintyCalibration",
        "naturalForecasterVoice",
        "concisionAndNonRepetition",
        "factualFidelity"
      ],
      properties: {
        actionableSessionCall: { type: "integer", minimum: 1, maximum: 5 },
        daylightEvolutionClarity: { type: "integer", minimum: 1, maximum: 5 },
        reasonAndTradeoff: { type: "integer", minimum: 1, maximum: 5 },
        primaryAlternateDistinction: { type: "integer", minimum: 1, maximum: 5 },
        uncertaintyCalibration: { type: "integer", minimum: 1, maximum: 5 },
        naturalForecasterVoice: { type: "integer", minimum: 1, maximum: 5 },
        concisionAndNonRepetition: { type: "integer", minimum: 1, maximum: 5 },
        factualFidelity: { type: "integer", minimum: 1, maximum: 5 }
      }
    }
  }
} as const;

type Usage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

type Completion = {
  content: string;
  latencyMs: number;
  usage: Usage;
  reportedModel: string | null;
};

export type PreparedBakeoffCase = {
  sequence: number;
  caseId: string;
  bundle: ForecastFactBundle;
  snapshot: Awaited<ReturnType<typeof buildSurfAnalysisSnapshot>>;
  job: NarrativeJob;
};

export type UnavailableBakeoffBundle = {
  sequence: number;
  spotId: string;
  localDate: string;
  generatedAt: string;
  inputFingerprint: string;
  materialFingerprint: string;
  reasonCode: "analysis_no_recommendation" | "analysis_snapshot_invalid";
  errorMessage?: string;
};

export type BakeoffCallPlan = {
  cases: number;
  preflightRequests: number;
  generatorCalls: number;
  candidatePairs: number;
  judgeCallsUpperBound: number;
  totalCallsUpperBound: number;
  totalHttpRequestsUpperBound: number;
};

export type CandidateResult = {
  callIndex: number;
  candidateId: string;
  caseId: string;
  spotId: string;
  localDate: string;
  factFingerprint: string;
  generatorId: string;
  modelId: string;
  seed: number;
  startedAt: string;
  latencyMs: number;
  usage: Usage;
  reportedModel: string | null;
  jsonParsePass: boolean;
  schemaPass: boolean;
  validatorPass: boolean;
  rendererPass: boolean;
  hardPass: boolean;
  errorCode: string | null;
  outputSha256: string | null;
  outputBytes: number | null;
  planSignatureSha256: string | null;
  report: ReturnType<typeof renderSurfAnalysisReport> | null;
};

export type JudgeTask = {
  callIndex: number;
  matchupId: string;
  comparisonId: string;
  order: 0 | 1;
  judge: BakeoffModel;
  judgeSeed: number;
  case: PreparedBakeoffCase;
  candidateA: CandidateResult;
  candidateB: CandidateResult;
  leftCandidate: CandidateResult;
  rightCandidate: CandidateResult;
  messages: NarrativeJob["inference"]["messages"];
};

export type JudgeResult = {
  callIndex: number;
  matchupId: string;
  comparisonId: string;
  order: 0 | 1;
  caseId: string;
  judgeId: string;
  modelId: string;
  judgeSeed: number;
  startedAt: string;
  latencyMs: number;
  usage: Usage;
  reportedModel: string | null;
  schemaPass: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  outputSha256: string | null;
  outputBytes: number | null;
  decision: z.infer<typeof JudgeDecisionSchema> | null;
};

export type BakeoffSummary = {
  artifactVersion: typeof BAKEOFF_ARTIFACT_VERSION;
  evaluationMode: BakeoffConfig["evaluationMode"];
  completionGate: "hard_validator_only" | "hard_validator_plus_advisory_pairwise";
  promptVersion: typeof SURF_ANALYSIS_PROMPT_VERSION;
  outputSchemaVersion: typeof SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION;
  validatorIsAbsolute: true;
  judgeCanPublish: false;
  thinkingEnabled: false;
  callPlan: BakeoffCallPlan;
  actualCalls: {
    preflight: number;
    generators: number;
    judges: number;
    totalInference: number;
    totalHttp: number;
  };
  generators: Array<Record<string, unknown>>;
  judges: Array<Record<string, unknown>>;
  pairwise: Record<string, unknown>;
};

export type BakeoffRunOptions = {
  repositoryRoot: string;
  maxCalls: number;
  runnerIsolation: "stopped" | "dedicated-endpoint";
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
};

export class BakeoffInterruptedError extends Error {
  constructor() {
    super("Analysis bakeoff interrupted at an inference boundary");
    this.name = "BakeoffInterruptedError";
  }
}

class BakeoffCallError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function outputIdentity(content: string): { outputSha256: string; outputBytes: number } {
  return {
    outputSha256: createHash("sha256").update(content).digest("hex"),
    outputBytes: new TextEncoder().encode(content).byteLength
  };
}

function safeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ")
      .slice(0, 1_000);
  }
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return "Unknown bakeoff error";
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof BakeoffCallError ? error.code : fallback;
}

function usage(value: z.infer<typeof UsageSchema> | undefined): Usage {
  return {
    promptTokens: value?.prompt_tokens ?? null,
    completionTokens: value?.completion_tokens ?? null,
    totalTokens: value?.total_tokens ?? null
  };
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function databaseHasFactBundles(path: string): number | null {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const table = database
      .prepare(
        "select count(*) as count from sqlite_master where type = 'table' and name = 'forecast_fact_bundles'"
      )
      .get() as { count?: number | bigint } | undefined;
    if (Number(table?.count ?? 0) !== 1) return null;
    const row = database
      .prepare("select count(*) as count from forecast_fact_bundles")
      .get() as { count?: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  } finally {
    database.close();
  }
}

export async function findLocalFactBundleDatabase(
  repositoryRoot: string,
  explicitPath: string | null = null
): Promise<string> {
  if (explicitPath) {
    if (!(await pathIsFile(explicitPath))) {
      throw new Error(`Local D1 database does not exist: ${explicitPath}`);
    }
    if (databaseHasFactBundles(explicitPath) === null) {
      throw new Error(`Local D1 database has no forecast_fact_bundles table: ${explicitPath}`);
    }
    return explicitPath;
  }
  const directory = join(
    repositoryRoot,
    "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject"
  );
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
    .map((entry) => join(directory, entry.name))
    .filter((path) => databaseHasFactBundles(path) !== null);
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one local D1 database with forecast_fact_bundles, found ${candidates.length}; set databasePath explicitly`
    );
  }
  return candidates[0]!;
}

export async function loadLocalFactBundles(options: {
  repositoryRoot: string;
  databasePath: string | null;
  expectedCount: number;
}): Promise<{ databasePath: string; bundles: ForecastFactBundle[] }> {
  const databasePath = await findLocalFactBundleDatabase(
    options.repositoryRoot,
    options.databasePath
  );
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `select bundle.spot_id, bundle.local_date, bundle.generation_id,
                bundle.generated_at, bundle.input_fingerprint,
                bundle.material_fingerprint, bundle.schema_version,
                bundle.fact_bundle_json
         from forecast_fact_bundles as bundle
         inner join forecast_read_models as model
           on model.spot_id = bundle.spot_id
          and model.interval = '3h'
          and model.generation_id = bundle.generation_id
         order by bundle.local_date asc, bundle.spot_id asc`
      )
      .all() as Array<{
      spot_id: string;
      local_date: string;
      generation_id: string;
      generated_at: string;
      input_fingerprint: string;
      material_fingerprint: string;
      schema_version: number | bigint;
      fact_bundle_json: string;
    }>;
    if (rows.length !== options.expectedCount) {
      throw new Error(
        `Expected ${options.expectedCount} local forecast_fact_bundles, found ${rows.length}`
      );
    }
    const bundles = rows.map((row) => {
      const bundle = ForecastFactBundleSchema.parse(JSON.parse(row.fact_bundle_json));
      if (bundle.input.spotId !== row.spot_id || bundle.input.localDate !== row.local_date) {
        throw new Error(
          `Stored fact bundle identity mismatch for ${row.spot_id}/${row.local_date}`
        );
      }
      if (bundle.input.generatedAt !== row.generated_at) {
        throw new Error(`Stored fact bundle generated_at mismatch for ${row.spot_id}/${row.local_date}`);
      }
      if (
        bundle.inputFingerprint !== row.input_fingerprint ||
        bundle.materialFingerprint !== row.material_fingerprint
      ) {
        throw new Error(`Stored fact bundle fingerprint mismatch for ${row.spot_id}/${row.local_date}`);
      }
      if (bundle.schemaVersion !== Number(row.schema_version)) {
        throw new Error(`Stored fact bundle schema version mismatch for ${row.spot_id}/${row.local_date}`);
      }
      return bundle;
    });
    return { databasePath, bundles };
  } finally {
    database.close();
  }
}

export async function prepareBakeoffCases(
  bundles: readonly ForecastFactBundle[]
): Promise<PreparedBakeoffCase[]> {
  return Promise.all(
    bundles.map(async (bundle, sequence) => {
      const snapshot = await buildSurfAnalysisSnapshot(bundle);
      const job = await buildSurfNarrativeJob(snapshot);
      return {
        sequence,
        caseId: `${snapshot.spotId}/${snapshot.localDate}/${snapshot.factFingerprint.slice(0, 12)}`,
        bundle,
        snapshot,
        job
      };
    })
  );
}

export async function prepareBakeoffCorpus(
  bundles: readonly ForecastFactBundle[]
): Promise<{
  cases: PreparedBakeoffCase[];
  unavailable: UnavailableBakeoffBundle[];
}> {
  const cases: PreparedBakeoffCase[] = [];
  const unavailable: UnavailableBakeoffBundle[] = [];
  for (let sequence = 0; sequence < bundles.length; sequence += 1) {
    const bundle = bundles[sequence]!;
    if (bundle.input.recommendationWindowIds.length === 0) {
      unavailable.push({
        sequence,
        spotId: bundle.input.spotId,
        localDate: bundle.input.localDate,
        generatedAt: bundle.input.generatedAt,
        inputFingerprint: bundle.inputFingerprint,
        materialFingerprint: bundle.materialFingerprint,
        reasonCode: "analysis_no_recommendation"
      });
      continue;
    }
    try {
      const snapshot = await buildSurfAnalysisSnapshot(bundle);
      cases.push({
        sequence,
        caseId: `${snapshot.spotId}/${snapshot.localDate}/${snapshot.factFingerprint.slice(0, 12)}`,
        bundle,
        snapshot,
        job: await buildSurfNarrativeJob(snapshot)
      });
    } catch (error) {
      unavailable.push({
        sequence,
        spotId: bundle.input.spotId,
        localDate: bundle.input.localDate,
        generatedAt: bundle.input.generatedAt,
        inputFingerprint: bundle.inputFingerprint,
        materialFingerprint: bundle.materialFingerprint,
        reasonCode: "analysis_snapshot_invalid",
        errorMessage: safeError(error)
      });
    }
  }
  return { cases, unavailable };
}

export function buildBakeoffCallPlan(
  config: BakeoffConfig,
  caseCount: number
): BakeoffCallPlan {
  const generatorCalls = caseCount * config.generators.length * config.seeds.length;
  const generatorPairs =
    (config.generators.length * (config.generators.length - 1)) / 2;
  const candidatePairs = caseCount * config.seeds.length * generatorPairs;
  const judgeCallsUpperBound =
    candidatePairs * config.judges.length * config.judgeSeeds.length * 2;
  const preflightRequests = new Set(
    [...config.generators, ...config.judges].map(({ endpoint }) => endpoint)
  ).size;
  return {
    cases: caseCount,
    preflightRequests,
    generatorCalls,
    candidatePairs,
    judgeCallsUpperBound,
    totalCallsUpperBound: generatorCalls + judgeCallsUpperBound,
    totalHttpRequestsUpperBound:
      preflightRequests + generatorCalls + judgeCallsUpperBound
  };
}

export function assertBakeoffCallBudget(plan: BakeoffCallPlan, maxCalls: number): void {
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    throw new Error("--max-calls must be a positive integer");
  }
  if (plan.totalCallsUpperBound > maxCalls) {
    throw new Error(
      `Bakeoff needs at most ${plan.totalCallsUpperBound} calls, exceeding --max-calls ${maxCalls}`
    );
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<unknown> {
  try {
    return await readBoundedJson(response, maximumBytes);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new BakeoffCallError("response_too_large", "Model response exceeded byte limit");
    }
    if (error instanceof SyntaxError) {
      throw new BakeoffCallError("response_json_invalid", "Model response was not JSON");
    }
    throw new BakeoffCallError("response_read_failed", "Model response could not be read");
  }
}

async function invokeCompletion(options: {
  endpoint: BakeoffConfig["endpoints"][string];
  model: BakeoffModel;
  token: string | null;
  messages: NarrativeJob["inference"]["messages"];
  responseSchemaName: string;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
  temperature: number;
  seed: number;
  timeoutMs: number;
  responseMaxBytes: number;
  fetcher: typeof fetch;
}): Promise<Completion> {
  const started = performance.now();
  const body = JSON.stringify({
    model: options.model.modelId,
    messages: options.messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: options.responseSchemaName,
        strict: true,
        schema: options.responseSchema
      }
    },
    max_tokens: options.maxOutputTokens,
    temperature: options.temperature,
    seed: options.seed,
    chat_template_kwargs: { enable_thinking: BAKEOFF_THINKING_ENABLED },
    stream: false
  });
  if (new TextEncoder().encode(body).byteLength > BAKEOFF_REQUEST_MAX_BYTES) {
    throw new BakeoffCallError("request_too_large", "Model request exceeded byte limit");
  }
  let response: Response;
  try {
    response = await options.fetcher(`${options.endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
      body
    });
  } catch {
    throw new BakeoffCallError("request_failed", "Model request failed or timed out");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new BakeoffCallError(
      response.status === 401 || response.status === 403
        ? "request_auth_failed"
        : "request_http_failed",
      `Model request returned HTTP ${response.status}`
    );
  }
  const parsed = CompletionSchema.parse(
    await readBoundedResponse(response, options.responseMaxBytes)
  );
  return {
    content: parsed.choices[0]!.message.content,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    usage: usage(parsed.usage),
    reportedModel: parsed.model ?? null
  };
}

export async function preflightModels(options: {
  config: BakeoffConfig;
  env: NodeJS.ProcessEnv;
  fetcher: typeof fetch;
}): Promise<void> {
  const modelsByEndpoint = new Map<string, Set<string>>();
  for (const model of [...options.config.generators, ...options.config.judges]) {
    const requested = modelsByEndpoint.get(model.endpoint) ?? new Set<string>();
    requested.add(model.modelId);
    modelsByEndpoint.set(model.endpoint, requested);
  }
  for (const [endpointId, requested] of modelsByEndpoint) {
    const endpoint = options.config.endpoints[endpointId]!;
    let response: Response;
    try {
      const token = resolveEndpointToken(endpoint, options.env);
      response = await options.fetcher(`${endpoint.baseUrl}/models`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(options.config.timeoutMs, 30_000))
      });
    } catch {
      throw new Error(`oMLX model preflight failed for endpoint ${endpointId}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`oMLX model preflight returned HTTP ${response.status} for ${endpointId}`);
    }
    const listed = ModelListSchema.parse(
      await readBoundedResponse(response, options.config.responseMaxBytes)
    );
    const available = new Set(listed.data.map(({ id }) => id));
    const missing = [...requested].filter((modelId) => !available.has(modelId));
    if (missing.length > 0) {
      throw new Error(
        `oMLX endpoint ${endpointId} is missing configured model IDs: ${missing.join(", ")}`
      );
    }
  }
}

export function productionGeneratorRequestBody(options: {
  preparedCase: PreparedBakeoffCase;
  modelId: string;
  seed: number;
}): Record<string, unknown> {
  return {
    model: options.modelId,
    messages: options.preparedCase.job.inference.messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: `narrative_output_v${options.preparedCase.job.outputSchemaVersion}`,
        strict: true,
        schema: options.preparedCase.job.inference.responseSchema
      }
    },
    max_tokens: options.preparedCase.job.inference.maxOutputTokens,
    temperature: options.preparedCase.job.inference.temperature,
    seed: options.seed,
    chat_template_kwargs: { enable_thinking: BAKEOFF_THINKING_ENABLED },
    stream: false
  };
}

export async function evaluateGenerator(options: {
  callIndex: number;
  preparedCase: PreparedBakeoffCase;
  model: BakeoffModel;
  config: BakeoffConfig;
  seed: number;
  env: NodeJS.ProcessEnv;
  fetcher: typeof fetch;
  now: () => Date;
}): Promise<CandidateResult> {
  const { preparedCase, model, config, seed } = options;
  const candidateId = `candidate.${sha256({
    factFingerprint: preparedCase.snapshot.factFingerprint,
    generationFingerprint: preparedCase.job.generationFingerprint,
    generatorId: model.id,
    modelId: model.modelId,
    seed
  })}`;
  const startedAt = options.now().toISOString();
  const base: Omit<
    CandidateResult,
    | "latencyMs"
    | "usage"
    | "reportedModel"
    | "jsonParsePass"
    | "schemaPass"
    | "validatorPass"
    | "rendererPass"
    | "hardPass"
    | "errorCode"
    | "outputSha256"
    | "outputBytes"
    | "report"
  > = {
    callIndex: options.callIndex,
    candidateId,
    caseId: preparedCase.caseId,
    spotId: preparedCase.snapshot.spotId,
    localDate: preparedCase.snapshot.localDate,
    factFingerprint: preparedCase.snapshot.factFingerprint,
    generatorId: model.id,
    modelId: model.modelId,
    seed,
    startedAt,
    planSignatureSha256: null
  };
  const emptyUsage: Usage = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null
  };
  let completion: Completion;
  const invocationStarted = performance.now();
  try {
    const endpoint = config.endpoints[model.endpoint]!;
    completion = await invokeCompletion({
      endpoint,
      model,
      token: resolveEndpointToken(endpoint, options.env),
      messages: preparedCase.job.inference.messages,
      responseSchemaName: `narrative_output_v${preparedCase.job.outputSchemaVersion}`,
      responseSchema: preparedCase.job.inference.responseSchema,
      maxOutputTokens: preparedCase.job.inference.maxOutputTokens,
      temperature: preparedCase.job.inference.temperature,
      seed,
      timeoutMs: config.timeoutMs,
      responseMaxBytes: config.responseMaxBytes,
      fetcher: options.fetcher
    });
  } catch (error) {
    return {
      ...base,
      latencyMs: Math.round((performance.now() - invocationStarted) * 100) / 100,
      usage: emptyUsage,
      reportedModel: null,
      jsonParsePass: false,
      schemaPass: false,
      validatorPass: false,
      rendererPass: false,
      hardPass: false,
      errorCode: errorCode(error, "completion_failed"),
      outputSha256: null,
      outputBytes: null,
      report: null
    };
  }

  const identity = outputIdentity(completion.content);
  if (completion.reportedModel !== model.modelId) {
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      jsonParsePass: false,
      schemaPass: false,
      validatorPass: false,
      rendererPass: false,
      hardPass: false,
      errorCode:
        completion.reportedModel === null
          ? "candidate_model_identity_missing"
          : "candidate_model_identity_mismatch",
      ...identity,
      report: null
    };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(completion.content);
  } catch {
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      jsonParsePass: false,
      schemaPass: false,
      validatorPass: false,
      rendererPass: false,
      hardPass: false,
      errorCode: "candidate_json_invalid",
      ...identity,
      report: null
    };
  }
  const schemaResult = SurfAnalysisPlanV5Schema.safeParse(parsedJson);
  if (!schemaResult.success) {
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      jsonParsePass: true,
      schemaPass: false,
      validatorPass: false,
      rendererPass: false,
      hardPass: false,
      errorCode: "candidate_schema_invalid",
      ...identity,
      report: null
    };
  }
  let validated: ReturnType<typeof validateSurfAnalysisDraft>;
  try {
    validated = validateSurfAnalysisDraft(
      schemaResult.data,
      preparedCase.snapshot,
      new Date(preparedCase.bundle.input.generatedAt)
    );
  } catch {
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      jsonParsePass: true,
      schemaPass: true,
      validatorPass: false,
      rendererPass: false,
      hardPass: false,
      errorCode: "candidate_validator_rejected",
      ...identity,
      report: null
    };
  }
  try {
    const report = renderSurfAnalysisReport({
      draft: validated.draft,
      snapshot: preparedCase.snapshot,
      revisionId: `bakeoff.${candidateId.slice("candidate.".length, "candidate.".length + 32)}`,
      publishedAt: preparedCase.bundle.input.generatedAt
    });
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      jsonParsePass: true,
      schemaPass: true,
      validatorPass: true,
      rendererPass: true,
      hardPass: true,
      errorCode: null,
      ...identity,
      planSignatureSha256: sha256(validated.draft),
      report
    };
  } catch {
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      jsonParsePass: true,
      schemaPass: true,
      validatorPass: true,
      rendererPass: false,
      hardPass: false,
      errorCode: "candidate_renderer_rejected",
      ...identity,
      report: null
    };
  }
}

function judgeMessages(
  preparedCase: PreparedBakeoffCase,
  candidateA: CandidateResult,
  candidateB: CandidateResult
): NarrativeJob["inference"]["messages"] {
  if (!candidateA.report || !candidateB.report) {
    throw new Error("Judge input requires two validator-passing rendered reports");
  }
  return [
    {
      role: "system",
      content: BAKEOFF_JUDGE_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: JSON.stringify({
        authority:
          "Everything under authoritativeFrame is deterministic code-owned ground truth. Recommendation order is immutable. Card previews/templates and their evidence are authorized report material; do not label their rendered values or claims hallucinations.",
        authoritativeFrame: {
          spot: preparedCase.snapshot.spotName,
          date: preparedCase.snapshot.localDate,
          callMode: preparedCase.snapshot.callMode,
          recommendationOrder: preparedCase.snapshot.recommendationWindowIds,
          immutableValues: preparedCase.snapshot.slots,
          facts: preparedCase.snapshot.facts,
          cards: preparedCase.snapshot.cards.map((card) => ({
            ...card,
            evidence: card.factRefs.map(
              (factRef) =>
                preparedCase.snapshot.facts.find(({ id }) => id === factRef)?.statement ?? ""
            )
          }))
        },
        candidateA: {
          headline: candidateA.report.headline,
          paragraphs: candidateA.report.paragraphs
        },
        candidateB: {
          headline: candidateB.report.headline,
          paragraphs: candidateB.report.paragraphs
        }
      })
    }
  ];
}

function candidateKey(caseId: string, generatorId: string, seed: number): string {
  return `${caseId}\u0000${generatorId}\u0000${seed}`;
}

export function buildJudgeTasks(options: {
  cases: readonly PreparedBakeoffCase[];
  candidates: readonly CandidateResult[];
  config: BakeoffConfig;
  firstCallIndex?: number;
}): JudgeTask[] {
  const byKey = new Map(
    options.candidates.map((candidate) => [
      candidateKey(candidate.caseId, candidate.generatorId, candidate.seed),
      candidate
    ])
  );
  const tasks: JudgeTask[] = [];
  let callIndex = options.firstCallIndex ?? 0;
  for (const preparedCase of options.cases) {
    for (const seed of options.config.seeds) {
      for (let leftIndex = 0; leftIndex < options.config.generators.length; leftIndex += 1) {
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < options.config.generators.length;
          rightIndex += 1
        ) {
          const leftGenerator = options.config.generators[leftIndex]!;
          const rightGenerator = options.config.generators[rightIndex]!;
          const leftCandidate = byKey.get(
            candidateKey(preparedCase.caseId, leftGenerator.id, seed)
          );
          const rightCandidate = byKey.get(
            candidateKey(preparedCase.caseId, rightGenerator.id, seed)
          );
          if (!leftCandidate?.hardPass || !rightCandidate?.hardPass) continue;
          const matchupId = `matchup.${sha256({
            caseId: preparedCase.caseId,
            generatorSeed: seed,
            leftCandidateId: leftCandidate.candidateId,
            rightCandidateId: rightCandidate.candidateId
          })}`;
          for (const judge of options.config.judges) {
            for (const judgeSeed of options.config.judgeSeeds) {
              const comparisonId = `comparison.${sha256({
                matchupId,
                judgeId: judge.id,
                judgeSeed
              })}`;
              const baseSwap = Number.parseInt(comparisonId.slice(-2), 16) % 2;
              for (const order of [0, 1] as const) {
                const swap = (baseSwap + order) % 2 === 1;
                const candidateA = swap ? rightCandidate : leftCandidate;
                const candidateB = swap ? leftCandidate : rightCandidate;
                tasks.push({
                  callIndex,
                  matchupId,
                  comparisonId,
                  order,
                  judge,
                  judgeSeed,
                  case: preparedCase,
                  candidateA,
                  candidateB,
                  leftCandidate,
                  rightCandidate,
                  messages: judgeMessages(preparedCase, candidateA, candidateB)
                });
                callIndex += 1;
              }
            }
          }
        }
      }
    }
  }
  return tasks;
}

export async function evaluateJudge(options: {
  task: JudgeTask;
  config: BakeoffConfig;
  env: NodeJS.ProcessEnv;
  fetcher: typeof fetch;
  now: () => Date;
}): Promise<JudgeResult> {
  const { task, config } = options;
  const base = {
    callIndex: task.callIndex,
    matchupId: task.matchupId,
    comparisonId: task.comparisonId,
    order: task.order,
    caseId: task.case.caseId,
    judgeId: task.judge.id,
    modelId: task.judge.modelId,
    judgeSeed: task.judgeSeed,
    startedAt: options.now().toISOString()
  };
  const emptyUsage: Usage = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null
  };
  let completion: Completion;
  const invocationStarted = performance.now();
  try {
    const endpoint = config.endpoints[task.judge.endpoint]!;
    completion = await invokeCompletion({
      endpoint,
      model: task.judge,
      token: resolveEndpointToken(endpoint, options.env),
      messages: task.messages,
      responseSchemaName: BAKEOFF_JUDGE_REQUEST_CONTRACT.responseSchemaName,
      responseSchema: BAKEOFF_JUDGE_RESPONSE_JSON_SCHEMA,
      maxOutputTokens: BAKEOFF_JUDGE_REQUEST_CONTRACT.maxOutputTokens,
      temperature: BAKEOFF_JUDGE_REQUEST_CONTRACT.temperature,
      seed: task.judgeSeed,
      timeoutMs: config.timeoutMs,
      responseMaxBytes: config.responseMaxBytes,
      fetcher: options.fetcher
    });
  } catch (error) {
    return {
      ...base,
      latencyMs: Math.round((performance.now() - invocationStarted) * 100) / 100,
      usage: emptyUsage,
      reportedModel: null,
      schemaPass: false,
      errorCode: errorCode(error, "judge_completion_failed"),
      errorMessage: safeError(error),
      outputSha256: null,
      outputBytes: null,
      decision: null
    };
  }
  const identity = outputIdentity(completion.content);
  if (completion.reportedModel !== task.judge.modelId) {
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      schemaPass: false,
      errorCode:
        completion.reportedModel === null
          ? "judge_model_identity_missing"
          : "judge_model_identity_mismatch",
      errorMessage: "oMLX response model identity did not match the configured judge",
      ...identity,
      decision: null
    };
  }
  try {
    const decision = parseBakeoffJudgeDecision(JSON.parse(completion.content));
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      schemaPass: true,
      errorCode: null,
      errorMessage: null,
      ...identity,
      decision
    };
  } catch (error) {
    return {
      ...base,
      latencyMs: completion.latencyMs,
      usage: completion.usage,
      reportedModel: completion.reportedModel,
      schemaPass: false,
      errorCode: "judge_schema_invalid",
      errorMessage: safeError(error),
      ...identity,
      decision: null
    };
  }
}

async function mapLimit<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
  signal?: AbortSignal
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let cursor = 0;
  let interrupted = signal?.aborted ?? false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        if (signal?.aborted) {
          interrupted = true;
          return;
        }
        const index = cursor;
        cursor += 1;
        results[index] = await operation(values[index]!);
      }
    })
  );
  if (interrupted || signal?.aborted) throw new BakeoffInterruptedError();
  return results;
}

export function scheduleByEndpointModel<T>(
  values: readonly T[],
  modelFor: (value: T) => { endpoint: string; modelId: string }
): T[] {
  return values
    .map((value, canonicalIndex) => ({ value, canonicalIndex, model: modelFor(value) }))
    .sort((left, right) => {
      const leftKey = `${left.model.endpoint}\u0000${left.model.modelId}`;
      const rightKey = `${right.model.endpoint}\u0000${right.model.modelId}`;
      return leftKey.localeCompare(rightKey) || left.canonicalIndex - right.canonicalIndex;
    })
    .map(({ value }) => value);
}

function percentile(values: readonly number[], percentage: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percentage / 100) * sorted.length) - 1)
  );
  return Math.round(sorted[index]! * 100) / 100;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100;
}

function jobSizeStats(cases: readonly PreparedBakeoffCase[]): Record<string, unknown> {
  const sizes = cases.map((preparedCase) => ({
    caseId: preparedCase.caseId,
    bytes: serializedNarrativeJobBytes(preparedCase.job)
  }));
  const largest = [...sizes].sort((left, right) => right.bytes - left.bytes)[0] ?? null;
  return {
    limitBytes: NARRATIVE_JOB_MAX_BYTES,
    maxBytes: largest?.bytes ?? null,
    largestCaseId: largest?.caseId ?? null,
    p50Bytes: percentile(sizes.map(({ bytes }) => bytes), 50),
    p95Bytes: percentile(sizes.map(({ bytes }) => bytes), 95)
  };
}

function tokenTotals(results: readonly { usage: Usage }[]): Record<string, unknown> {
  const metric = (key: keyof Usage) => {
    const values = results.flatMap((result) => {
      const value = result.usage[key];
      return value === null ? [] : [value];
    });
    return {
      observedTotal:
        values.length === 0 ? null : values.reduce((total, value) => total + value, 0),
      reportedCalls: values.length,
      totalCalls: results.length,
      coverage: results.length === 0 ? null : values.length / results.length,
      complete: results.length > 0 && values.length === results.length
    };
  };
  return {
    promptTokens: metric("promptTokens"),
    completionTokens: metric("completionTokens"),
    totalTokens: metric("totalTokens")
  };
}

function latencyStats(values: readonly number[]): Record<string, number | null> {
  const latencyMean = mean(values);
  return {
    mean: latencyMean,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? null : Math.max(...values)
  };
}

function latencySummary<T extends { latencyMs: number; outputSha256: string | null }>(
  results: readonly T[]
): Record<string, unknown> {
  const completedResponses = results.filter((result) => result.outputSha256 !== null);
  const completedLatency = completedResponses.map((result) => result.latencyMs);
  const completedMean = mean(completedLatency);
  return {
    kind: "non_streaming_wall",
    ttft: null,
    attempts: {
      calls: results.length,
      ...latencyStats(results.map((result) => result.latencyMs))
    },
    completedResponses: {
      calls: completedResponses.length,
      ...latencyStats(completedLatency),
      estimatedSequentialOutputsPerHour:
        completedMean === null || completedMean === 0
          ? null
          : Math.round((3_600_000 / completedMean) * 100) / 100
    }
  };
}

function normalizeWinner(task: JudgeTask, result: JudgeResult): string | "tie" | null {
  if (!result.decision) return null;
  if (result.decision.winner === "tie") return "tie";
  const winningCandidate =
    result.decision.winner === "A" ? task.candidateA : task.candidateB;
  return winningCandidate.generatorId;
}

function planSelectionSummary(results: readonly CandidateResult[]): Record<string, unknown> {
  const valid = results.filter(
    (result): result is CandidateResult & { planSignatureSha256: string } =>
      result.hardPass && result.planSignatureSha256 !== null
  );
  const counts = new Map<string, number>();
  for (const result of valid) {
    counts.set(
      result.planSignatureSha256,
      (counts.get(result.planSignatureSha256) ?? 0) + 1
    );
  }
  const ranked = [...counts.entries()].sort(
    ([leftSignature, leftCount], [rightSignature, rightCount]) =>
      rightCount - leftCount || leftSignature.localeCompare(rightSignature)
  );
  const dominant = ranked[0] ?? null;
  const byCase = new Map<string, string[]>();
  for (const result of valid) {
    const signatures = byCase.get(result.caseId) ?? [];
    signatures.push(result.planSignatureSha256);
    byCase.set(result.caseId, signatures);
  }
  const caseRows = [...byCase.entries()].map(([caseId, signatures]) => {
    const caseCounts = new Map<string, number>();
    for (const signature of signatures) {
      caseCounts.set(signature, (caseCounts.get(signature) ?? 0) + 1);
    }
    const dominantSignature = [...caseCounts.entries()].sort(
      ([leftSignature, leftCount], [rightSignature, rightCount]) =>
        rightCount - leftCount || leftSignature.localeCompare(rightSignature)
    )[0]![0];
    return {
      caseId,
      calls: signatures.length,
      uniqueSignatures: caseCounts.size,
      dominantSignatureSha256: dominantSignature
    };
  });
  const stableCases = caseRows.filter(({ uniqueSignatures }) => uniqueSignatures === 1).length;
  const distinctCaseDominants = new Set(
    caseRows.map(({ dominantSignatureSha256 }) => dominantSignatureSha256)
  ).size;
  return {
    hardPassPlans: valid.length,
    uniqueSignatures: counts.size,
    dominantSignature:
      dominant === null
        ? null
        : {
            sha256: dominant[0],
            calls: dominant[1],
            rate: valid.length === 0 ? null : dominant[1] / valid.length
          },
    seedStability: {
      evaluatedCases: caseRows.length,
      stableCases,
      casesWithSeedVariation: caseRows.length - stableCases,
      rate: caseRows.length === 0 ? null : stableCases / caseRows.length
    },
    inputSensitivity: {
      evaluatedCases: caseRows.length,
      distinctCaseDominantSignatures: distinctCaseDominants,
      allCasesShareOneDominantSignature:
        caseRows.length < 2 ? null : distinctCaseDominants === 1,
      distinctDominantRate:
        caseRows.length === 0 ? null : distinctCaseDominants / caseRows.length
    }
  };
}

export function summarizeBakeoff(
  config: BakeoffConfig,
  plan: BakeoffCallPlan,
  candidates: readonly CandidateResult[],
  judgeTasks: readonly JudgeTask[],
  judgeResults: readonly JudgeResult[]
): BakeoffSummary {
  const taskByKey = new Map(
    judgeTasks.map((task) => [`${task.comparisonId}\u0000${task.order}`, task])
  );
  const resultByKey = new Map(
    judgeResults.map((result) => [`${result.comparisonId}\u0000${result.order}`, result])
  );
  const comparisonIds = [...new Set(judgeTasks.map((task) => task.comparisonId))];
  const stableComparisonIds = new Set(
    comparisonIds.filter((comparisonId) => {
      const task0 = taskByKey.get(`${comparisonId}\u00000`);
      const task1 = taskByKey.get(`${comparisonId}\u00001`);
      const result0 = resultByKey.get(`${comparisonId}\u00000`);
      const result1 = resultByKey.get(`${comparisonId}\u00001`);
      if (!task0 || !task1 || !result0 || !result1) return false;
      const first = normalizeWinner(task0, result0);
      const second = normalizeWinner(task1, result1);
      return first !== null && first === second;
    })
  );
  const rubricRows = new Map<string, Array<z.infer<typeof JudgeRubricScoresSchema>>>();
  const addRubric = (
    generatorId: string,
    scores: z.infer<typeof JudgeRubricScoresSchema>
  ) => {
    const rows = rubricRows.get(generatorId) ?? [];
    rows.push(scores);
    rubricRows.set(generatorId, rows);
  };
  for (const result of judgeResults) {
    if (!result.decision || !stableComparisonIds.has(result.comparisonId)) continue;
    const task = taskByKey.get(`${result.comparisonId}\u0000${result.order}`);
    if (!task) continue;
    addRubric(task.candidateA.generatorId, result.decision.scores.A);
    addRubric(task.candidateB.generatorId, result.decision.scores.B);
  }
  const generators = config.generators.map((generator) => {
    const results = candidates.filter((candidate) => candidate.generatorId === generator.id);
    const hardPasses = results.filter((result) => result.hardPass).length;
    const rubric = rubricRows.get(generator.id) ?? [];
    return {
      id: generator.id,
      modelId: generator.modelId,
      calls: results.length,
      jsonParsePasses: results.filter((result) => result.jsonParsePass).length,
      schemaPasses: results.filter((result) => result.schemaPass).length,
      validatorPasses: results.filter((result) => result.validatorPass).length,
      rendererPasses: results.filter((result) => result.rendererPass).length,
      hardPasses,
      hardPassRate: results.length === 0 ? null : hardPasses / results.length,
      firstPassHardValidRate: results.length === 0 ? null : hardPasses / results.length,
      planSelection: planSelectionSummary(results),
      latencyMs: latencySummary(results),
      tokens: tokenTotals(results),
      rubricScores: Object.fromEntries(
        JUDGE_RUBRIC_KEYS.map((key) => [key, mean(rubric.map((scores) => scores[key]))])
      ),
      rubricObservations: rubric.length,
      failures: Object.fromEntries(
        [...new Set(results.flatMap((result) => (result.errorCode ? [result.errorCode] : [])))].map(
          (code) => [code, results.filter((result) => result.errorCode === code).length]
        )
      )
    };
  });
  const judges = config.judges.map((judge) => {
    const results = judgeResults.filter((result) => result.judgeId === judge.id);
    return {
      id: judge.id,
      modelId: judge.modelId,
      calls: results.length,
      schemaPasses: results.filter((result) => result.schemaPass).length,
      latencyMs: latencySummary(results),
      tokens: tokenTotals(results)
    };
  });
  let resolved = 0;
  let ties = 0;
  let inconsistent = 0;
  let invalid = 0;
  const wins: Record<string, number> = Object.fromEntries(
    config.generators.map((generator) => [generator.id, 0])
  );
  const reconciled = comparisonIds.map((comparisonId) => {
    const task0 = taskByKey.get(`${comparisonId}\u00000`)!;
    const task1 = taskByKey.get(`${comparisonId}\u00001`)!;
    const result0 = resultByKey.get(`${comparisonId}\u00000`);
    const result1 = resultByKey.get(`${comparisonId}\u00001`);
    const first = result0 ? normalizeWinner(task0, result0) : null;
    const second = result1 ? normalizeWinner(task1, result1) : null;
    let outcome: string;
    let winner: string | null = null;
    if (first === null || second === null) {
      invalid += 1;
      outcome = "invalid";
    } else if (first === "tie" && second === "tie") {
      ties += 1;
      outcome = "tie";
    } else if (first === second && first !== "tie") {
      resolved += 1;
      outcome = "resolved";
      winner = first;
      wins[first] = (wins[first] ?? 0) + 1;
    } else {
      inconsistent += 1;
      outcome = "order_inconsistent";
    }
    return {
      matchupId: task0.matchupId,
      comparisonId,
      judgeId: task0.judge.id,
      judgeSeed: task0.judgeSeed,
      outcome,
      winner,
      order0: first,
      order1: second
    };
  });
  const matchupIds = [...new Set(judgeTasks.map((task) => task.matchupId))];
  const consensusWins: Record<string, number> = Object.fromEntries(
    config.generators.map((generator) => [generator.id, 0])
  );
  const consensus = matchupIds.map((matchupId) => {
    const votes = reconciled.filter((candidate) => candidate.matchupId === matchupId);
    const unstable = votes.some(
      ({ outcome }) => outcome === "invalid" || outcome === "order_inconsistent"
    );
    const winnerVotes = votes.filter(({ outcome }) => outcome === "resolved");
    const tieVotes = votes.filter(({ outcome }) => outcome === "tie");
    const winners = [...new Set(winnerVotes.map(({ winner }) => winner!))];
    let outcome: "winner" | "tie" | "judge_disagreement" | "needs_calibration";
    let winner: string | null = null;
    if (unstable) {
      outcome = "needs_calibration";
    } else if (winners.length > 1 || (winnerVotes.length > 0 && tieVotes.length > 0)) {
      outcome = "judge_disagreement";
    } else if (winners.length === 1 && winnerVotes.length === votes.length) {
      outcome = "winner";
      winner = winners[0]!;
      consensusWins[winner] = (consensusWins[winner] ?? 0) + 1;
    } else {
      outcome = "tie";
    }
    return { matchupId, outcome, winner, votes };
  });
  const allOrderPairs = resolved + ties + inconsistent + invalid;
  return {
    artifactVersion: BAKEOFF_ARTIFACT_VERSION,
    evaluationMode: config.evaluationMode,
    completionGate:
      config.evaluationMode === "generator_only"
        ? "hard_validator_only"
        : "hard_validator_plus_advisory_pairwise",
    promptVersion: SURF_ANALYSIS_PROMPT_VERSION,
    outputSchemaVersion: SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
    validatorIsAbsolute: true,
    judgeCanPublish: false,
    thinkingEnabled: BAKEOFF_THINKING_ENABLED,
    callPlan: plan,
    actualCalls: {
      preflight: plan.preflightRequests,
      generators: candidates.length,
      judges: judgeResults.length,
      totalInference: candidates.length + judgeResults.length,
      totalHttp: plan.preflightRequests + candidates.length + judgeResults.length
    },
    generators,
    judges,
    pairwise: {
      comparisonsEligible: comparisonIds.length,
      orderSwappedCalls: judgeTasks.length,
      resolved,
      ties,
      orderInconsistent: inconsistent,
      swappedOrderConsistencyRate:
        allOrderPairs === 0 ? null : (resolved + ties) / allOrderPairs,
      invalid,
      wins,
      reconciled,
      judgeConsensus: {
        matchups: matchupIds.length,
        winners: consensus.filter(({ outcome }) => outcome === "winner").length,
        ties: consensus.filter(({ outcome }) => outcome === "tie").length,
        disagreements: consensus.filter(({ outcome }) => outcome === "judge_disagreement").length,
        needsCalibration: consensus.filter(({ outcome }) => outcome === "needs_calibration").length,
        wins: consensusWins,
        results: consensus
      }
    }
  };
}

class ArtifactStore {
  readonly runDirectory: string;
  private readonly pendingAppends = new Map<string, Promise<void>>();

  private constructor(runDirectory: string) {
    this.runDirectory = runDirectory;
  }

  static async create(options: {
    root: string;
    now: Date;
    runFingerprint: string;
  }): Promise<ArtifactStore> {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const timestamp = options.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const runDirectory = join(options.root, `${timestamp}-${options.runFingerprint.slice(0, 12)}`);
    await mkdir(runDirectory, { mode: 0o700 });
    return new ArtifactStore(runDirectory);
  }

  async append(name: string, value: unknown): Promise<void> {
    const previous = this.pendingAppends.get(name) ?? Promise.resolve();
    const next = previous.then(async () => {
      await appendFile(join(this.runDirectory, name), `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
    });
    this.pendingAppends.set(name, next);
    await next;
  }

  async json(name: string, value: unknown): Promise<void> {
    const target = join(this.runDirectory, name);
    const temporary = join(this.runDirectory, `.${basename(name)}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, target);
  }
}

export async function planBakeoff(
  config: BakeoffConfig,
  repositoryRoot: string
): Promise<{
  databasePath: string;
  loadedBundles: ForecastFactBundle[];
  cases: PreparedBakeoffCase[];
  eligibleCaseCount: number;
  unavailable: UnavailableBakeoffBundle[];
  callPlan: BakeoffCallPlan;
}> {
  const loaded = await loadLocalFactBundles({
    repositoryRoot,
    databasePath: config.databasePath,
    expectedCount: config.expectedBundleCount
  });
  const corpus = await prepareBakeoffCorpus(loaded.bundles);
  const cases = corpus.cases.slice(0, config.caseLimit);
  return {
    databasePath: loaded.databasePath,
    loadedBundles: loaded.bundles,
    cases,
    eligibleCaseCount: corpus.cases.length,
    unavailable: corpus.unavailable,
    callPlan: buildBakeoffCallPlan(config, cases.length)
  };
}

export async function runBakeoff(
  config: BakeoffConfig,
  options: BakeoffRunOptions
): Promise<{ runDirectory: string; summary: BakeoffSummary }> {
  if (
    options.runnerIsolation !== "stopped" &&
    options.runnerIsolation !== "dedicated-endpoint"
  ) {
    throw new Error(
      "run requires runnerIsolation=stopped or dedicated-endpoint so evaluation cannot starve production leases"
    );
  }
  const planned = await planBakeoff(config, options.repositoryRoot);
  const snapshotFailures = planned.unavailable.filter(
    ({ reasonCode }) => reasonCode === "analysis_snapshot_invalid"
  );
  if (snapshotFailures.length > 0) {
    throw new Error(
      `Refusing inference because ${snapshotFailures.length} eligible bundles failed the production snapshot/job builder; run plan and fix production compatibility first`
    );
  }
  assertBakeoffCallBudget(planned.callPlan, options.maxCalls);
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const generatorRequestFingerprints = planned.cases.flatMap((preparedCase) =>
    config.seeds.flatMap((seed) =>
      config.generators.map((generator) => ({
        caseId: preparedCase.caseId,
        generatorId: generator.id,
        seed,
        fingerprint: sha256(
          productionGeneratorRequestBody({
            preparedCase,
            modelId: generator.modelId,
            seed
          })
        )
      }))
    )
  );
  const judgeRequestContractFingerprint = sha256({
    systemPrompt: BAKEOFF_JUDGE_SYSTEM_PROMPT,
    responseSchema: BAKEOFF_JUDGE_RESPONSE_JSON_SCHEMA,
    ...BAKEOFF_JUDGE_REQUEST_CONTRACT
  });
  const runFingerprint = sha256({
    artifactVersion: BAKEOFF_ARTIFACT_VERSION,
    evaluationMode: config.evaluationMode,
    promptVersion: SURF_ANALYSIS_PROMPT_VERSION,
    outputSchemaVersion: SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
    judgePromptVersion: BAKEOFF_JUDGE_PROMPT_VERSION,
    judgePromptFingerprint: sha256(BAKEOFF_JUDGE_SYSTEM_PROMPT),
    judgeResponseSchemaFingerprint: sha256(BAKEOFF_JUDGE_RESPONSE_JSON_SCHEMA),
    judgeRequestContractFingerprint,
    generatorRequestFingerprints,
    thinkingEnabled: BAKEOFF_THINKING_ENABLED,
    config: {
      evaluationMode: config.evaluationMode,
      endpoints: config.endpoints,
      generators: config.generators,
      judges: config.judges,
      seeds: config.seeds,
      judgeSeeds: config.judgeSeeds,
      thinkingEnabled: config.enableThinking,
      timeoutMs: config.timeoutMs,
      responseMaxBytes: config.responseMaxBytes,
      concurrency: config.concurrency,
      caseLimit: config.caseLimit
    },
    facts: planned.loadedBundles.map((bundle) => ({
      spotId: bundle.input.spotId,
      localDate: bundle.input.localDate,
      inputFingerprint: bundle.inputFingerprint,
      materialFingerprint: bundle.materialFingerprint
    }))
  });
  const createdAt = now();
  const artifacts = await ArtifactStore.create({
    root: config.outputDirectory,
    now: createdAt,
    runFingerprint
  });
  const manifest = {
    artifactVersion: BAKEOFF_ARTIFACT_VERSION,
    evaluationMode: config.evaluationMode,
    completionGate:
      config.evaluationMode === "generator_only"
        ? "hard_validator_only"
        : "hard_validator_plus_advisory_pairwise",
    status: "running",
    createdAt: createdAt.toISOString(),
    runFingerprint,
    sourceDatabase: planned.databasePath,
    sourceBundleCount: config.expectedBundleCount,
    eligibleCaseCount: planned.eligibleCaseCount,
    unavailableBundleCount: planned.unavailable.length,
    selectedCaseCount: planned.cases.length,
    promptVersion: SURF_ANALYSIS_PROMPT_VERSION,
    outputSchemaVersion: SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
    judgePromptVersion: BAKEOFF_JUDGE_PROMPT_VERSION,
    responseSchemaFingerprint: sha256(SURF_ANALYSIS_RESPONSE_JSON_SCHEMA),
    judgePromptFingerprint: sha256(BAKEOFF_JUDGE_SYSTEM_PROMPT),
    judgeResponseSchemaFingerprint: sha256(BAKEOFF_JUDGE_RESPONSE_JSON_SCHEMA),
    judgeRequestContractFingerprint,
    generatorRequestFingerprints,
    requestMaxBytes: BAKEOFF_REQUEST_MAX_BYTES,
    thinkingEnabled: BAKEOFF_THINKING_ENABLED,
    validatorIsAbsolute: true,
    judgeCanPublish: false,
    runnerIsolation: options.runnerIsolation,
    maxCallsAuthorized: options.maxCalls,
    callPlan: planned.callPlan,
    serializedJobs: jobSizeStats(planned.cases),
    config: redactedBakeoffConfig(config)
  };
  await artifacts.json("manifest.json", manifest);
  let preflightRequests = 0;
  let completedGeneratorCalls = 0;
  let completedJudgeCalls = 0;

  try {
    if (options.signal?.aborted) throw new BakeoffInterruptedError();
    await preflightModels({ config, env, fetcher });
    preflightRequests = planned.callPlan.preflightRequests;
    if (options.signal?.aborted) throw new BakeoffInterruptedError();

    const casesBySequence = new Map(
    planned.cases.map((preparedCase) => [preparedCase.sequence, preparedCase])
  );
  const unavailableBySequence = new Map(
    planned.unavailable.map((unavailable) => [unavailable.sequence, unavailable])
  );
  for (let sequence = 0; sequence < planned.loadedBundles.length; sequence += 1) {
    const preparedCase = casesBySequence.get(sequence);
    if (preparedCase) {
      await artifacts.append("inputs.ndjson", {
        sequence,
        status: "eligible",
        selected: true,
        caseId: preparedCase.caseId,
        bundleIdentity: {
          spotId: preparedCase.bundle.input.spotId,
          localDate: preparedCase.bundle.input.localDate,
          generatedAt: preparedCase.bundle.input.generatedAt,
          inputFingerprint: preparedCase.bundle.inputFingerprint,
          materialFingerprint: preparedCase.bundle.materialFingerprint
        },
        snapshot: preparedCase.snapshot,
        job: preparedCase.job
      });
      continue;
    }
    const unavailable = unavailableBySequence.get(sequence);
    if (unavailable) {
      await artifacts.append("inputs.ndjson", {
        status: "unavailable",
        selected: false,
        ...unavailable
      });
      continue;
    }
    const bundle = planned.loadedBundles[sequence]!;
    await artifacts.append("inputs.ndjson", {
      sequence,
      status: "eligible",
      selected: false,
      bundleIdentity: {
        spotId: bundle.input.spotId,
        localDate: bundle.input.localDate,
        generatedAt: bundle.input.generatedAt,
        inputFingerprint: bundle.inputFingerprint,
        materialFingerprint: bundle.materialFingerprint
      }
    });
  }

    let callIndex = 0;
    const generatorTasks = planned.cases.flatMap((preparedCase) =>
      config.seeds.flatMap((seed) =>
        config.generators.map((model) => ({
          callIndex: callIndex++,
          preparedCase,
          seed,
          model
        }))
      )
    );
    const generatorExecutionTasks = scheduleByEndpointModel(
      generatorTasks,
      ({ model }) => model
    );
    const candidatesInExecutionOrder = await mapLimit(generatorExecutionTasks, config.concurrency, async (task) => {
      const result = await evaluateGenerator({
        ...task,
        config,
        env,
        fetcher,
        now
      });
      await artifacts.append("candidate-results.ndjson", result);
      completedGeneratorCalls += 1;
      return result;
    }, options.signal);
    const candidates = candidatesInExecutionOrder.sort(
      (left, right) => left.callIndex - right.callIndex
    );

    const judgeTasks = buildJudgeTasks({
      cases: planned.cases,
      candidates,
      config,
      firstCallIndex: callIndex
    });
    const recordedComparisons = new Set<string>();
    for (const task of judgeTasks) {
      if (options.signal?.aborted) throw new BakeoffInterruptedError();
      if (!recordedComparisons.has(task.comparisonId)) {
        recordedComparisons.add(task.comparisonId);
        await artifacts.append("pairwise-map.ndjson", {
          matchupId: task.matchupId,
          comparisonId: task.comparisonId,
          caseId: task.case.caseId,
          judgeId: task.judge.id,
          judgeSeed: task.judgeSeed,
          left: {
            candidateId: task.leftCandidate.candidateId,
            generatorId: task.leftCandidate.generatorId,
            generatorSeed: task.leftCandidate.seed
          },
          right: {
            candidateId: task.rightCandidate.candidateId,
            generatorId: task.rightCandidate.generatorId,
            generatorSeed: task.rightCandidate.seed
          }
        });
      }
      await artifacts.append("judge-inputs.ndjson", {
        callIndex: task.callIndex,
        matchupId: task.matchupId,
        comparisonId: task.comparisonId,
        order: task.order,
        caseId: task.case.caseId,
        judgeSeed: task.judgeSeed,
        messages: task.messages,
        responseFormat: {
          type: "json_schema",
          jsonSchema: BAKEOFF_JUDGE_RESPONSE_JSON_SCHEMA
        },
        thinkingEnabled: BAKEOFF_THINKING_ENABLED
      });
    }
    const judgeExecutionTasks = scheduleByEndpointModel(
      judgeTasks,
      ({ judge }) => judge
    );
    const judgeResultsInExecutionOrder = await mapLimit(judgeExecutionTasks, config.concurrency, async (task) => {
      const result = await evaluateJudge({ task, config, env, fetcher, now });
      await artifacts.append("judge-results.ndjson", result);
      completedJudgeCalls += 1;
      return result;
    }, options.signal);
    const judgeResults = judgeResultsInExecutionOrder.sort(
      (left, right) => left.callIndex - right.callIndex
    );
    const summary = summarizeBakeoff(
      config,
      planned.callPlan,
      candidates,
      judgeTasks,
      judgeResults
    );
    await artifacts.json("summary.json", summary);
    await artifacts.json("manifest.json", {
      ...manifest,
      status: "complete",
      completedAt: now().toISOString(),
      actualCalls: summary.actualCalls
    });
    return { runDirectory: artifacts.runDirectory, summary };
  } catch (error) {
    const interrupted =
      error instanceof BakeoffInterruptedError || options.signal?.aborted === true;
    await artifacts.json(
      "manifest.json",
      interrupted
        ? {
            ...manifest,
            status: "interrupted",
            interruptedAt: now().toISOString(),
            actualCalls: {
              preflight: preflightRequests,
              generators: completedGeneratorCalls,
              judges: completedJudgeCalls,
              totalInference: completedGeneratorCalls + completedJudgeCalls,
              totalHttp:
                preflightRequests + completedGeneratorCalls + completedJudgeCalls
            }
          }
        : {
            ...manifest,
            status: "failed",
            failedAt: now().toISOString(),
            error: safeError(error)
          }
    );
    throw error;
  }
}

export function bakeoffPlanForDisplay(options: {
  databasePath: string;
  loadedBundles: readonly ForecastFactBundle[];
  cases: readonly PreparedBakeoffCase[];
  eligibleCaseCount: number;
  unavailable: readonly UnavailableBakeoffBundle[];
  callPlan: BakeoffCallPlan;
  config: BakeoffConfig;
}): Record<string, unknown> {
  return {
    sourceDatabase: resolve(options.databasePath),
    loadedBundles: options.loadedBundles.length,
    eligibleCases: options.eligibleCaseCount,
    unavailableBundles: options.unavailable.length,
    unavailableReasonCodes: Object.fromEntries(
      [...new Set(options.unavailable.map(({ reasonCode }) => reasonCode))].map((reasonCode) => [
        reasonCode,
        options.unavailable.filter((candidate) => candidate.reasonCode === reasonCode).length
      ])
    ),
    unavailableExamples: options.unavailable.slice(0, 8).map(
      ({ spotId, localDate, reasonCode, errorMessage }) => ({
        spotId,
        localDate,
        reasonCode,
        errorMessage: errorMessage ?? null
      })
    ),
    selectedCases: options.cases.length,
    spots: [...new Set(options.cases.map(({ snapshot }) => snapshot.spotId))],
    dates: [...new Set(options.cases.map(({ snapshot }) => snapshot.localDate))],
    promptVersion: SURF_ANALYSIS_PROMPT_VERSION,
    evaluationMode: options.config.evaluationMode,
    completionGate:
      options.config.evaluationMode === "generator_only"
        ? "hard_validator_only"
        : "hard_validator_plus_advisory_pairwise",
    outputSchemaVersion: SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
    judgePromptVersion: BAKEOFF_JUDGE_PROMPT_VERSION,
    productionResponseSchema: true,
    responseSchemaFingerprint: sha256(SURF_ANALYSIS_RESPONSE_JSON_SCHEMA),
    judgePromptFingerprint: sha256(BAKEOFF_JUDGE_SYSTEM_PROMPT),
    judgeResponseSchemaFingerprint: sha256(BAKEOFF_JUDGE_RESPONSE_JSON_SCHEMA),
    requestMaxBytes: BAKEOFF_REQUEST_MAX_BYTES,
    thinkingEnabled: BAKEOFF_THINKING_ENABLED,
    validatorIsAbsolute: true,
    judgeCanPublish: false,
    generators: options.config.generators.map(({ id, modelId }) => ({ id, modelId })),
    judges: options.config.judges.map(({ id, modelId }) => ({ id, modelId })),
    seeds: options.config.seeds,
    judgeSeeds: options.config.judgeSeeds,
    callPlan: options.callPlan,
    serializedJobs: jobSizeStats(options.cases),
    outputDirectory: options.config.outputDirectory
  };
}
