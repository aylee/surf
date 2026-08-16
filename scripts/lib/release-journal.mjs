import * as nodeFs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  RELEASE_IMPACT_SCHEMA_VERSION,
  RELEASE_LANES,
  assertReleaseClassification,
  assertReleaseFingerprintSet,
  canonicalReleaseJson,
  createTrustedActiveReleaseReceipt,
  fingerprintCanonicalReleaseValue
} from "./release-impact.mjs";

export const RELEASE_JOURNAL_SCHEMA_VERSION = 2;
export const RELEASE_POINTER_SCHEMA_VERSION = 1;

export const RELEASE_JOURNAL_STATES = Object.freeze({
  PLANNED: "planned",
  VERIFIED: "verified",
  PREPARED: "prepared",
  WORKER_UPLOADED: "worker-uploaded",
  DATA_PREPARED: "data-prepared",
  RUNNER_READY: "runner-ready",
  PREDECESSOR_RECHECKED: "predecessor-rechecked",
  WORKER_ACTIVE: "worker-active",
  TRIGGERS_SYNCED: "triggers-synced",
  GENERATION_VERIFIED: "generation-verified",
  VERIFIED_LIVE: "verified-live",
  COMPLETE: "complete",
  RETRYABLE_FAILURE: "retryable-failure",
  NEEDS_FIX_FORWARD: "needs-fix-forward",
  SUPERSEDED: "superseded",
  REPLACED: "replaced"
});

export const RELEASE_POINTER_KINDS = Object.freeze({
  ACTIVE: "active",
  LAST_COMPLETE: "last-complete"
});

export const RELEASE_FAILURE_CODES = Object.freeze({
  INTERRUPTED: "interrupted",
  VERIFY_FAILED: "verify_failed",
  PREPARE_FAILED: "prepare_failed",
  UPLOAD_FAILED: "upload_failed",
  DATA_PREPARE_FAILED: "data_prepare_failed",
  RUNNER_FAILED: "runner_failed",
  PREDECESSOR_CHANGED: "predecessor_changed",
  DEPENDENCY_DRIFT: "dependency_drift",
  ACTIVATION_AMBIGUOUS: "activation_ambiguous",
  TRIGGER_SYNC_FAILED: "trigger_sync_failed",
  GENERATION_FAILED: "generation_failed",
  LIVE_VERIFY_FAILED: "live_verify_failed"
});

export const RELEASE_RECEIPT_KEYS = Object.freeze([
  "profileSha256",
  "operatorEnvironmentFingerprint",
  "wranglerConfigSha256",
  "workerSecretsFingerprint",
  "workerVersionId",
  "deploymentId",
  "runnerActivationId",
  "runnerDrainSha256",
  "d1Bookmark",
  "d1ExportSha256",
  "generationId"
]);

const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ALLOWED_FAILURE_CODES = new Set(Object.values(RELEASE_FAILURE_CODES));

const JOURNAL_KEYS = Object.freeze([
  "schemaVersion",
  "releaseId",
  "targetGitSha",
  "lane",
  "classification",
  "targetFingerprints",
  "predecessor",
  "state",
  "resumeFrom",
  "failureCode",
  "supersededBy",
  "receipts",
  "attempt",
  "revision",
  "previousJournalSha256",
  "createdAt",
  "updatedAt"
]);

const SUPERSEDED_BY_KEYS = Object.freeze(["releaseId", "targetGitSha"]);
const BEFORE_UPLOAD_ATTESTATION_KEYS = Object.freeze([
  "failedConfigSha256",
  "queueEvidence",
  "queueTopologyFingerprint",
  "schemaVersion",
  "predecessorDeploymentCreatedOn"
]);
const REMOTE_UPLOAD_ATTESTATION_KEYS = Object.freeze([
  "releaseTag",
  "remoteVersionCount",
  "remoteVersionInventorySha256",
  "schemaVersion",
  "taggedUploadAbsent",
  "workerName"
]);
const INACTIVE_UPLOAD_ATTESTATION_KEYS = Object.freeze([
  "failedConfigSha256",
  "queueEvidence",
  "queueTopologyFingerprint",
  "remoteUploadEvidence",
  "schemaVersion",
  "predecessorDeploymentCreatedOn"
]);
const INACTIVE_REMOTE_UPLOAD_ATTESTATION_KEYS = Object.freeze([
  "clientBuildDigest",
  "inactiveWorkerCreatedOn",
  "inactiveWorkerVersionDetailSha256",
  "inactiveWorkerVersionId",
  "inactiveWorkerVersionNumber",
  "predecessorWorkerVersionDetailSha256",
  "releaseMessage",
  "releaseTag",
  "remoteVersionCount",
  "remoteVersionInventorySha256",
  "runtimeCpuMs",
  "schemaVersion",
  "sourceRevision",
  "workerName",
  "workerRuntimeDigest"
]);

const PREDECESSOR_KEYS = Object.freeze([
  "releaseId",
  "journalSha256",
  "workerVersionId",
  "deploymentId",
  "runnerActivationId"
]);

const POINTER_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "releaseId",
  "targetGitSha",
  "workerVersionId",
  "journalSha256",
  "updatedAt"
]);

export const RELEASE_LANE_STATE_PATHS = Object.freeze({
  [RELEASE_LANES.ASSETS_ONLY]: Object.freeze([
    RELEASE_JOURNAL_STATES.PLANNED,
    RELEASE_JOURNAL_STATES.VERIFIED,
    RELEASE_JOURNAL_STATES.PREPARED,
    RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
    RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
    RELEASE_JOURNAL_STATES.WORKER_ACTIVE,
    RELEASE_JOURNAL_STATES.VERIFIED_LIVE,
    RELEASE_JOURNAL_STATES.COMPLETE
  ]),
  [RELEASE_LANES.CONSERVATIVE_FULL]: Object.freeze([
    RELEASE_JOURNAL_STATES.PLANNED,
    RELEASE_JOURNAL_STATES.VERIFIED,
    RELEASE_JOURNAL_STATES.PREPARED,
    RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
    RELEASE_JOURNAL_STATES.DATA_PREPARED,
    RELEASE_JOURNAL_STATES.RUNNER_READY,
    RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
    RELEASE_JOURNAL_STATES.WORKER_ACTIVE,
    RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED,
    RELEASE_JOURNAL_STATES.GENERATION_VERIFIED,
    RELEASE_JOURNAL_STATES.VERIFIED_LIVE,
    RELEASE_JOURNAL_STATES.COMPLETE
  ])
});

const POST_ACTIVATION_STATES = new Set([
  RELEASE_JOURNAL_STATES.WORKER_ACTIVE,
  RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED,
  RELEASE_JOURNAL_STATES.GENERATION_VERIFIED,
  RELEASE_JOURNAL_STATES.VERIFIED_LIVE,
  RELEASE_JOURNAL_STATES.COMPLETE
]);

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

function exactIsoTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

