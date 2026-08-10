import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9:._/-]*$/i);

const EndpointSchema = z
  .object({
    baseUrl: z.string().url(),
    tokenEnv: z
      .string()
      .regex(/^ANALYSIS_BAKEOFF_OMLX_[A-Z0-9_]*TOKEN$/)
      .optional(),
    allowRemote: z.literal(true).optional()
  })
  .strict();

const ModelSchema = z
  .object({
    id: IdentifierSchema,
    endpoint: IdentifierSchema,
    modelId: z.string().min(1).max(500)
  })
  .strict();

const BakeoffFileConfigSchema = z
  .object({
    evaluationMode: z.enum(["full", "generator_only"]).default("full"),
    databasePath: z.string().min(1).optional(),
    expectedBundleCount: z.number().int().min(1).max(10_000).default(55),
    caseLimit: z.number().int().min(1).max(10_000).default(55),
    outputDirectory: z.string().min(1).default(".analysis-bakeoff"),
    endpoints: z.record(IdentifierSchema, EndpointSchema),
    generators: z.array(ModelSchema).min(1).max(16),
    judges: z.array(ModelSchema).max(16).default([]),
    seeds: z
      .array(z.number().int().min(0).max(2_147_483_647))
      .min(1)
      .max(16)
      .default([17, 29, 43]),
    judgeSeeds: z
      .array(z.number().int().min(0).max(2_147_483_647))
      .min(1)
      .max(16)
      .default([59]),
    enableThinking: z.literal(false).default(false),
    concurrency: z.number().int().min(1).max(4).default(1),
    timeoutMs: z.number().int().min(1_000).max(900_000).default(300_000),
    responseMaxBytes: z
      .number()
      .int()
      .min(16 * 1_024)
      .max(4 * 1_024 * 1_024)
      .default(512 * 1_024)
  })
  .strict();

export type BakeoffEndpoint = {
  baseUrl: string;
  tokenEnv?: string;
  allowRemote: boolean;
};

export type BakeoffModel = z.infer<typeof ModelSchema>;

export type BakeoffConfig = {
  evaluationMode: "full" | "generator_only";
  databasePath: string | null;
  expectedBundleCount: number;
  caseLimit: number;
  outputDirectory: string;
  endpoints: Readonly<Record<string, BakeoffEndpoint>>;
  generators: BakeoffModel[];
  judges: BakeoffModel[];
  seeds: number[];
  judgeSeeds: number[];
  enableThinking: false;
  concurrency: number;
  timeoutMs: number;
  responseMaxBytes: number;
};

function normalizeBaseUrl(raw: string, label: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  const normalized = url.toString().replace(/\/$/, "");
  if (!new URL(normalized).pathname.endsWith("/v1")) {
    throw new Error(`${label} must end in /v1`);
  }
  return normalized;
}

function isLoopbackBaseUrl(raw: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(raw).hostname);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique IDs`);
  }
}

function uniqueNumbers(values: readonly number[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique values`);
  }
}

