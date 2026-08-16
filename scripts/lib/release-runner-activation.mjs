import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseStrictDotenv } from "./strict-env-file.mjs";
import { readVerifiedFileSnapshot } from "./verified-file-snapshot.mjs";
import {
  renderLaunchAgents,
  verifyLaunchActivation
} from "../../apps/narrative-runner/scripts/render-launch-agents.mjs";
import { activateLaunchAgents } from "../../apps/narrative-runner/scripts/manage-launch-agents.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ACTIVATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_RUNNER_PRIVATE_FILE_BYTES = 1024 * 1024;

function privateCanonicalFile(path, label) {
  return readVerifiedFileSnapshot(path, {
    label,
    maximumBytes: MAX_RUNNER_PRIVATE_FILE_BYTES,
    requireMode0600: true,
    requireCanonical: true
  });
}

function ensurePrivateCanonicalDirectory(path, parent, label) {
  if (dirname(path) !== parent) {
    throw new Error(`${label} must be an immediate child of its verified parent`);
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if (realpathSync(path) !== resolve(path)) {
    throw new Error(`${label} must use its canonical path`);
  }
  chmodSync(path, 0o700);
  return path;
}

function replaceExactSetting(contents, name, value) {
  if (/[\r\n#]/.test(value)) {
    throw new Error(`Runner environment ${name} replacement is unsafe`);
  }
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?${name}\\s*=.*$`,
    "gm"
  );
  const matches = contents.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Runner environment must contain exactly one ${name}`);
  }
  return contents.replace(pattern, `${name}=${value}`);
}

function writeExclusiveOrIdentical(path, contents) {
  try {
    writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = privateCanonicalFile(path, "Runner environment snapshot");
    if (existing.contents.toString("utf8") !== contents) {
      throw new Error("Runner environment snapshot differs; use a new activation ID");
    }
  }
  chmodSync(path, 0o600);
}

export function stageRunnerEnvironment({
  sourcePath,
  outputPath,
  sourceRevision,
  statusFile
}) {
  if (!SHA_PATTERN.test(sourceRevision ?? "")) {
    throw new Error("Runner source revision must be an exact Git SHA");
  }
  const source = privateCanonicalFile(sourcePath, "Runner environment source");
  const before = source.contents.toString("utf8");
  parseStrictDotenv(before, "Runner environment source");
  let contents = replaceExactSetting(
    before,
    "NARRATIVE_RUNNER_RELEASE_SHA",
    sourceRevision
  );
  contents = replaceExactSetting(
    contents,
    "NARRATIVE_RUNNER_STATUS_FILE",
    statusFile
  );
  const values = parseStrictDotenv(contents, "Runner environment snapshot");
  if (
    values.NARRATIVE_RUNNER_RELEASE_SHA !== sourceRevision ||
    values.NARRATIVE_RUNNER_STATUS_FILE !== statusFile
  ) {
    throw new Error("Runner environment snapshot identity did not apply exactly");
  }
  writeExclusiveOrIdentical(outputPath, contents);
  const output = privateCanonicalFile(outputPath, "Runner environment snapshot");
  return Object.freeze({
    path: output.path,
    values
  });
}

function priorRuntimePaths(record) {
  const modelArtifact =
    record.schemaVersion === 4 ? record.model?.artifact : record.modelArtifact;
  const nodePath = record.executables?.node?.path;
  const omlxPath = record.executables?.omlx?.path;
  if (
    typeof modelArtifact?.path !== "string" ||
    typeof nodePath !== "string" ||
    typeof omlxPath !== "string"
  ) {
    throw new Error("Prior runner record lacks pinned runtime paths");
  }
  return {
    modelArtifactPath: modelArtifact.path,
    omlxDataPath: dirname(dirname(modelArtifact.path)),
    nodeBinPath: dirname(nodePath),
    omlxPath
  };
}