const ISO_UTC_NANOSECONDS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function exactIsoTimestampNanoseconds(value, label) {
  if (typeof value !== "string" || value.length > 64) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  const match = value.match(ISO_UTC_NANOSECONDS_PATTERN);
  if (!match) throw new Error(`${label} must be an exact ISO timestamp`);
  const wholeSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const milliseconds = Date.parse(`${wholeSecond}.000Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== `${wholeSecond}.000Z`
  ) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  const fractionalNanoseconds = BigInt(
    (match[7] ?? "").padEnd(9, "0") || "0"
  );
  return BigInt(milliseconds) * 1_000_000n + fractionalNanoseconds;
}

function notEarlier(candidate, previous, label) {
  exactIsoTimestamp(candidate, label);
  if (Date.parse(candidate) < Date.parse(previous)) {
    throw new Error(`${label} cannot move backward`);
  }
}

function nullablePattern(value, pattern, label) {
  if (value !== null && (typeof value !== "string" || !pattern.test(value))) {
    throw new Error(`${label} is invalid`);
  }
}

function validatePredecessor(value) {
  exactKeys(value, PREDECESSOR_KEYS, "Release predecessor");
  nullablePattern(value.releaseId, RELEASE_ID_PATTERN, "Predecessor release ID");
  nullablePattern(
    value.journalSha256,
    SHA256_PATTERN,
    "Predecessor journal SHA-256"
  );
  nullablePattern(
    value.workerVersionId,
    UUID_PATTERN,
    "Predecessor Worker version ID"
  );
  nullablePattern(value.deploymentId, UUID_PATTERN, "Predecessor deployment ID");
  nullablePattern(
    value.runnerActivationId,
    SAFE_ID_PATTERN,
    "Predecessor runner activation ID"
  );
  const hasAny = Object.values(value).some((entry) => entry !== null);
  const hasIdentity = value.releaseId !== null && value.journalSha256 !== null;
  const hasExternalDeployment =
    value.releaseId === null &&
    value.journalSha256 === null &&
    value.workerVersionId !== null &&
    value.deploymentId !== null;
  if (hasAny && !hasIdentity && !hasExternalDeployment) {
    throw new Error(
      "A release predecessor requires journal identity or an exact external Worker/deployment pair"
    );
  }
  return Object.freeze({ ...value });
}

function emptyPredecessor() {
  return Object.freeze(Object.fromEntries(PREDECESSOR_KEYS.map((key) => [key, null])));
}

function validateRemoteUploadAttestation(value) {
  exactKeys(
    value,
    REMOTE_UPLOAD_ATTESTATION_KEYS,
    "Remote Worker-upload replacement attestation"
  );
  if (value.schemaVersion !== 1) {
    throw new Error("Remote Worker-upload replacement attestation schema is unsupported");
  }
  if (
    typeof value.workerName !== "string" ||
    !SAFE_ID_PATTERN.test(value.workerName) ||
    !RELEASE_ID_PATTERN.test(value.releaseTag ?? "") ||
    !Number.isInteger(value.remoteVersionCount) ||
    value.remoteVersionCount < 0 ||
    value.remoteVersionCount > 10_000 ||
    !SHA256_PATTERN.test(value.remoteVersionInventorySha256 ?? "") ||
    value.taggedUploadAbsent !== true
  ) {
    throw new Error("Remote Worker-upload replacement attestation is invalid");
  }
  return Object.freeze({ ...value });
}

function validateBeforeUploadAttestation(value) {
  const schemaVersion = value?.schemaVersion;
  exactKeys(
    value,
    schemaVersion === 2
      ? [...BEFORE_UPLOAD_ATTESTATION_KEYS, "remoteUploadEvidence"]
      : BEFORE_UPLOAD_ATTESTATION_KEYS,
    "Before-upload replacement attestation"
  );
  if (![1, 2].includes(schemaVersion)) {
    throw new Error("Before-upload replacement attestation schema is unsupported");
  }
  if (!SHA256_PATTERN.test(value.failedConfigSha256 ?? "")) {
    throw new Error("Before-upload replacement attestation has an invalid config SHA-256");
  }
  if (!SHA256_PATTERN.test(value.queueTopologyFingerprint ?? "")) {
    throw new Error(
      "Before-upload replacement attestation has an invalid Queue-topology fingerprint"
    );
  }
  const predecessorDeploymentCreatedOn = value.predecessorDeploymentCreatedOn;
  exactIsoTimestampNanoseconds(
    predecessorDeploymentCreatedOn,
    "Predecessor deployment creation time"
  );
  const queueEvidence = validatedBeforeUploadQueueEvidence(
    predecessorDeploymentCreatedOn,
    value.queueEvidence
  );
  return Object.freeze({
    schemaVersion,
    failedConfigSha256: value.failedConfigSha256,
    queueTopologyFingerprint: value.queueTopologyFingerprint,
    predecessorDeploymentCreatedOn,
    queueEvidence,
    ...(schemaVersion === 2
      ? {
          remoteUploadEvidence: validateRemoteUploadAttestation(
            value.remoteUploadEvidence
          )
        }
      : {})
  });
}

function validateInactiveRemoteUploadAttestation(value) {
  exactKeys(
    value,
    INACTIVE_REMOTE_UPLOAD_ATTESTATION_KEYS,
    "Inactive Worker-upload replacement attestation"
  );
  if (value.schemaVersion !== 1) {
    throw new Error(
      "Inactive Worker-upload replacement attestation schema is unsupported"
    );
  }
  if (
    typeof value.workerName !== "string" ||
    !SAFE_ID_PATTERN.test(value.workerName) ||
    !RELEASE_ID_PATTERN.test(value.releaseTag ?? "") ||
    value.releaseMessage !== `surf release ${value.releaseTag}` ||
    !UUID_PATTERN.test(value.inactiveWorkerVersionId ?? "") ||
    !Number.isSafeInteger(value.inactiveWorkerVersionNumber) ||
    value.inactiveWorkerVersionNumber < 1 ||
    !Number.isSafeInteger(value.runtimeCpuMs) ||
    value.runtimeCpuMs < 1 ||
    value.runtimeCpuMs > 1_000_000 ||
    !Number.isInteger(value.remoteVersionCount) ||
    value.remoteVersionCount < 1 ||
    value.remoteVersionCount > 10_000 ||
    !SHA_PATTERN.test(value.sourceRevision ?? "") ||
    !SHA256_PATTERN.test(value.workerRuntimeDigest ?? "") ||
    !SHA256_PATTERN.test(value.clientBuildDigest ?? "") ||
    !SHA256_PATTERN.test(value.remoteVersionInventorySha256 ?? "") ||
    !SHA256_PATTERN.test(value.inactiveWorkerVersionDetailSha256 ?? "") ||
    !SHA256_PATTERN.test(value.predecessorWorkerVersionDetailSha256 ?? "")
  ) {
    throw new Error("Inactive Worker-upload replacement attestation is invalid");
  }
  exactIsoTimestampNanoseconds(
    value.inactiveWorkerCreatedOn,
    "Inactive Worker version creation time"
  );
  return Object.freeze({ ...value });
}

function validateInactiveUploadAttestation(value) {
  exactKeys(
    value,
    INACTIVE_UPLOAD_ATTESTATION_KEYS,
    "Inactive-upload replacement attestation"
  );
  if (value.schemaVersion !== 1) {
    throw new Error(
      "Inactive-upload replacement attestation schema is unsupported"
    );
  }
  if (!SHA256_PATTERN.test(value.failedConfigSha256 ?? "")) {
    throw new Error(
      "Inactive-upload replacement attestation has an invalid config SHA-256"
    );
  }
  if (!SHA256_PATTERN.test(value.queueTopologyFingerprint ?? "")) {
    throw new Error(
      "Inactive-upload replacement attestation has an invalid Queue-topology fingerprint"
    );
  }
  exactIsoTimestampNanoseconds(
    value.predecessorDeploymentCreatedOn,
    "Predecessor deployment creation time"
  );
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    failedConfigSha256: value.failedConfigSha256,
    queueTopologyFingerprint: value.queueTopologyFingerprint,
    predecessorDeploymentCreatedOn: value.predecessorDeploymentCreatedOn,
    queueEvidence: validatedBeforeUploadQueueEvidence(
      value.predecessorDeploymentCreatedOn,
      value.queueEvidence
    ),
    remoteUploadEvidence: validateInactiveRemoteUploadAttestation(
      value.remoteUploadEvidence
    )
  });
}

function validateSupersededBy(value) {
  if (value === null) return null;
  const hasBeforeUploadAttestation = Object.hasOwn(
    value,
    "beforeUploadAttestation"
  );
  const hasInactiveUploadAttestation = Object.hasOwn(
    value,
    "inactiveUploadAttestation"
  );
  if (hasBeforeUploadAttestation && hasInactiveUploadAttestation) {
    throw new Error(
      "A replacement link cannot contain two upload attestations"
    );
  }
  exactKeys(
    value,
    hasBeforeUploadAttestation
      ? [...SUPERSEDED_BY_KEYS, "beforeUploadAttestation"]
      : hasInactiveUploadAttestation
        ? [...SUPERSEDED_BY_KEYS, "inactiveUploadAttestation"]
      : SUPERSEDED_BY_KEYS,
    "Superseding release link"
  );
  if (!RELEASE_ID_PATTERN.test(value.releaseId ?? "")) {
    throw new Error("Superseding release link has an invalid release ID");
  }
  if (!SHA_PATTERN.test(value.targetGitSha ?? "")) {
    throw new Error("Superseding release link has an invalid target Git SHA");
  }
  return Object.freeze({
    releaseId: value.releaseId,
    targetGitSha: value.targetGitSha,
    ...(hasBeforeUploadAttestation
      ? {
          beforeUploadAttestation: validateBeforeUploadAttestation(
            value.beforeUploadAttestation
          )
        }
      : {}),
    ...(hasInactiveUploadAttestation
      ? {
          inactiveUploadAttestation: validateInactiveUploadAttestation(
            value.inactiveUploadAttestation
          )
        }
      : {})
  });
}

function validateReceipts(value) {
  exactKeys(value, RELEASE_RECEIPT_KEYS, "Release receipts");
  nullablePattern(value.profileSha256, SHA256_PATTERN, "Production profile receipt");
  nullablePattern(
    value.operatorEnvironmentFingerprint,
    SHA256_PATTERN,
    "Operator environment receipt"
  );
  nullablePattern(
    value.wranglerConfigSha256,
    SHA256_PATTERN,
    "Wrangler config receipt"
  );
  nullablePattern(
    value.workerSecretsFingerprint,
    SHA256_PATTERN,
    "Worker secrets receipt"
  );
  nullablePattern(value.workerVersionId, UUID_PATTERN, "Worker version receipt");
  nullablePattern(value.deploymentId, UUID_PATTERN, "Deployment receipt");
  nullablePattern(
    value.runnerActivationId,
    SAFE_ID_PATTERN,
    "Runner activation receipt"
  );
  nullablePattern(value.runnerDrainSha256, SHA256_PATTERN, "Runner drain receipt");
  nullablePattern(value.d1Bookmark, SAFE_ID_PATTERN, "D1 bookmark receipt");
  nullablePattern(value.d1ExportSha256, SHA256_PATTERN, "D1 export receipt");
  nullablePattern(value.generationId, SAFE_ID_PATTERN, "Generation receipt");
  return Object.freeze({ ...value });
}

function emptyReceipts() {
  return Object.freeze(
    Object.fromEntries(RELEASE_RECEIPT_KEYS.map((key) => [key, null]))
  );
}

const PREPARED_RECEIPT_KEYS = Object.freeze([
  "profileSha256",
  "operatorEnvironmentFingerprint",
  "wranglerConfigSha256",
  "workerSecretsFingerprint"
]);

function hasOnlyPreparedReceipts(receipts) {
  return RELEASE_RECEIPT_KEYS.every((key) =>
    PREPARED_RECEIPT_KEYS.includes(key)
      ? receipts[key] !== null
      : receipts[key] === null
  );
}

function stateReached(path, state, milestone) {
  return path.indexOf(state) >= path.indexOf(milestone);
}

function validateReceiptBoundary(
  journal,
  { path, effectiveState, key, label, milestone, optional = false }
) {
  const reached = stateReached(path, effectiveState, milestone);
  if (reached && !optional && journal.receipts[key] === null) {
    throw new Error(`${effectiveState} requires a ${label} receipt`);
  }
  if (!reached && journal.receipts[key] !== null) {
    throw new Error(`${label} receipt cannot precede ${milestone}`);
  }
}

function validateStateRequirements(journal) {
  const effectiveState = [
    RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
    RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD,
    RELEASE_JOURNAL_STATES.SUPERSEDED,
    RELEASE_JOURNAL_STATES.REPLACED
  ].includes(journal.state)
    ? journal.resumeFrom
    : journal.state;
  const path = RELEASE_LANE_STATE_PATHS[journal.lane];
  if (!path.includes(effectiveState)) {
    throw new Error(`${journal.lane} releases cannot enter ${effectiveState}`);
  }
  if (
    journal.lane === RELEASE_LANES.ASSETS_ONLY &&
    [
      journal.receipts.runnerActivationId,
      journal.receipts.runnerDrainSha256,
      journal.receipts.d1Bookmark,
      journal.receipts.d1ExportSha256,
      journal.receipts.generationId
    ].some((value) => value !== null)
  ) {
    throw new Error("Assets-only releases cannot record stateful receipts");
  }

  validateReceiptBoundary(journal, {
    path,
    effectiveState,
    key: "profileSha256",
    label: "production profile",
    milestone: RELEASE_JOURNAL_STATES.PREPARED
  });
  validateReceiptBoundary(journal, {
    path,
    effectiveState,
    key: "operatorEnvironmentFingerprint",
    label: "operator environment",
    milestone: RELEASE_JOURNAL_STATES.PREPARED
  });
  validateReceiptBoundary(journal, {
    path,
    effectiveState,
    key: "wranglerConfigSha256",
    label: "Wrangler config",
    milestone: RELEASE_JOURNAL_STATES.PREPARED
  });
  validateReceiptBoundary(journal, {
    path,
    effectiveState,
    key: "workerSecretsFingerprint",
    label: "Worker secrets",
    milestone: RELEASE_JOURNAL_STATES.PREPARED
  });
  validateReceiptBoundary(journal, {
    path,
    effectiveState,
    key: "workerVersionId",
    label: "Worker version",
    milestone: RELEASE_JOURNAL_STATES.WORKER_UPLOADED
  });
  validateReceiptBoundary(journal, {
    path,
    effectiveState,
    key: "deploymentId",
    label: "deployment",
    milestone: RELEASE_JOURNAL_STATES.WORKER_ACTIVE
  });

  if (journal.lane === RELEASE_LANES.CONSERVATIVE_FULL) {
    const impact = journal.classification.impact;
    const storageMutationRequired = impact.migrations || impact.seed;
    const generationRequired = impact.materialization || impact.seed;
    const dataPrepared = stateReached(
      path,
      effectiveState,
      RELEASE_JOURNAL_STATES.DATA_PREPARED
    );
    const hasBookmark = journal.receipts.d1Bookmark !== null;
    const hasExport = journal.receipts.d1ExportSha256 !== null;
    if (hasBookmark !== hasExport) {
      throw new Error("D1 rollback requires both bookmark and export receipts");
    }
    const hasRollbackReceipt = hasBookmark && hasExport;
    if (dataPrepared && storageMutationRequired && !hasRollbackReceipt) {
      throw new Error(`${effectiveState} requires a D1 rollback receipt`);
    }
    if (!storageMutationRequired && hasRollbackReceipt) {
      throw new Error(
        "A release without migration or seed impact cannot record a D1 rollback receipt"
      );
    }
    if (
      !dataPrepared &&
      (journal.receipts.d1Bookmark !== null ||
        journal.receipts.d1ExportSha256 !== null)
    ) {
      throw new Error("D1 rollback receipts cannot precede data-prepared");
    }
    validateReceiptBoundary(journal, {
      path,
      effectiveState,
      key: "runnerActivationId",
      label: "runner activation",
      milestone: RELEASE_JOURNAL_STATES.RUNNER_READY,
      // Analysis-disabled instances intentionally have no live runner even
      // when a target commit contains runner changes.
      optional: true
    });
    validateReceiptBoundary(journal, {
      path,
      effectiveState,
      key: "runnerDrainSha256",
      label: "runner drain",
      milestone: RELEASE_JOURNAL_STATES.RUNNER_READY,
      optional: true
    });
    validateReceiptBoundary(journal, {
      path,
      effectiveState,
      key: "generationId",
      label: "generation",
      milestone: RELEASE_JOURNAL_STATES.GENERATION_VERIFIED,
      optional: !generationRequired
    });
    if (!generationRequired && journal.receipts.generationId !== null) {
      throw new Error(
        "A release without materialization or seed impact cannot record a generation receipt"
      );
    }
    if (!impact.runner && journal.receipts.runnerDrainSha256 !== null) {
      throw new Error(
        "A release without runner impact cannot record a runner drain receipt"
      );
    }
  }
  if (
    journal.state === RELEASE_JOURNAL_STATES.COMPLETE &&
    journal.failureCode !== null
  ) {
    throw new Error("A complete release cannot retain a failure code");
  }
}

export function assertReleaseJournal(value) {
  exactKeys(value, JOURNAL_KEYS, "Release journal");
  if (value.schemaVersion !== RELEASE_JOURNAL_SCHEMA_VERSION) {
    throw new Error("Release journal schema is unsupported");
  }
  if (!RELEASE_ID_PATTERN.test(value.releaseId)) {
    throw new Error("Release journal has an invalid release ID");
  }
  if (!SHA_PATTERN.test(value.targetGitSha)) {
    throw new Error("Release journal has an invalid target Git SHA");
  }
  if (!Object.values(RELEASE_LANES).includes(value.lane)) {
    throw new Error("Release journal has an invalid lane");
  }
  const classification = assertReleaseClassification(value.classification);
  if (classification.lane !== value.lane) {
    throw new Error("Release journal lane does not match its classification");
  }
  const targetFingerprints = assertReleaseFingerprintSet(
    value.targetFingerprints,
    "Journal target fingerprints"
  );
  const predecessor = validatePredecessor(value.predecessor);
  const supersededBy = validateSupersededBy(value.supersededBy);
  if (!Object.values(RELEASE_JOURNAL_STATES).includes(value.state)) {
    throw new Error("Release journal has an invalid state");
  }
  if (
    value.resumeFrom !== null &&
    (!Object.values(RELEASE_JOURNAL_STATES).includes(value.resumeFrom) ||
      [
        RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
        RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD,
        RELEASE_JOURNAL_STATES.SUPERSEDED,
        RELEASE_JOURNAL_STATES.REPLACED,
        RELEASE_JOURNAL_STATES.COMPLETE
      ].includes(value.resumeFrom))
  ) {
    throw new Error("Release journal has an invalid resume state");
  }
  const hasFailureContext = [
    RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
    RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD,
    RELEASE_JOURNAL_STATES.SUPERSEDED,
    RELEASE_JOURNAL_STATES.REPLACED
  ].includes(value.state);
  if (
    hasFailureContext !==
    (value.resumeFrom !== null && value.failureCode !== null)
  ) {
    throw new Error("Release failure state, resume state, and failure code must agree");
  }
  if (
    ([
      RELEASE_JOURNAL_STATES.SUPERSEDED,
      RELEASE_JOURNAL_STATES.REPLACED
    ].includes(value.state)) !==
    (supersededBy !== null)
  ) {
    throw new Error(
      "Only a superseded or replaced release may contain a replacement link"
    );
  }
  if (
    supersededBy !== null &&
    (supersededBy.releaseId === value.releaseId ||
      supersededBy.targetGitSha === value.targetGitSha)
  ) {
    throw new Error(
      "A replacement must name a different release and target Git SHA"
    );
  }
  if (
    supersededBy?.beforeUploadAttestation !== undefined &&
    (value.state !== RELEASE_JOURNAL_STATES.REPLACED ||
      ![
        RELEASE_JOURNAL_STATES.VERIFIED,
        RELEASE_JOURNAL_STATES.PREPARED
      ].includes(value.resumeFrom))
  ) {
    throw new Error(
      "Only a verified or prepared before-upload replacement may retain its attestation"
    );
  }
  if (
    supersededBy?.inactiveUploadAttestation !== undefined &&
    (value.state !== RELEASE_JOURNAL_STATES.REPLACED ||
      value.resumeFrom !== RELEASE_JOURNAL_STATES.PREPARED ||
      value.failureCode !== RELEASE_FAILURE_CODES.UPLOAD_FAILED)
  ) {
    throw new Error(
      "Only a prepared inactive-upload replacement may retain its attestation"
    );
  }
  nullablePattern(value.failureCode, FAILURE_CODE_PATTERN, "Release failure code");
  if (value.failureCode !== null && !ALLOWED_FAILURE_CODES.has(value.failureCode)) {
    throw new Error("Release journal contains an unknown failure code");
  }
  const receipts = validateReceipts(value.receipts);
  const receiptFree = Object.values(receipts).every((entry) => entry === null);
  const exactLivePredecessor =
    predecessor.workerVersionId !== null &&
    predecessor.deploymentId !== null;
  const validReplacementBoundary =
    (value.resumeFrom === RELEASE_JOURNAL_STATES.PLANNED &&
      receiptFree &&
      exactLivePredecessor &&
      supersededBy?.beforeUploadAttestation === undefined) ||
    (value.resumeFrom === RELEASE_JOURNAL_STATES.VERIFIED &&
      value.failureCode === RELEASE_FAILURE_CODES.PREPARE_FAILED &&
      receiptFree &&
      exactLivePredecessor &&
      predecessor.runnerActivationId !== null &&
      supersededBy?.beforeUploadAttestation?.schemaVersion === 1 &&
      supersededBy?.beforeUploadAttestation?.queueTopologyFingerprint ===
        targetFingerprints.queueTopology) ||
    (value.resumeFrom === RELEASE_JOURNAL_STATES.PREPARED &&
      value.failureCode === RELEASE_FAILURE_CODES.UPLOAD_FAILED &&
      hasOnlyPreparedReceipts(receipts) &&
      exactLivePredecessor &&
      predecessor.runnerActivationId !== null &&
      ((supersededBy?.beforeUploadAttestation?.schemaVersion === 2 &&
        supersededBy.beforeUploadAttestation.failedConfigSha256 ===
          receipts.wranglerConfigSha256 &&
        supersededBy.beforeUploadAttestation.queueTopologyFingerprint ===
          targetFingerprints.queueTopology &&
        supersededBy.beforeUploadAttestation.remoteUploadEvidence.releaseTag ===
          value.releaseId) ||
        (supersededBy?.inactiveUploadAttestation?.schemaVersion === 1 &&
          supersededBy.inactiveUploadAttestation.failedConfigSha256 ===
            receipts.wranglerConfigSha256 &&
          supersededBy.inactiveUploadAttestation.queueTopologyFingerprint ===
            targetFingerprints.queueTopology &&
          supersededBy.inactiveUploadAttestation.remoteUploadEvidence.releaseTag ===
            value.releaseId &&
          supersededBy.inactiveUploadAttestation.remoteUploadEvidence.sourceRevision ===
            value.targetGitSha &&
          supersededBy.inactiveUploadAttestation.remoteUploadEvidence.workerRuntimeDigest ===
            targetFingerprints.workerRuntime &&
          supersededBy.inactiveUploadAttestation.remoteUploadEvidence.clientBuildDigest ===
            targetFingerprints.workerAssets &&
          supersededBy.inactiveUploadAttestation.remoteUploadEvidence
            .inactiveWorkerVersionId !== predecessor.workerVersionId)));
  if (
    value.state === RELEASE_JOURNAL_STATES.REPLACED &&
    !validReplacementBoundary
  ) {
    throw new Error(
      "A replaced release must retain an allowed replacement boundary and exact live predecessor"
    );
  }
  if (!Number.isInteger(value.attempt) || value.attempt < 1) {
    throw new Error("Release journal attempt must be a positive integer");
  }
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    throw new Error("Release journal revision must be a nonnegative integer");
  }
  nullablePattern(
    value.previousJournalSha256,
    SHA256_PATTERN,
    "Previous journal SHA-256"
  );
  if ((value.revision === 0) !== (value.previousJournalSha256 === null)) {
    throw new Error("Only the initial journal revision may omit its predecessor hash");
  }
  exactIsoTimestamp(value.createdAt, "Release creation time");
  notEarlier(value.updatedAt, value.createdAt, "Release update time");

  const normalized = {
    ...value,
    classification,
    targetFingerprints,
    predecessor,
    supersededBy,
    receipts
  };
  validateStateRequirements(normalized);
  return Object.freeze(normalized);
}

export function createReleaseJournal({
  releaseId,
  targetGitSha,
  classification,
  targetFingerprints,
  predecessor = emptyPredecessor(),
  createdAt
}) {
  return assertReleaseJournal({
    schemaVersion: RELEASE_JOURNAL_SCHEMA_VERSION,
    releaseId,
    targetGitSha,
    lane: classification?.lane,
    classification,
    targetFingerprints,
    predecessor,
    state: RELEASE_JOURNAL_STATES.PLANNED,
    resumeFrom: null,
    failureCode: null,
    supersededBy: null,
    receipts: emptyReceipts(),
    attempt: 1,
    revision: 0,
    previousJournalSha256: null,
    createdAt,
    updatedAt: createdAt
  });
}

export function fingerprintReleaseJournal(journal) {
  return fingerprintCanonicalReleaseValue(assertReleaseJournal(journal));
}

export function assertReleaseJournalRevisionHistory(currentValue, revisions) {
  const current = assertReleaseJournal(currentValue);
  if (!Array.isArray(revisions) || revisions.length !== current.revision + 1) {
    throw new Error("Immutable release journal history is incomplete");
  }
  let previous = null;
  for (let revision = 0; revision < revisions.length; revision += 1) {
    const entry = assertReleaseJournal(revisions[revision]);
    if (entry.releaseId !== current.releaseId || entry.revision !== revision) {
      throw new Error("Immutable release journal revision identity is invalid");
    }
    if (
      revision > 0 &&
      entry.previousJournalSha256 !== fingerprintReleaseJournal(previous)
    ) {
      throw new Error("Immutable release journal revision chain is broken");
    }
    previous = entry;
  }
  if (canonicalReleaseJson(previous) !== canonicalReleaseJson(current)) {
    throw new Error("Current release journal differs from its immutable revision");
  }
  return current;
}

function mergedReceipts(current, patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Release receipt patch must be an object");
  }
  for (const key of Object.keys(patch)) {
    if (!RELEASE_RECEIPT_KEYS.includes(key)) {
      throw new Error(`Unknown release receipt: ${key}`);
    }
    if (
      current[key] !== null &&
      patch[key] !== undefined &&
      patch[key] !== current[key]
    ) {
      throw new Error(`Release receipt ${key} is immutable once recorded`);
    }
  }
  return validateReceipts({ ...current, ...patch });
}

function revisedJournal(journal, patch, at) {
  const current = assertReleaseJournal(journal);
  notEarlier(at, current.updatedAt, "Release transition time");
  return assertReleaseJournal({
    ...current,
    ...patch,
    revision: current.revision + 1,
    previousJournalSha256: fingerprintReleaseJournal(current),
    updatedAt: at
  });
}

export function transitionReleaseJournal(
  journal,
  nextState,
  { at, receipts: receiptPatch = {} } = {}
) {
  const current = assertReleaseJournal(journal);
  if (
    current.state === RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE ||
    current.state === RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD ||
    current.state === RELEASE_JOURNAL_STATES.SUPERSEDED ||
    current.state === RELEASE_JOURNAL_STATES.REPLACED
  ) {
    throw new Error("Resume a failed release before applying another transition");
  }
  const path = RELEASE_LANE_STATE_PATHS[current.lane];
  if (path[path.indexOf(current.state) + 1] !== nextState) {
    throw new Error(`Illegal release transition: ${current.state} -> ${nextState}`);
  }
  return revisedJournal(
    current,
    {
      state: nextState,
      resumeFrom: null,
      failureCode: null,
      receipts: mergedReceipts(current.receipts, receiptPatch)
    },
    at
  );
}

export function recordReleaseJournalFailure(journal, { code, at } = {}) {
  const current = assertReleaseJournal(journal);
  if (!FAILURE_CODE_PATTERN.test(code ?? "") || !ALLOWED_FAILURE_CODES.has(code)) {
    throw new Error("Release failures require a bounded reason code, not raw output");
  }
  if (
    current.state === RELEASE_JOURNAL_STATES.COMPLETE ||
    current.state === RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE ||
    current.state === RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD ||
    current.state === RELEASE_JOURNAL_STATES.SUPERSEDED ||
    current.state === RELEASE_JOURNAL_STATES.REPLACED
  ) {
    throw new Error(`Cannot record another failure from ${current.state}`);
  }
  const activationIsAmbiguous =
    code === RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS;
  if (
    activationIsAmbiguous &&
    current.state !== RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED
  ) {
    throw new Error(
      "Activation ambiguity may only be recorded at the activation boundary"
    );
  }
  const state =
    activationIsAmbiguous || POST_ACTIVATION_STATES.has(current.state)
      ? RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD
      : RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE;
  return revisedJournal(
    current,
    { state, resumeFrom: current.state, failureCode: code },
    at
  );
}

export function resumeReleaseJournal(journal, { at } = {}) {
  const current = assertReleaseJournal(journal);
  if (
    ![
      RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
      RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD
    ].includes(current.state)
  ) {
    throw new Error("Only a failed release journal may resume");
  }
  if (current.failureCode === RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS) {
    throw new Error("Ambiguous activation must be reconciled before resuming");
  }
  return revisedJournal(
    current,
    {
      state: current.resumeFrom,
      resumeFrom: null,
      failureCode: null,
      attempt: current.attempt + 1
    },
    at
  );
}

export function supersedeReleaseJournal(
  journal,
  { releaseId, targetGitSha, at } = {}
) {
  const current = assertReleaseJournal(journal);
  if (current.state !== RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD) {
    throw new Error("Only a needs-fix-forward release may be superseded");
  }
  return revisedJournal(
    current,
    {
      state: RELEASE_JOURNAL_STATES.SUPERSEDED,
      supersededBy: validateSupersededBy({ releaseId, targetGitSha })
    },
    at
  );
}

export function replacePreMutationReleaseJournal(
  journal,
  { releaseId, targetGitSha, at } = {}
) {
  const current = assertReleaseJournal(journal);
  const hasReceipts = Object.values(current.receipts).some(
    (value) => value !== null
  );
  if (
    current.state !== RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE ||
    current.resumeFrom !== RELEASE_JOURNAL_STATES.PLANNED ||
    hasReceipts ||
    current.predecessor.workerVersionId === null ||
    current.predecessor.deploymentId === null
  ) {
    throw new Error(
      "Only a receipt-free release that failed from planned with an exact live predecessor may be replaced before mutation"
    );
  }
  return revisedJournal(
    current,
    {
      state: RELEASE_JOURNAL_STATES.REPLACED,
      supersededBy: validateSupersededBy({ releaseId, targetGitSha })
    },
    at
  );
}

function validatedBeforeUploadQueueEvidence(createdBefore, evidence) {
  const cutoffNanoseconds = exactIsoTimestampNanoseconds(
    createdBefore,
    "Predecessor deployment creation time"
  );
  exactKeys(evidence, ["expectedQueueNames", "queues"], "Before-upload Queue evidence");
  if (
    !Array.isArray(evidence.expectedQueueNames) ||
    evidence.expectedQueueNames.length < 1 ||
    evidence.expectedQueueNames.length > 256 ||
    !Array.isArray(evidence.queues) ||
    evidence.queues.length !== evidence.expectedQueueNames.length
  ) {
    throw new Error("Before-upload Queue evidence is incomplete");
  }
  const expected = [...evidence.expectedQueueNames];
  if (
    expected.some((name) => typeof name !== "string" || !SAFE_ID_PATTERN.test(name)) ||
    new Set(expected).size !== expected.length
  ) {
    throw new Error("Before-upload expected Queue names are invalid");
  }
  expected.sort();
  const queues = evidence.queues.map((queue) => {
    exactKeys(queue, ["createdOn", "name"], "Before-upload Queue entry");
    if (typeof queue.name !== "string" || !SAFE_ID_PATTERN.test(queue.name)) {
      throw new Error("Before-upload Queue name is invalid");
    }
    const createdOnNanoseconds = exactIsoTimestampNanoseconds(
      queue.createdOn,
      "Before-upload Queue creation time"
    );
    if (createdOnNanoseconds >= cutoffNanoseconds) {
      throw new Error(
        "Before-upload Queue evidence does not predate the live predecessor deployment"
      );
    }
    return Object.freeze({ name: queue.name, createdOn: queue.createdOn });
  });
  queues.sort((left, right) => left.name.localeCompare(right.name));
  if (
    new Set(queues.map((queue) => queue.name)).size !== queues.length ||
    queues.some((queue, index) => queue.name !== expected[index])
  ) {
    throw new Error("Before-upload Queue evidence is missing a configured Queue");
  }
  return Object.freeze({
    expectedQueueNames: Object.freeze(expected),
    queues: Object.freeze(queues)
  });
}

export function assertBeforeUploadReplacementEvidence(journal, evidence) {
  const current = assertReleaseJournal(journal);
  exactKeys(
    evidence,
    [
      "backupArtifactAbsent",
      "failedConfigSha256",
      "failedQueueTopologyFingerprint",
      "liveDeploymentId",
      "liveDeploymentCreatedOn",
      "liveRunnerActivationId",
      "liveWorkerVersionId",
      "queueEvidence",
      "remoteUploadEvidence",
      "rollbackArtifactAbsent",
      "uploadArtifactAbsent"
    ],
    "Before-upload replacement evidence"
  );
  const verifiedPrepareFailure =
    current.resumeFrom === RELEASE_JOURNAL_STATES.VERIFIED &&
    current.failureCode === RELEASE_FAILURE_CODES.PREPARE_FAILED &&
    Object.values(current.receipts).every((value) => value === null);
  const preparedUploadFailure =
    current.resumeFrom === RELEASE_JOURNAL_STATES.PREPARED &&
    current.failureCode === RELEASE_FAILURE_CODES.UPLOAD_FAILED &&
    hasOnlyPreparedReceipts(current.receipts);
  if (
    ![
      RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
      RELEASE_JOURNAL_STATES.REPLACED
    ].includes(current.state) ||
    (!verifiedPrepareFailure && !preparedUploadFailure)
  ) {
    throw new Error(
      "Before-upload replacement requires an exact verified prepare failure or prepared upload failure"
    );
  }
  if (
    evidence.liveWorkerVersionId !== current.predecessor.workerVersionId ||
    evidence.liveDeploymentId !== current.predecessor.deploymentId ||
    evidence.liveRunnerActivationId !== current.predecessor.runnerActivationId ||
    current.predecessor.runnerActivationId === null
  ) {
    throw new Error(
      "Before-upload replacement live predecessor differs from the failed release"
    );
  }
  if (
    evidence.uploadArtifactAbsent !== true ||
    evidence.backupArtifactAbsent !== true ||
    evidence.rollbackArtifactAbsent !== true
  ) {
    throw new Error(
      "Before-upload replacement found an upload, backup, or rollback artifact"
    );
  }
  if (!SHA256_PATTERN.test(evidence.failedConfigSha256 ?? "")) {
    throw new Error("Before-upload replacement config SHA-256 is invalid");
  }
  if (
    preparedUploadFailure &&
    evidence.failedConfigSha256 !== current.receipts.wranglerConfigSha256
  ) {
    throw new Error(
      "Before-upload replacement config differs from the prepared receipt"
    );
  }
  if (
    evidence.failedQueueTopologyFingerprint !==
    current.targetFingerprints.queueTopology
  ) {
    throw new Error(
      "Before-upload replacement Queue topology differs from the failed journal"
    );
  }
  exactIsoTimestampNanoseconds(
    evidence.liveDeploymentCreatedOn,
    "Live predecessor deployment creation time"
  );
  const queueEvidence = validatedBeforeUploadQueueEvidence(
    evidence.liveDeploymentCreatedOn,
    evidence.queueEvidence
  );
  let remoteUploadEvidence = null;
  if (preparedUploadFailure) {
    remoteUploadEvidence = validateRemoteUploadAttestation(
      evidence.remoteUploadEvidence
    );
    if (remoteUploadEvidence.releaseTag !== current.releaseId) {
      throw new Error(
        "Remote Worker-upload attestation does not name the failed release"
      );
    }
  } else if (evidence.remoteUploadEvidence !== null) {
    throw new Error(
      "Verified prepare failures must not claim a remote Worker-upload attestation"
    );
  }
  return Object.freeze({
    ...evidence,
    queueEvidence,
    remoteUploadEvidence
  });
}

export function replaceBeforeUploadReleaseJournal(
  journal,
  { releaseId, targetGitSha, evidence, at } = {}
) {
  const current = assertReleaseJournal(journal);
  if (current.state !== RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE) {
    throw new Error(
      "Only a retryable release may be replaced before Worker upload"
    );
  }
  const validatedEvidence = assertBeforeUploadReplacementEvidence(
    current,
    evidence
  );
  return revisedJournal(
    current,
    {
      state: RELEASE_JOURNAL_STATES.REPLACED,
      supersededBy: validateSupersededBy({
        releaseId,
        targetGitSha,
        beforeUploadAttestation: {
          schemaVersion:
            current.resumeFrom === RELEASE_JOURNAL_STATES.PREPARED ? 2 : 1,
          failedConfigSha256: validatedEvidence.failedConfigSha256,
          queueTopologyFingerprint:
            validatedEvidence.failedQueueTopologyFingerprint,
          predecessorDeploymentCreatedOn:
            validatedEvidence.liveDeploymentCreatedOn,
          queueEvidence: validatedEvidence.queueEvidence,
          ...(current.resumeFrom === RELEASE_JOURNAL_STATES.PREPARED
            ? {
                remoteUploadEvidence:
                  validatedEvidence.remoteUploadEvidence
              }
            : {})
        }
      })
    },
    at
  );
}

export function assertInactiveUploadReplacementEvidence(journal, evidence) {
  const current = assertReleaseJournal(journal);
  exactKeys(
    evidence,
    [
      "backupArtifactAbsent",
      "failedConfigSha256",
      "failedQueueTopologyFingerprint",
      "liveDeploymentCreatedOn",
      "liveDeploymentId",
      "liveRunnerActivationId",
      "liveWorkerVersionId",
      "queueEvidence",
      "remoteUploadEvidence",
      "rollbackArtifactAbsent",
      "uploadArtifactAbsent"
    ],
    "Inactive-upload replacement evidence"
  );
  if (
    current.state !== RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE ||
    current.resumeFrom !== RELEASE_JOURNAL_STATES.PREPARED ||
    current.failureCode !== RELEASE_FAILURE_CODES.UPLOAD_FAILED ||
    !hasOnlyPreparedReceipts(current.receipts)
  ) {
    throw new Error(
      "Inactive-upload replacement requires an exact prepared upload failure"
    );
  }
  if (
    evidence.liveWorkerVersionId !== current.predecessor.workerVersionId ||
    evidence.liveDeploymentId !== current.predecessor.deploymentId ||
    evidence.liveRunnerActivationId !== current.predecessor.runnerActivationId ||
    current.predecessor.runnerActivationId === null
  ) {
    throw new Error(
      "Inactive-upload replacement live predecessor differs from the failed release"
    );
  }
  if (
    evidence.uploadArtifactAbsent !== true ||
    evidence.backupArtifactAbsent !== true ||
    evidence.rollbackArtifactAbsent !== true
  ) {
    throw new Error(
      "Inactive-upload replacement found an upload, backup, or rollback artifact"
    );
  }
  if (
    evidence.failedConfigSha256 !== current.receipts.wranglerConfigSha256
  ) {
    throw new Error(
      "Inactive-upload replacement config differs from the prepared receipt"
    );
  }
  if (
    evidence.failedQueueTopologyFingerprint !==
    current.targetFingerprints.queueTopology
  ) {
    throw new Error(
      "Inactive-upload replacement Queue topology differs from the failed journal"
    );
  }
  const liveDeploymentCreatedOn = evidence.liveDeploymentCreatedOn;
  const predecessorCreatedNanoseconds = exactIsoTimestampNanoseconds(
    liveDeploymentCreatedOn,
    "Live predecessor deployment creation time"
  );
  const queueEvidence = validatedBeforeUploadQueueEvidence(
    liveDeploymentCreatedOn,
    evidence.queueEvidence
  );
  const remoteUploadEvidence = validateInactiveRemoteUploadAttestation(
    evidence.remoteUploadEvidence
  );
  if (
    remoteUploadEvidence.releaseTag !== current.releaseId ||
    remoteUploadEvidence.sourceRevision !== current.targetGitSha ||
    remoteUploadEvidence.workerRuntimeDigest !==
      current.targetFingerprints.workerRuntime ||
    remoteUploadEvidence.clientBuildDigest !==
      current.targetFingerprints.workerAssets
  ) {
    throw new Error(
      "Inactive Worker upload does not match the failed release identity"
    );
  }
  if (
    remoteUploadEvidence.inactiveWorkerVersionId ===
    evidence.liveWorkerVersionId
  ) {
    throw new Error("Tagged Worker upload is active, not inactive");
  }
  if (
    exactIsoTimestampNanoseconds(
      remoteUploadEvidence.inactiveWorkerCreatedOn,
      "Inactive Worker version creation time"
    ) <= predecessorCreatedNanoseconds
  ) {
    throw new Error(
      "Inactive Worker upload does not postdate the live predecessor deployment"
    );
  }
  return Object.freeze({
    ...evidence,
    queueEvidence,
    remoteUploadEvidence
  });
}

export function replaceInactiveUploadReleaseJournal(
  journal,
  { releaseId, targetGitSha, evidence, at } = {}
) {
  const current = assertReleaseJournal(journal);
  if (current.state !== RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE) {
    throw new Error(
      "Only a retryable release may replace a committed inactive Worker upload"
    );
  }
  const validatedEvidence = assertInactiveUploadReplacementEvidence(
    current,
    evidence
  );
  return revisedJournal(
    current,
    {
      state: RELEASE_JOURNAL_STATES.REPLACED,
      supersededBy: validateSupersededBy({
        releaseId,
        targetGitSha,
        inactiveUploadAttestation: {
          schemaVersion: 1,
          failedConfigSha256: validatedEvidence.failedConfigSha256,
          queueTopologyFingerprint:
            validatedEvidence.failedQueueTopologyFingerprint,
          predecessorDeploymentCreatedOn:
            validatedEvidence.liveDeploymentCreatedOn,
          queueEvidence: validatedEvidence.queueEvidence,
          remoteUploadEvidence: validatedEvidence.remoteUploadEvidence
        }
      })
    },
    at
  );
}

export function predecessorForReleaseReplacement(journal) {
  const replaced = assertReleaseJournal(journal);
  if (replaced.state !== RELEASE_JOURNAL_STATES.REPLACED) {
    throw new Error("Release replacement predecessor requires a replaced journal");
  }
  if (
    replaced.predecessor.workerVersionId === null ||
    replaced.predecessor.deploymentId === null
  ) {
    throw new Error(
      "Release replacement requires an exact live Worker predecessor"
    );
  }
  return Object.freeze({
    releaseId: replaced.releaseId,
    journalSha256: fingerprintReleaseJournal(replaced),
    workerVersionId: replaced.predecessor.workerVersionId,
    deploymentId: replaced.predecessor.deploymentId,
    runnerActivationId: replaced.predecessor.runnerActivationId
  });
}

export function assertReleaseReplacement(
  failedJournal,
  replacementJournal
) {
  const failed = assertReleaseJournal(failedJournal);
  const replacement = assertReleaseJournal(replacementJournal);
  const expectedPredecessor = predecessorForReleaseReplacement(failed);
  if (
    failed.state !== RELEASE_JOURNAL_STATES.REPLACED ||
    failed.supersededBy?.releaseId !== replacement.releaseId ||
    failed.supersededBy?.targetGitSha !== replacement.targetGitSha ||
    ([
      RELEASE_JOURNAL_STATES.VERIFIED,
      RELEASE_JOURNAL_STATES.PREPARED
    ].includes(failed.resumeFrom) &&
      replacement.lane !== RELEASE_LANES.CONSERVATIVE_FULL) ||
    canonicalReleaseJson(replacement.predecessor) !==
      canonicalReleaseJson(expectedPredecessor)
  ) {
    throw new Error(
      "Release replacement does not exactly link its replaced release"
    );
  }
  return Object.freeze({ failed, replacement });
}

export function assertReleaseSupersession(failedJournal, replacementJournal) {
  const failed = assertReleaseJournal(failedJournal);
  const replacement = assertReleaseJournal(replacementJournal);
  if (
    failed.state !== RELEASE_JOURNAL_STATES.SUPERSEDED ||
    failed.supersededBy?.releaseId !== replacement.releaseId ||
    failed.supersededBy?.targetGitSha !== replacement.targetGitSha ||
    replacement.predecessor.releaseId !== failed.releaseId ||
    replacement.predecessor.journalSha256 !== fingerprintReleaseJournal(failed) ||
    replacement.predecessor.workerVersionId !== failed.receipts.workerVersionId ||
    replacement.predecessor.deploymentId !== failed.receipts.deploymentId ||
    replacement.predecessor.runnerActivationId !==
      (failed.receipts.runnerActivationId ??
        failed.predecessor.runnerActivationId)
  ) {
    throw new Error("Fix-forward replacement does not exactly link its superseded release");
  }
  return Object.freeze({ failed, replacement });
}

export function reconcileReleaseActivation(
  journal,
  { targetIsActive, deploymentId = null, at } = {}
) {
  const current = assertReleaseJournal(journal);
  if (
    current.state !== RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD ||
    current.failureCode !== RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS ||
    current.resumeFrom !== RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED
  ) {
    throw new Error("Only an ambiguous activation may be reconciled");
  }
  if (typeof targetIsActive !== "boolean") {
    throw new Error("Activation reconciliation requires an exact active result");
  }
  if (targetIsActive !== (deploymentId !== null)) {
    throw new Error(
      "Activation reconciliation requires a deployment ID only when target is active"
    );
  }
  return revisedJournal(
    current,
    {
      state: targetIsActive
        ? RELEASE_JOURNAL_STATES.WORKER_ACTIVE
        : RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
      resumeFrom: null,
      failureCode: null,
      receipts: mergedReceipts(current.receipts, { deploymentId }),
      attempt: current.attempt + 1
    },
    at
  );
}

export function assertReleasePointer(value) {
  exactKeys(value, POINTER_KEYS, "Release pointer");
  if (value.schemaVersion !== RELEASE_POINTER_SCHEMA_VERSION) {
    throw new Error("Release pointer schema is unsupported");
  }
  if (!Object.values(RELEASE_POINTER_KINDS).includes(value.kind)) {
    throw new Error("Release pointer kind is invalid");
  }
  if (!RELEASE_ID_PATTERN.test(value.releaseId)) {
    throw new Error("Release pointer has an invalid release ID");
  }
  if (!SHA_PATTERN.test(value.targetGitSha)) {
    throw new Error("Release pointer has an invalid target Git SHA");
  }
  if (!UUID_PATTERN.test(value.workerVersionId)) {
    throw new Error("Release pointer has an invalid Worker version ID");
  }
  if (!SHA256_PATTERN.test(value.journalSha256)) {
    throw new Error("Release pointer has an invalid journal SHA-256");
  }
  exactIsoTimestamp(value.updatedAt, "Release pointer update time");
  return Object.freeze({ ...value });
}

export function createReleasePointer(journal, kind, { at } = {}) {
  const current = assertReleaseJournal(journal);
  if (!Object.values(RELEASE_POINTER_KINDS).includes(kind)) {
    throw new Error("Unknown release pointer kind");
  }
  const resumeState = [
    RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
    RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD,
    RELEASE_JOURNAL_STATES.SUPERSEDED,
    RELEASE_JOURNAL_STATES.REPLACED
  ].includes(current.state)
    ? current.resumeFrom
    : current.state;
  if (
    kind === RELEASE_POINTER_KINDS.ACTIVE &&
    !POST_ACTIVATION_STATES.has(resumeState)
  ) {
    throw new Error("Active pointer requires a confirmed Worker activation");
  }
  if (
    kind === RELEASE_POINTER_KINDS.LAST_COMPLETE &&
    current.state !== RELEASE_JOURNAL_STATES.COMPLETE
  ) {
    throw new Error("Last-complete pointer requires a complete release");
  }
  if (current.receipts.workerVersionId === null) {
    throw new Error("Release pointer requires a Worker version receipt");
  }
  notEarlier(at, current.updatedAt, "Release pointer time");
  return assertReleasePointer({
    schemaVersion: RELEASE_POINTER_SCHEMA_VERSION,
    kind,
    releaseId: current.releaseId,
    targetGitSha: current.targetGitSha,
    workerVersionId: current.receipts.workerVersionId,
    journalSha256: fingerprintReleaseJournal(current),
    updatedAt: at
  });
}

export function releasePointerMatchesJournal(pointer, journal, kind = null) {
  if (pointer === null) return false;
  const currentPointer = assertReleasePointer(pointer);
  const currentJournal = assertReleaseJournal(journal);
  if (kind !== null && currentPointer.kind !== kind) return false;
  return (
    currentPointer.releaseId === currentJournal.releaseId &&
    currentPointer.targetGitSha === currentJournal.targetGitSha &&
    currentPointer.workerVersionId === currentJournal.receipts.workerVersionId &&
    currentPointer.journalSha256 === fingerprintReleaseJournal(currentJournal)
  );
}

export function resolveTrustedActiveReleaseReceipt({ pointer, journal }) {
  const activePointer = assertReleasePointer(pointer);
  const activeJournal = assertReleaseJournal(journal);
  if (activePointer.kind !== RELEASE_POINTER_KINDS.ACTIVE) {
    throw new Error("Trusted active receipt requires the active pointer");
  }
  if (activeJournal.state !== RELEASE_JOURNAL_STATES.COMPLETE) {
    throw new Error("Routine releases require a complete active predecessor");
  }
  if (!releasePointerMatchesJournal(activePointer, activeJournal)) {
    throw new Error("Active release pointer does not match its journal");
  }
  return createTrustedActiveReleaseReceipt({
    schemaVersion: RELEASE_IMPACT_SCHEMA_VERSION,
    releaseId: activeJournal.releaseId,
    targetGitSha: activeJournal.targetGitSha,
    workerVersionId: activeJournal.receipts.workerVersionId,
    journalSha256: activePointer.journalSha256,
    state: activeJournal.state,
    fingerprints: activeJournal.targetFingerprints
  });
}

function ensurePrivateDirectory(fileSystem, path) {
  fileSystem.mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = fileSystem.lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Release state directory is unsafe: ${path}`);
  }
  fileSystem.chmodSync(path, 0o700);
}

