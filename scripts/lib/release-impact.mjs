import { createHash } from "node:crypto";

export const RELEASE_IMPACT_SCHEMA_VERSION = 1;

export const RELEASE_LANES = Object.freeze({
  ASSETS_ONLY: "assets-only",
  CONSERVATIVE_FULL: "conservative-full"
});

export const RELEASE_IMPACT_KEYS = Object.freeze([
  "workerAssets",
  "workerRuntime",
  "materialization",
  "migrations",
  "seed",
  "queueTopology",
  "triggerTopology",
  "runner",
  "narrativeContract",
  "secrets"
]);

// These hashes describe every stateful or shared input that must remain
// identical before a path-only UI change may use the narrow release lane.
// `workerAssets` is deliberately excluded because it is the one component the
// lane is expected to change.
export const RELEASE_FINGERPRINT_KEYS = Object.freeze([
  "workerAssets",
  "workerRuntime",
  "materialization",
  "migrations",
  "seed",
  "queueTopology",
  "triggerTopology",
  "runnerArtifact",
  "runnerRuntime",
  "narrativeContract",
  "logicalConfig",
  "workerSecrets",
  "dependencyLock",
  "sharedWorkspace",
  "releaseTooling"
]);

export const ASSETS_ONLY_TRUSTED_FINGERPRINT_KEYS = Object.freeze(
  RELEASE_FINGERPRINT_KEYS.filter((key) => key !== "workerAssets")
);

export const RELEASE_CLASSIFICATION_REASON_CODES = Object.freeze({
  ASSETS_ONLY_VERIFIED: "assets_only_verified",
  ACTIVE_RECEIPT_MISSING: "active_receipt_missing",
  ACTIVE_RECEIPT_UNTRUSTED: "active_receipt_untrusted",
  EMPTY_CHANGESET: "empty_changeset",
  FINGERPRINT_MISMATCH: "fingerprint_mismatch",
  FINGERPRINT_SET_INVALID: "fingerprint_set_invalid",
  INVALID_CHANGED_PATH: "invalid_changed_path",
  NON_UI_PATH: "non_ui_path",
  COMPONENT_IMPACT_VERIFIED: "component_impact_verified",
  OPERATOR_FORCED_FULL: "operator_forced_full",
  FIX_FORWARD_REQUIRED: "fix_forward_required",
  CONSERVATIVE_FULL_DEFAULT: "conservative_full_default"
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TRUSTED_ACTIVE_RECEIPT = Symbol("trusted-active-release-receipt");

const UI_SOURCE_EXTENSION =
  /\.(?:css|gif|ico|jpe?g|json|png|svg|ts|tsx|webmanifest|webp|woff2)$/;
const UI_PUBLIC_EXTENSION =
  /\.(?:css|gif|ico|jpe?g|json|png|svg|txt|webmanifest|webp|woff2)$/;
const WORKER_SOURCE_EXTENSION = /\.(?:json|jsonc|mjs|mts|sql|ts|tsx)$/;
const RUNNER_SOURCE_EXTENSION = /\.(?:json|mjs|mts|plist|sh|ts)$/;
const NARRATIVE_CONTRACT_EXTENSION = /\.(?:json|ts)$/;
const ROOT_DOCUMENTATION_PATHS = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md"
]);
const FAIL_CLOSED_FINGERPRINT_KEYS = new Set([
  "logicalConfig",
  "dependencyLock",
  "sharedWorkspace",
  "releaseTooling"
]);
const FINGERPRINT_IMPACT_KEYS = Object.freeze({
  workerAssets: Object.freeze(["workerAssets"]),
  workerRuntime: Object.freeze(["workerRuntime"]),
  materialization: Object.freeze(["materialization"]),
  migrations: Object.freeze(["migrations"]),
  seed: Object.freeze(["seed"]),
  queueTopology: Object.freeze(["queueTopology"]),
  triggerTopology: Object.freeze(["triggerTopology"]),
  runnerArtifact: Object.freeze(["runner"]),
  runnerRuntime: Object.freeze(["runner"]),
  narrativeContract: Object.freeze(["narrativeContract"]),
  workerSecrets: Object.freeze(["secrets"])
});
const ALL_RELEASE_FINGERPRINT_KEYS = Object.freeze(
  [...RELEASE_FINGERPRINT_KEYS].sort()
);

