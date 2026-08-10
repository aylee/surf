import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const TargetConfigSchema = z
  .object({
    url: z.string().url(),
    tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/)
  })
  .strict();

const TargetMapSchema = z.record(
  z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9:._-]*$/i),
  TargetConfigSchema
);

export type ResultTargetConfig = {
  url: string;
  token: string;
};

export type RunnerConfig = {
  runnerId: string;
  queue: {
    apiBaseUrl: string;
    accountId: string;
    queueId: string;
    apiToken: string;
  };
  omlx: {
    baseUrl: string;
    modelId: string;
    apiToken: string | null;
    timeoutMs: number;
  };
  targets: ReadonlyMap<string, ResultTargetConfig>;
  concurrency: number;
  visibilityTimeoutMs: number;
  queueTimeoutMs: number;
  pollIntervalMs: number;
  idleMaxMs: number;
  heartbeatIntervalMs: number;
  preflightIntervalMs: number;
  modelBackoffMs: number;
  resultTimeoutMs: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  statusFile: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required runtime setting ${name}`);
  return value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function normalizedUrl(raw: string, options: { loopbackHttp: boolean; label: string }): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${options.label} must not contain credentials, query, or fragment`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(options.loopbackHttp && url.protocol === "http:" && loopback)) {
    throw new Error(`${options.label} must use HTTPS or loopback HTTP`);
  }
  return url.toString().replace(/\/$/, "");
}

function parseTargets(env: NodeJS.ProcessEnv): ReadonlyMap<string, ResultTargetConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(required(env, "NARRATIVE_RUNNER_TARGET_MAP_JSON"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("NARRATIVE_RUNNER_TARGET_MAP_JSON must be valid JSON");
    }
    throw error;
  }
  const parsed = TargetMapSchema.parse(raw);
  const targets = new Map<string, ResultTargetConfig>();
  for (const [targetId, target] of Object.entries(parsed)) {
    targets.set(targetId, {
      url: normalizedUrl(target.url, {
        loopbackHttp: true,
        label: `result target ${targetId}`
      }),
      token: required(env, target.tokenEnv)
    });
  }
  if (targets.size === 0) throw new Error("NARRATIVE_RUNNER_TARGET_MAP_JSON must not be empty");
  return targets;
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const concurrency = integer(env, "NARRATIVE_RUNNER_CONCURRENCY", 1, 1, 100);
  const omlxTimeoutMs = integer(
    env,
    "NARRATIVE_RUNNER_OMLX_TIMEOUT_MS",
    600_000,
    1_000,
    43_000_000
  );
  const resultTimeoutMs = integer(
    env,
    "NARRATIVE_RUNNER_RESULT_TIMEOUT_MS",
    30_000,
    1_000,
    300_000
  );
  const visibilityTimeoutMs = integer(
    env,
    "NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS",
    900_000,
    1_000,
    43_200_000
  );
  const queueTimeoutMs = integer(
    env,
    "NARRATIVE_RUNNER_QUEUE_TIMEOUT_MS",
    30_000,
    1_000,
    300_000
  );
  if (
    visibilityTimeoutMs <
    omlxTimeoutMs + resultTimeoutMs + queueTimeoutMs + 5_000
  ) {
    throw new Error(
      "NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS must cover model, result, Queue settlement, and a 5 second margin"
    );
  }

  const baseUrl = normalizedUrl(required(env, "NARRATIVE_RUNNER_OMLX_BASE_URL"), {
    loopbackHttp: true,
    label: "NARRATIVE_RUNNER_OMLX_BASE_URL"
  });
  if (!new URL(baseUrl).pathname.endsWith("/v1")) {
    throw new Error("NARRATIVE_RUNNER_OMLX_BASE_URL must end in /v1");
  }

  const pollIntervalMs = integer(
    env,
    "NARRATIVE_RUNNER_POLL_INTERVAL_MS",
    5_000,
    250,
    300_000
  );
  const idleMaxMs = integer(
    env,
    "NARRATIVE_RUNNER_IDLE_MAX_MS",
    600_000,
    pollIntervalMs,
    3_600_000
  );

  return {
    runnerId: env.NARRATIVE_RUNNER_ID?.trim() || hostname(),
    queue: {
      apiBaseUrl: normalizedUrl(required(env, "NARRATIVE_RUNNER_CF_API_BASE_URL"), {
        loopbackHttp: false,
        label: "NARRATIVE_RUNNER_CF_API_BASE_URL"
      }),
      accountId: required(env, "NARRATIVE_RUNNER_CF_ACCOUNT_ID"),
      queueId: required(env, "NARRATIVE_RUNNER_CF_QUEUE_ID"),
      apiToken: required(env, "NARRATIVE_RUNNER_CF_API_TOKEN")
    },
    omlx: {
      baseUrl,
      modelId: required(env, "NARRATIVE_RUNNER_OMLX_MODEL"),
      apiToken: env.NARRATIVE_RUNNER_OMLX_API_TOKEN?.trim() || null,
      timeoutMs: omlxTimeoutMs
    },
    targets: parseTargets(env),
    concurrency,
    visibilityTimeoutMs,
    queueTimeoutMs,
    pollIntervalMs,
    idleMaxMs,
    heartbeatIntervalMs: integer(
      env,
      "NARRATIVE_RUNNER_HEARTBEAT_INTERVAL_MS",
      15_000,
      1_000,
      60_000
    ),
    preflightIntervalMs: integer(
      env,
      "NARRATIVE_RUNNER_PREFLIGHT_INTERVAL_MS",
      60_000,
      1_000,
      3_600_000
    ),
    modelBackoffMs: integer(
      env,
      "NARRATIVE_RUNNER_MODEL_BACKOFF_MS",
      30_000,
      1_000,
      3_600_000
    ),
    resultTimeoutMs,
    retryBaseSeconds: integer(
      env,
      "NARRATIVE_RUNNER_RETRY_BASE_SECONDS",
      30,
      1,
      43_200
    ),
    retryMaxSeconds: integer(
      env,
      "NARRATIVE_RUNNER_RETRY_MAX_SECONDS",
      3_600,
      1,
      43_200
    ),
    statusFile: resolve(
      env.NARRATIVE_RUNNER_STATUS_FILE?.trim() || "dist/narrative-runner/status.json"
    )
  };
}

export function redactedConfigSummary(config: RunnerConfig): Record<string, unknown> {
  return {
    runnerId: config.runnerId,
    modelId: config.omlx.modelId,
    concurrency: config.concurrency,
    visibilityTimeoutMs: config.visibilityTimeoutMs,
    queueTimeoutMs: config.queueTimeoutMs,
    targetIds: [...config.targets.keys()].sort(),
    statusFile: config.statusFile
  };
}
