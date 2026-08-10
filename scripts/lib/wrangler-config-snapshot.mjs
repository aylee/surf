import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

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
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`${label} must name an existing mode-0600 regular file`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must name a non-symlink regular file with mode 0600`);
  }
  return realpathSync(path);
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
  return parseConfig(readFileSync(path, "utf8"), "tracked Wrangler config");
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
    if (field.source !== field.canonical && field.source !== expected) {
      throw new Error(
        `Wrangler snapshot ${field.label} must match the tracked release path`
      );
    }
    field.apply(expected);
  }
  return normalized;
}

export function verifyWranglerConfigSnapshot(options) {
  const expectedSha256 = options.expectedSha256?.trim();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) {
    throw new Error("SURF_WRANGLER_CONFIG_SHA256 must be an exact lowercase SHA-256");
  }
  const canonicalPath = strictPrivateFile(options.path, "Wrangler config snapshot");
  requireOutsideRelease(canonicalPath, options.releaseRoot, "Wrangler config snapshot");
  const contents = readFileSync(canonicalPath, "utf8");
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
  const sourcePath = strictPrivateFile(options.sourcePath, "Wrangler config source");
  requireOutsideRelease(sourcePath, options.releaseRoot, "Wrangler config source");
  if (!isAbsolute(options.outputPath)) {
    throw new Error("Wrangler config snapshot output must be an absolute path");
  }
  const outputPath = requireOutsideRelease(
    options.outputPath,
    options.releaseRoot,
    "Wrangler config snapshot output"
  );
  const source = parseConfig(readFileSync(sourcePath, "utf8"), "Wrangler config source");
  const normalized = normalizeReleasePaths(source, options.releaseRoot);
  const contents = `${JSON.stringify(normalized, null, 2)}\n`;
  const expectedSha256 = sha256(contents);
  try {
    writeFileSync(outputPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
    const metadata = lstatSync(outputPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "Existing Wrangler config snapshot must be a non-symlink mode-0600 regular file"
      );
    }
    if (readFileSync(outputPath, "utf8") !== contents) {
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