function existingRegularFile(fileSystem, path) {
  try {
    const metadata = fileSystem.lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error(`Release state file is not a mode-0600 regular file: ${path}`);
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readPrivateRegularFile(fileSystem, path, label, { missingOk = false } = {}) {
  const noFollow = fileSystem.constants?.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new Error(`${label} cannot be read safely on this platform`);
  }
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      path,
      (fileSystem.constants?.O_RDONLY ?? 0) | noFollow
    );
    const before = fileSystem.fstatSync(descriptor);
    if (
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > 8 * 1024 * 1024
    ) {
      throw new Error(`${label} is not a bounded mode-0600 regular file`);
    }
    const contents = fileSystem.readFileSync(descriptor, "utf8");
    const after = fileSystem.fstatSync(descriptor);
    const pathAfter = fileSystem.lstatSync(path);
    if (
      !after.isFile() ||
      pathAfter.isSymbolicLink() ||
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
      throw new Error(`${label} changed while it was read`);
    }
    return contents;
  } catch (error) {
    if (missingOk && error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw new Error(`${label} is not a bounded mode-0600 regular file`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function fsyncDirectory(fileSystem, path) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(path, "r");
    fileSystem.fsyncSync(descriptor);
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

export function atomicWriteReleaseJsonSync(
  path,
  value,
  { fileSystem = nodeFs, temporaryName = () => randomUUID() } = {}
) {
  if (!isAbsolute(path)) {
    throw new Error("Release state writes require an absolute path");
  }
  const directory = dirname(path);
  ensurePrivateDirectory(fileSystem, directory);
  existingRegularFile(fileSystem, path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${temporaryName()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporaryPath, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, `${canonicalReleaseJson(value)}\n`, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(temporaryPath, path);
    fsyncDirectory(fileSystem, directory);
  } catch (error) {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    try {
      fileSystem.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function writeImmutableReleaseJsonSync(
  path,
  value,
  { fileSystem = nodeFs, temporaryName = () => randomUUID() } = {}
) {
  const directory = dirname(path);
  ensurePrivateDirectory(fileSystem, directory);
  const contents = `${canonicalReleaseJson(value)}\n`;
  if (existingRegularFile(fileSystem, path)) {
    if (readPrivateRegularFile(fileSystem, path, "Immutable release state") !== contents) {
      throw new Error(`Immutable release state differs: ${path}`);
    }
    return;
  }
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${temporaryName()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporaryPath, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, contents, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    try {
      fileSystem.linkSync(temporaryPath, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (
        !existingRegularFile(fileSystem, path) ||
        readPrivateRegularFile(fileSystem, path, "Immutable release state") !== contents
      ) {
        throw new Error(`Immutable release state raced with different bytes: ${path}`);
      }
    }
    fsyncDirectory(fileSystem, directory);
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    try {
      fileSystem.unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function readReleaseJsonSync(fileSystem, path, label) {
  const contents = readPrivateRegularFile(fileSystem, path, label, {
    missingOk: true
  });
  if (contents === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return parsed;
}

export function createReleaseStateStore({ rootDir, fileSystem = nodeFs }) {
  if (typeof rootDir !== "string" || !isAbsolute(rootDir)) {
    throw new Error("Release state root must be an absolute path");
  }
  const requestedRoot = resolve(rootDir);
  ensurePrivateDirectory(fileSystem, requestedRoot);
  const root = fileSystem.realpathSync(requestedRoot);
  const journalsDirectory = join(root, "journals");
  const pointersDirectory = join(root, "pointers");
  ensurePrivateDirectory(fileSystem, journalsDirectory);
  ensurePrivateDirectory(fileSystem, pointersDirectory);

  const journalPath = (releaseId) => {
    if (!RELEASE_ID_PATTERN.test(releaseId ?? "")) {
      throw new Error("Release state lookup has an invalid release ID");
    }
    return join(journalsDirectory, `${releaseId}.json`);
  };
  const revisionDirectory = (releaseId) => {
    if (!RELEASE_ID_PATTERN.test(releaseId ?? "")) {
      throw new Error("Release revision lookup has an invalid release ID");
    }
    const path = join(journalsDirectory, `${releaseId}.revisions`);
    ensurePrivateDirectory(fileSystem, path);
    return path;
  };
  const revisionPath = (releaseId, revision) => {
    if (!Number.isInteger(revision) || revision < 0 || revision > 999_999) {
      throw new Error("Release revision number is invalid");
    }
    return join(
      revisionDirectory(releaseId),
      `${String(revision).padStart(6, "0")}.json`
    );
  };
  const pointerPath = (kind) => {
    if (!Object.values(RELEASE_POINTER_KINDS).includes(kind)) {
      throw new Error("Release state lookup has an invalid pointer kind");
    }
    return join(pointersDirectory, `${kind}.json`);
  };

  const readJournal = (releaseId) => {
    const parsed = readReleaseJsonSync(
      fileSystem,
      journalPath(releaseId),
      "Release journal"
    );
    if (parsed === null) return null;
    let current = assertReleaseJournal(parsed);
    const revisions = [];
    for (let revision = 0; revision <= current.revision; revision += 1) {
      const stored = readReleaseJsonSync(
        fileSystem,
        revisionPath(releaseId, revision),
        "Immutable release journal revision"
      );
      if (stored === null) {
        throw new Error(`Immutable release journal revision ${revision} is missing`);
      }
      revisions.push(stored);
    }
    current = assertReleaseJournalRevisionHistory(current, revisions);
    const pendingRevision = readReleaseJsonSync(
      fileSystem,
      revisionPath(releaseId, current.revision + 1),
      "Pending immutable release journal revision"
    );
    if (pendingRevision !== null) {
      current = assertReleaseJournalRevisionHistory(pendingRevision, [
        ...revisions,
        pendingRevision
      ]);
      atomicWriteReleaseJsonSync(journalPath(releaseId), current, { fileSystem });
    }
    return current;
  };
  const writeJournal = (journal) => {
    const next = assertReleaseJournal(journal);
    const current = readJournal(next.releaseId);
    if (current === null) {
      if (next.revision !== 0 || next.previousJournalSha256 !== null) {
        throw new Error("A new release journal must start at revision zero");
      }
      const orphanedInitial = readReleaseJsonSync(
        fileSystem,
        revisionPath(next.releaseId, 0),
        "Orphaned initial release journal revision"
      );
      if (orphanedInitial !== null) {
        const storedInitial = assertReleaseJournalRevisionHistory(
          orphanedInitial,
          [orphanedInitial]
        );
        const candidateAtStoredTime = assertReleaseJournal({
          ...next,
          createdAt: storedInitial.createdAt,
          updatedAt: storedInitial.updatedAt
        });
        if (
          canonicalReleaseJson(candidateAtStoredTime) !==
          canonicalReleaseJson(storedInitial)
        ) {
          throw new Error(
            "Orphaned initial release journal differs from the requested release"
          );
        }
        atomicWriteReleaseJsonSync(
          journalPath(next.releaseId),
          storedInitial,
          { fileSystem }
        );
        return storedInitial;
      }
    } else if (
      next.revision !== current.revision + 1 ||
      next.previousJournalSha256 !== fingerprintReleaseJournal(current)
    ) {
      throw new Error("Release journal update is stale or not linked to stored state");
    }
    writeImmutableReleaseJsonSync(
      revisionPath(next.releaseId, next.revision),
      next,
      { fileSystem }
    );
    atomicWriteReleaseJsonSync(journalPath(next.releaseId), next, { fileSystem });
    return next;
  };
  const scanJournalBatches = function* ({ batchSize = 64 } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) {
      throw new Error("Release journal scan batch size must be between 1 and 256");
    }
    const directory = fileSystem.opendirSync(journalsDirectory);
    let batch = [];
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const releaseId = entry.name.slice(0, -".json".length);
        if (!RELEASE_ID_PATTERN.test(releaseId)) {
          throw new Error("Release state contains an invalid journal filename");
        }
        batch.push(readJournal(releaseId));
        if (batch.length === batchSize) {
          yield Object.freeze(batch);
          batch = [];
        }
      }
      if (batch.length > 0) yield Object.freeze(batch);
    } finally {
      directory.closeSync();
    }
  };
  const readPointer = (kind) => {
    const parsed = readReleaseJsonSync(
      fileSystem,
      pointerPath(kind),
      "Release pointer"
    );
    return parsed === null ? null : assertReleasePointer(parsed);
  };
  const writePointer = (pointer) => {
    const next = assertReleasePointer(pointer);
    const journal = readJournal(next.releaseId);
    if (!journal) throw new Error("Release pointer journal is not stored");
    const expected = createReleasePointer(journal, next.kind, {
      at: next.updatedAt
    });
    if (canonicalReleaseJson(expected) !== canonicalReleaseJson(next)) {
      throw new Error("Release pointer does not match stored journal state");
    }
    atomicWriteReleaseJsonSync(pointerPath(next.kind), next, { fileSystem });
    return next;
  };
  const readTrustedActiveReceipt = () => {
    const pointer = readPointer(RELEASE_POINTER_KINDS.ACTIVE);
    if (!pointer) return null;
    const journal = readJournal(pointer.releaseId);
    if (!journal) throw new Error("Active release journal is missing");
    return resolveTrustedActiveReleaseReceipt({ pointer, journal });
  };

  return Object.freeze({
    root,
    scanJournalBatches,
    readJournal,
    writeJournal,
    readPointer,
    writePointer,
    readTrustedActiveReceipt
  });
}
