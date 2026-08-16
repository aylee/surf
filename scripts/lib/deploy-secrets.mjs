import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SURF_ANALYSIS_RESULT_TARGET } from "../../apps/web/worker/analysis/runtime-constants.mjs";
import {
  assertSupportedRunnerEnvironment,
  readStrictDotenvFile
} from "./strict-env-file.mjs";

const REQUIRED_WORKER_SECRETS = ["NARRATIVE_RESULT_TOKEN", "GEMINI_API_KEY"];

export function assertNarrativeSetupDisabled(mode, config) {
  if (mode === "setup" && config?.vars?.NARRATIVE_ENABLED === "true") {
    throw new Error(
      "Initial setup requires NARRATIVE_ENABLED=false; complete storage, Queue consumer, and runner activation before enabling through the staged deploy path."
    );
  }
}

function immutableReleaseSha(root) {
  let topLevel;
  let head;
  let branch;
  let status;
  try {
    topLevel = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).trim();
    head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).trim();
    branch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    }).trim();
    status = execFileSync(
      "git",
      ["-C", root, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 }
    ).trim();
  } catch {
    throw new Error("Enabled narrative deploy must run from a readable Git release worktree.");
  }
  if (realpathSync(topLevel) !== realpathSync(root)) {
    throw new Error("Enabled narrative deploy root must be the release worktree root.");
  }
  if (!/^[0-9a-f]{40}$/.test(head) || branch !== "HEAD" || status !== "") {
    throw new Error("Enabled narrative deploy requires a clean detached exact-SHA release worktree.");
  }
  return head;
}

