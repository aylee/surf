import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  assertReleaseJournal,
  assertReleaseReplacement,
  fingerprintReleaseJournal
} from "./release-journal.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function exactCommittedEvidence(value) {
  if (
    value?.schemaVersion !== 1 ||
    typeof value.targetActivationId !== "string" ||
    !SHA_PATTERN.test(value.targetReleaseSha ?? "") ||
    !SHA_PATTERN.test(value.priorReleaseSha ?? "") ||
    !SHA256_PATTERN.test(value.targetRecordSha256 ?? "") ||
    !SHA256_PATTERN.test(value.priorRecordSha256 ?? "") ||
    !SHA256_PATTERN.test(value.semanticReceiptSha256 ?? "") ||
    (value.priorActivationId !== null &&
      typeof value.priorActivationId !== "string")
  ) {
    throw new Error("Committed runner drain evidence is invalid");
  }
  return value;
}

function runnerFailureSource(journal) {
  const current = assertReleaseJournal(journal);
  if (
    current.resumeFrom !== RELEASE_JOURNAL_STATES.DATA_PREPARED ||
    current.failureCode !== RELEASE_FAILURE_CODES.RUNNER_FAILED ||
    ![
      RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
      RELEASE_JOURNAL_STATES.REPLACED
    ].includes(current.state)
  ) {
    return null;
  }
  return current;
}

export function runnerFailureRecoveryMode(failedJournal, installedRunner) {
  const failed = runnerFailureSource(failedJournal);
  if (failed === null || !installedRunner) {
    throw new Error(
      "Runner-failure recovery requires its exact failed journal and installed runner"
    );
  }
  if (
    installedRunner.recordSchemaVersion === 4 &&
    installedRunner.transitionOnly === false &&
    installedRunner.activationId === failed.releaseId
  ) {
    return "committed";
  }
  if (
    installedRunner.recordSchemaVersion === 3 &&
    installedRunner.transitionOnly === true &&
    installedRunner.activationId ===
      failed.predecessor.runnerActivationId &&
    SHA_PATTERN.test(installedRunner.legacyCoupledSourceRevision ?? "")
  ) {
    return "legacy";
  }
  throw new Error(
    "Runner-failure recovery requires the exact failed v4 target or legacy v3 predecessor"
  );
}

function linkedRunnerFailureSource(successor, readJournal) {
  if (
    typeof readJournal !== "function" ||
    successor.predecessor.releaseId === null ||
    successor.predecessor.journalSha256 === null
  ) {
    return null;
  }
  const source = readJournal(successor.predecessor.releaseId);
  const committedAttestation =
    source?.supersededBy?.runnerFailureAttestation;
  if (committedAttestation?.schemaVersion !== 2) return null;
  if (
    source === null ||
    fingerprintReleaseJournal(source) !== successor.predecessor.journalSha256 ||
    source.state !== RELEASE_JOURNAL_STATES.REPLACED ||
    source.supersededBy.releaseId !== successor.releaseId ||
    source.supersededBy.targetGitSha !== successor.targetGitSha
  ) {
    throw new Error(
      "Runner-failure successor has a malformed committed-runner replacement link"
    );
  }
  assertReleaseReplacement(source, successor);
  return source;
}

export function linkedCommittedRunnerFailureSource(
  successor,
  { readJournal }
) {
  const current = assertReleaseJournal(successor);
  const source = linkedRunnerFailureSource(current, readJournal);
  if (source === null) {
    throw new Error(
      "Runner-failure successor lacks its exact committed-runner replacement link"
    );
  }
  return source;
}

function attestedCommittedDrainEvidence(source) {
  const attestation = source.supersededBy?.runnerFailureAttestation;
  if (attestation?.schemaVersion !== 2) {
    throw new Error(
      "Runner-failure replacement lacks committed-runner lineage evidence"
    );
  }
  return exactCommittedEvidence({
    schemaVersion: 1,
    targetActivationId: attestation.committedRunnerActivationId,
    targetReleaseSha: source.targetGitSha,
    targetRecordSha256: attestation.committedRunnerRecordSha256,
    priorActivationId: null,
    priorReleaseSha: attestation.priorRunnerReleaseSha,
    priorRecordSha256: attestation.priorRunnerRecordSha256,
    semanticReceiptSha256: attestation.runnerTransitionSha256
  });
}

