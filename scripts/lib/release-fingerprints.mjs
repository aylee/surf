import { createHash, createHmac } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";
import {
  assertReleaseFingerprintSet,
  fingerprintCanonicalReleaseValue,
  fingerprintReleaseFiles
} from "./release-impact.mjs";
import { clientBuildDigest } from "./build-identity.mjs";
import { readVerifiedFileSnapshot } from "./verified-file-snapshot.mjs";
import { readStrictDotenvFile } from "./strict-env-file.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_PRIVATE_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_DIGEST_BYTES = 256 * 1024 * 1024;
const RELEASE_IDENTITY_VARS = new Set([
  "SURF_SOURCE_REVISION",
  "SURF_WORKER_RUNTIME_DIGEST",
  "SURF_CLIENT_BUILD_DIGEST"
]);

const MATERIALIZATION_INPUTS = Object.freeze([
  // Materialization is dispatched by the Worker entrypoint and crosses brief,
  // narrative, time, adapter, and ingest modules. Hash the complete production
  // Worker source surface so a newly added relative dependency cannot silently
  // escape the generation proof.
  "apps/web/worker",
  "packages/forecast-core/src",
  "services/extractor/pyproject.toml",
  "services/extractor/src",
  "services/extractor/uv.lock"
]);

const NON_PRODUCTION_MATERIALIZATION_PATH =
  /(?:^|\/)(?:test|tests|__tests__|__pycache__|\.pytest_cache|\.venv)(?:\/|$)|\.(?:pyc|pyo)$|\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:quality-fixtures|test-helpers)\.[^/]+$/;

const SHARED_WORKSPACE_INPUTS = Object.freeze([
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "packages/contracts"
]);

const RELEASE_TOOLING_INPUTS = Object.freeze([
  "scripts",
  "apps/web/package.json",
  "apps/web/vite.config.ts"
]);

const RUNNER_ARTIFACT_INPUTS = Object.freeze([
  "apps/narrative-runner/package.json",
  "apps/narrative-runner/examples",
  "apps/narrative-runner/scripts/build-runner.mjs",
  "apps/narrative-runner/scripts/install-launch-agents.mjs",
  "apps/narrative-runner/scripts/manage-launch-agents.mjs",
  "apps/narrative-runner/scripts/render-launch-agents.mjs",
  "apps/narrative-runner/scripts/run-verified-runner.mjs",
  "apps/narrative-runner/scripts/supervise-omlx.sh",
  "scripts/lib/strict-env-file.mjs",
  "scripts/lib/verified-file-snapshot.mjs"
]);

function repoRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function walk(root, candidate, entries, includeFile = () => true) {
  const metadata = lstatSync(candidate);
  const name = repoRelative(root, candidate);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Release fingerprint input must not be a symlink: ${name}`);
  }
  if (metadata.isFile()) {
    if (includeFile(name)) {
      entries.push({ path: name, contents: readFileSync(candidate) });
    }
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Release fingerprint input must be a file or directory: ${name}`);
  }
  for (const child of readdirSync(candidate).sort()) {
    walk(root, resolve(candidate, child), entries, includeFile);
  }
}

function fingerprintSelectedReleasePaths(root, inputs, includeFile) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("Release fingerprint paths must be a nonempty array");
  }
  const entries = [];
  for (const input of inputs) {
    if (
      typeof input !== "string" ||
      input.startsWith("/") ||
      input.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`Release fingerprint path is unsafe: ${String(input)}`);
    }
    const candidate = resolve(root, input);
    const relation = relative(root, candidate);
    if (
      relation === "" ||
      relation === ".." ||
      relation.startsWith(`..${sep}`)
    ) {
      throw new Error(`Release fingerprint path escapes the release: ${input}`);
    }
    walk(root, candidate, entries, includeFile);
  }
  if (entries.length === 0) {
    throw new Error("Release fingerprint paths did not select any files");
  }
  return fingerprintReleaseFiles(entries);
}

export function fingerprintReleasePaths(root, inputs) {
  return fingerprintSelectedReleasePaths(root, inputs, () => true);
}

function fingerprintMaterializationPaths(root) {
  return fingerprintSelectedReleasePaths(
    root,
    MATERIALIZATION_INPUTS,
    (path) => !NON_PRODUCTION_MATERIALIZATION_PATH.test(path)
  );
}

