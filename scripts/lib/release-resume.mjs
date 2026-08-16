import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  assertReleaseJournal
} from "./release-journal.mjs";

const ACTIVATED_STATES = new Set([
  RELEASE_JOURNAL_STATES.WORKER_ACTIVE,
  RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED,
  RELEASE_JOURNAL_STATES.GENERATION_VERIFIED,
  RELEASE_JOURNAL_STATES.VERIFIED_LIVE,
  RELEASE_JOURNAL_STATES.COMPLETE
]);

export function journalNeedsActivationBoundaryReconciliation(journal) {
  assertReleaseJournal(journal);
  return (
    journal.state === RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED ||
    (journal.state === RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD &&
      journal.failureCode === RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS)
  );
}

export function exactResumeJournalAcceptsLiveTarget(
  journal,
  { targetGitSha, liveSourceRevision, liveWorkerVersionId }
) {
  assertReleaseJournal(journal);
  const effectiveState = [
    RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
    RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD
  ].includes(journal.state)
    ? journal.resumeFrom
    : journal.state;
  return (
    journal.targetGitSha === targetGitSha &&
    liveSourceRevision === targetGitSha &&
    journal.receipts.workerVersionId === liveWorkerVersionId &&
    (effectiveState === RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED ||
      ACTIVATED_STATES.has(effectiveState))
  );
}
