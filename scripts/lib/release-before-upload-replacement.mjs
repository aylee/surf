import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  RELEASE_JOURNAL_STATES,
  assertReleaseJournal,
  replaceBeforeUploadReleaseJournal
} from "./release-journal.mjs";

const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function assertAbsent(path, label) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must be absent before replacement`);
}

export function assertBeforeUploadReplacementArtifactsAbsent({
  attemptDirectory,
  serviceRoot,
  releaseId
}) {
  if (
    !isAbsolute(attemptDirectory ?? "") ||
    !isAbsolute(serviceRoot ?? "") ||
    !RELEASE_ID_PATTERN.test(releaseId ?? "")
  ) {
    throw new Error("Before-upload artifact guard requires exact absolute inputs");
  }
  assertAbsent(
    resolve(attemptDirectory, "worker-upload.json"),
    "Failed release Worker upload artifact"
  );
  assertAbsent(
    resolve(attemptDirectory, "d1-backup.json"),
    "Failed release D1 backup artifact"
  );
  assertAbsent(
    resolve(serviceRoot, "rollbacks", releaseId),
    "Failed release rollback artifact directory"
  );
  return Object.freeze({
    uploadArtifactAbsent: true,
    backupArtifactAbsent: true,
    rollbackArtifactAbsent: true
  });
}

function beforeUploadSource(journal) {
  const current = assertReleaseJournal(journal);
  if (
    ![
      RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
      RELEASE_JOURNAL_STATES.REPLACED
    ].includes(current.state) ||
    current.resumeFrom !== RELEASE_JOURNAL_STATES.VERIFIED
  ) {
    throw new Error("Before-upload recovery requires its exact verified source");
  }
  return current;
}

function attestor(value) {
  if (typeof value !== "function") {
    throw new Error("Before-upload recovery requires a callable attestor");
  }
  return value;
}

export async function previewBeforeUploadReplacement(journal, attest) {
  const current = beforeUploadSource(journal);
  if (current.state === RELEASE_JOURNAL_STATES.REPLACED) return null;
  return attestor(attest)(current);
}

export async function commitBeforeUploadReplacement(
  journal,
  { releaseId, targetGitSha, at, attest } = {}
) {
  const current = beforeUploadSource(journal);
  if (current.state === RELEASE_JOURNAL_STATES.REPLACED) {
    if (
      current.supersededBy.releaseId !== releaseId ||
      current.supersededBy.targetGitSha !== targetGitSha
    ) {
      throw new Error(
        "Linked before-upload replacement identity changed before journal creation"
      );
    }
    return Object.freeze({ journal: current, evidence: null });
  }
  const evidence = await attestor(attest)(current);
  const replaced = replaceBeforeUploadReleaseJournal(current, {
    releaseId,
    targetGitSha,
    evidence,
    at
  });
  return Object.freeze({ journal: replaced, evidence });
}
