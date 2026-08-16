import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { repoRoot } from "./root-env.mjs";

export const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
export const BUILD_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const WEB_PRODUCTION_ROOTS = [
  "apps/web/index.html",
  "apps/web/package.json",
  "apps/web/public",
  "apps/web/src",
  "apps/web/vite.config.ts"
];

function posixRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function productionClientFile(path) {
  const name = path.split("/").at(-1) ?? "";
  return !(
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    name.endsWith(".snap") ||
    name === ".DS_Store"
  );
}

function walkRegularFiles(root, path, results) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Build identity input must not be a symbolic link: ${posixRelative(root, path)}`);
  }
  if (stat.isFile()) {
    const relativePath = posixRelative(root, path);
    if (productionClientFile(relativePath)) results.push(relativePath);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Build identity input must be a regular file or directory: ${posixRelative(root, path)}`);
  }
  for (const entry of readdirSync(path).sort()) {
    walkRegularFiles(root, resolve(path, entry), results);
  }
}

export function clientProductionFiles(root = repoRoot) {
  const files = [];
  for (const input of WEB_PRODUCTION_ROOTS) {
    walkRegularFiles(root, resolve(root, input), files);
  }
  return files.sort();
}

export function digestFiles(root, files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    if (file.startsWith("/") || file.split("/").includes("..")) {
      throw new Error(`Build identity path must be repository-relative: ${file}`);
    }
    const path = resolve(root, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Build identity input must be a regular non-symlink file: ${file}`);
    }
    const contents = readFileSync(path);
    hash.update(`${Buffer.byteLength(file)}:${file}:${contents.byteLength}:`);
    hash.update(contents);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function clientBuildDigest(root = repoRoot) {
  return digestFiles(root, clientProductionFiles(root));
}

export function workerBundleDigest(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Worker bundle must be a regular non-symlink file");
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function gitSourceRevision(root = repoRoot) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  if (!SOURCE_REVISION_PATTERN.test(revision)) {
    throw new Error("Git source revision must be an exact lowercase 40-character SHA");
  }
  return revision;
}

export function resolveWebBuildIdentity({
  root = repoRoot,
  environment = process.env
} = {}) {
  const calculatedClientDigest = clientBuildDigest(root);
  const configuredClientDigest = environment.SURF_CLIENT_BUILD_DIGEST?.trim();
  if (
    configuredClientDigest &&
    (!BUILD_DIGEST_PATTERN.test(configuredClientDigest) ||
      configuredClientDigest !== calculatedClientDigest)
  ) {
    throw new Error(
      "SURF_CLIENT_BUILD_DIGEST must exactly match the canonical production client inputs"
    );
  }

  const sourceRevision = environment.SURF_RELEASE_SHA?.trim() || gitSourceRevision(root);
  if (!SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    throw new Error("SURF_RELEASE_SHA must be an exact lowercase 40-character SHA");
  }

  return Object.freeze({
    schemaVersion: 1,
    sourceRevision,
    clientBuildDigest: calculatedClientDigest
  });
}
