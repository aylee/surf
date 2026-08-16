import { execFile } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  assertSupportedRunnerEnvironment,
  parseStrictDotenv
} from "./strict-env-file.mjs";
import { verifyLaunchActivation } from "../../apps/narrative-runner/scripts/render-launch-agents.mjs";

const execFileAsync = promisify(execFile);
const ACTIVATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const HEX_40_PATTERN = /^[0-9a-f]{40}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const RUNNER_LABEL = "ai.alex.narrative-runner";
const OMLX_LABEL = "ai.alex.omlx-server";
const RESULT_CALLBACK_PATH = "/api/internal/narratives/results";
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_GUARD_CHECK_BYTES = 64 * 1024;
const MAX_PLIST_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 60_000;

function exactObjectKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} schema is invalid`);
  }
}

function boundedString(value, label, maximum = 1024) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedSecret(value, label, minimum = 32) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > 16_384 ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value) ||
    /placeholder|replace[-_ ]?me/i.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

async function canonicalDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute directory`);
  }
  let metadata;
  let canonical;
  try {
    [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
  } catch {
    throw new Error(`${label} must be a readable canonical directory`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || resolve(path) !== canonical) {
    throw new Error(`${label} must be a canonical non-symlink directory`);
  }
  return canonical;
}

async function privateFileSnapshot(path, label, maximumBytes) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw new Error(
      `${label} must be a readable bounded canonical non-symlink mode-0600 regular file`
    );
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > maximumBytes
    ) {
      throw new Error(
        `${label} must be a bounded canonical non-symlink mode-0600 regular file`
      );
    }
    const contents = await handle.readFile();
    const [after, pathMetadata, canonical] = await Promise.all([
      handle.stat(),
      lstat(path),
      realpath(path)
    ]);
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      resolve(path) !== canonical ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== pathMetadata.dev ||
      after.ino !== pathMetadata.ino ||
      after.size !== pathMetadata.size ||
      after.mtimeMs !== pathMetadata.mtimeMs ||
      contents.byteLength !== after.size ||
      contents.byteLength > maximumBytes
    ) {
      throw new Error(
        `${label} changed while its private snapshot was being read`
      );
    }
    return {
      path: canonical,
      contents,
      sha256: createHash("sha256").update(contents).digest("hex")
    };
  } finally {
    await handle.close();
  }
}

function parseJson(contents, label) {
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function activationRecordShape(record, activationId) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schemaVersion !== 4 ||
    record.activationId !== activationId ||
    !HEX_40_PATTERN.test(record.source?.revision ?? "") ||
    !HEX_64_PATTERN.test(record.runnerArtifact?.sha256 ?? "") ||
    !HEX_64_PATTERN.test(record.runtime?.environmentFingerprint ?? "") ||
    typeof record.runtime?.environmentPath !== "string" ||
    typeof record.runtime?.statusFile !== "string" ||
    typeof record.model?.id !== "string" ||
    !Array.isArray(record.acceptedProtocols) ||
    record.acceptedProtocols.length < 1 ||
    record.acceptedProtocols.length > 16 ||
    typeof record.launchAgents?.narrativeRunner?.path !== "string" ||
    !HEX_64_PATTERN.test(record.launchAgents?.narrativeRunner?.sha256 ?? "") ||
    typeof record.launchAgents?.omlxServer?.path !== "string" ||
    !HEX_64_PATTERN.test(record.launchAgents?.omlxServer?.sha256 ?? "") ||
    typeof record.executables?.node?.path !== "string" ||
    typeof record.executables?.runnerGuard?.path !== "string"
  ) {
    throw new Error("active runner activation record v4 schema is invalid");
  }
  const fingerprints = record.acceptedProtocols.map((descriptor) => {
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      descriptor.family !== "surf.narrative" ||
      !Number.isInteger(descriptor.version) ||
      descriptor.version < 1 ||
      !HEX_64_PATTERN.test(descriptor.fingerprint ?? "")
    ) {
      throw new Error("active runner protocol descriptor is invalid");
    }
    return descriptor.fingerprint;
  });
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("active runner protocol fingerprints must be unique");
  }
  return fingerprints;
}

function legacyActivationRecordShape(record) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schemaVersion !== 3 ||
    !HEX_40_PATTERN.test(record.releaseSha ?? "") ||
    typeof record.repositoryPath !== "string" ||
    !isAbsolute(record.repositoryPath) ||
    typeof record.runnerEnvPath !== "string" ||
    !isAbsolute(record.runnerEnvPath) ||
    typeof record.statusFile !== "string" ||
    !isAbsolute(record.statusFile) ||
    !HEX_64_PATTERN.test(record.runnerEnvironmentFingerprint ?? "") ||
    typeof record.modelId !== "string" ||
    record.modelId.length < 1 ||
    record.modelId.length > 1024 ||
    typeof record.launchAgents?.narrativeRunner?.path !== "string" ||
    !HEX_64_PATTERN.test(record.launchAgents?.narrativeRunner?.sha256 ?? "")
  ) {
    throw new Error("legacy runner activation record v3 transition shape is invalid");
  }
}