export function parseBakeoffConfig(
  value: unknown,
  options: { repositoryRoot: string }
): BakeoffConfig {
  const parsed = BakeoffFileConfigSchema.parse(value);
  const endpoints = Object.fromEntries(
    Object.entries(parsed.endpoints).map(([id, endpoint]) => {
      const baseUrl = normalizeBaseUrl(endpoint.baseUrl, `endpoint ${id}`);
      const loopback = isLoopbackBaseUrl(baseUrl);
      if (!loopback && endpoint.allowRemote !== true) {
        throw new Error(`endpoint ${id} requires allowRemote=true for a non-loopback host`);
      }
      if (!loopback && !endpoint.tokenEnv) {
        throw new Error(`remote endpoint ${id} must use a dedicated bakeoff tokenEnv`);
      }
      return [
        id,
        {
          baseUrl,
          ...(endpoint.tokenEnv ? { tokenEnv: endpoint.tokenEnv } : {}),
          allowRemote: endpoint.allowRemote === true
        }
      ];
    })
  );
  if (Object.keys(endpoints).length === 0) {
    throw new Error("endpoints must not be empty");
  }
  unique(parsed.generators.map(({ id }) => id), "generators");
  unique(parsed.judges.map(({ id }) => id), "judges");
  const modelKey = ({ endpoint, modelId }: { endpoint: string; modelId: string }) =>
    `${endpoint}\u0000${modelId}`;
  unique(parsed.generators.map(modelKey), "generator endpoint/model pairs");
  unique(parsed.judges.map(modelKey), "judge endpoint/model pairs");
  uniqueNumbers(parsed.seeds, "seeds");
  uniqueNumbers(parsed.judgeSeeds, "judgeSeeds");
  for (const model of [...parsed.generators, ...parsed.judges]) {
    if (!endpoints[model.endpoint]) {
      throw new Error(`Model ${model.id} references unknown endpoint ${model.endpoint}`);
    }
  }
  if (
    parsed.evaluationMode === "generator_only" &&
    (parsed.generators.length !== 1 || parsed.judges.length !== 0)
  ) {
    throw new Error(
      "generator_only evaluationMode requires exactly one generator and zero judges"
    );
  }
  if (parsed.evaluationMode === "full" && parsed.judges.length === 0) {
    throw new Error(
      "full evaluationMode requires at least one judge; use generator_only explicitly for a validator-only run"
    );
  }
  if (parsed.judges.length > 0 && parsed.generators.length < 2) {
    throw new Error("Pairwise judging requires at least two generators");
  }
  const generatorModels = new Set(parsed.generators.map(modelKey));
  for (const judge of parsed.judges) {
    if (generatorModels.has(modelKey(judge))) {
      throw new Error(
        `Judge ${judge.id} must not use the same endpoint/model pair as a generator`
      );
    }
  }
  if (parsed.caseLimit > parsed.expectedBundleCount) {
    throw new Error("caseLimit must not exceed expectedBundleCount");
  }
  const outputDirectory = resolve(options.repositoryRoot, parsed.outputDirectory);
  const ignoredArtifactRoot = resolve(options.repositoryRoot, ".analysis-bakeoff");
  const relativeOutput = relative(ignoredArtifactRoot, outputDirectory);
  if (
    isAbsolute(relativeOutput) ||
    relativeOutput === ".." ||
    relativeOutput.startsWith(`..${sep}`)
  ) {
    throw new Error("outputDirectory must be .analysis-bakeoff or one of its subdirectories");
  }
  return {
    evaluationMode: parsed.evaluationMode,
    databasePath: parsed.databasePath
      ? resolve(options.repositoryRoot, parsed.databasePath)
      : null,
    expectedBundleCount: parsed.expectedBundleCount,
    caseLimit: parsed.caseLimit,
    outputDirectory,
    endpoints,
    generators: parsed.generators,
    judges: parsed.judges,
    seeds: parsed.seeds,
    judgeSeeds: parsed.judgeSeeds,
    enableThinking: parsed.enableThinking,
    concurrency: parsed.concurrency,
    timeoutMs: parsed.timeoutMs,
    responseMaxBytes: parsed.responseMaxBytes
  };
}

export async function loadBakeoffConfig(
  path: string,
  options: { repositoryRoot: string }
): Promise<BakeoffConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Bakeoff config is not valid JSON: ${path}`);
    }
    throw error;
  }
  return parseBakeoffConfig(value, options);
}

export function redactedBakeoffConfig(config: BakeoffConfig): Record<string, unknown> {
  return {
    evaluationMode: config.evaluationMode,
    databasePath: config.databasePath,
    expectedBundleCount: config.expectedBundleCount,
    caseLimit: config.caseLimit,
    outputDirectory: config.outputDirectory,
    endpoints: Object.fromEntries(
      Object.entries(config.endpoints).map(([id, endpoint]) => [
        id,
        {
          baseUrl: endpoint.baseUrl,
          authenticated: endpoint.tokenEnv !== undefined,
          tokenEnv: endpoint.tokenEnv ?? null,
          allowRemote: endpoint.allowRemote
        }
      ])
    ),
    generators: config.generators,
    judges: config.judges,
    seeds: config.seeds,
    judgeSeeds: config.judgeSeeds,
    enableThinking: config.enableThinking,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    responseMaxBytes: config.responseMaxBytes
  };
}

export function resolveEndpointToken(
  endpoint: BakeoffEndpoint,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!endpoint.tokenEnv) return null;
  const token = env[endpoint.tokenEnv]?.trim();
  if (!token) throw new Error(`Missing configured oMLX credential ${endpoint.tokenEnv}`);
  return token;
}
