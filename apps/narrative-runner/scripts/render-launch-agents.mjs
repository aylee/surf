#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readStrictDotenvFile } from "../../../scripts/lib/strict-env-file.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererRepositoryRoot = resolve(packageRoot, "../..");
const execFileAsync = promisify(execFile);

function requiredAbsolute(options, name) {
  const value = options[name];
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function requiredInteger(options, name, minimum, maximum) {
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return String(value);
}

function requiredReleaseSha(options) {
  const value = options.releaseSha;
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("releaseSha must be the exact lowercase 40-character merged SHA");
  }
  return value;
}

async function gitValue(repositoryPath, args, label) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  } catch {
    throw new Error(`repositoryPath must be a readable Git worktree (${label})`);
  }
}

export async function validateImmutableRelease(repositoryPath, releaseSha) {
  let renderedFrom;
  let requestedRepository;
  try {
    [renderedFrom, requestedRepository] = await Promise.all([
      realpath(rendererRepositoryRoot),
      realpath(repositoryPath)
    ]);
  } catch {
    throw new Error("renderer and repositoryPath must resolve to readable release paths");
  }
  if (renderedFrom !== requestedRepository) {
    throw new Error(
      "LaunchAgent renderer must execute from the same release as repositoryPath"
    );
  }
  const head = await gitValue(repositoryPath, ["rev-parse", "HEAD"], "HEAD");
  if (head !== releaseSha) {
    throw new Error("repositoryPath HEAD must exactly match releaseSha");
  }
  const branch = await gitValue(
    repositoryPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "detached HEAD"
  );
  if (branch !== "HEAD") {
    throw new Error("repositoryPath must be a detached release worktree");
  }
  const status = await gitValue(
    repositoryPath,
    ["status", "--porcelain", "--untracked-files=all"],
    "clean status"
  );
  if (status !== "") {
    throw new Error("repositoryPath release worktree must be clean");
  }
}

async function writeExclusiveOrIdentical(path, contents) {
  try {
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
    let existing;
    try {
      existing = await readFile(path, "utf8");
    } catch {
      throw new Error("existing LaunchAgent artifact could not be read");
    }
    if (existing !== contents) {
      throw new Error("existing LaunchAgent artifact differs; use a new release output path");
    }
  }
  await chmod(path, 0o600);
}