function parseRunnerStatus(contents) {
  const value = parseJson(contents, "Runner status file");
  exactObjectKeys(
    value,
    [
      "schemaVersion",
      "runnerId",
      "pid",
      "modelId",
      "activationId",
      "runnerArtifactSha256",
      "sourceRevision",
      "runtimeFingerprint",
      "acceptedProtocolFingerprints",
      "state",
      "startedAt",
      "updatedAt",
      "inFlight",
      "pulled",
      "acked",
      "retried",
      "terminal",
      "backlogCount",
      "lastOutcome",
      "lastErrorCode"
    ],
    "Runner status file"
  );
  if (value.schemaVersion !== 3) throw new Error("Runner status schema version is invalid");
  boundedString(value.runnerId, "Runner status runnerId");
  positiveInteger(value.pid, "Runner status pid");
  boundedString(value.modelId, "Runner status modelId");
  if (!ACTIVATION_ID_PATTERN.test(value.activationId ?? "")) {
    throw new Error("Runner status activationId is invalid");
  }
  for (const [name, candidate, pattern] of [
    ["runner artifact", value.runnerArtifactSha256, HEX_64_PATTERN],
    ["source revision", value.sourceRevision, HEX_40_PATTERN],
    ["runtime fingerprint", value.runtimeFingerprint, HEX_64_PATTERN]
  ]) {
    if (!pattern.test(candidate ?? "")) throw new Error(`Runner status ${name} is invalid`);
  }
  if (
    !Array.isArray(value.acceptedProtocolFingerprints) ||
    value.acceptedProtocolFingerprints.length < 1 ||
    value.acceptedProtocolFingerprints.length > 16 ||
    value.acceptedProtocolFingerprints.some((item) => !HEX_64_PATTERN.test(item)) ||
    new Set(value.acceptedProtocolFingerprints).size !==
      value.acceptedProtocolFingerprints.length
  ) {
    throw new Error("Runner status protocol fingerprints are invalid");
  }
  if (
    !["starting", "idle", "processing", "backing_off", "halted", "stopped"].includes(
      value.state
    )
  ) {
    throw new Error("Runner status state is invalid");
  }
  const startedAt = Date.parse(value.startedAt);
  const updatedAt = Date.parse(value.updatedAt);
  const isoOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    !isoOffset.test(value.startedAt ?? "") ||
    !isoOffset.test(value.updatedAt ?? "") ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(updatedAt) ||
    updatedAt < startedAt
  ) {
    throw new Error("Runner status timestamps are invalid");
  }
  for (const name of ["inFlight", "pulled", "acked", "retried", "terminal"]) {
    nonnegativeInteger(value[name], `Runner status ${name}`);
  }
  if (value.backlogCount !== null) {
    nonnegativeInteger(value.backlogCount, "Runner status backlogCount");
  }
  for (const name of ["lastOutcome", "lastErrorCode"]) {
    if (value[name] !== null) boundedString(value[name], `Runner status ${name}`);
  }
  return { value, updatedAt };
}