export function replacementLiveWorkerLineageEvidence(
  successor,
  { readJournal }
) {
  const current = assertReleaseJournal(successor);
  if (
    current.predecessor.releaseId === null ||
    current.predecessor.journalSha256 === null ||
    typeof readJournal !== "function"
  ) {
    return null;
  }
  const replaced = readJournal(current.predecessor.releaseId);
  const attestation = replaced?.supersededBy?.runnerFailureAttestation;
  if (
    replaced === null ||
    fingerprintReleaseJournal(replaced) !==
      current.predecessor.journalSha256 ||
    replaced.state !== RELEASE_JOURNAL_STATES.REPLACED ||
    replaced.supersededBy?.releaseId !== current.releaseId ||
    replaced.supersededBy?.targetGitSha !== current.targetGitSha ||
    ![1, 2].includes(attestation?.schemaVersion)
  ) {
    throw new Error(
      "Runner-failure successor lacks its exact hash-linked replacement lineage"
    );
  }
  assertReleaseReplacement(replaced, current);
  return Object.freeze({
    sourceRevision:
      attestation.schemaVersion === 2
        ? attestation.liveWorkerSourceRevision
        : attestation.priorRunnerReleaseSha,
    runnerReleaseSha:
      attestation.schemaVersion === 2
        ? replaced.targetGitSha
        : attestation.priorRunnerReleaseSha,
    runnerRecordSha256:
      attestation.schemaVersion === 2
        ? attestation.committedRunnerRecordSha256
        : attestation.priorRunnerRecordSha256
  });
}

export function replacementLiveWorkerSourceRevision(
  successor,
  { readJournal }
) {
  return replacementLiveWorkerLineageEvidence(successor, { readJournal })
    ?.sourceRevision ?? null;
}

export function committedRunnerLineagePlan(
  selectedJournal,
  { readJournal, drainEvidence }
) {
  const selected = assertReleaseJournal(selectedJournal);
  const evidence = exactCommittedEvidence(drainEvidence);
  const linkedSource = linkedRunnerFailureSource(selected, readJournal);
  const directSource =
    linkedSource === null ? runnerFailureSource(selected) : null;
  const source = linkedSource ?? directSource;
  if (source === null) {
    throw new Error(
      "Unmanaged Worker lineage requires an exact runner-failure replacement link"
    );
  }
  const attestation = source.supersededBy?.runnerFailureAttestation;
  const linkedSuccessor = directSource === null;

  if (
    !linkedSuccessor &&
    source.state === RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE
  ) {
    const linkedLiveWorker = replacementLiveWorkerLineageEvidence(source, {
      readJournal
    });
    if (
      evidence.targetActivationId !== source.releaseId ||
      evidence.targetReleaseSha !== source.targetGitSha ||
      evidence.priorActivationId !== null ||
      (linkedLiveWorker !== null &&
        (evidence.priorReleaseSha !== linkedLiveWorker.runnerReleaseSha ||
          evidence.priorRecordSha256 !==
            linkedLiveWorker.runnerRecordSha256))
    ) {
      throw new Error(
        "Committed runner drain evidence differs from the failed target"
      );
    }
    return Object.freeze({
      liveSourceRevision:
        linkedLiveWorker?.sourceRevision ?? evidence.priorReleaseSha,
      runnerActivationId: evidence.targetActivationId,
      sourceJournal: source
    });
  }

  if (attestation?.schemaVersion !== 2) {
    throw new Error(
      "Runner-failure replacement lacks committed-runner lineage evidence"
    );
  }
  const linkedLiveWorker = replacementLiveWorkerLineageEvidence(source, {
    readJournal
  });
  if (
    linkedLiveWorker !== null &&
    (attestation.liveWorkerSourceRevision !==
      linkedLiveWorker.sourceRevision ||
      attestation.priorRunnerReleaseSha !==
        linkedLiveWorker.runnerReleaseSha ||
      attestation.priorRunnerRecordSha256 !==
        linkedLiveWorker.runnerRecordSha256)
  ) {
    throw new Error(
      "Committed-runner replacement changed its hash-linked live Worker lineage"
    );
  }
  const committedTargetMatches =
    evidence.targetActivationId === attestation.committedRunnerActivationId &&
    evidence.targetReleaseSha === source.targetGitSha &&
    evidence.priorActivationId === null &&
    evidence.targetRecordSha256 ===
      attestation.committedRunnerRecordSha256 &&
    evidence.priorRecordSha256 === attestation.priorRunnerRecordSha256 &&
    evidence.semanticReceiptSha256 === attestation.runnerTransitionSha256 &&
    evidence.priorReleaseSha === attestation.priorRunnerReleaseSha;
  const successorTargetMatches =
    linkedSuccessor &&
    evidence.targetActivationId === selected.releaseId &&
    evidence.targetReleaseSha === selected.targetGitSha &&
    evidence.priorActivationId === attestation.committedRunnerActivationId &&
    evidence.priorRecordSha256 ===
      attestation.committedRunnerRecordSha256 &&
    evidence.priorReleaseSha === source.targetGitSha;
  if (!committedTargetMatches && !successorTargetMatches) {
    throw new Error(
      "Installed runner transition differs from the linked recovery lineage"
    );
  }
  return Object.freeze({
    liveSourceRevision: attestation.liveWorkerSourceRevision,
    runnerActivationId: evidence.targetActivationId,
    sourceJournal: source
  });
}