function secretFilePath(rawPath, label, root) {
  const value = rawPath?.trim();
  if (!value) throw new Error(`${label} is required when NARRATIVE_ENABLED=true.`);
  const path = isAbsolute(value) ? value : resolve(root, value);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label} must name an existing mode-0600 regular file.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must name a non-symlink regular file with mode 0600.`);
  }
  return path;
}

function readSecrets(path, label) {
  if (path.endsWith(".json")) {
    let contents;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      throw new Error(`${label} could not be read.`);
    }
    try {
      const parsed = JSON.parse(contents);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "string")
      );
    } catch {
      throw new Error(`${label} must contain a JSON object of string secrets.`);
    }
  }
  return readStrictDotenvFile(path, "Environment file");
}

function equalSecret(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function privateSnapshotPath(rawPath, root) {
  const value = rawPath?.trim();
  if (!value || !isAbsolute(value) || !value.toLowerCase().endsWith(".json")) {
    throw new Error(
      "SURF_WORKER_SECRETS_SNAPSHOT must be an absolute external .json activation path."
    );
  }
  const releaseRoot = realpathSync(root);
  const path = resolve(realpathSync(dirname(value)), basename(value));
  const relation = relative(releaseRoot, path);
  if (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  ) {
    throw new Error("SURF_WORKER_SECRETS_SNAPSHOT must be outside the release worktree.");
  }
  return path;
}

function hmacValues(values, key, namespace) {
  const canonical = Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
  );
  return createHmac("sha256", key)
    .update(namespace)
    .update("\u0000")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function writeExclusiveOrIdentical(path, contents) {
  try {
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "Existing Worker secrets snapshot must be a non-symlink mode-0600 regular file."
      );
    }
    if (readFileSync(path, "utf8") !== contents) {
      throw new Error("Existing Worker secrets snapshot differs; use a new activation path.");
    }
  }
  chmodSync(path, 0o600);
}

function exactToken(value, label, minimumLength) {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value) ||
    /replace|placeholder/i.test(value)
  ) {
    throw new Error(`${label} must be a non-placeholder token without surrounding whitespace.`);
  }
  return value;
}

function requiredSurfResultTarget(runner, environment, expectedToken) {
  let targetMap;
  try {
    targetMap = JSON.parse(runner.NARRATIVE_RUNNER_TARGET_MAP_JSON);
  } catch {
    throw new Error(
      "Narrative runner NARRATIVE_RUNNER_TARGET_MAP_JSON must be valid JSON."
    );
  }
  if (!targetMap || typeof targetMap !== "object" || Array.isArray(targetMap)) {
    throw new Error(
      "Narrative runner NARRATIVE_RUNNER_TARGET_MAP_JSON must be an object."
    );
  }
  const target = targetMap[SURF_ANALYSIS_RESULT_TARGET];
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(
      `Narrative runner target map must contain ${SURF_ANALYSIS_RESULT_TARGET}.`
    );
  }
  if (target.tokenEnv !== "SURF_NARRATIVE_RESULT_TOKEN") {
    throw new Error(
      `${SURF_ANALYSIS_RESULT_TARGET} tokenEnv must be SURF_NARRATIVE_RESULT_TOKEN.`
    );
  }
  const mappedToken = exactToken(
    runner[target.tokenEnv],
    `Narrative runner ${target.tokenEnv}`,
    32
  );
  if (!equalSecret(mappedToken, expectedToken)) {
    throw new Error(
      `${SURF_ANALYSIS_RESULT_TARGET} tokenEnv must resolve to the staged Worker result token.`
    );
  }

  let productionOrigin;
  let targetUrl;
  try {
    productionOrigin = new URL(environment.SURF_BASE_URL);
    targetUrl = new URL(target.url);
  } catch {
    throw new Error(
      `SURF_BASE_URL and ${SURF_ANALYSIS_RESULT_TARGET} callback must be valid URLs.`
    );
  }
  if (
    productionOrigin.protocol !== "https:" ||
    productionOrigin.username ||
    productionOrigin.password ||
    productionOrigin.search ||
    productionOrigin.hash ||
    productionOrigin.pathname !== "/"
  ) {
    throw new Error("SURF_BASE_URL must be a bare HTTPS production origin.");
  }
  const expectedCallback = new URL(
    "/api/internal/narratives/results",
    productionOrigin
  ).toString();
  if (
    targetUrl.toString() !== expectedCallback ||
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.search ||
    targetUrl.hash
  ) {
    throw new Error(
      `${SURF_ANALYSIS_RESULT_TARGET} callback must be the expected production Surf origin /api/internal/narratives/results.`
    );
  }
}

function requiredNarrativeQueueName(runner, config) {
  const producers = config?.queues?.producers;
  const matches = Array.isArray(producers)
    ? producers.filter((producer) => producer?.binding === "NARRATIVE_QUEUE")
    : [];
  if (
    matches.length !== 1 ||
    typeof matches[0]?.queue !== "string" ||
    !matches[0].queue.trim()
  ) {
    throw new Error(
      "Active Wrangler config must contain exactly one named NARRATIVE_QUEUE producer."
    );
  }
  const expectedName = matches[0].queue.trim();
  const actualName = runner.NARRATIVE_RUNNER_CF_QUEUE_NAME;
  if (
    typeof actualName !== "string" ||
    actualName !== actualName.trim() ||
    actualName.length === 0 ||
    /[\x00-\x1f\x7f]/.test(actualName)
  ) {
    throw new Error(
      "Narrative runner NARRATIVE_RUNNER_CF_QUEUE_NAME must be an exact nonempty Queue name."
    );
  }
  if (actualName !== expectedName) {
    throw new Error(
      "Narrative runner NARRATIVE_RUNNER_CF_QUEUE_NAME must exactly match the active NARRATIVE_QUEUE producer."
    );
  }

  const expectedDeadLetterName =
    typeof config?.name === "string" && config.name.trim()
      ? `${config.name.trim()}-narrative-dlq`
      : null;
  if (!expectedDeadLetterName) {
    throw new Error("Active Wrangler config must provide its exact instance name.");
  }
  const actualDeadLetterName = runner.NARRATIVE_RUNNER_CF_DLQ_NAME;
  if (
    typeof actualDeadLetterName !== "string" ||
    actualDeadLetterName !== actualDeadLetterName.trim() ||
    actualDeadLetterName.length === 0 ||
    /[\x00-\x1f\x7f]/.test(actualDeadLetterName)
  ) {
    throw new Error(
      "Narrative runner NARRATIVE_RUNNER_CF_DLQ_NAME must be an exact nonempty Queue name."
    );
  }
  if (actualDeadLetterName !== expectedDeadLetterName) {
    throw new Error(
      "Narrative runner NARRATIVE_RUNNER_CF_DLQ_NAME must exactly match the active narrative DLQ."
    );
  }
}

export function resolveNarrativeDeploySecrets(options) {
  if (options.config?.vars?.NARRATIVE_ENABLED !== "true") return null;
  const root = options.root;
  const releaseSha = immutableReleaseSha(root);
  const workerPath = secretFilePath(
    options.environment.SURF_WORKER_SECRETS_FILE,
    "SURF_WORKER_SECRETS_FILE",
    root
  );
  const runnerPath = secretFilePath(
    options.environment.SURF_NARRATIVE_RUNNER_ENV_FILE,
    "SURF_NARRATIVE_RUNNER_ENV_FILE",
    root
  );
  if (runnerPath.toLowerCase().endsWith(".json")) {
    throw new Error(
      "SURF_NARRATIVE_RUNNER_ENV_FILE must be a dotenv file because the verified runner wrapper loads strict dotenv syntax."
    );
  }
  const worker = readSecrets(workerPath, "Worker secrets file");
  const runner = readSecrets(runnerPath, "Narrative runner environment file");

  const workerKeys = Object.keys(worker).sort();
  if (
    workerKeys.length !== REQUIRED_WORKER_SECRETS.length ||
    !REQUIRED_WORKER_SECRETS.every((key) => workerKeys.includes(key))
  ) {
    throw new Error(
      "Worker secrets file must contain exactly NARRATIVE_RESULT_TOKEN and GEMINI_API_KEY."
    );
  }

  const workerResultToken = exactToken(
    worker.NARRATIVE_RESULT_TOKEN,
    "Worker secrets file NARRATIVE_RESULT_TOKEN",
    16
  );
  const geminiApiKey = exactToken(
    worker.GEMINI_API_KEY,
    "Worker secrets file GEMINI_API_KEY",
    16
  );
  if (equalSecret(workerResultToken, geminiApiKey)) {
    throw new Error("NARRATIVE_RESULT_TOKEN and GEMINI_API_KEY must be distinct.");
  }
  const runnerResultToken = exactToken(
    runner.SURF_NARRATIVE_RESULT_TOKEN,
    "Narrative runner SURF_NARRATIVE_RESULT_TOKEN",
    32
  );
  if (
    !equalSecret(workerResultToken, runnerResultToken)
  ) {
    throw new Error(
      "NARRATIVE_RESULT_TOKEN must exactly match SURF_NARRATIVE_RESULT_TOKEN in the runner environment."
    );
  }
  requiredSurfResultTarget(runner, options.environment, workerResultToken);
  requiredNarrativeQueueName(runner, options.config);
  assertSupportedRunnerEnvironment(runner);
  if (!/^[0-9a-f]{40}$/.test(runner.NARRATIVE_RUNNER_RELEASE_SHA ?? "")) {
    throw new Error(
      "Narrative runner NARRATIVE_RUNNER_RELEASE_SHA must be an exact lowercase 40-character SHA."
    );
  }
  const runnerReleaseSha = runner.NARRATIVE_RUNNER_RELEASE_SHA;
  if (runnerReleaseSha !== releaseSha) {
    throw new Error(
      "Legacy setup requires NARRATIVE_RUNNER_RELEASE_SHA to match the exact Worker checkout HEAD; independent component revisions require pnpm release:prod."
    );
  }
  const statusHmacKey = exactToken(
    runner.NARRATIVE_RUNNER_STATUS_HMAC_KEY,
    "Narrative runner NARRATIVE_RUNNER_STATUS_HMAC_KEY",
    32
  );
  const queueToken = exactToken(
    runner.NARRATIVE_RUNNER_CF_API_TOKEN,
    "Narrative runner NARRATIVE_RUNNER_CF_API_TOKEN",
    16
  );
  if (
    equalSecret(queueToken, runnerResultToken) ||
    equalSecret(queueToken, geminiApiKey) ||
    equalSecret(statusHmacKey, runnerResultToken) ||
    equalSecret(statusHmacKey, geminiApiKey) ||
    equalSecret(statusHmacKey, queueToken)
  ) {
    throw new Error(
      "Queue, status-HMAC, result, and Gemini secret roles must be distinct."
    );
  }
  const workerSnapshotPath = privateSnapshotPath(
    options.environment.SURF_WORKER_SECRETS_SNAPSHOT,
    root
  );
  const workerSnapshot = {
    GEMINI_API_KEY: geminiApiKey,
    NARRATIVE_RESULT_TOKEN: workerResultToken
  };
  const snapshotContents = `${JSON.stringify(workerSnapshot, null, 2)}\n`;
  writeExclusiveOrIdentical(workerSnapshotPath, snapshotContents);
  const canonicalWorkerSnapshotPath = secretFilePath(
    workerSnapshotPath,
    "Worker secrets snapshot",
    root
  );
  const workerFingerprint = hmacValues(
    workerSnapshot,
    statusHmacKey,
    "surf-worker-secrets-v1"
  );
  const runnerFingerprint = hmacValues(
    runner,
    statusHmacKey,
    "surf-runner-env-v1"
  );
  const assertUnchanged = () => {
    const currentWorker = readSecrets(
      secretFilePath(
        canonicalWorkerSnapshotPath,
        "Worker secrets snapshot",
        root
      ),
      "Worker secrets snapshot"
    );
    const currentRunner = readSecrets(
      secretFilePath(runnerPath, "SURF_NARRATIVE_RUNNER_ENV_FILE", root),
      "Narrative runner environment file"
    );
    if (
      hmacValues(currentWorker, statusHmacKey, "surf-worker-secrets-v1") !==
        workerFingerprint ||
      hmacValues(currentRunner, statusHmacKey, "surf-runner-env-v1") !==
        runnerFingerprint
    ) {
      throw new Error("Narrative deploy input changed after activation validation.");
    }
  };
  assertUnchanged();
  return {
    workerSecretsFile: canonicalWorkerSnapshotPath,
    assertUnchanged,
    receipt: {
      workerSecretsPath: canonicalWorkerSnapshotPath,
      workerSecretsFingerprint: workerFingerprint,
      runnerEnvPath: runnerPath,
      runnerEnvFingerprint: runnerFingerprint,
      releaseSha,
      runnerReleaseSha
    }
  };
}
