import { constants as fsConstants } from "node:fs";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import { resolve } from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

function sameFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  );
}

function privateFileDescription(label, requireMode0600) {
  return requireMode0600
    ? `${label} must be a readable bounded canonical non-symlink mode-0600 regular file (mode 0600)`
    : `${label} must be a readable bounded canonical non-symlink regular file`;
}

function readBounded(fd, maximumBytes, label) {
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const remainingBytes = maximumBytes - totalBytes;
    const buffer = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, remainingBytes + 1)
    );
    const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maximumBytes) {
      throw new Error(`${label} exceeds its ${maximumBytes}-byte limit`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, totalBytes);
}

export function readVerifiedFileSnapshot(
  path,
  {
    label = "Release input",
    maximumBytes,
    requireMode0600 = false,
    requireCanonical = false
  } = {}
) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1
  ) {
    throw new Error(`${label} snapshot parameters are invalid`);
  }
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error(`${label} cannot be read safely on this platform`);
  }

  const description = privateFileDescription(label, requireMode0600);
  let pathBefore;
  let canonicalBefore;
  try {
    pathBefore = lstatSync(path, { bigint: true });
    canonicalBefore = realpathSync(path);
  } catch {
    throw new Error(description);
  }
  if (
    pathBefore.isSymbolicLink() ||
    !pathBefore.isFile() ||
    (requireCanonical && canonicalBefore !== resolve(path)) ||
    (requireMode0600 && (pathBefore.mode & 0o777n) !== 0o600n) ||
    pathBefore.size > BigInt(maximumBytes)
  ) {
    throw new Error(description);
  }

  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error(description);
  }
  try {
    const fdBefore = fstatSync(fd, { bigint: true });
    if (
      !fdBefore.isFile() ||
      !sameFileState(pathBefore, fdBefore) ||
      (requireMode0600 && (fdBefore.mode & 0o777n) !== 0o600n) ||
      fdBefore.size > BigInt(maximumBytes)
    ) {
      throw new Error(`${label} changed before its verified snapshot was read`);
    }

    const contents = readBounded(fd, maximumBytes, label);
    const fdAfter = fstatSync(fd, { bigint: true });
    let pathAfter;
    let canonicalAfter;
    try {
      pathAfter = lstatSync(path, { bigint: true });
      canonicalAfter = realpathSync(path);
    } catch {
      throw new Error(`${label} changed while its verified snapshot was read`);
    }
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      (requireCanonical && canonicalAfter !== resolve(path)) ||
      canonicalAfter !== canonicalBefore ||
      !sameFileState(fdBefore, fdAfter) ||
      !sameFileState(fdAfter, pathAfter) ||
      (requireMode0600 && (fdAfter.mode & 0o777n) !== 0o600n) ||
      BigInt(contents.byteLength) !== fdAfter.size
    ) {
      throw new Error(`${label} changed while its verified snapshot was read`);
    }
    return Object.freeze({
      path: canonicalAfter,
      contents
    });
  } finally {
    closeSync(fd);
  }
}