function environmentInteger(values, name, fallback, minimum, maximum) {
  const raw = values[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function environmentString(values, name) {
  const value = values[name];
  if (value === undefined) throw new Error(`${name} is required in runnerEnvPath`);
  if (!value) throw new Error(`${name} must not be empty in runnerEnvPath`);
  return value;
}

async function prospectiveRealPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...suffix);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function pathIsInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

async function requireOperationalPathsOutsideRelease(repositoryPath, paths) {
  const repositoryRealPath = await realpath(repositoryPath);
  for (const [label, path] of Object.entries(paths)) {
    const candidate = await prospectiveRealPath(path);
    if (pathIsInside(repositoryRealPath, candidate)) {
      throw new Error(`${label} must be outside the immutable release worktree`);
    }
  }
}

async function canonicalExecutable(path, label) {
  let canonical;
  let metadata;
  try {
    metadata = await lstat(path);
    canonical = await realpath(path);
  } catch {
    throw new Error(`${label} must name a readable executable`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must be the canonical realpath, not a mutable alias`);
  }
  try {
    await access(canonical, constants.X_OK);
  } catch {
    throw new Error(`${label} must be executable`);
  }
  return canonical;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function runnerEnvironmentFingerprint(values) {
  const key = values.NARRATIVE_RUNNER_STATUS_HMAC_KEY;
  if (
    typeof key !== "string" ||
    key.length < 32 ||
    key !== key.trim() ||
    /[\x00-\x1f\x7f]/.test(key)
  ) {
    throw new Error(
      "NARRATIVE_RUNNER_STATUS_HMAC_KEY must be at least 32 characters without surrounding whitespace"
    );
  }
  const canonical = Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
  );
  return createHmac("sha256", key)
    .update("surf-runner-env-v1")
    .update("\u0000")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

async function privateRegularFile(path, label) {
  let metadata;
  let canonical;
  try {
    metadata = await lstat(path);
    canonical = await realpath(path);
  } catch {
    throw new Error(`${label} must name a readable mode-0600 regular file`);
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600 ||
    resolve(path) !== canonical
  ) {
    throw new Error(`${label} must be a canonical non-symlink mode-0600 regular file`);
  }
  return canonical;
}

async function workerSecretsArtifact(path, runnerEnvironment) {
  const canonical = await privateRegularFile(path, "workerSecretsPath");
  let values;
  try {
    values = JSON.parse(await readFile(canonical, "utf8"));
  } catch {
    throw new Error("workerSecretsPath must contain a JSON object");
  }
  const keys =
    values && typeof values === "object" && !Array.isArray(values)
      ? Object.keys(values).sort()
      : [];
  if (
    keys.join(",") !== "GEMINI_API_KEY,NARRATIVE_RESULT_TOKEN" ||
    keys.some((key) => typeof values[key] !== "string" || values[key].length < 16)
  ) {
    throw new Error(
      "workerSecretsPath must contain exactly the staged Gemini and narrative result tokens"
    );
  }
  if (values.NARRATIVE_RESULT_TOKEN !== runnerEnvironment.SURF_NARRATIVE_RESULT_TOKEN) {
    throw new Error("workerSecretsPath result token must match the runner environment");
  }
  if (values.GEMINI_API_KEY === values.NARRATIVE_RESULT_TOKEN) {
    throw new Error("workerSecretsPath secret roles must be distinct");
  }
  const key = runnerEnvironment.NARRATIVE_RUNNER_STATUS_HMAC_KEY;
  const canonicalValues = Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    path: canonical,
    fingerprint: createHmac("sha256", key)
      .update("surf-worker-secrets-v1")
      .update("\u0000")
      .update(JSON.stringify(canonicalValues))
      .digest("hex")
  };
}

async function directoryArtifact(path, label) {
  let metadata;
  let canonical;
  try {
    metadata = await lstat(path);
    canonical = await realpath(path);
  } catch {
    throw new Error(`${label} must name a readable model directory`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must name a non-symlink model directory`);
  }
  if (resolve(path) !== canonical) {
    throw new Error(`${label} must be the canonical model directory realpath`);
  }

  const entries = [];
  async function visit(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const childPath = resolve(directory, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`${label} must not contain symbolic links (${relativePath})`);
      }
      if (child.isDirectory()) {
        await visit(childPath, relativePath);
        continue;
      }
      const childMetadata = await lstat(childPath);
      if (!childMetadata.isFile()) {
        throw new Error(`${label} contains a non-regular artifact (${relativePath})`);
      }
      entries.push({
        path: relativePath,
        bytes: childMetadata.size,
        sha256: await sha256File(childPath)
      });
    }
  }
  await visit(canonical);
  if (entries.length === 0) throw new Error(`${label} must not be empty`);
  return {
    path: canonical,
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0)
  };
}

async function verifyRecordedFile(
  record,
  label,
  executable = false,
  requirePrivateMode = false
) {
  if (
    !record ||
    typeof record !== "object" ||
    typeof record.path !== "string" ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256)
  ) {
    throw new Error(`${label} activation record is invalid`);
  }
  const canonical = executable
    ? await canonicalExecutable(record.path, label)
    : await realpath(record.path);
  const metadata = await lstat(record.path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    canonical !== record.path ||
    (requirePrivateMode && (metadata.mode & 0o777) !== 0o600)
  ) {
    throw new Error(`${label} must remain a canonical non-symlink regular file`);
  }
  if (await sha256File(canonical) !== record.sha256) {
    throw new Error(`${label} SHA-256 differs from the activation record`);
  }
}