/**
 * @typedef {"assets-only" | "conservative-full"} ReleaseLane
 *
 * @typedef {object} ReleaseImpactVector
 * @property {boolean} workerAssets
 * @property {boolean} workerRuntime
 * @property {boolean} materialization
 * @property {boolean} migrations
 * @property {boolean} seed
 * @property {boolean} queueTopology
 * @property {boolean} triggerTopology
 * @property {boolean} runner
 * @property {boolean} narrativeContract
 * @property {boolean} secrets
 */

function exactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function plainObject(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function canonicalValue(value, seen = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical release values cannot contain non-finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new Error(`Canonical release values cannot contain ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new Error("Canonical release values cannot contain cycles");
  }
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((entry) => canonicalValue(entry, seen));
  } else {
    plainObject(value, "Canonical release value");
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (/\p{Cc}/u.test(key)) {
        throw new Error("Canonical release object keys cannot contain control characters");
      }
      normalized[key] = canonicalValue(value[key], seen);
    }
  }
  seen.delete(value);
  return normalized;
}

export function canonicalReleaseJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function fingerprintCanonicalReleaseValue(value) {
  return createHash("sha256")
    .update("surf-release-canonical-v1\0")
    .update(canonicalReleaseJson(value))
    .digest("hex");
}

export function normalizeReleaseRepoPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /\p{Cc}/u.test(value)
  ) {
    return null;
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function bytesForFingerprint(contents) {
  if (typeof contents === "string") return Buffer.from(contents);
  if (contents instanceof Uint8Array) return Buffer.from(contents);
  throw new Error("Release fingerprint contents must be a string or Uint8Array");
}

export function fingerprintReleaseFiles(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Release file fingerprint requires at least one entry");
  }
  const normalized = entries.map((entry) => {
    plainObject(entry, "Release fingerprint entry");
    exactKeys(entry, ["path", "contents"], "Release fingerprint entry");
    const path = normalizeReleaseRepoPath(entry.path);
    if (!path) throw new Error("Release fingerprint entry path is unsafe");
    return { path, contents: bytesForFingerprint(entry.contents) };
  });
  normalized.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new Error(`Duplicate release fingerprint path: ${normalized[index].path}`);
    }
  }

  const hash = createHash("sha256").update("surf-release-files-v1\0");
  for (const entry of normalized) {
    const pathBytes = Buffer.from(entry.path);
    hash.update(`${pathBytes.byteLength}:`);
    hash.update(pathBytes);
    hash.update(`${entry.contents.byteLength}:`);
    hash.update(entry.contents);
  }
  return hash.digest("hex");
}

export function assertReleaseFingerprintSet(value, label = "Release fingerprints") {
  exactKeys(value, RELEASE_FINGERPRINT_KEYS, label);
  for (const key of RELEASE_FINGERPRINT_KEYS) {
    if (!SHA256_PATTERN.test(value[key])) {
      throw new Error(`${label}.${key} must be an exact lowercase SHA-256`);
    }
  }
  return Object.freeze({ ...value });
}

/** @returns {Readonly<ReleaseImpactVector>} */
export function releaseImpactForLane(lane) {
  if (lane === RELEASE_LANES.ASSETS_ONLY) {
    return Object.freeze(
      Object.fromEntries(
        RELEASE_IMPACT_KEYS.map((key) => [key, key === "workerAssets"])
      )
    );
  }
  if (lane === RELEASE_LANES.CONSERVATIVE_FULL) {
    return Object.freeze(
      Object.fromEntries(RELEASE_IMPACT_KEYS.map((key) => [key, true]))
    );
  }
  throw new Error(`Unknown release lane: ${String(lane)}`);
}

export function assertReleaseImpactVector(value) {
  exactKeys(value, RELEASE_IMPACT_KEYS, "Release impact vector");
  for (const key of RELEASE_IMPACT_KEYS) {
    if (typeof value[key] !== "boolean") {
      throw new Error(`Release impact ${key} must be boolean`);
    }
  }
  return Object.freeze({ ...value });
}

function impactForFingerprintMismatches(mismatchKeys) {
  const impacted = new Set();
  for (const fingerprintKey of mismatchKeys) {
    for (const impactKey of FINGERPRINT_IMPACT_KEYS[fingerprintKey] ?? []) {
      impacted.add(impactKey);
    }
  }
  return Object.freeze(
    Object.fromEntries(
      RELEASE_IMPACT_KEYS.map((key) => [key, impacted.has(key)])
    )
  );
}

function isAllTrueImpact(impact) {
  return RELEASE_IMPACT_KEYS.every((key) => impact[key]);
}

function sameStringSet(left, right) {
  return left.join("\0") === right.join("\0");
}

export function assertReleaseClassification(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "lane",
      "impact",
      "changedPaths",
      "reasonCodes",
      "comparedFingerprintKeys",
      "mismatchKeys"
    ],
    "Release classification"
  );
  if (value.schemaVersion !== RELEASE_IMPACT_SCHEMA_VERSION) {
    throw new Error("Release classification schema is unsupported");
  }
  if (!Object.values(RELEASE_LANES).includes(value.lane)) {
    throw new Error("Release classification lane is invalid");
  }
  const impact = assertReleaseImpactVector(value.impact);
  const arrays = [
    ["changedPaths", value.changedPaths],
    ["reasonCodes", value.reasonCodes],
    ["comparedFingerprintKeys", value.comparedFingerprintKeys],
    ["mismatchKeys", value.mismatchKeys]
  ];
  for (const [label, entries] of arrays) {
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new Error(`Release classification ${label} must be a string array`);
    }
    if (new Set(entries).size !== entries.length) {
      throw new Error(`Release classification ${label} must not contain duplicates`);
    }
    if ([...entries].sort().some((entry, index) => entry !== entries[index])) {
      throw new Error(`Release classification ${label} must be sorted`);
    }
  }
  if (
    value.changedPaths.some((path) => normalizeReleaseRepoPath(path) !== path)
  ) {
    throw new Error("Release classification contains an unsafe changed path");
  }
  const allowedReasons = new Set(Object.values(RELEASE_CLASSIFICATION_REASON_CODES));
  if (value.reasonCodes.some((reason) => !allowedReasons.has(reason))) {
    throw new Error("Release classification contains an unknown reason code");
  }
  for (const key of [
    ...value.comparedFingerprintKeys,
    ...value.mismatchKeys
  ]) {
    if (!RELEASE_FINGERPRINT_KEYS.includes(key)) {
      throw new Error("Release classification contains an unknown fingerprint key");
    }
  }
  if (
    value.lane === RELEASE_LANES.ASSETS_ONLY &&
    (RELEASE_IMPACT_KEYS.some(
      (key) => impact[key] !== releaseImpactForLane(value.lane)[key]
    ) ||
      value.changedPaths.length === 0 ||
      value.changedPaths.some((path) => !isNarrowUiReleasePath(path)) ||
      value.reasonCodes.length !== 1 ||
      value.reasonCodes[0] !==
        RELEASE_CLASSIFICATION_REASON_CODES.ASSETS_ONLY_VERIFIED ||
      value.mismatchKeys.length !== 0 ||
      value.comparedFingerprintKeys.join("\0") !==
        [...ASSETS_ONLY_TRUSTED_FINGERPRINT_KEYS].sort().join("\0"))
  ) {
    throw new Error("Assets-only release classification is not fully trusted");
  }
  if (
    value.lane === RELEASE_LANES.CONSERVATIVE_FULL &&
    !isAllTrueImpact(impact)
  ) {
    const expectedImpact = impactForFingerprintMismatches(value.mismatchKeys);
    const expectedReasons = [
      RELEASE_CLASSIFICATION_REASON_CODES.COMPONENT_IMPACT_VERIFIED,
      RELEASE_CLASSIFICATION_REASON_CODES.CONSERVATIVE_FULL_DEFAULT,
      ...(value.mismatchKeys.length > 0
        ? [RELEASE_CLASSIFICATION_REASON_CODES.FINGERPRINT_MISMATCH]
        : [])
    ].sort();
    if (
      value.changedPaths.length === 0 ||
      value.changedPaths.some((path) => !isClaimedComponentReleasePath(path)) ||
      value.mismatchKeys.some((key) => FAIL_CLOSED_FINGERPRINT_KEYS.has(key)) ||
      RELEASE_IMPACT_KEYS.some((key) => impact[key] !== expectedImpact[key]) ||
      !sameStringSet(value.comparedFingerprintKeys, ALL_RELEASE_FINGERPRINT_KEYS) ||
      !sameStringSet(value.reasonCodes, expectedReasons)
    ) {
      throw new Error(
        "Conservative release classification has an unverified component impact"
      );
    }
  }
  return Object.freeze({
    ...value,
    impact,
    changedPaths: Object.freeze([...value.changedPaths]),
    reasonCodes: Object.freeze([...value.reasonCodes]),
    comparedFingerprintKeys: Object.freeze([
      ...value.comparedFingerprintKeys
    ]),
    mismatchKeys: Object.freeze([...value.mismatchKeys])
  });
}

export function isNarrowUiReleasePath(value) {
  const path = normalizeReleaseRepoPath(value);
  if (!path) return false;
  if (path === "apps/web/index.html") return true;
  if (path.startsWith("apps/web/src/")) {
    // UI test companions are safe inputs for this lane even though the client
    // build digest deliberately excludes them. A normal UI PR should not be
    // forced through storage, Queue, or runner work merely because it carries
    // its colocated test update.
    return UI_SOURCE_EXTENSION.test(path);
  }
  if (path.startsWith("apps/web/public/")) return UI_PUBLIC_EXTENSION.test(path);
  return false;
}

function isClaimedComponentReleasePath(value) {
  const path = normalizeReleaseRepoPath(value);
  if (!path) return false;
  if (isNarrowUiReleasePath(path)) return true;

  // These roots are either direct fingerprint inputs or source/test companions
  // whose production effect is bounded by the corresponding built-artifact
  // fingerprint. Inputs outside this list cannot receive a derived vector.
  if (
    path.startsWith("apps/web/worker/") &&
    WORKER_SOURCE_EXTENSION.test(path)
  ) {
    return true;
  }
  if (path === "apps/web/wrangler.jsonc") return true;
  if (
    path.startsWith("packages/db/migrations/") ||
    path.startsWith("packages/db/seeds/") ||
    path.startsWith("packages/forecast-core/") ||
    path.startsWith("services/extractor/")
  ) {
    return true;
  }
  if (
    [
      "packages/db/scripts/generate-norcal-seed.ts",
      "packages/db/src/norcal-seed-config.ts",
      "packages/db/src/norcal-seed.ts"
    ].includes(path)
  ) {
    // These are the deterministic source/generator companions for the
    // fingerprinted checked-in SQL seed. If they drift without changing that
    // artifact, they cannot alter a production seed operation.
    return true;
  }
  if (
    path.startsWith("apps/narrative-runner/src/") &&
    RUNNER_SOURCE_EXTENSION.test(path)
  ) {
    return true;
  }
  if (
    path.startsWith("apps/narrative-runner/test/") &&
    RUNNER_SOURCE_EXTENSION.test(path)
  ) {
    return true;
  }
  if (
    path.startsWith("apps/narrative-runner/scripts/") &&
    RUNNER_SOURCE_EXTENSION.test(path)
  ) {
    return true;
  }
  if (
    path.startsWith("apps/narrative-runner/examples/") &&
    RUNNER_SOURCE_EXTENSION.test(path)
  ) {
    return true;
  }
  if (
    [
      "apps/narrative-runner/.env.example",
      "apps/narrative-runner/bakeoff.example.json",
      "apps/narrative-runner/package.json",
      "apps/narrative-runner/tsconfig.json",
      "apps/narrative-runner/vitest.config.ts"
    ].includes(path)
  ) {
    return true;
  }
  if (
    path.startsWith("packages/narrative-contracts/") &&
    NARRATIVE_CONTRACT_EXTENSION.test(path)
  ) {
    return true;
  }
  if (
    path.startsWith("packages/db/test/") &&
    /\.(?:sql|ts)$/.test(path)
  ) {
    return true;
  }
  if (path.startsWith("docs/") || ROOT_DOCUMENTATION_PATHS.has(path)) {
    return true;
  }
  return false;
}

export function forceConservativeReleaseClassification(
  classification,
  reasonCode = RELEASE_CLASSIFICATION_REASON_CODES.OPERATOR_FORCED_FULL
) {
  const current = assertReleaseClassification(classification);
  if (
    ![
      RELEASE_CLASSIFICATION_REASON_CODES.OPERATOR_FORCED_FULL,
      RELEASE_CLASSIFICATION_REASON_CODES.FIX_FORWARD_REQUIRED
    ].includes(reasonCode)
  ) {
    throw new Error("Forced conservative release reason is invalid");
  }
  return conservativeClassification(
    current.changedPaths,
    [...current.reasonCodes, reasonCode],
    current.mismatchKeys
  );
}

function assertTrustedReceiptShape(receipt) {
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "releaseId",
      "targetGitSha",
      "workerVersionId",
      "journalSha256",
      "state",
      "fingerprints"
    ],
    "Trusted active release receipt"
  );
  if (receipt.schemaVersion !== RELEASE_IMPACT_SCHEMA_VERSION) {
    throw new Error("Trusted active release receipt schema is unsupported");
  }
  if (!RELEASE_ID_PATTERN.test(receipt.releaseId)) {
    throw new Error("Trusted active release receipt has an invalid release ID");
  }
  if (!SHA_PATTERN.test(receipt.targetGitSha)) {
    throw new Error("Trusted active release receipt has an invalid target Git SHA");
  }
  if (!UUID_PATTERN.test(receipt.workerVersionId)) {
    throw new Error("Trusted active release receipt has an invalid Worker version ID");
  }
  if (!SHA256_PATTERN.test(receipt.journalSha256)) {
    throw new Error("Trusted active release receipt has an invalid journal SHA-256");
  }
  if (receipt.state !== "complete") {
    throw new Error("Trusted active release receipt must come from a complete release");
  }
  assertReleaseFingerprintSet(receipt.fingerprints, "Active release fingerprints");
}

// Callers should obtain this value by resolving an active pointer against its
// journal. The non-enumerable brand prevents an unchecked deserialized object
// from accidentally crossing the classifier boundary.
export function createTrustedActiveReleaseReceipt(receipt) {
  assertTrustedReceiptShape(receipt);
  const trusted = {
    ...receipt,
    fingerprints: Object.freeze({ ...receipt.fingerprints })
  };
  Object.defineProperty(trusted, TRUSTED_ACTIVE_RECEIPT, {
    value: true,
    enumerable: false
  });
  return Object.freeze(trusted);
}

export function isTrustedActiveReleaseReceipt(value) {
  return Boolean(value?.[TRUSTED_ACTIVE_RECEIPT]);
}

function conservativeClassification(changedPaths, reasonCodes, mismatchKeys = []) {
  const reasons = [...new Set([
    ...reasonCodes,
    RELEASE_CLASSIFICATION_REASON_CODES.CONSERVATIVE_FULL_DEFAULT
  ])].sort();
  return Object.freeze({
    schemaVersion: RELEASE_IMPACT_SCHEMA_VERSION,
    lane: RELEASE_LANES.CONSERVATIVE_FULL,
    impact: releaseImpactForLane(RELEASE_LANES.CONSERVATIVE_FULL),
    changedPaths: Object.freeze([...changedPaths]),
    reasonCodes: Object.freeze(reasons),
    comparedFingerprintKeys: Object.freeze([]),
    mismatchKeys: Object.freeze([...mismatchKeys].sort())
  });
}

function componentClassification(changedPaths, mismatchKeys) {
  const sortedMismatchKeys = [...mismatchKeys].sort();
  const reasons = [
    RELEASE_CLASSIFICATION_REASON_CODES.COMPONENT_IMPACT_VERIFIED,
    RELEASE_CLASSIFICATION_REASON_CODES.CONSERVATIVE_FULL_DEFAULT,
    ...(sortedMismatchKeys.length > 0
      ? [RELEASE_CLASSIFICATION_REASON_CODES.FINGERPRINT_MISMATCH]
      : [])
  ].sort();
  return Object.freeze({
    schemaVersion: RELEASE_IMPACT_SCHEMA_VERSION,
    lane: RELEASE_LANES.CONSERVATIVE_FULL,
    impact: impactForFingerprintMismatches(sortedMismatchKeys),
    changedPaths: Object.freeze([...changedPaths]),
    reasonCodes: Object.freeze(reasons),
    comparedFingerprintKeys: ALL_RELEASE_FINGERPRINT_KEYS,
    mismatchKeys: Object.freeze(sortedMismatchKeys)
  });
}

export function classifyReleaseImpact({
  changedPaths,
  targetFingerprints,
  activeReceipt
}) {
  if (!Array.isArray(changedPaths)) {
    throw new Error("Release changedPaths must be an array");
  }
  const normalizedPaths = [];
  let invalidPath = false;
  for (const candidate of changedPaths) {
    const normalized = normalizeReleaseRepoPath(candidate);
    if (!normalized) {
      invalidPath = true;
      continue;
    }
    normalizedPaths.push(normalized);
  }
  const uniquePaths = [...new Set(normalizedPaths)].sort();
  if (invalidPath) {
    return conservativeClassification(uniquePaths, [
      RELEASE_CLASSIFICATION_REASON_CODES.INVALID_CHANGED_PATH
    ]);
  }
  if (uniquePaths.length === 0) {
    return conservativeClassification(uniquePaths, [
      RELEASE_CLASSIFICATION_REASON_CODES.EMPTY_CHANGESET
    ]);
  }
  if (uniquePaths.some((path) => !isClaimedComponentReleasePath(path))) {
    return conservativeClassification(uniquePaths, [
      RELEASE_CLASSIFICATION_REASON_CODES.NON_UI_PATH
    ]);
  }

  let normalizedTargetFingerprints;
  try {
    normalizedTargetFingerprints = assertReleaseFingerprintSet(
      targetFingerprints,
      "Target release fingerprints"
    );
  } catch {
    return conservativeClassification(uniquePaths, [
      RELEASE_CLASSIFICATION_REASON_CODES.FINGERPRINT_SET_INVALID
    ]);
  }
  if (!activeReceipt) {
    return conservativeClassification(uniquePaths, [
      RELEASE_CLASSIFICATION_REASON_CODES.ACTIVE_RECEIPT_MISSING
    ]);
  }
  if (!isTrustedActiveReleaseReceipt(activeReceipt)) {
    return conservativeClassification(uniquePaths, [
      RELEASE_CLASSIFICATION_REASON_CODES.ACTIVE_RECEIPT_UNTRUSTED
    ]);
  }

  const mismatchKeys = RELEASE_FINGERPRINT_KEYS.filter(
    (key) =>
      normalizedTargetFingerprints[key] !== activeReceipt.fingerprints[key]
  );
  if (mismatchKeys.some((key) => FAIL_CLOSED_FINGERPRINT_KEYS.has(key))) {
    return conservativeClassification(
      uniquePaths,
      [RELEASE_CLASSIFICATION_REASON_CODES.FINGERPRINT_MISMATCH],
      mismatchKeys
    );
  }

  const sensitiveMismatchKeys = mismatchKeys.filter(
    (key) => key !== "workerAssets"
  );
  if (
    uniquePaths.every((path) => isNarrowUiReleasePath(path)) &&
    sensitiveMismatchKeys.length === 0
  ) {
    return Object.freeze({
      schemaVersion: RELEASE_IMPACT_SCHEMA_VERSION,
      lane: RELEASE_LANES.ASSETS_ONLY,
      impact: releaseImpactForLane(RELEASE_LANES.ASSETS_ONLY),
      changedPaths: Object.freeze(uniquePaths),
      reasonCodes: Object.freeze([
        RELEASE_CLASSIFICATION_REASON_CODES.ASSETS_ONLY_VERIFIED
      ]),
      comparedFingerprintKeys: Object.freeze(
        [...ASSETS_ONLY_TRUSTED_FINGERPRINT_KEYS].sort()
      ),
      mismatchKeys: Object.freeze([])
    });
  }

  return componentClassification(uniquePaths, mismatchKeys);
}