function parseRunnerGuardCheck(stdout) {
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") > MAX_GUARD_CHECK_BYTES
  ) {
    throw new Error("Active runner live check output is invalid");
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new Error("Active runner live check output is ambiguous");
  }
  const value = parseJson(
    Buffer.from(lines[0], "utf8"),
    "Active runner live check output"
  );
  exactObjectKeys(
    value,
    ["command", "config", "queue", "omlx"],
    "Active runner live check output"
  );
  if (value.command !== "check") {
    throw new Error("Active runner live check command is invalid");
  }

  exactObjectKeys(
    value.config,
    [
      "runnerId",
      "activationId",
      "artifactSha256",
      "sourceRevision",
      "acceptedProtocolFingerprints",
      "runtimeFingerprint",
      "modelId",
      "queueName",
      "queueDeadLetterName",
      "omlxThinkingEnabled",
      "concurrency",
      "visibilityTimeoutMs",
      "queueTimeoutMs",
      "targetIds",
      "statusFile"
    ],
    "Active runner live check config"
  );
  const config = value.config;
  boundedString(config.runnerId, "Active runner live check runnerId");
  if (!ACTIVATION_ID_PATTERN.test(config.activationId ?? "")) {
    throw new Error("Active runner live check activationId is invalid");
  }
  for (const [name, candidate, pattern] of [
    ["artifact", config.artifactSha256, HEX_64_PATTERN],
    ["source revision", config.sourceRevision, HEX_40_PATTERN],
    ["runtime fingerprint", config.runtimeFingerprint, HEX_64_PATTERN]
  ]) {
    if (!pattern.test(candidate ?? "")) {
      throw new Error(`Active runner live check ${name} is invalid`);
    }
  }
  if (
    !Array.isArray(config.acceptedProtocolFingerprints) ||
    config.acceptedProtocolFingerprints.length < 1 ||
    config.acceptedProtocolFingerprints.length > 16 ||
    config.acceptedProtocolFingerprints.some(
      (fingerprint) => !HEX_64_PATTERN.test(fingerprint)
    ) ||
    new Set(config.acceptedProtocolFingerprints).size !==
      config.acceptedProtocolFingerprints.length
  ) {
    throw new Error("Active runner live check protocol fingerprints are invalid");
  }
  boundedString(config.modelId, "Active runner live check modelId");
  boundedString(config.queueName, "Active runner live check Queue name", 256);
  boundedString(
    config.queueDeadLetterName,
    "Active runner live check dead-letter Queue name",
    256
  );
  if (typeof config.omlxThinkingEnabled !== "boolean") {
    throw new Error("Active runner live check model thinking setting is invalid");
  }
  positiveInteger(config.concurrency, "Active runner live check concurrency");
  positiveInteger(
    config.visibilityTimeoutMs,
    "Active runner live check visibility timeout"
  );
  positiveInteger(config.queueTimeoutMs, "Active runner live check Queue timeout");
  if (
    !Array.isArray(config.targetIds) ||
    config.targetIds.length < 1 ||
    config.targetIds.length > 1024 ||
    config.targetIds.some(
      (targetId) =>
        typeof targetId !== "string" ||
        targetId.length < 1 ||
        targetId.length > 160 ||
        !/^[a-z0-9][a-z0-9:._-]*$/i.test(targetId)
    ) ||
    new Set(config.targetIds).size !== config.targetIds.length
  ) {
    throw new Error("Active runner live check target IDs are invalid");
  }
  boundedString(config.statusFile, "Active runner live check status file", 16_384);
  if (!isAbsolute(config.statusFile)) {
    throw new Error("Active runner live check status file is invalid");
  }

  exactObjectKeys(
    value.queue,
    ["ready", "code", "queueName", "consumerType", "deadLetterQueueName"],
    "Active runner live check Queue result"
  );
  if (
    value.queue.ready !== true ||
    value.queue.code !== null ||
    value.queue.queueName !== config.queueName ||
    value.queue.consumerType !== "http_pull" ||
    value.queue.deadLetterQueueName !== config.queueDeadLetterName
  ) {
    throw new Error("Active runner live Queue preflight output is not ready");
  }
  exactObjectKeys(
    value.omlx,
    ["ready", "code"],
    "Active runner live check model result"
  );
  if (value.omlx.ready !== true || value.omlx.code !== null) {
    throw new Error("Active runner live model preflight output is not ready");
  }
  return Object.freeze(config);
}

function assertRunnerGuardMatchesStatus(config, status) {
  if (
    config.runnerId !== status.runnerId ||
    config.activationId !== status.activationId ||
    config.artifactSha256 !== status.runnerArtifactSha256 ||
    config.sourceRevision !== status.sourceRevision ||
    config.runtimeFingerprint !== status.runtimeFingerprint ||
    config.modelId !== status.modelId ||
    JSON.stringify(config.acceptedProtocolFingerprints) !==
      JSON.stringify(status.acceptedProtocolFingerprints)
  ) {
    throw new Error("Active runner live check semantic identity differs from runner status");
  }
}