export async function verifyLaunchActivation(
  recordPath,
  { requireInstalled = true } = {}
) {
  let metadata;
  let record;
  try {
    metadata = await lstat(recordPath);
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch {
    throw new Error("activation record must be readable JSON");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("activation record must be a non-symlink mode-0600 regular file");
  }
  if (
    !record ||
    typeof record !== "object" ||
    record.schemaVersion !== 3 ||
    typeof record.releaseSha !== "string" ||
    typeof record.repositoryPath !== "string" ||
    typeof record.runnerEnvPath !== "string" ||
    typeof record.runnerEnvironmentFingerprint !== "string" ||
    typeof record.modelId !== "string" ||
    typeof record.wranglerConfig?.path !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.wranglerConfig?.sha256 ?? "") ||
    typeof record.workerSecrets?.path !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.workerSecrets?.fingerprint ?? "")
  ) {
    throw new Error("activation record schema is invalid");
  }
  await validateImmutableRelease(record.repositoryPath, record.releaseSha);
  const runnerEnvironment = readStrictDotenvFile(
    record.runnerEnvPath,
    "Narrative runner environment file"
  );
  if (runnerEnvironment.NARRATIVE_RUNNER_RELEASE_SHA !== record.releaseSha) {
    throw new Error("runner environment release SHA differs from activation record");
  }
  if (runnerEnvironment.NARRATIVE_RUNNER_OMLX_MODEL !== record.modelId) {
    throw new Error("runner environment model ID differs from activation record");
  }
  if (runnerEnvironmentFingerprint(runnerEnvironment) !== record.runnerEnvironmentFingerprint) {
    throw new Error("runner environment differs from activation record");
  }
  await privateRegularFile(record.wranglerConfig.path, "wranglerConfigPath");
  await verifyRecordedFile(record.wranglerConfig, "wranglerConfigPath", false);
  const currentWorkerSecrets = await workerSecretsArtifact(
    record.workerSecrets.path,
    runnerEnvironment
  );
  if (currentWorkerSecrets.fingerprint !== record.workerSecrets.fingerprint) {
    throw new Error("worker secrets differ from activation record");
  }

  for (const name of ["node", "pnpm", "omlx", "omlxSupervisor"]) {
    await verifyRecordedFile(record.executables?.[name], name, true);
  }
  await verifyRecordedFile(record.executables?.runnerGuard, "runnerGuard", false);
  for (const name of ["narrativeRunner", "omlxServer"]) {
    await verifyRecordedFile(
      record.renderedLaunchAgents?.[name],
      `rendered ${name}`,
      false,
      true
    );
    if (requireInstalled) {
      await verifyRecordedFile(
        record.launchAgents?.[name],
        `installed ${name}`,
        false,
        true
      );
    }
  }
  const currentModelArtifact = await directoryArtifact(
    record.modelArtifact?.path,
    "modelArtifactPath"
  );
  if (
    currentModelArtifact.sha256 !== record.modelArtifact?.sha256 ||
    currentModelArtifact.fileCount !== record.modelArtifact?.fileCount ||
    currentModelArtifact.totalBytes !== record.modelArtifact?.totalBytes
  ) {
    throw new Error("model artifact differs from activation record");
  }
  return {
    status: "ok",
    releaseSha: record.releaseSha,
    modelId: record.modelId,
    wranglerConfigSha256: record.wranglerConfig.sha256,
    modelArtifactSha256: currentModelArtifact.sha256
  };
}

function replacePlaceholders(template, values) {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    const escaped = value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
    rendered = rendered.replaceAll(`__${name}__`, escaped);
  }
  const unresolved = [...new Set(rendered.match(/__[A-Z_]+__/g) ?? [])];
  if (unresolved.length > 0) {
    throw new Error(`Unresolved LaunchAgent placeholders: ${unresolved.join(", ")}`);
  }
  return rendered;
}

