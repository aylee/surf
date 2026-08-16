import { createHmac, timingSafeEqual } from "node:crypto";
import {
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parseStrictDotenv } from "./strict-env-file.mjs";
import { readVerifiedFileSnapshot } from "./verified-file-snapshot.mjs";

const MAX_SECRET_SOURCE_BYTES = 1024 * 1024;

const REQUIRED_WORKER_SECRET_KEYS = Object.freeze([
  "GEMINI_API_KEY",
  "NARRATIVE_RESULT_TOKEN"
]);
const OPERATOR_ENVIRONMENT_KEYS = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "SURF_INGEST_TOKEN"
]);
const RELEASE_SYSTEM_ENVIRONMENT_KEYS = Object.freeze([
  "COREPACK_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NVM_BIN",
  "NVM_DIR",
  "PATH",
  "PNPM_HOME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "VOLTA_HOME",
  "XDG_CACHE_HOME"
]);

function privateFileSnapshot(path, label) {
  return readVerifiedFileSnapshot(path, {
    label,
    maximumBytes: MAX_SECRET_SOURCE_BYTES,
    requireMode0600: true,
    requireCanonical: true
  });
}

function exactToken(value, label, minimumLength) {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value !== value.trim() ||
    /[\x00-\x1f\x7f]/.test(value) ||
    /replace|placeholder/i.test(value)
  ) {
    throw new Error(`${label} must be a non-placeholder token without whitespace`);
  }
  return value;
}

export function validateProductionOperatorEnvironment(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Production operator environment must be an object");
  }
  const unknown = Object.keys(values).filter(
    (key) => !OPERATOR_ENVIRONMENT_KEYS.includes(key)
  );
  if (unknown.length > 0) {
    throw new Error(
      `Production operator environment contains unsupported setting ${unknown[0]}`
    );
  }
  const normalized = {
    CLOUDFLARE_API_TOKEN: exactToken(
      values.CLOUDFLARE_API_TOKEN,
      "CLOUDFLARE_API_TOKEN",
      16
    )
  };
  if (!/^[0-9a-f]{32}$/i.test(values.CLOUDFLARE_ACCOUNT_ID ?? "")) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be an exact 32-character ID");
  }
  normalized.CLOUDFLARE_ACCOUNT_ID = values.CLOUDFLARE_ACCOUNT_ID;
  if (values.SURF_INGEST_TOKEN !== undefined) {
    normalized.SURF_INGEST_TOKEN = exactToken(
      values.SURF_INGEST_TOKEN,
      "SURF_INGEST_TOKEN",
      16
    );
  }
  return Object.freeze(normalized);
}