function environmentInteger(values, name, fallback, minimum, maximum) {
  const raw = values[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid in the active runner environment`);
  }
  return value;
}

function statusFreshnessThresholdMs(values) {
  const idleMaxMs = environmentInteger(
    values,
    "NARRATIVE_RUNNER_IDLE_MAX_MS",
    120_000,
    250,
    3_600_000
  );
  const pollIntervalMs = environmentInteger(
    values,
    "NARRATIVE_RUNNER_POLL_INTERVAL_MS",
    5_000,
    250,
    300_000
  );
  if (idleMaxMs < pollIntervalMs) {
    throw new Error("NARRATIVE_RUNNER_IDLE_MAX_MS is invalid in the active runner environment");
  }
  const heartbeatIntervalMs = environmentInteger(
    values,
    "NARRATIVE_RUNNER_HEARTBEAT_INTERVAL_MS",
    15_000,
    1_000,
    60_000
  );
  const queueTimeoutMs = environmentInteger(
    values,
    "NARRATIVE_RUNNER_QUEUE_TIMEOUT_MS",
    30_000,
    1_000,
    300_000
  );
  const omlxTimeoutMs = environmentInteger(
    values,
    "NARRATIVE_RUNNER_OMLX_TIMEOUT_MS",
    600_000,
    1_000,
    43_000_000
  );
  return Math.max(
    idleMaxMs +
      queueTimeoutMs +
      Math.min(omlxTimeoutMs, 30_000) +
      Math.max(10_000, pollIntervalMs * 2),
    heartbeatIntervalMs * 3
  );
}

function canonicalHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Expected callback origin must be a bare HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("Expected callback origin must be a bare HTTPS origin");
  }
  return parsed.origin;
}

function exactBindingValue(value, label) {
  return boundedString(value, label, 256);
}

function hmac(key, domain, value) {
  return createHmac("sha256", key)
    .update(domain)
    .update("\u0000")
    .update(value)
    .digest();
}

function hmacHex(key, domain, value) {
  return hmac(key, domain, value).toString("hex");
}

function secretsEqual(key, left, right) {
  return timingSafeEqual(
    hmac(key, "surf-runner-result-token-compare-v1", left),
    hmac(key, "surf-runner-result-token-compare-v1", right)
  );
}

function runnerEnvironmentFingerprint(environment, key) {
  const canonical = Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
  );
  return createHmac("sha256", key)
    .update("surf-runner-env-v1")
    .update("\u0000")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function verifyBindings(environment, options) {
  assertSupportedRunnerEnvironment(environment);
  const statusHmacKey = boundedSecret(
    environment.NARRATIVE_RUNNER_STATUS_HMAC_KEY,
    "Active runner status HMAC key"
  );
  const queueApiToken = boundedSecret(
    environment.NARRATIVE_RUNNER_CF_API_TOKEN,
    "Active runner Queue API token",
    16
  );
  const accountId = exactBindingValue(
    environment.NARRATIVE_RUNNER_CF_ACCOUNT_ID,
    "Active runner Cloudflare account ID"
  );
  const queueId = exactBindingValue(
    environment.NARRATIVE_RUNNER_CF_QUEUE_ID,
    "Active runner Queue ID"
  );
  const queueName = exactBindingValue(
    environment.NARRATIVE_RUNNER_CF_QUEUE_NAME,
    "Active runner Queue name"
  );
  const deadLetterQueueName = exactBindingValue(
    environment.NARRATIVE_RUNNER_CF_DLQ_NAME,
    "Active runner dead-letter Queue name"
  );
  const expectedQueueName = exactBindingValue(options.expectedQueueName, "Expected Queue name");
  const expectedDeadLetterQueueName = exactBindingValue(
    options.expectedDeadLetterQueueName,
    "Expected dead-letter Queue name"
  );
  const expectedAccountId = exactBindingValue(
    options.expectedCloudflareAccountId,
    "Expected Cloudflare account ID"
  );
  const expectedQueueId = exactBindingValue(
    options.expectedQueueId,
    "Expected Queue ID"
  );
  if (accountId !== expectedAccountId) {
    throw new Error("Active runner Cloudflare account binding is incompatible");
  }
  if (queueId !== expectedQueueId) {
    throw new Error("Active runner Queue ID binding is incompatible");
  }
  if (queueName !== expectedQueueName) throw new Error("Active runner Queue binding is incompatible");
  if (deadLetterQueueName !== expectedDeadLetterQueueName) {
    throw new Error("Active runner dead-letter Queue binding is incompatible");
  }

  const resultTargetId = boundedString(
    options.expectedResultTargetId ?? "surf.analysis.v5",
    "Expected result target ID",
    160
  );
  if (!/^[a-z0-9][a-z0-9:._-]*$/i.test(resultTargetId)) {
    throw new Error("Expected result target ID is invalid");
  }
  let targetMap;
  try {
    targetMap = JSON.parse(environment.NARRATIVE_RUNNER_TARGET_MAP_JSON);
  } catch {
    throw new Error("Active runner target map is invalid");
  }
  const target = targetMap?.[resultTargetId];
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("Active runner result target is incompatible");
  }
  const targetKeys = Object.keys(target).sort();
  if (targetKeys.join(",") !== "tokenEnv,url") {
    throw new Error("Active runner result target is incompatible");
  }
  if (target.tokenEnv !== "SURF_NARRATIVE_RESULT_TOKEN") {
    throw new Error("Active runner result-token binding is incompatible");
  }
  const callbackOrigin = canonicalHttpsOrigin(options.expectedCallbackOrigin);
  const expectedCallbackUrl = new URL(RESULT_CALLBACK_PATH, `${callbackOrigin}/`).toString();
  let actualCallbackUrl;
  try {
    actualCallbackUrl = new URL(target.url).toString();
  } catch {
    throw new Error("Active runner callback is incompatible");
  }
  if (actualCallbackUrl !== expectedCallbackUrl || target.url !== actualCallbackUrl) {
    throw new Error("Active runner callback is incompatible");
  }
  const runnerResultToken = boundedSecret(
    environment.SURF_NARRATIVE_RESULT_TOKEN,
    "Active runner result token"
  );
  const workerResultToken = boundedSecret(options.workerResultToken, "Worker result token", 16);
  const workerGeminiToken = boundedSecret(
    options.workerGeminiToken,
    "Worker Gemini token",
    16
  );
  if (!secretsEqual(statusHmacKey, runnerResultToken, workerResultToken)) {
    throw new Error("Active runner result token is incompatible");
  }
  const roleSecrets = [
    ["status-HMAC", statusHmacKey],
    ["Queue", queueApiToken],
    ["result", runnerResultToken],
    ["Gemini", workerGeminiToken]
  ];
  for (let left = 0; left < roleSecrets.length; left += 1) {
    for (let right = left + 1; right < roleSecrets.length; right += 1) {
      if (
        secretsEqual(
          statusHmacKey,
          roleSecrets[left][1],
          roleSecrets[right][1]
        )
      ) {
        throw new Error(
          "Queue, status-HMAC, result, and Gemini secret roles must be distinct"
        );
      }
    }
  }

  return {
    resultTargetId,
    environmentFingerprint: runnerEnvironmentFingerprint(environment, statusHmacKey),
    fingerprints: {
      queue: hmacHex(statusHmacKey, "surf-runner-queue-v1", queueName),
      cloudflareAccount: hmacHex(
        statusHmacKey,
        "surf-runner-cloudflare-account-v1",
        accountId
      ),
      queueId: hmacHex(statusHmacKey, "surf-runner-queue-id-v1", queueId),
      deadLetterQueue: hmacHex(
        statusHmacKey,
        "surf-runner-dead-letter-queue-v1",
        deadLetterQueueName
      ),
      callback: hmacHex(statusHmacKey, "surf-runner-callback-v1", actualCallbackUrl),
      resultToken: hmacHex(
        statusHmacKey,
        "surf-runner-result-token-v1",
        runnerResultToken
      )
    }
  };
}

export function verifyRunnerEnvironmentBindings(environment, options) {
  return verifyBindings(environment, options);
}

async function defaultCommand(file, args, { timeoutMs }) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return { status: 0, stdout: result.stdout ?? "" };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ETIMEDOUT") {
      throw new Error("bounded runner identity command timed out");
    }
    return {
      status: typeof error?.code === "number" ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : ""
    };
  }
}

function dependencies(overrides = {}) {
  return {
    verifyActivation: overrides.verifyActivation ?? verifyLaunchActivation,
    command: overrides.command ?? defaultCommand,
    now: overrides.now ?? Date.now,
    pidAlive:
      overrides.pidAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return Boolean(error && typeof error === "object" && error.code === "EPERM");
        }
      }),
    uid: overrides.uid ?? process.getuid?.(),
    home: overrides.home ?? homedir()
  };
}

function parseLoadedJob(stdout, expectedPath, label) {
  if (typeof stdout !== "string" || stdout.length > 1024 * 1024) {
    throw new Error(`${label} launchctl attestation is invalid`);
  }
  const lines = stdout.split(/\r?\n/);
  const paths = lines
    .map((line) => {
      const match = line.match(/^([ \t]*)path = (.+)$/);
      return match ? { indentation: match[1], value: match[2] } : undefined;
    })
    .filter((value) => value !== undefined);
  if (paths.length !== 1 || paths[0].value !== expectedPath) {
    throw new Error(`${label} is not loaded from the exact recorded persistent plist`);
  }
  const rootIndentation = paths[0].indentation;
  const states = lines
    .map((line) => line.match(/^([ \t]*)state = (.+)$/))
    .filter((match) => match?.[1] === rootIndentation)
    .map((match) => match[2]);
  const pids = lines
    .map((line) => line.match(/^([ \t]*)pid = ([0-9]+)$/))
    .filter((match) => match?.[1] === rootIndentation)
    .map((match) => Number(match[2]));
  if (
    states.length !== 1 ||
    states[0] !== "running" ||
    pids.length !== 1 ||
    !Number.isSafeInteger(pids[0]) ||
    pids[0] < 1
  ) {
    throw new Error(`${label} is not loaded from the exact recorded persistent plist`);
  }
  return { pid: pids[0] };
}

async function attestLoadedJob(label, expectedPath, domain, deps) {
  const result = await deps.command(
    "/bin/launchctl",
    ["print", `${domain}/${label}`],
    { timeoutMs: COMMAND_TIMEOUT_MS }
  );
  if (result?.status !== 0) {
    throw new Error(`${label} is not loaded`);
  }
  return parseLoadedJob(result.stdout, expectedPath, label);
}

async function assertInstalledPlist(recorded, label) {
  const snapshot = await privateFileSnapshot(recorded.path, label, MAX_PLIST_BYTES);
  if (snapshot.sha256 !== recorded.sha256) {
    throw new Error(`${label} differs from the active runner activation record`);
  }
  return snapshot;
}

function parseProcessSnapshot(stdout, expectedPid, label) {
  if (typeof stdout !== "string" || stdout.length > 64 * 1024) {
    throw new Error(`${label} process attestation is invalid`);
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new Error(`${label} process attestation is ambiguous`);
  }
  const match = /^([1-9][0-9]*)\s+([0-9]+)\s+(.+)$/.exec(lines[0]);
  if (!match) throw new Error(`${label} process attestation is malformed`);
  const pid = Number(match[1]);
  const parentPid = Number(match[2]);
  const startedAt = match[3];
  if (
    pid !== expectedPid ||
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0
  ) {
    throw new Error(`${label} process identity is inconsistent`);
  }
  boundedString(startedAt, `${label} process start identity`, 128);
  return Object.freeze({ pid, parentPid, startedAt });
}

async function attestProcess(pid, label, deps) {
  const result = await deps.command(
    "/bin/ps",
    ["-o", "pid=,ppid=,lstart=", "-p", String(pid)],
    { timeoutMs: COMMAND_TIMEOUT_MS }
  );
  if (result?.status !== 0) {
    throw new Error(`${label} process is not inspectable`);
  }
  return parseProcessSnapshot(result.stdout, pid, label);
}

async function attestRunnerProcessTree(wrapperPid, heartbeatPid, deps) {
  if (
    !Number.isSafeInteger(wrapperPid) ||
    wrapperPid < 1 ||
    !Number.isSafeInteger(heartbeatPid) ||
    heartbeatPid < 1 ||
    wrapperPid === heartbeatPid
  ) {
    throw new Error("Runner wrapper and heartbeat child PIDs are not distinct");
  }
  if (!deps.pidAlive(wrapperPid) || !deps.pidAlive(heartbeatPid)) {
    throw new Error("Runner wrapper or heartbeat child process is not alive");
  }
  const [wrapper, heartbeat] = await Promise.all([
    attestProcess(wrapperPid, "Runner wrapper", deps),
    attestProcess(heartbeatPid, "Runner heartbeat child", deps)
  ]);
  if (heartbeat.parentPid !== wrapper.pid) {
    throw new Error("Runner heartbeat process is not a direct child of the loaded wrapper");
  }
  if (!deps.pidAlive(wrapperPid) || !deps.pidAlive(heartbeatPid)) {
    throw new Error("Runner wrapper or heartbeat child process changed during attestation");
  }
  return Object.freeze({ wrapper, heartbeat });
}

function assertSameRunnerProcessTree(before, after) {
  if (
    before.wrapper.pid !== after.wrapper.pid ||
    before.wrapper.startedAt !== after.wrapper.startedAt ||
    before.heartbeat.pid !== after.heartbeat.pid ||
    before.heartbeat.parentPid !== after.heartbeat.parentPid ||
    before.heartbeat.startedAt !== after.heartbeat.startedAt
  ) {
    throw new Error("Runner wrapper or heartbeat child process identity changed");
  }
}

function attestRunnerStatus(
  contents,
  record,
  acceptedProtocolFingerprints,
  { now, maximumAge, maximumFutureSkew }
) {
  const { value: status, updatedAt } = parseRunnerStatus(contents);
  if (
    status.activationId !== record.activationId ||
    status.runnerArtifactSha256 !== record.runnerArtifact.sha256 ||
    status.sourceRevision !== record.source.revision ||
    status.modelId !== record.model.id ||
    JSON.stringify(status.acceptedProtocolFingerprints) !==
      JSON.stringify(acceptedProtocolFingerprints)
  ) {
    throw new Error("Runner status identity differs from the activation record");
  }
  if (!["idle", "processing"].includes(status.state) || status.lastErrorCode !== null) {
    throw new Error("Active runner status is not healthy");
  }
  if (updatedAt > now + maximumFutureSkew || now - updatedAt > maximumAge) {
    throw new Error("Active runner status is stale or future-dated");
  }
  return Object.freeze({ status, updatedAt });
}

export async function verifyActiveRunnerCompatibility(options, overrides = {}) {
  if (!ACTIVATION_ID_PATTERN.test(options?.activationId ?? "")) {
    throw new Error("A trusted active runner activationId is required");
  }
  if (!HEX_64_PATTERN.test(options?.expectedProtocolFingerprint ?? "")) {
    throw new Error("Expected narrative protocol fingerprint is invalid");
  }
  const deps = dependencies(overrides);
  if (!Number.isInteger(deps.uid) || deps.uid < 0) {
    throw new Error("A numeric per-user UID is required for runner attestation");
  }
  const serviceRoot = await canonicalDirectory(options.serviceRoot, "Runner service root");
  const recordPath = resolve(
    serviceRoot,
    "launch-agents",
    options.activationId,
    "activation-record.json"
  );
  const recordBefore = await privateFileSnapshot(
    recordPath,
    "Active runner activation record",
    MAX_RECORD_BYTES
  );
  const record = parseJson(recordBefore.contents, "Active runner activation record");
  const acceptedProtocolFingerprints = activationRecordShape(record, options.activationId);
  if (!acceptedProtocolFingerprints.includes(options.expectedProtocolFingerprint)) {
    throw new Error("Active runner does not accept the expected narrative protocol");
  }

  const verification = await deps.verifyActivation(recordPath, {
    requireInstalled: true,
    allowLegacyV3: false
  });
  if (
    verification?.status !== "ok" ||
    verification.schemaVersion !== 4 ||
    verification.transitionOnly !== false ||
    verification.activationId !== options.activationId ||
    verification.releaseSha !== record.source.revision ||
    verification.runnerArtifactSha256 !== record.runnerArtifact.sha256 ||
    verification.modelId !== record.model.id ||
    JSON.stringify(
      verification.acceptedProtocols?.map((descriptor) => descriptor.fingerprint)
    ) !== JSON.stringify(acceptedProtocolFingerprints)
  ) {
    throw new Error("Active runner activation verification did not attest v4 identity");
  }
  const recordAfterVerification = await privateFileSnapshot(
    recordPath,
    "Active runner activation record",
    MAX_RECORD_BYTES
  );
  if (!recordBefore.contents.equals(recordAfterVerification.contents)) {
    throw new Error("Active runner activation record changed during verification");
  }

  await Promise.all([
    assertInstalledPlist(
      record.launchAgents.narrativeRunner,
      "Installed narrative runner plist"
    ),
    assertInstalledPlist(record.launchAgents.omlxServer, "Installed omlx plist")
  ]);
  const domain = `gui/${deps.uid}`;
  const [runnerJob, omlxJob] = await Promise.all([
    attestLoadedJob(RUNNER_LABEL, record.launchAgents.narrativeRunner.path, domain, deps),
    attestLoadedJob(OMLX_LABEL, record.launchAgents.omlxServer.path, domain, deps)
  ]);
  if (!deps.pidAlive(runnerJob.pid) || !deps.pidAlive(omlxJob.pid)) {
    throw new Error("Active runner LaunchAgent process identity is not alive");
  }

  const environmentBefore = await privateFileSnapshot(
    record.runtime.environmentPath,
    "Active runner environment",
    MAX_ENVIRONMENT_BYTES
  );
  const environment = parseStrictDotenv(
    environmentBefore.contents.toString("utf8"),
    "Active runner environment"
  );
  const bindings = verifyBindings(environment, options);
  if (bindings.environmentFingerprint !== record.runtime.environmentFingerprint) {
    throw new Error("Active runner environment differs from the activation record");
  }
  const statusSnapshot = await privateFileSnapshot(
    record.runtime.statusFile,
    "Runner status file",
    MAX_STATUS_BYTES
  );
  const now = deps.now();
  if (!Number.isFinite(now)) throw new Error("Runner attestation clock is invalid");
  const maximumAge =
    options.maxStatusAgeMs === undefined
      ? statusFreshnessThresholdMs(environment)
      : positiveInteger(options.maxStatusAgeMs, "Maximum runner status age");
  const maximumFutureSkew =
    options.maxFutureSkewMs === undefined
      ? 5_000
      : nonnegativeInteger(options.maxFutureSkewMs, "Maximum runner status clock skew");
  const { status } = attestRunnerStatus(
    statusSnapshot.contents,
    record,
    acceptedProtocolFingerprints,
    { now, maximumAge, maximumFutureSkew }
  );
  const processTreeBefore = await attestRunnerProcessTree(
    runnerJob.pid,
    status.pid,
    deps
  );

  const liveCheck = await deps.command(
    record.executables.node.path,
    [
      record.executables.runnerGuard.path,
      "--record",
      recordPath,
      "--command",
      "check"
    ],
    { timeoutMs: HEALTH_CHECK_TIMEOUT_MS }
  );
  if (liveCheck?.status !== 0) {
    throw new Error("Active runner live Queue and model preflight failed");
  }
  const liveCheckConfig = parseRunnerGuardCheck(liveCheck.stdout);
  if (liveCheckConfig.statusFile !== record.runtime.statusFile) {
    throw new Error("Active runner live check status file differs from the activation record");
  }
  assertRunnerGuardMatchesStatus(liveCheckConfig, status);

  const [runnerJobAfter, omlxJobAfter] = await Promise.all([
    attestLoadedJob(RUNNER_LABEL, record.launchAgents.narrativeRunner.path, domain, deps),
    attestLoadedJob(OMLX_LABEL, record.launchAgents.omlxServer.path, domain, deps)
  ]);
  if (
    runnerJobAfter.pid !== runnerJob.pid ||
    omlxJobAfter.pid !== omlxJob.pid ||
    !deps.pidAlive(omlxJobAfter.pid)
  ) {
    throw new Error("Active runner LaunchAgent process identity changed during preflight");
  }
  const statusAfterSnapshot = await privateFileSnapshot(
    record.runtime.statusFile,
    "Runner status file",
    MAX_STATUS_BYTES
  );
  const afterClock = deps.now();
  if (!Number.isFinite(afterClock)) throw new Error("Runner attestation clock is invalid");
  const { status: statusAfter } = attestRunnerStatus(
    statusAfterSnapshot.contents,
    record,
    acceptedProtocolFingerprints,
    { now: afterClock, maximumAge, maximumFutureSkew }
  );
  assertRunnerGuardMatchesStatus(liveCheckConfig, statusAfter);
  if (statusAfter.pid !== status.pid) {
    throw new Error("Runner heartbeat child identity changed during live preflight");
  }
  const processTreeAfter = await attestRunnerProcessTree(
    runnerJobAfter.pid,
    statusAfter.pid,
    deps
  );
  assertSameRunnerProcessTree(processTreeBefore, processTreeAfter);

  const environmentAfter = await privateFileSnapshot(
    record.runtime.environmentPath,
    "Active runner environment",
    MAX_ENVIRONMENT_BYTES
  );
  if (!environmentBefore.contents.equals(environmentAfter.contents)) {
    throw new Error("Active runner environment changed during compatibility verification");
  }
  await Promise.all([
    assertInstalledPlist(
      record.launchAgents.narrativeRunner,
      "Installed narrative runner plist"
    ),
    assertInstalledPlist(record.launchAgents.omlxServer, "Installed omlx plist")
  ]);
  const recordFinal = await privateFileSnapshot(
    recordPath,
    "Active runner activation record",
    MAX_RECORD_BYTES
  );
  if (!recordBefore.contents.equals(recordFinal.contents)) {
    throw new Error("Active runner activation record changed during compatibility verification");
  }

  return {
    schemaVersion: 1,
    activationId: record.activationId,
    runnerArtifactSha256: record.runnerArtifact.sha256,
    sourceRevision: record.source.revision,
    acceptedProtocolFingerprints: [...acceptedProtocolFingerprints],
    runtimeFingerprint: liveCheckConfig.runtimeFingerprint,
    resultTargetId: bindings.resultTargetId,
    bindingHmacs: bindings.fingerprints
  };
}

function decodeXmlText(value) {
  if (value.includes("<") || value.includes(">")) {
    throw new Error("Installed runner plist ProgramArguments contains invalid XML text");
  }
  return value.replace(/&([^;]+);/g, (_match, entity) => {
    const entities = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'"
    };
    if (!Object.hasOwn(entities, entity)) {
      throw new Error("Installed runner plist ProgramArguments contains an unsupported entity");
    }
    return entities[entity];
  });
}

function parseProgramArguments(plistContents) {
  const text = plistContents.toString("utf8");
  const sections = [
    ...text.matchAll(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/g)
  ];
  if (sections.length !== 1) {
    throw new Error("Installed runner plist must contain exactly one ProgramArguments array");
  }
  const body = sections[0][1];
  const values = [];
  let cursor = 0;
  const pattern = /<string>([\s\S]*?)<\/string>/g;
  for (const match of body.matchAll(pattern)) {
    if (body.slice(cursor, match.index).trim() !== "") {
      throw new Error("Installed runner plist ProgramArguments must contain only strings");
    }
    const value = decodeXmlText(match[1]);
    if (value.length > 16_384 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
      throw new Error("Installed runner plist ProgramArguments contains an invalid string");
    }
    values.push(value);
    cursor = match.index + match[0].length;
  }
  if (body.slice(cursor).trim() !== "" || values.length < 1 || values.length > 128) {
    throw new Error("Installed runner plist ProgramArguments is invalid");
  }
  return values;
}

function exactFlagValue(argumentsList, flag) {
  const lookalikes = argumentsList.filter(
    (value) => value === flag || value.startsWith(`${flag}=`)
  );
  const indexes = argumentsList
    .map((value, index) => (value === flag ? index : -1))
    .filter((index) => index >= 0);
  if (
    lookalikes.length !== 1 ||
    indexes.length !== 1 ||
    indexes[0] + 1 >= argumentsList.length ||
    argumentsList[indexes[0] + 1].startsWith("--")
  ) {
    throw new Error(`Installed runner plist must contain one exact ${flag} argument`);
  }
  return argumentsList[indexes[0] + 1];
}

function activationFromRecordPath(serviceRoot, recordPath) {
  if (!isAbsolute(recordPath)) {
    throw new Error("Installed runner plist --record value must be absolute");
  }
  const launchAgentRoot = resolve(serviceRoot, "launch-agents");
  const relation = relative(launchAgentRoot, resolve(recordPath));
  const parts = relation.split(sep);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation) ||
    parts.length !== 2 ||
    !ACTIVATION_ID_PATTERN.test(parts[0]) ||
    parts[1] !== "activation-record.json" ||
    resolve(launchAgentRoot, parts[0], parts[1]) !== recordPath
  ) {
    throw new Error("Installed runner plist --record value is outside the activation store");
  }
  return { activationId: parts[0], recordPath };
}

export async function discoverRunnerActivationFromInstalledPlist(
  options,
  overrides = {}
) {
  const deps = dependencies(overrides);
  const serviceRoot = await canonicalDirectory(options?.serviceRoot, "Runner service root");
  const installedPlistPath =
    options?.installedPlistPath ??
    resolve(deps.home, "Library/LaunchAgents/ai.alex.narrative-runner.plist");
  const plist = await privateFileSnapshot(
    installedPlistPath,
    "Installed narrative runner plist",
    MAX_PLIST_BYTES
  );
  const argumentsList = parseProgramArguments(plist.contents);
  const recordArgument = exactFlagValue(argumentsList, "--record");
  const command = exactFlagValue(argumentsList, "--command");
  if (command !== "run") {
    throw new Error("Installed runner plist must use the exact --command run argument");
  }
  const discovered = activationFromRecordPath(serviceRoot, recordArgument);
  const recordSnapshot = await privateFileSnapshot(
    discovered.recordPath,
    "Discovered runner activation record",
    MAX_RECORD_BYTES
  );
  const record = parseJson(recordSnapshot.contents, "Discovered runner activation record");
  if (record.schemaVersion === 3) {
    if (options?.allowLegacyV3 !== true) {
      throw new Error(
        "legacy v3 runner discovery requires explicit allowLegacyV3 transition mode"
      );
    }
    legacyActivationRecordShape(record);
  } else {
    activationRecordShape(record, discovered.activationId);
  }
  if (
    record.launchAgents.narrativeRunner.path !== plist.path ||
    record.launchAgents.narrativeRunner.sha256 !== plist.sha256
  ) {
    throw new Error("Discovered activation record does not own the installed runner plist");
  }
  return {
    activationId: discovered.activationId,
    recordPath: discovered.recordPath,
    recordSchemaVersion: record.schemaVersion,
    transitionOnly: record.schemaVersion === 3,
    legacyCoupledSourceRevision:
      record.schemaVersion === 3 ? record.releaseSha : null
  };
}
