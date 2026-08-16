import { createHash } from "node:crypto";
import {
  lstatSync,
  realpathSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { readVerifiedFileSnapshot } from "./verified-file-snapshot.mjs";

export const RELEASE_PROFILE_SCHEMA_VERSION = 1;
const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_PRIVATE_INPUT_BYTES = 4 * 1024 * 1024;

const PROFILE_KEYS = Object.freeze([
  "schemaVersion",
  "repositoryPath",
  "serviceRoot",
  "releasesDirectory",
  "stateDirectory",
  "wranglerSourcePath",
  "workerSecretsSourcePath",
  "runnerEnvironmentPath",
  "operatorEnvironmentPath",
  "customOrigin",
  "workersDevOrigin"
]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function existingCanonicalDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} must be an existing directory`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  const canonical = realpathSync(path);
  if (canonical !== resolve(path)) {
    throw new Error(`${label} must use its canonical path`);
  }
  return canonical;
}

function privateFileSnapshot(path, label, maximumBytes = MAX_PRIVATE_INPUT_BYTES) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return readVerifiedFileSnapshot(path, {
    label,
    maximumBytes,
    requireMode0600: true,
    requireCanonical: true
  });
}

function privateCanonicalFile(path, label) {
  return privateFileSnapshot(path, label).path;
}

function pathInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function prospectiveServiceDirectory(path, serviceRoot, label) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const candidate = resolve(path);
  if (!pathInside(serviceRoot, candidate)) {
    throw new Error(`${label} must be inside serviceRoot`);
  }
  try {
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a non-symlink directory when it exists`);
    }
    if (realpathSync(candidate) !== candidate) {
      throw new Error(`${label} must use its canonical path`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = realpathSync(dirname(candidate));
    if (!pathInside(serviceRoot, parent) && parent !== serviceRoot) {
      throw new Error(`${label} must have a canonical parent inside serviceRoot`);
    }
    if (resolve(parent, basename(candidate)) !== candidate) {
      throw new Error(`${label} must not traverse a symlinked parent`);
    }
  }
  return candidate;
}

function bareHttpsOrigin(value, label, { workersDev = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.port
  ) {
    throw new Error(`${label} must be a bare HTTPS origin`);
  }
  if (workersDev && !url.hostname.endsWith(".workers.dev")) {
    throw new Error(`${label} must use a workers.dev hostname`);
  }
  return url.origin;
}

export function assertProductionProfile(value) {
  exactKeys(value, PROFILE_KEYS, "Production profile");
  if (value.schemaVersion !== RELEASE_PROFILE_SCHEMA_VERSION) {
    throw new Error("Production profile schema is unsupported");
  }
  const repositoryPath = existingCanonicalDirectory(
    value.repositoryPath,
    "Production repositoryPath"
  );
  const serviceRoot = existingCanonicalDirectory(
    value.serviceRoot,
    "Production serviceRoot"
  );
  if (
    pathInside(repositoryPath, serviceRoot) ||
    pathInside(serviceRoot, repositoryPath) ||
    repositoryPath === serviceRoot
  ) {
    throw new Error("Production serviceRoot and repositoryPath must be disjoint");
  }
  const releasesDirectory = prospectiveServiceDirectory(
    value.releasesDirectory,
    serviceRoot,
    "Production releasesDirectory"
  );
  const stateDirectory = prospectiveServiceDirectory(
    value.stateDirectory,
    serviceRoot,
    "Production stateDirectory"
  );
  if (releasesDirectory === stateDirectory) {
    throw new Error("Production release and state directories must be distinct");
  }
  const privateFiles = Object.fromEntries(
    [
      ["wranglerSourcePath", "Production Wrangler source"],
      ["workerSecretsSourcePath", "Production Worker secrets source"],
      ["runnerEnvironmentPath", "Production runner environment"],
      ["operatorEnvironmentPath", "Production operator environment"]
    ].map(([key, label]) => [key, privateCanonicalFile(value[key], label)])
  );
  if (new Set(Object.values(privateFiles)).size !== Object.values(privateFiles).length) {
    throw new Error("Production profile private source files must be distinct");
  }
  for (const path of Object.values(privateFiles)) {
    if (pathInside(repositoryPath, path)) {
      throw new Error("Production private source files must be outside repositoryPath");
    }
  }
  const customOrigin = bareHttpsOrigin(value.customOrigin, "Production customOrigin");
  const workersDevOrigin = bareHttpsOrigin(
    value.workersDevOrigin,
    "Production workersDevOrigin",
    { workersDev: true }
  );
  if (customOrigin === workersDevOrigin) {
    throw new Error("Production origins must be distinct");
  }
  return Object.freeze({
    schemaVersion: RELEASE_PROFILE_SCHEMA_VERSION,
    repositoryPath,
    serviceRoot,
    releasesDirectory,
    stateDirectory,
    ...privateFiles,
    customOrigin,
    workersDevOrigin
  });
}

export function readProductionProfile(path) {
  const snapshot = privateFileSnapshot(
    path,
    "Production profile",
    MAX_PROFILE_BYTES
  );
  const contents = snapshot.contents.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Production profile must contain valid JSON");
  }
  const profile = assertProductionProfile(parsed);
  return Object.freeze({
    path: snapshot.path,
    sha256: createHash("sha256").update(snapshot.contents).digest("hex"),
    profile
  });
}