export async function activateTargetRunner(
  {
    targetReleaseRoot,
    targetGitSha,
    activationId,
    serviceRoot,
    runnerEnvironmentSourcePath,
    runnerArtifactPath,
    runnerArtifactManifestPath,
    priorRecordPath,
    environment = process.env
  },
  dependencies = {}
) {
  if (!ACTIVATION_PATTERN.test(activationId ?? "")) {
    throw new Error("Runner activation ID is invalid");
  }
  if (!SHA_PATTERN.test(targetGitSha ?? "")) {
    throw new Error("Runner target Git SHA is invalid");
  }
  const verify = dependencies.verifyActivation ?? verifyLaunchActivation;
  const render = dependencies.render ?? renderLaunchAgents;
  const activate = dependencies.activate ?? activateLaunchAgents;
  await verify(priorRecordPath, {
    // The bounded manager reconciles each installed plist independently.
    // Requiring the entire prior pair here would strand a crash after the
    // first atomic target rename.
    requireInstalled: false,
    allowLegacyV3: true
  });
  const priorSnapshot = privateCanonicalFile(
    priorRecordPath,
    "Prior runner activation record"
  );
  const prior = JSON.parse(priorSnapshot.contents.toString("utf8"));
  const runtime = priorRuntimePaths(prior);

  const canonicalServiceRoot = realpathSync(serviceRoot);
  if (canonicalServiceRoot !== resolve(serviceRoot)) {
    throw new Error("Runner service root must be a canonical non-symlink directory");
  }
  const launchAgentsDirectory = ensurePrivateCanonicalDirectory(
    resolve(canonicalServiceRoot, "launch-agents"),
    canonicalServiceRoot,
    "Runner activation store"
  );
  const activationDirectory = ensurePrivateCanonicalDirectory(
    resolve(launchAgentsDirectory, activationId),
    launchAgentsDirectory,
    "Runner activation directory"
  );
  const secretsDirectory = ensurePrivateCanonicalDirectory(
    resolve(canonicalServiceRoot, "secrets"),
    canonicalServiceRoot,
    "Runner secrets directory"
  );
  const stateDirectory = ensurePrivateCanonicalDirectory(
    resolve(canonicalServiceRoot, "state"),
    canonicalServiceRoot,
    "Runner state directory"
  );
  const statusDirectory = ensurePrivateCanonicalDirectory(
    resolve(stateDirectory, "runner-status"),
    stateDirectory,
    "Runner status directory"
  );
  const logDirectory = ensurePrivateCanonicalDirectory(
    resolve(canonicalServiceRoot, "logs"),
    canonicalServiceRoot,
    "Runner log directory"
  );
  const statusFile = resolve(statusDirectory, `${activationId}.json`);
  const runnerEnvironment = stageRunnerEnvironment({
    sourcePath: runnerEnvironmentSourcePath,
    outputPath: resolve(secretsDirectory, `${activationId}.env`),
    sourceRevision: targetGitSha,
    statusFile
  });
  const visibilityTimeoutMs = Number(
    runnerEnvironment.values.NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS ?? "900000"
  );
  if (!Number.isInteger(visibilityTimeoutMs) || visibilityTimeoutMs < 1_000) {
    throw new Error("Runner visibility timeout is invalid");
  }
  const runnerExitTimeoutSeconds = Math.ceil(visibilityTimeoutMs / 1000) + 30;
  const rendered = await render({
    outputDir: activationDirectory,
    repositoryPath: targetReleaseRoot,
    releaseSha: targetGitSha,
    runnerEnvPath: runnerEnvironment.path,
    runnerExitTimeoutSeconds,
    runnerArtifactPath,
    runnerArtifactManifestPath,
    nodeBinPath: runtime.nodeBinPath,
    omlxPath: runtime.omlxPath,
    omlxDataPath: runtime.omlxDataPath,
    modelArtifactPath: runtime.modelArtifactPath,
    logDir: logDirectory,
    environment
  });
  const recordPath = rendered.activationRecordPath ?? resolve(
    activationDirectory,
    "activation-record.json"
  );
  const activation = await activate({
    recordPath,
    priorRecordPath,
    environment,
    transitionMode: "activate"
  });
  await verify(recordPath, { requireInstalled: true, allowLegacyV3: false });
  return Object.freeze({
    activationId,
    recordPath,
    changed: true,
    drainReceipt: activation?.drainReceipt ?? null
  });
}