export function committedRunnerResumeLineagePlan(
  selectedJournal,
  {
    readJournal,
    installedRunnerActivationId,
    installedRunnerRecordSha256,
    installState = null,
    targetDrainEvidence = null
  }
) {
  const selected = assertReleaseJournal(selectedJournal);
  const source = linkedCommittedRunnerFailureSource(selected, { readJournal });
  const attested = attestedCommittedDrainEvidence(source);
  if (!SHA256_PATTERN.test(installedRunnerRecordSha256 ?? "")) {
    throw new Error("Installed runner record fingerprint is invalid");
  }

  let drainEvidence = attested;
  let targetCommitted = false;
  let validPrecommit = true;
  if (installState === null) {
    if (
      installedRunnerActivationId !== attested.targetActivationId ||
      installedRunnerRecordSha256 !== attested.targetRecordSha256
    ) {
      throw new Error(
        "Installed runner differs from the attested committed predecessor"
      );
    }
  } else {
    if (
      installState?.schemaVersion !== 1 ||
      installState.targetActivationId !== selected.releaseId ||
      installState.targetReleaseSha !== selected.targetGitSha ||
      !SHA256_PATTERN.test(installState.targetRecordSha256 ?? "") ||
      installState.priorActivationId !== attested.targetActivationId ||
      installState.priorReleaseSha !== source.targetGitSha ||
      installState.priorRecordSha256 !== attested.targetRecordSha256 ||
      !["prior", "target"].includes(installState.narrativeRunner) ||
      !["prior", "target"].includes(installState.omlxServer) ||
      typeof installState.targetCommitted !== "boolean" ||
      typeof installState.validPrecommit !== "boolean" ||
      installState.targetCommitted === installState.validPrecommit ||
      (installState.targetCommitted &&
        (installState.narrativeRunner !== "target" ||
          installState.omlxServer !== "target")) ||
      (installState.validPrecommit &&
        (installState.narrativeRunner !== "prior" ||
          !["prior", "target"].includes(installState.omlxServer)))
    ) {
      throw new Error(
        "Installed runner transition differs from the linked successor"
      );
    }
    const expectedInstalledActivationId =
      installState.narrativeRunner === "target"
        ? selected.releaseId
        : attested.targetActivationId;
    const expectedInstalledRecordSha256 =
      installState.narrativeRunner === "target"
        ? installState.targetRecordSha256
        : attested.targetRecordSha256;
    if (
      installedRunnerActivationId !== expectedInstalledActivationId ||
      installedRunnerRecordSha256 !== expectedInstalledRecordSha256
    ) {
      throw new Error(
        "Installed runner plist ownership differs from the inspected transition"
      );
    }
    targetCommitted = installState.targetCommitted;
    validPrecommit = installState.validPrecommit;
    if (targetCommitted) {
      drainEvidence = exactCommittedEvidence(targetDrainEvidence);
      if (
        drainEvidence.targetActivationId !== installState.targetActivationId ||
        drainEvidence.targetReleaseSha !== installState.targetReleaseSha ||
        drainEvidence.targetRecordSha256 !== installState.targetRecordSha256 ||
        drainEvidence.priorActivationId !== installState.priorActivationId ||
        drainEvidence.priorReleaseSha !== installState.priorReleaseSha ||
        drainEvidence.priorRecordSha256 !== installState.priorRecordSha256
      ) {
        throw new Error(
          "Committed successor drain evidence differs from its installed transition"
        );
      }
    } else if (targetDrainEvidence !== null) {
      throw new Error(
        "Precommit runner transition cannot claim committed drain evidence"
      );
    }
  }

  const lineage = committedRunnerLineagePlan(selected, {
    readJournal,
    drainEvidence
  });
  return Object.freeze({
    ...lineage,
    targetCommitted,
    validPrecommit
  });
}
