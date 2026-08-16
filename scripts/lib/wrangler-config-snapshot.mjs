import { createHash } from "node:crypto";
import {
  chmodSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";
import { readVerifiedFileSnapshot } from "./verified-file-snapshot.mjs";

const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_WRANGLER_CONFIG_BYTES = 1024 * 1024;
const RELEASE_IDENTITY_VAR_KEYS = Object.freeze([
  "SURF_SOURCE_REVISION",
  "SURF_WORKER_RUNTIME_DIGEST",
  "SURF_CLIENT_BUILD_DIGEST"
]);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function parseConfig(contents, label) {
  const errors = [];
  const config = parse(contents, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !config || typeof config !== "object") {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`${label} is not valid JSONC${details ? `: ${details}` : ""}`);
  }
  return config;
}

function strictPrivateFile(path, label) {
  return readVerifiedFileSnapshot(path, {
    label,
    maximumBytes: MAX_WRANGLER_CONFIG_BYTES,
    requireMode0600: true
  });
}

function pathIsInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function requireOutsideRelease(path, releaseRoot, label) {
  const release = realpathSync(releaseRoot);
  const candidate = resolve(realpathSync(dirname(path)), basename(path));
  if (pathIsInside(release, candidate)) {
    throw new Error(`${label} must be outside the immutable release worktree`);
  }
  return candidate;
}

function canonicalTrackedConfig(releaseRoot) {
  const path = resolve(releaseRoot, "apps/web/wrangler.jsonc");
  const snapshot = readVerifiedFileSnapshot(path, {
    label: "tracked Wrangler config",
    maximumBytes: MAX_WRANGLER_CONFIG_BYTES
  });
  return parseConfig(snapshot.contents.toString("utf8"), "tracked Wrangler config");
}

function normalizeReleasePaths(source, releaseRoot) {
  const canonical = canonicalTrackedConfig(releaseRoot);
  const webRoot = resolve(realpathSync(releaseRoot), "apps/web");
  const normalized = structuredClone(source);
  const fields = [
    {
      label: "$schema",
      source: source.$schema,
      canonical: canonical.$schema,
      apply: (value) => {
        normalized.$schema = value;
      }
    },
    {
      label: "main",
      source: source.main,
      canonical: canonical.main,
      apply: (value) => {
        normalized.main = value;
      }
    },
    {
      label: "assets.directory",
      source: source.assets?.directory,
      canonical: canonical.assets?.directory,
      apply: (value) => {
        normalized.assets.directory = value;
      }
    },
    {
      label: "d1_databases[0].migrations_dir",
      source: source.d1_databases?.[0]?.migrations_dir,
      canonical: canonical.d1_databases?.[0]?.migrations_dir,
      apply: (value) => {
        normalized.d1_databases[0].migrations_dir = value;
      }
    }
  ];
  for (const field of fields) {
    if (typeof field.canonical !== "string" || typeof field.source !== "string") {
      throw new Error(`Wrangler snapshot requires ${field.label}`);
    }
    const expected = resolve(webRoot, field.canonical);
    const releaseSuffix = expected.slice(resolve(realpathSync(releaseRoot)).length);
    const isPriorReleasePath =
      isAbsolute(field.source) && field.source.endsWith(releaseSuffix);
    if (
      field.source !== field.canonical &&
      field.source !== expected &&
      !isPriorReleasePath
    ) {
      throw new Error(
        `Wrangler snapshot ${field.label} must match the tracked release path`
      );
    }
    field.apply(expected);
  }
  return normalized;
}

function applyReleaseIdentity(config, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Wrangler release identity must be an object");
  }
  const expectedKeys = [
    "clientBuildDigest",
    "sourceRevision",
    "workerRuntimeDigest"
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(
      "Wrangler release identity must contain exactly sourceRevision, workerRuntimeDigest, and clientBuildDigest"
    );
  }
  if (!SOURCE_REVISION_PATTERN.test(value.sourceRevision)) {
    throw new Error("Wrangler release source revision must be an exact lowercase Git SHA");
  }
  for (const key of ["workerRuntimeDigest", "clientBuildDigest"]) {
    if (!SHA256_PATTERN.test(value[key])) {
      throw new Error(`Wrangler release ${key} must be an exact lowercase SHA-256`);
    }
  }
  const normalized = structuredClone(config);
  if (
    !normalized.vars ||
    typeof normalized.vars !== "object" ||
    Array.isArray(normalized.vars)
  ) {
    throw new Error("Wrangler snapshot requires a vars object for release identity");
  }
  const values = {
    SURF_SOURCE_REVISION: value.sourceRevision,
    SURF_WORKER_RUNTIME_DIGEST: value.workerRuntimeDigest,
    SURF_CLIENT_BUILD_DIGEST: value.clientBuildDigest
  };
  for (const key of RELEASE_IDENTITY_VAR_KEYS) {
    if (!(key in normalized.vars)) {
      throw new Error(`Tracked Wrangler config is missing release identity var ${key}`);
    }
    normalized.vars[key] = values[key];
  }
  return normalized;
}

export function verifyWranglerConfigSnapshot(options) {
  const expectedSha256 = options.expectedSha256?.trim();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) {
    throw new Error("SURF_WRANGLER_CONFIG_SHA256 must be an exact lowercase SHA-256");
  }
  const snapshot = strictPrivateFile(options.path, "Wrangler config snapshot");
  const canonicalPath = snapshot.path;
  requireOutsideRelease(canonicalPath, options.releaseRoot, "Wrangler config snapshot");
  const contents = snapshot.contents.toString("utf8");
  const actualSha256 = sha256(contents);
  if (actualSha256 !== expectedSha256) {
    throw new Error("Wrangler config snapshot SHA-256 does not match activation");
  }
  const config = parseConfig(contents, "Wrangler config snapshot");
  const normalized = normalizeReleasePaths(config, options.releaseRoot);
  if (JSON.stringify(normalized) !== JSON.stringify(config)) {
    throw new Error("Wrangler config snapshot paths are not pinned to the release");
  }
  return { path: canonicalPath, sha256: actualSha256, config };
}

export function stageWranglerConfigSnapshot(options) {
  const sourceSnapshot = strictPrivateFile(
    options.sourcePath,
    "Wrangler config source"
  );
  const sourcePath = sourceSnapshot.path;
  requireOutsideRelease(sourcePath, options.releaseRoot, "Wrangler config source");
  if (!isAbsolute(options.outputPath)) {
    throw new Error("Wrangler config snapshot output must be an absolute path");
  }
  const outputPath = requireOutsideRelease(
    options.outputPath,
    options.releaseRoot,
    "Wrangler config snapshot output"
  );
  const source = parseConfig(
    sourceSnapshot.contents.toString("utf8"),
    "Wrangler config source"
  );
  let normalized = normalizeReleasePaths(source, options.releaseRoot);
  if (options.releaseIdentity !== undefined) {
    normalized = applyReleaseIdentity(normalized, options.releaseIdentity);
  }
  const contents = `${JSON.stringify(normalized, null, 2)}\n`;
  const expectedSha256 = sha256(contents);
  try {
    writeFileSync(outputPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
    const existing = strictPrivateFile(
      outputPath,
      "Existing Wrangler config snapshot"
    );
    if (existing.contents.toString("utf8") !== contents) {
      throw new Error(
        "Existing Wrangler config snapshot differs; use a new activation path"
      );
    }
  }
  chmodSync(outputPath, 0o600);
  return verifyWranglerConfigSnapshot({
    path: outputPath,
    releaseRoot: options.releaseRoot,
    expectedSha256
  });
}
