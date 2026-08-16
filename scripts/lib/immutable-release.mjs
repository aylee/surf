import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as FS_CONSTANTS,
  chmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PREPARATION_LOCK_BYTES = 4 * 1024;
const CURRENT_PROCESS_STARTED_AT_SECONDS = Math.floor(
  (Date.now() - process.uptime() * 1_000) / 1_000
);

function defaultRun(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
}

function exactSha(value, label) {
  if (!SHA_PATTERN.test(value ?? "")) {
    throw new Error(`${label} must be an exact lowercase 40-character SHA`);
  }
  return value;
}

function processIsAlive(pid, signal) {
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function defaultProcessIdentity(pid) {
  let startedAtSeconds;
  try {
    const output = execFileSync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", maxBuffer: 64 * 1024 }
    ).trim();
    if (output) {
      const parsed = new Date(output).getTime();
      if (Number.isFinite(parsed)) startedAtSeconds = Math.floor(parsed / 1_000);
    }
  } catch {
    // The desktop sandbox can deny process-table reads. Its own start time is
    // still available from Node; other owners remain deliberately unverifiable.
  }
  if (startedAtSeconds === undefined && pid === process.pid) {
    startedAtSeconds = CURRENT_PROCESS_STARTED_AT_SECONDS;
  }
  if (startedAtSeconds === undefined) return null;
  return createHash("sha256")
    .update("surf-immutable-release-process-identity-v1\0")
    .update(`${pid}\0${startedAtSeconds}`)
    .digest("hex");
}