export function createReleaseLocalEnvironment(
  systemEnvironment = process.env
) {
  if (
    !systemEnvironment ||
    typeof systemEnvironment !== "object" ||
    Array.isArray(systemEnvironment)
  ) {
    throw new Error("Release system environment must be an object");
  }
  const environment = {};
  for (const key of RELEASE_SYSTEM_ENVIRONMENT_KEYS) {
    const value = systemEnvironment[key];
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  if (typeof environment.PATH !== "string" || environment.PATH.length === 0) {
    throw new Error("Release system environment requires PATH");
  }
  return Object.freeze(environment);
}

export function createProductionChildEnvironment({
  systemEnvironment = process.env,
  operatorEnvironment,
  baseUrl
}) {
  const local = createReleaseLocalEnvironment(systemEnvironment);
  const operator = validateProductionOperatorEnvironment(operatorEnvironment);
  if (
    typeof baseUrl !== "string" ||
    !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(baseUrl)
  ) {
    throw new Error("Production child environment requires an HTTPS base origin");
  }
  return Object.freeze({
    ...local,
    CLOUDFLARE_ACCOUNT_ID: operator.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: operator.CLOUDFLARE_API_TOKEN,
    SURF_BASE_URL: baseUrl,
    WRANGLER_SEND_METRICS: "false"
  });
}

export function requireProductionIngestToken(environment) {
  return exactToken(
    environment?.SURF_INGEST_TOKEN,
    "SURF_INGEST_TOKEN",
    16
  );
}

function readWorkerSecrets(path) {
  const snapshot = privateFileSnapshot(path, "Worker secrets source");
  let values;
  if (snapshot.path.endsWith(".json")) {
    try {
      values = JSON.parse(snapshot.contents.toString("utf8"));
    } catch {
      throw new Error("Worker secrets JSON is invalid");
    }
  } else {
    values = parseStrictDotenv(
      snapshot.contents.toString("utf8"),
      "Worker secrets source"
    );
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Worker secrets source must contain an object");
  }
  const actualKeys = Object.keys(values).sort();
  if (
    actualKeys.length !== REQUIRED_WORKER_SECRET_KEYS.length ||
    actualKeys.some((key, index) => key !== REQUIRED_WORKER_SECRET_KEYS[index])
  ) {
    throw new Error(
      "Worker secrets source must contain exactly GEMINI_API_KEY and NARRATIVE_RESULT_TOKEN"
    );
  }
  const normalized = {
    GEMINI_API_KEY: exactToken(values.GEMINI_API_KEY, "GEMINI_API_KEY", 16),
    NARRATIVE_RESULT_TOKEN: exactToken(
      values.NARRATIVE_RESULT_TOKEN,
      "NARRATIVE_RESULT_TOKEN",
      16
    )
  };
  const left = Buffer.from(normalized.GEMINI_API_KEY);
  const right = Buffer.from(normalized.NARRATIVE_RESULT_TOKEN);
  if (left.byteLength === right.byteLength && timingSafeEqual(left, right)) {
    throw new Error("Worker secret roles must use distinct tokens");
  }
  return { path: snapshot.path, values: normalized };
}

function writeExclusiveOrIdentical(path, contents) {
  try {
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const snapshot = privateFileSnapshot(path, "Existing Worker secrets snapshot");
    if (snapshot.contents.toString("utf8") !== contents) {
      throw new Error("Existing Worker secrets snapshot differs; use a new release ID");
    }
  }
}

function fingerprint(values, hmacKey) {
  if (
    typeof hmacKey !== "string" ||
    hmacKey.length < 32 ||
    hmacKey !== hmacKey.trim()
  ) {
    throw new Error("Worker secret snapshot requires a strong HMAC key");
  }
  return createHmac("sha256", hmacKey)
    .update("surf-worker-secrets-v2\0")
    .update(JSON.stringify(values))
    .digest("hex");
}

export function inspectWorkerSecrets({ sourcePath, hmacKey }) {
  const source = readWorkerSecrets(sourcePath);
  return Object.freeze({
    sourcePath: source.path,
    fingerprint: fingerprint(source.values, hmacKey),
    geminiToken: source.values.GEMINI_API_KEY,
    resultToken: source.values.NARRATIVE_RESULT_TOKEN,
    assertUnchanged() {
      const current = readWorkerSecrets(source.path);
      if (fingerprint(current.values, hmacKey) !== fingerprint(source.values, hmacKey)) {
        throw new Error("Worker secret source changed during release");
      }
    }
  });
}

export function stageWorkerSecretsSnapshot({ sourcePath, outputPath, hmacKey }) {
  const source = readWorkerSecrets(sourcePath);
  if (!outputPath.endsWith(".json") || resolve(outputPath) !== outputPath) {
    throw new Error("Worker secrets snapshot path must be an absolute .json path");
  }
  const parent = realpathSync(dirname(outputPath));
  if (resolve(parent, outputPath.split("/").at(-1)) !== outputPath) {
    throw new Error("Worker secrets snapshot must use a canonical parent");
  }
  const contents = `${JSON.stringify(source.values, null, 2)}\n`;
  writeExclusiveOrIdentical(outputPath, contents);
  const canonicalPath = privateFileSnapshot(
    outputPath,
    "Worker secrets snapshot"
  ).path;
  const expectedFingerprint = fingerprint(source.values, hmacKey);
  const assertUnchanged = () => {
    const currentSource = readWorkerSecrets(source.path);
    const currentSnapshot = readWorkerSecrets(canonicalPath);
    if (
      fingerprint(currentSource.values, hmacKey) !== expectedFingerprint ||
      fingerprint(currentSnapshot.values, hmacKey) !== expectedFingerprint
    ) {
      throw new Error("Worker secret input changed after snapshot staging");
    }
  };
  assertUnchanged();
  return Object.freeze({
    path: canonicalPath,
    fingerprint: expectedFingerprint,
    geminiToken: source.values.GEMINI_API_KEY,
    resultToken: source.values.NARRATIVE_RESULT_TOKEN,
    assertUnchanged
  });
}
