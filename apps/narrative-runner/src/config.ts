import { createHash, createHmac } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { NARRATIVE_PROTOCOL_DESCRIPTOR } from "@surf/narrative-contracts";

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
  activationId: string;
  artifactSha256: string;
  acceptedProtocolFingerprints: readonly string[];
  releaseSha: string;
  runtimeFingerprint: string;
  queue: {
    apiBaseUrl: string;
    accountId: string;
    queueId: string;
    name: string;
    deadLetterQueueName: string;
    retryDelaySeconds: number;
    apiToken: string;
  };
  omlx: {
    baseUrl: string;
    modelId: string;
    apiToken: string | null;
    enableThinking: boolean;
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

function boundedSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (
    value.length < 32 ||
    value !== env[name] ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${name} must be at least 32 characters without surrounding whitespace`);
  }
  return value;
}

function releaseSha(env: NodeJS.ProcessEnv, expectedReleaseSha: string): string {
  const value = required(env, "NARRATIVE_RUNNER_RELEASE_SHA");
  if (!/^[0-9a-f]{40}$/.test(value) || !/^[0-9a-f]{40}$/.test(expectedReleaseSha)) {
    throw new Error(
      "NARRATIVE_RUNNER_RELEASE_SHA and expected release argument must be exact lowercase 40-character release SHAs"
    );
  }
  if (value !== expectedReleaseSha) {
    throw new Error(
      "NARRATIVE_RUNNER_RELEASE_SHA must equal the immutable expected release SHA"
    );
  }
  return value;
}

function runtimeIdentity(env: NodeJS.ProcessEnv, sourceRevision: string) {
  const rawActivationId = env.NARRATIVE_RUNNER_ACTIVATION_ID;
  if (rawActivationId !== undefined && rawActivationId !== rawActivationId.trim()) {
    throw new Error("NARRATIVE_RUNNER_ACTIVATION_ID must not contain surrounding whitespace");
  }
  const activationId = rawActivationId || `development-${sourceRevision}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(activationId)) {
    throw new Error("NARRATIVE_RUNNER_ACTIVATION_ID must be a stable activation identifier");
  }
  const developmentArtifact = createHash("sha256")
    .update(`surf-narrative-runner-source:${sourceRevision}`)
    .digest("hex");
  const rawArtifactSha256 = env.NARRATIVE_RUNNER_ARTIFACT_SHA256;
  if (
    rawArtifactSha256 !== undefined &&
    rawArtifactSha256 !== rawArtifactSha256.trim()
  ) {
    throw new Error(
      "NARRATIVE_RUNNER_ARTIFACT_SHA256 must not contain surrounding whitespace"
    );
  }
  const artifactSha256 = rawArtifactSha256 || developmentArtifact;
  if (!/^[0-9a-f]{64}$/.test(artifactSha256)) {
    throw new Error("NARRATIVE_RUNNER_ARTIFACT_SHA256 must be an exact lowercase SHA-256");
  }
  return {
    activationId,
    artifactSha256,
    acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_DESCRIPTOR.fingerprint] as const
  };
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

function booleanSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be either true or false`);
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

export function loadRunnerConfig(
  env: NodeJS.ProcessEnv = process.env,
  expectedReleaseSha = ""
): RunnerConfig {
  const concurrency = integer(env, "NARRATIVE_RUNNER_CONCURRENCY", 1, 1, 100);
  const retryBaseSeconds = integer(
    env,
    "NARRATIVE_RUNNER_RETRY_BASE_SECONDS",
    30,
    1,
    43_200
  );
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
    120_000,
    pollIntervalMs,
    3_600_000
  );

  const resolvedReleaseSha = releaseSha(env, expectedReleaseSha);
  const identity = runtimeIdentity(env, resolvedReleaseSha);
  const statusHmacKey = boundedSecret(env, "NARRATIVE_RUNNER_STATUS_HMAC_KEY");
  const cloudflareApiBaseUrl = required(
    env,
    "NARRATIVE_RUNNER_CF_API_BASE_URL"
  );
  if (cloudflareApiBaseUrl !== "https://api.cloudflare.com/client/v4") {
    throw new Error(
      "NARRATIVE_RUNNER_CF_API_BASE_URL must be exactly https://api.cloudflare.com/client/v4"
    );
  }
  const baseConfig = {
    runnerId: env.NARRATIVE_RUNNER_ID?.trim() || hostname(),
    ...identity,
    releaseSha: resolvedReleaseSha,
    queue: {
      apiBaseUrl: cloudflareApiBaseUrl,
      accountId: required(env, "NARRATIVE_RUNNER_CF_ACCOUNT_ID"),
      queueId: required(env, "NARRATIVE_RUNNER_CF_QUEUE_ID"),
      name: required(env, "NARRATIVE_RUNNER_CF_QUEUE_NAME"),
      deadLetterQueueName: required(env, "NARRATIVE_RUNNER_CF_DLQ_NAME"),
      retryDelaySeconds: retryBaseSeconds,
      apiToken: required(env, "NARRATIVE_RUNNER_CF_API_TOKEN")
    },
    omlx: {
      baseUrl,
      modelId: required(env, "NARRATIVE_RUNNER_OMLX_MODEL"),
      apiToken: env.NARRATIVE_RUNNER_OMLX_API_TOKEN?.trim() || null,
      enableThinking: booleanSetting(
        env,
        "NARRATIVE_RUNNER_OMLX_ENABLE_THINKING",
        false
      ),
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
    retryBaseSeconds,
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
  const runtimeFingerprint = createHmac("sha256", statusHmacKey)
    .update(
      JSON.stringify({
        ...baseConfig,
        targets: [...baseConfig.targets.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      })
    )
    .digest("hex");
  return { ...baseConfig, runtimeFingerprint };
}

export function redactedConfigSummary(config: RunnerConfig): Record<string, unknown> {
  return {
    runnerId: config.runnerId,
    activationId: config.activationId,
    artifactSha256: config.artifactSha256,
    sourceRevision: config.releaseSha,
    acceptedProtocolFingerprints: config.acceptedProtocolFingerprints,
    runtimeFingerprint: config.runtimeFingerprint,
    modelId: config.omlx.modelId,
    queueName: config.queue.name,
    queueDeadLetterName: config.queue.deadLetterQueueName,
    omlxThinkingEnabled: config.omlx.enableThinking,
    concurrency: config.concurrency,
    visibilityTimeoutMs: config.visibilityTimeoutMs,
    queueTimeoutMs: config.queueTimeoutMs,
    targetIds: [...config.targets.keys()].sort(),
    statusFile: config.statusFile
  };
}