function parseJsonc(contents, label) {
  const errors = [];
  const value = parse(contents, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`)
      .join(", ");
    throw new Error(`${label} is not valid JSONC${details ? `: ${details}` : ""}`);
  }
  return value;
}

export function logicalWranglerConfig(configPath) {
  const snapshot = readVerifiedFileSnapshot(configPath, {
    label: "Logical Wrangler config",
    maximumBytes: MAX_CONFIG_BYTES
  });
  const config = structuredClone(
    parseJsonc(snapshot.contents.toString("utf8"), "Logical Wrangler config")
  );
  if (config.vars && typeof config.vars === "object" && !Array.isArray(config.vars)) {
    for (const key of RELEASE_IDENTITY_VARS) delete config.vars[key];
  }
  return config;
}

function nonTopologyWranglerConfig(config) {
  const value = structuredClone(config);
  delete value.queues;
  delete value.triggers;
  return value;
}

export function privateFileHmacFingerprint({
  path,
  hmacKey,
  domain
}) {
  if (
    typeof hmacKey !== "string" ||
    hmacKey.length < 32 ||
    hmacKey !== hmacKey.trim() ||
    /[\x00-\x1f\x7f]/.test(hmacKey)
  ) {
    throw new Error("Release secret fingerprint requires a strong bounded HMAC key");
  }
  if (
    typeof domain !== "string" ||
    !/^surf-release-[a-z0-9-]+-v[1-9][0-9]*$/.test(domain)
  ) {
    throw new Error("Release private-file fingerprint requires a bounded domain");
  }
  const snapshot = readVerifiedFileSnapshot(path, {
    label: "Release secret source",
    maximumBytes: MAX_PRIVATE_INPUT_BYTES,
    requireMode0600: true
  });
  return createHmac("sha256", hmacKey)
    .update(`${domain}\0`)
    .update(snapshot.contents)
    .digest("hex");
}

export function secretHmacFingerprint({ secretPath, hmacKey }) {
  return privateFileHmacFingerprint({
    path: secretPath,
    hmacKey,
    domain: "surf-release-worker-secrets-v1"
  });
}

export function computeReleaseFingerprints({
  releaseRoot,
  workerBundlePath,
  runnerBundlePath,
  runnerEnvironmentPath,
  wranglerSourcePath,
  workerSecretsPath,
  secretFingerprintKey,
  narrativeProtocolFingerprint
}) {
  if (!SHA256_PATTERN.test(narrativeProtocolFingerprint ?? "")) {
    throw new Error("Narrative protocol fingerprint must be an exact lowercase SHA-256");
  }
  const config = logicalWranglerConfig(wranglerSourcePath);
  const queueTopology = {
    name: config.name ?? null,
    producers: config.queues?.producers ?? [],
    consumers: config.queues?.consumers ?? []
  };
  const triggerTopology = {
    name: config.name ?? null,
    triggers: config.triggers ?? {}
  };
  const runnerArtifact = fingerprintCanonicalReleaseValue({
    bundleSha256: sha256File(runnerBundlePath),
    activationClosureSha256: fingerprintReleasePaths(
      releaseRoot,
      RUNNER_ARTIFACT_INPUTS
    )
  });
  const runnerRuntime = privateFileHmacFingerprint({
    path: runnerEnvironmentPath,
    hmacKey: secretFingerprintKey,
    domain: "surf-release-runner-runtime-v1"
  });
  return assertReleaseFingerprintSet({
    workerAssets: clientBuildDigest(releaseRoot),
    workerRuntime: sha256File(workerBundlePath),
    materialization: fingerprintMaterializationPaths(releaseRoot),
    migrations: fingerprintReleasePaths(releaseRoot, ["packages/db/migrations"]),
    seed: fingerprintReleasePaths(releaseRoot, ["packages/db/seeds"]),
    queueTopology: fingerprintCanonicalReleaseValue(queueTopology),
    triggerTopology: fingerprintCanonicalReleaseValue(triggerTopology),
    runnerArtifact,
    runnerRuntime,
    narrativeContract: narrativeProtocolFingerprint,
    logicalConfig: fingerprintCanonicalReleaseValue(
      nonTopologyWranglerConfig(config)
    ),
    workerSecrets: secretHmacFingerprint({
      secretPath: workerSecretsPath,
      hmacKey: secretFingerprintKey
    }),
    dependencyLock: fingerprintReleasePaths(releaseRoot, ["pnpm-lock.yaml"]),
    sharedWorkspace: fingerprintReleasePaths(releaseRoot, SHARED_WORKSPACE_INPUTS),
    releaseTooling: fingerprintReleasePaths(releaseRoot, RELEASE_TOOLING_INPUTS)
  });
}

export function runnerReplacementRequired({
  targetFingerprints,
  activeFingerprints
}) {
  const target = assertReleaseFingerprintSet(
    targetFingerprints,
    "Target runner fingerprints"
  );
  if (activeFingerprints === null) return true;
  const active = assertReleaseFingerprintSet(
    activeFingerprints,
    "Active runner fingerprints"
  );
  return (
    active.runnerArtifact !== target.runnerArtifact ||
    active.runnerRuntime !== target.runnerRuntime
  );
}

export function assertRoutineRunnerRuntimeTransition({
  activeFingerprint,
  targetFingerprint,
  activeEnvironmentPath = null,
  targetEnvironmentPath = null,
  hmacKey = null
}) {
  if (!SHA256_PATTERN.test(targetFingerprint ?? "")) {
    throw new Error("Target runner runtime fingerprint is invalid");
  }
  if (activeFingerprint === null || activeFingerprint === targetFingerprint) return;
  if (!SHA256_PATTERN.test(activeFingerprint ?? "")) {
    throw new Error("Active runner runtime fingerprint is invalid");
  }
  if (
    typeof activeEnvironmentPath !== "string" ||
    typeof targetEnvironmentPath !== "string" ||
    typeof hmacKey !== "string" ||
    hmacKey.length < 32
  ) {
    throw new Error(
      "Runner runtime changes require exact active and target environment evidence"
    );
  }
  const active = readStrictDotenvFile(
    activeEnvironmentPath,
    "Active runner environment"
  );
  const target = readStrictDotenvFile(
    targetEnvironmentPath,
    "Target runner environment"
  );
  if (active.NARRATIVE_RUNNER_OMLX_MODEL !== target.NARRATIVE_RUNNER_OMLX_MODEL) {
    throw new Error(
      "Runner model changes require an explicit coordinated runtime-artifact operation"
    );
  }
  const secretNames = (values) => {
    const names = new Set(
      Object.keys(values).filter(
        (name) => name.endsWith("_TOKEN") || name.endsWith("_HMAC_KEY")
      )
    );
    let targets;
    try {
      targets = JSON.parse(values.NARRATIVE_RUNNER_TARGET_MAP_JSON ?? "{}");
    } catch {
      throw new Error("Runner target map is invalid during runtime comparison");
    }
    for (const value of Object.values(targets)) {
      if (typeof value?.tokenEnv === "string") names.add(value.tokenEnv);
    }
    return [...names].sort();
  };
  const activeNames = secretNames(active);
  const targetNames = secretNames(target);
  if (JSON.stringify(activeNames) !== JSON.stringify(targetNames)) {
    throw new Error(
      "Runner secret rotation requires an explicit coordinated operation"
    );
  }
  const secretFingerprint = (values, names) =>
    createHmac("sha256", hmacKey)
      .update("surf-release-runner-secret-projection-v1\0")
      .update(
        JSON.stringify(names.map((name) => [name, values[name] ?? null]))
      )
      .digest("hex");
  if (
    secretFingerprint(active, activeNames) !==
    secretFingerprint(target, targetNames)
  ) {
    throw new Error(
      "Runner secret rotation requires an explicit coordinated operation"
    );
  }
}

export function assertRoutineNarrativeContractTransition({
  activeFingerprint,
  targetFingerprint,
  runnerAcceptedFingerprints
}) {
  if (!SHA256_PATTERN.test(targetFingerprint ?? "")) {
    throw new Error("Target narrative protocol fingerprint is invalid");
  }
  if (activeFingerprint === null) return;
  if (!SHA256_PATTERN.test(activeFingerprint ?? "")) {
    throw new Error("Active narrative protocol fingerprint is invalid");
  }
  if (activeFingerprint === targetFingerprint) return;
  if (
    !Array.isArray(runnerAcceptedFingerprints) ||
    new Set(runnerAcceptedFingerprints).size !== runnerAcceptedFingerprints.length ||
    runnerAcceptedFingerprints.some(
      (fingerprint) => !SHA256_PATTERN.test(fingerprint ?? "")
    )
  ) {
    throw new Error("Runner accepted-protocol fingerprints are invalid");
  }
  throw new Error(
    "Narrative protocol changes require an explicit expand/migrate/contract rollout outside the routine release command"
  );
}

export function assertRoutineWorkerSecretTransition({
  activeFingerprint,
  targetFingerprint
}) {
  if (!SHA256_PATTERN.test(targetFingerprint ?? "")) {
    throw new Error("Target Worker-secret fingerprint is invalid");
  }
  if (activeFingerprint === null) return;
  if (!SHA256_PATTERN.test(activeFingerprint ?? "")) {
    throw new Error("Active Worker-secret fingerprint is invalid");
  }
  if (activeFingerprint !== targetFingerprint) {
    throw new Error(
      "Worker secret rotation requires an explicit coordinated rotation outside the routine release command"
    );
  }
}

export function sha256File(path) {
  const snapshot = readVerifiedFileSnapshot(path, {
    label: "Release digest input",
    maximumBytes: MAX_RELEASE_DIGEST_BYTES
  });
  return createHash("sha256").update(snapshot.contents).digest("hex");
}