function exactPreparationLock(value, targetSha) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "pid,processIdentity,schemaVersion,startedAt,targetGitSha" ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !SHA256_PATTERN.test(value.processIdentity ?? "") ||
    value.targetGitSha !== targetSha ||
    typeof value.startedAt !== "string"
  ) {
    throw new Error("Existing immutable release preparation lock is invalid");
  }
  try {
    if (new Date(value.startedAt).toISOString() !== value.startedAt) {
      throw new Error("invalid timestamp");
    }
  } catch {
    throw new Error("Existing immutable release preparation lock is invalid");
  }
  return value;
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function readPreparationLock(lockPath, targetSha) {
  const pathMetadata = lstatSync(lockPath);
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    (pathMetadata.mode & 0o777) !== 0o600 ||
    pathMetadata.size > MAX_PREPARATION_LOCK_BYTES
  ) {
    throw new Error(
      "Existing immutable release preparation lock must be a bounded mode-0600 regular file"
    );
  }

  let descriptor;
  try {
    descriptor = openSync(
      lockPath,
      FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > MAX_PREPARATION_LOCK_BYTES
    ) {
      throw new Error(
        "Existing immutable release preparation lock must be a bounded mode-0600 regular file"
      );
    }
    const contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const currentPath = lstatSync(lockPath);
    if (
      !sameFile(pathMetadata, before) ||
      !sameFile(before, after) ||
      !sameFile(after, currentPath)
    ) {
      throw new Error(
        "Existing immutable release preparation lock changed while it was inspected"
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error("Existing immutable release preparation lock is not valid JSON");
    }
    return {
      contents,
      metadata: after,
      value: exactPreparationLock(parsed, targetSha)
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, FS_CONSTANTS.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function acquirePreparationLock({
  locksPath,
  targetSha,
  pid,
  now,
  signal,
  processIdentity
}) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Immutable release preparation lock PID is invalid");
  }
  const ownerIdentity = processIdentity(pid);
  if (!SHA256_PATTERN.test(ownerIdentity ?? "")) {
    throw new Error(
      "Immutable release preparation lock could not attest its owner process"
    );
  }
  let startedAt;
  try {
    startedAt = now().toISOString();
    if (new Date(startedAt).toISOString() !== startedAt) {
      throw new Error("invalid timestamp");
    }
  } catch {
    throw new Error("Immutable release preparation lock clock is invalid");
  }

  const stalePath = join(locksPath, "stale");
  mkdirSync(stalePath, { recursive: true, mode: 0o700 });
  const canonicalStalePath = directory(
    stalePath,
    "Immutable release stale-lock directory"
  );
  chmodSync(canonicalStalePath, 0o700);
  const pendingPath = join(locksPath, "pending");
  mkdirSync(pendingPath, { recursive: true, mode: 0o700 });
  const canonicalPendingPath = directory(
    pendingPath,
    "Immutable release pending-lock directory"
  );
  chmodSync(canonicalPendingPath, 0o700);
  const lockPath = join(locksPath, targetSha);
  const contents = `${JSON.stringify({
    schemaVersion: 1,
    pid,
    processIdentity: ownerIdentity,
    startedAt,
    targetGitSha: targetSha
  })}\n`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidatePath = join(
      canonicalPendingPath,
      `${targetSha}-${pid}-${randomUUID()}.json`
    );
    let descriptor;
    let identity;
    let published = false;
    try {
      descriptor = openSync(candidatePath, "wx", 0o600);
      writeFileSync(descriptor, contents, "utf8");
      fsyncSync(descriptor);
      identity = fstatSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(canonicalPendingPath);
      linkSync(candidatePath, lockPath);
      published = true;
      unlinkSync(candidatePath);
      fsyncDirectory(canonicalPendingPath);
      fsyncDirectory(locksPath);
      return Object.freeze({
        path: lockPath,
        release() {
          const current = readPreparationLock(lockPath, targetSha);
          if (
            !sameFile(current.metadata, identity) ||
            current.contents !== contents
          ) {
            throw new Error(
              "Immutable release preparation lock ownership changed before release"
            );
          }
          unlinkSync(lockPath);
          fsyncDirectory(locksPath);
        }
      });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (published) {
        const current = readPreparationLock(lockPath, targetSha);
        if (
          !sameFile(current.metadata, identity) ||
          current.contents !== contents
        ) {
          throw new Error(
            "Immutable release preparation lock ownership changed during failed publication",
            { cause: error }
          );
        }
        unlinkSync(lockPath);
        fsyncDirectory(locksPath);
      }
      try {
        unlinkSync(candidatePath);
        fsyncDirectory(canonicalPendingPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
      if (error?.code !== "EEXIST") throw error;

      const existing = readPreparationLock(lockPath, targetSha);
      const ownerAlive = processIsAlive(existing.value.pid, signal);
      const currentIdentity = ownerAlive
        ? processIdentity(existing.value.pid)
        : null;
      if (
        ownerAlive &&
        currentIdentity === existing.value.processIdentity
      ) {
        throw new Error(
          `Immutable release preparation is already locked for ${targetSha}`
        );
      }
      if (ownerAlive && !SHA256_PATTERN.test(currentIdentity ?? "")) {
        throw new Error(
          "Existing immutable release preparation lock owner identity could not be verified"
        );
      }

      const archivedPath = join(
        canonicalStalePath,
        `${existing.value.startedAt.replace(/[^0-9a-z]/gi, "-")}-${existing.value.pid}-${randomUUID()}.json`
      );
      try {
        renameSync(lockPath, archivedPath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      const archived = readPreparationLock(archivedPath, targetSha);
      if (
        !sameFile(archived.metadata, existing.metadata) ||
        archived.contents !== existing.contents
      ) {
        throw new Error(
          "Immutable release preparation lock changed during stale recovery"
        );
      }
      fsyncDirectory(canonicalStalePath);
      fsyncDirectory(locksPath);
    }
  }
  throw new Error("Could not acquire the immutable release preparation lock");
}

function directory(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label} must be an existing directory`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  const canonical = realpathSync(path);
  if (canonical !== resolve(path)) {
    throw new Error(`${label} must use its canonical non-symlink path`);
  }
  return canonical;
}

function gitValue(run, repositoryPath, args, label) {
  let output;
  try {
    output = run("git", ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (cause) {
    throw new Error(`Could not inspect immutable release ${label}`, { cause });
  }
  return String(output).trim();
}

export function validateImmutableRelease(
  repositoryPath,
  targetSha,
  { run = defaultRun } = {}
) {
  const expectedSha = exactSha(targetSha, "Immutable release SHA");
  const canonicalRepository = directory(repositoryPath, "Immutable release path");
  const topLevel = gitValue(
    run,
    canonicalRepository,
    ["rev-parse", "--show-toplevel"],
    "repository root"
  );
  if (realpathSync(topLevel) !== canonicalRepository) {
    throw new Error("Immutable release path must be the Git worktree root");
  }
  const head = gitValue(run, canonicalRepository, ["rev-parse", "HEAD"], "HEAD");
  if (head !== expectedSha) {
    throw new Error("Immutable release HEAD does not match the requested SHA");
  }
  const branch = gitValue(
    run,
    canonicalRepository,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "branch"
  );
  if (branch !== "HEAD") {
    throw new Error("Immutable release must use a detached HEAD");
  }
  const status = gitValue(
    run,
    canonicalRepository,
    ["status", "--porcelain", "--untracked-files=all"],
    "status"
  );
  if (status !== "") {
    throw new Error("Immutable release worktree must be clean");
  }
  return Object.freeze({ path: canonicalRepository, sourceRevision: expectedSha });
}

export function resolveGitRevision(
  repositoryPath,
  revision = "origin/main",
  { run = defaultRun } = {}
) {
  const canonicalRepository = directory(repositoryPath, "Source repository");
  if (
    typeof revision !== "string" ||
    revision.length === 0 ||
    revision.length > 512 ||
    /[\x00-\x1f\x7f]/.test(revision) ||
    revision.startsWith("-")
  ) {
    throw new Error("Git revision is unsafe");
  }
  const sha = gitValue(
    run,
    canonicalRepository,
    ["rev-parse", "--verify", `${revision}^{commit}`],
    "target revision"
  );
  return exactSha(sha, "Resolved Git revision");
}

export function listChangedReleasePaths(
  repositoryPath,
  predecessorSha,
  targetSha,
  { run = defaultRun } = {}
) {
  const canonicalRepository = directory(repositoryPath, "Source repository");
  const target = exactSha(targetSha, "Target Git SHA");
  const args = predecessorSha
    ? [
        "diff",
        "--no-renames",
        "--name-only",
        "--diff-filter=ACDMRTUXB",
        exactSha(predecessorSha, "Predecessor Git SHA"),
        target,
        "--"
      ]
    : [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--no-renames",
        "--name-only",
        "--diff-filter=ACDMRTUXB",
        "-r",
        target,
        "--"
      ];
  const output = gitValue(run, canonicalRepository, args, "changed paths");
  return Object.freeze(
    [...new Set(output.split(/\r?\n/).filter(Boolean))].sort()
  );
}

export function assertAppendOnlyMigrationHistory(
  repositoryPath,
  predecessorSha,
  targetSha,
  { run = defaultRun } = {}
) {
  const canonicalRepository = directory(repositoryPath, "Source repository");
  const predecessor = exactSha(predecessorSha, "Migration predecessor SHA");
  const target = exactSha(targetSha, "Migration target SHA");
  const output = gitValue(
    run,
    canonicalRepository,
    [
      "diff",
      "--no-renames",
      "--name-status",
      "--diff-filter=ACDMRTUXB",
      predecessor,
      target,
      "--",
      "packages/db/migrations"
    ],
    "migration history"
  );
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [status, path, extra] = line.split("\t");
    if (
      status !== "A" ||
      extra !== undefined ||
      !/^packages\/db\/migrations\/[0-9][A-Za-z0-9._-]*\.sql$/.test(path ?? "")
    ) {
      throw new Error(
        "Applied migration history must be append-only; modifying, deleting, or renaming an existing migration requires an explicit recovery plan"
      );
    }
  }
  return true;
}

export function prepareImmutableRelease({
  repositoryPath,
  releasesDirectory,
  targetSha,
  install = true,
  environment = process.env,
  run = defaultRun,
  pid = process.pid,
  now = () => new Date(),
  signal = process.kill,
  processIdentity = defaultProcessIdentity
}) {
  const canonicalRepository = directory(repositoryPath, "Source repository");
  const expectedSha = exactSha(targetSha, "Immutable release SHA");
  if (typeof releasesDirectory !== "string" || !isAbsolute(releasesDirectory)) {
    throw new Error("Releases directory must be an absolute path");
  }
  mkdirSync(releasesDirectory, { recursive: true, mode: 0o700 });
  const canonicalReleases = directory(releasesDirectory, "Releases directory");
  chmodSync(canonicalReleases, 0o700);
  if (
    canonicalReleases === canonicalRepository ||
    canonicalReleases.startsWith(`${canonicalRepository}/`)
  ) {
    throw new Error("Immutable releases directory must be outside the source repository");
  }

  const releasePath = join(canonicalReleases, expectedSha);
  const locksPath = join(canonicalReleases, ".locks");
  mkdirSync(locksPath, { recursive: true, mode: 0o700 });
  const canonicalLocksPath = directory(
    locksPath,
    "Immutable release locks directory"
  );
  chmodSync(canonicalLocksPath, 0o700);
  const lock = acquirePreparationLock({
    locksPath: canonicalLocksPath,
    targetSha: expectedSha,
    pid,
    now,
    signal,
    processIdentity
  });

  let reused = false;
  try {
    try {
      lstatSync(releasePath);
      reused = true;
      validateImmutableRelease(releasePath, expectedSha, { run });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      run("git", ["-C", canonicalRepository, "worktree", "add", "--detach", releasePath, expectedSha], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: "pipe"
      });
      validateImmutableRelease(releasePath, expectedSha, { run });
    }

    if (install) {
      run("pnpm", ["install", "--frozen-lockfile"], {
        cwd: releasePath,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: "pipe",
        env: { ...environment, CI: "true" }
      });
      validateImmutableRelease(releasePath, expectedSha, { run });
    }
    return Object.freeze({
      path: realpathSync(releasePath),
      sourceRevision: expectedSha,
      reused,
      dependenciesInstalled: install
    });
  } finally {
    lock.release();
  }
}
