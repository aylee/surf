import * as nodeFs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function ensurePrivateDirectory(fs, path) {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Release lock directory must be a non-symlink directory");
  }
  fs.chmodSync(path, 0o700);
}

function fsyncDirectory(fs, path) {
  const descriptor = fs.openSync(path, fs.constants?.O_RDONLY ?? 0);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function processIsAlive(pid, signal = process.kill) {
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupIsAlive(processGroupId, signal = process.kill) {
  return processIsAlive(-processGroupId, signal);
}

function defaultProcessIdentity(pid) {
  let output;
  try {
    output = execFileSync(
      "ps",
      ["-o", "lstart=,command=", "-p", String(pid)],
      { encoding: "utf8", maxBuffer: 64 * 1024 }
    ).trim();
  } catch {
    return null;
  }
  if (!output) return null;
  return createHash("sha256")
    .update("surf-release-process-identity-v1\0")
    .update(output)
    .digest("hex");
}

function exactLock(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "pid,processGroupId,processIdentity,schemaVersion,startedAt,targetGitSha" ||
    value.schemaVersion !== 2 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !Number.isSafeInteger(value.processGroupId) ||
    value.processGroupId < 1 ||
    !SHA256_PATTERN.test(value.processIdentity ?? "") ||
    !SHA_PATTERN.test(value.targetGitSha ?? "") ||
    typeof value.startedAt !== "string" ||
    new Date(value.startedAt).toISOString() !== value.startedAt
  ) {
    throw new Error("Existing release lock is invalid");
  }
  return value;
}

function readExistingLock(fs, path) {
  const noFollow = fs.constants?.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new Error("Release lock cannot be read safely on this platform");
  }
  let descriptor;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor);
    const contents = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(path);
    if (
      !before.isFile() ||
      !after.isFile() ||
      pathAfter.isSymbolicLink() ||
      (after.mode & 0o777) !== 0o600 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      after.size !== pathAfter.size ||
      Buffer.byteLength(contents) !== after.size
    ) {
      throw new Error("Existing release lock changed while it was read");
    }
    let value;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new Error("Existing release lock is not valid JSON");
    }
    return { value: exactLock(value), metadata: after, contents };
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("Existing release lock is not a mode-0600 regular file");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function acquireReleaseLock({
  stateDirectory,
  targetGitSha,
  fs = nodeFs,
  pid = process.pid,
  processGroupId = pid,
  now = () => new Date(),
  signal = process.kill,
  processIdentity = defaultProcessIdentity
}) {
  if (!SHA_PATTERN.test(targetGitSha ?? "")) {
    throw new Error("Release lock target must be an exact Git SHA");
  }
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Release lock PID is invalid");
  }
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) {
    throw new Error("Release lock process-group ID is invalid");
  }
  const ownerIdentity = processIdentity(pid);
  if (!SHA256_PATTERN.test(ownerIdentity ?? "")) {
    throw new Error("Release lock could not attest the owner process identity");
  }
  const root = resolve(stateDirectory);
  ensurePrivateDirectory(fs, root);
  const staleDirectory = join(root, "stale-locks");
  ensurePrivateDirectory(fs, staleDirectory);
  const path = join(root, "release.lock");
  const startedAt = now().toISOString();
  if (new Date(startedAt).toISOString() !== startedAt) {
    throw new Error("Release lock clock must return a valid Date");
  }
  const contents = `${JSON.stringify({
    schemaVersion: 2,
    pid,
    processGroupId,
    processIdentity: ownerIdentity,
    startedAt,
    targetGitSha
  })}\n`;

  let descriptor;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      descriptor = fs.openSync(path, "wx", 0o600);
      fs.writeFileSync(descriptor, contents, "utf8");
      fs.fsyncSync(descriptor);
      const identity = fs.fstatSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(fs, root);
      return Object.freeze({
        path,
        release() {
          const current = readExistingLock(fs, path);
          if (
            current.metadata.dev !== identity.dev ||
            current.metadata.ino !== identity.ino ||
            current.contents !== contents
          ) {
            throw new Error("Release lock ownership changed before release");
          }
          fs.unlinkSync(path);
          fsyncDirectory(fs, root);
        }
      });
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
      if (error?.code !== "EEXIST") throw error;
      const existing = readExistingLock(fs, path);
      const leaderAlive = processIsAlive(existing.value.pid, signal);
      const groupAlive = processGroupIsAlive(
        existing.value.processGroupId,
        signal
      );
      const currentIdentity = leaderAlive
        ? processIdentity(existing.value.pid)
        : null;
      const exactLeaderIsAlive =
        leaderAlive && currentIdentity === existing.value.processIdentity;
      if (exactLeaderIsAlive || groupAlive) {
        throw new Error(
          `Another production release or one of its mutation subprocesses is active under process group ${existing.value.processGroupId}`
        );
      }
      const stalePath = join(
        staleDirectory,
        `${existing.value.startedAt.replace(/[^0-9a-z]/gi, "-")}-${existing.value.pid}-${randomUUID()}.json`
      );
      try {
        fs.renameSync(path, stalePath);
        fs.chmodSync(stalePath, 0o600);
        fsyncDirectory(fs, root);
        fsyncDirectory(fs, staleDirectory);
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new Error("Could not acquire the production release lock");
}