export async function renderLaunchAgents(options) {
  const outputDir = requiredAbsolute(options, "outputDir");
  const repositoryPath = requiredAbsolute(options, "repositoryPath");
  const releaseSha = requiredReleaseSha(options);
  const runnerEnvPath = requiredAbsolute(options, "runnerEnvPath");
  const runnerExitTimeoutSeconds = requiredInteger(
    options,
    "runnerExitTimeoutSeconds",
    30,
    43_260
  );
  const environment = options.environment ?? process.env;
  const expectedLaunchAgentsDir = resolve(
    environment.HOME?.trim() || homedir(),
    "Library/LaunchAgents"
  );
  const launchAgentsDir = options.launchAgentsDir
    ? requiredAbsolute(options, "launchAgentsDir")
    : expectedLaunchAgentsDir;
  if (
    (await prospectiveRealPath(launchAgentsDir)) !==
    (await prospectiveRealPath(expectedLaunchAgentsDir))
  ) {
    throw new Error("launchAgentsDir must be the current user's ~/Library/LaunchAgents");
  }
  const homePath = await prospectiveRealPath(
    environment.HOME?.trim() || homedir()
  );
  const validatedRunnerEnvPath = environment.SURF_NARRATIVE_RUNNER_ENV_FILE;
  if (!validatedRunnerEnvPath || !isAbsolute(validatedRunnerEnvPath)) {
    throw new Error(
      "SURF_NARRATIVE_RUNNER_ENV_FILE must be set to the absolute runner environment path"
    );
  }
  if (resolve(validatedRunnerEnvPath) !== resolve(runnerEnvPath)) {
    throw new Error(
      "runnerEnvPath must exactly match SURF_NARRATIVE_RUNNER_ENV_FILE used by deploy validation"
    );
  }
  if (runnerEnvPath.toLowerCase().endsWith(".json")) {
    throw new Error(
      "runnerEnvPath must be a dotenv file because the verified runner guard loads dotenv syntax"
    );
  }
  const runnerEnvironment = readStrictDotenvFile(
    runnerEnvPath,
    "Narrative runner environment file"
  );
  const visibilityTimeoutMs = environmentInteger(
    runnerEnvironment,
    "NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS",
    900_000,
    1_000,
    43_200_000
  );
  const minimumExitTimeoutSeconds = Math.ceil(visibilityTimeoutMs / 1_000) + 30;
  if (Number(runnerExitTimeoutSeconds) < minimumExitTimeoutSeconds) {
    throw new Error(
      `runnerExitTimeoutSeconds must be at least ${minimumExitTimeoutSeconds} for the configured visibility timeout`
    );
  }
  const environmentReleaseSha = environmentString(
    runnerEnvironment,
    "NARRATIVE_RUNNER_RELEASE_SHA"
  );
  if (environmentReleaseSha !== releaseSha) {
    throw new Error("runnerEnvPath NARRATIVE_RUNNER_RELEASE_SHA must equal releaseSha");
  }
  const statusFile = environmentString(
    runnerEnvironment,
    "NARRATIVE_RUNNER_STATUS_FILE"
  );
  if (!isAbsolute(statusFile)) {
    throw new Error("NARRATIVE_RUNNER_STATUS_FILE must be absolute in runnerEnvPath");
  }
  const configuredModelId = environmentString(
    runnerEnvironment,
    "NARRATIVE_RUNNER_OMLX_MODEL"
  );
  await validateImmutableRelease(repositoryPath, releaseSha);
  const requestedPnpmPath = requiredAbsolute(options, "pnpmPath");
  const requestedNodeBinPath = requiredAbsolute(options, "nodeBinPath");
  const requestedOmlxPath = requiredAbsolute(options, "omlxPath");
  const omlxDataPath = requiredAbsolute(options, "omlxDataPath");
  const modelArtifactPath = requiredAbsolute(options, "modelArtifactPath");
  const logDir = requiredAbsolute(options, "logDir");

  await requireOperationalPathsOutsideRelease(repositoryPath, {
    outputDir,
    launchAgentsDir,
    logDir,
    runnerEnvPath,
    statusFile
  });

  const pnpmPath = await canonicalExecutable(requestedPnpmPath, "pnpmPath");
  const nodePath = await canonicalExecutable(
    resolve(requestedNodeBinPath, "node"),
    "nodeBinPath/node"
  );
  if (dirname(nodePath) !== await realpath(requestedNodeBinPath)) {
    throw new Error("nodeBinPath must be the canonical directory of the pinned node executable");
  }
  const nodeBinPath = dirname(nodePath);
  const omlxPath = await canonicalExecutable(requestedOmlxPath, "omlxPath");
  const expectedModelArtifactPath = resolve(
    await realpath(omlxDataPath),
    "models",
    configuredModelId
  );
  const canonicalModelArtifactPath = await realpath(modelArtifactPath);
  if (canonicalModelArtifactPath !== expectedModelArtifactPath) {
    throw new Error(
      "modelArtifactPath must be the configured model ID under omlxDataPath/models"
    );
  }
  const modelArtifact = await directoryArtifact(
    canonicalModelArtifactPath,
    "modelArtifactPath"
  );
  const wranglerConfigPath = requiredAbsolute(options, "wranglerConfigPath");
  const workerSecretsPath = requiredAbsolute(options, "workerSecretsPath");
  const wranglerConfigSha256 = options.wranglerConfigSha256;
  if (
    typeof wranglerConfigSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(wranglerConfigSha256)
  ) {
    throw new Error("wranglerConfigSha256 must be an exact lowercase SHA-256");
  }
  await requireOperationalPathsOutsideRelease(repositoryPath, {
    wranglerConfigPath,
    workerSecretsPath
  });
  const canonicalWranglerConfigPath = await privateRegularFile(
    wranglerConfigPath,
    "wranglerConfigPath"
  );
  if ((await sha256File(canonicalWranglerConfigPath)) !== wranglerConfigSha256) {
    throw new Error("wranglerConfigSha256 does not match wranglerConfigPath");
  }
  const workerSecrets = await workerSecretsArtifact(
    workerSecretsPath,
    runnerEnvironment
  );

  await mkdir(outputDir, { recursive: true });
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await chmod(logDir, 0o700);

  const narrativeTemplate = await readFile(
    resolve(packageRoot, "examples/ai.alex.narrative-runner.plist.example"),
    "utf8"
  );
  const omlxTemplate = await readFile(
    resolve(packageRoot, "examples/ai.alex.omlx-server.plist.example"),
    "utf8"
  );
  const supervisorPath = await realpath(
    resolve(packageRoot, "scripts/supervise-omlx.sh")
  );
  const runnerGuardPath = await realpath(
    resolve(packageRoot, "scripts/run-verified-runner.mjs")
  );
  const activationRecordPath = resolve(outputDir, "activation-record.json");
  const files = [
    {
      name: "ai.alex.narrative-runner.plist",
      contents: replacePlaceholders(narrativeTemplate, {
        HOME_ABSOLUTE_PATH: homePath,
        NODE_ABSOLUTE_PATH: nodePath,
        RUNNER_GUARD_ABSOLUTE_PATH: runnerGuardPath,
        ACTIVATION_RECORD_ABSOLUTE_PATH: activationRecordPath,
        REPOSITORY_ABSOLUTE_PATH: repositoryPath,
        RUNNER_EXIT_TIMEOUT_SECONDS: runnerExitTimeoutSeconds,
        NODE_BIN_ABSOLUTE_DIRECTORY: nodeBinPath,
        LOG_DIRECTORY_ABSOLUTE_PATH: logDir
      })
    },
    {
      name: "ai.alex.omlx-server.plist",
      contents: replacePlaceholders(omlxTemplate, {
        HOME_ABSOLUTE_PATH: homePath,
        OMLX_ABSOLUTE_PATH: omlxPath,
        OMLX_SUPERVISOR_ABSOLUTE_PATH: supervisorPath,
        NODE_ABSOLUTE_PATH: nodePath,
        ACTIVATION_VERIFIER_ABSOLUTE_PATH: resolve(
          packageRoot,
          "scripts/render-launch-agents.mjs"
        ),
        ACTIVATION_RECORD_ABSOLUTE_PATH: activationRecordPath,
        OMLX_BIN_ABSOLUTE_DIRECTORY: dirname(omlxPath),
        OMLX_DATA_ABSOLUTE_PATH: omlxDataPath,
        LOG_DIRECTORY_ABSOLUTE_PATH: logDir
      })
    }
  ];

  const written = [];
  for (const file of files) {
    const path = resolve(outputDir, file.name);
    await writeExclusiveOrIdentical(path, file.contents);
    written.push(path);
  }
  const activationRecord = {
    schemaVersion: 3,
    releaseSha,
    repositoryPath: await realpath(repositoryPath),
    runnerEnvPath: await realpath(runnerEnvPath),
    statusFile: await prospectiveRealPath(statusFile),
    modelId: configuredModelId,
    runnerEnvironmentFingerprint: runnerEnvironmentFingerprint(runnerEnvironment),
    wranglerConfig: {
      path: canonicalWranglerConfigPath,
      sha256: wranglerConfigSha256
    },
    workerSecrets,
    modelArtifact,
    renderedLaunchAgents: {
      narrativeRunner: {
        path: await realpath(written[0]),
        sha256: await sha256File(written[0])
      },
      omlxServer: {
        path: await realpath(written[1]),
        sha256: await sha256File(written[1])
      }
    },
    launchAgents: {
      narrativeRunner: {
        path: await prospectiveRealPath(
          resolve(launchAgentsDir, "ai.alex.narrative-runner.plist")
        ),
        sha256: await sha256File(written[0])
      },
      omlxServer: {
        path: await prospectiveRealPath(
          resolve(launchAgentsDir, "ai.alex.omlx-server.plist")
        ),
        sha256: await sha256File(written[1])
      }
    },
    executables: {
      node: { path: nodePath, sha256: await sha256File(nodePath) },
      pnpm: { path: pnpmPath, sha256: await sha256File(pnpmPath) },
      omlx: { path: omlxPath, sha256: await sha256File(omlxPath) },
      omlxSupervisor: {
        path: supervisorPath,
        sha256: await sha256File(supervisorPath)
      },
      runnerGuard: {
        path: runnerGuardPath,
        sha256: await sha256File(runnerGuardPath)
      }
    }
  };
  await writeExclusiveOrIdentical(
    activationRecordPath,
    `${JSON.stringify(activationRecord, null, 2)}\n`
  );
  written.push(activationRecordPath);
  return written;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error(`Invalid argument ${flag ?? ""}`);
    options[flag.slice(2)] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--verifyRecord" && args.length === 2) {
    console.log(JSON.stringify(await verifyLaunchActivation(args[1])));
  } else {
    const options = parseArgs(args);
    const written = await renderLaunchAgents(options);
    for (const path of written) console.log(path);
  }
}
