import {
  RELEASE_JOURNAL_STATES,
  assertReleaseJournal,
  assertReleaseReplacement,
  predecessorForReleaseReplacement,
  replaceRunnerFailureReleaseJournal
} from "./release-journal.mjs";

function source(journal) {
  const current = assertReleaseJournal(journal);
  if (
    ![
      RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
      RELEASE_JOURNAL_STATES.REPLACED
    ].includes(current.state) ||
    current.resumeFrom !== RELEASE_JOURNAL_STATES.DATA_PREPARED
  ) {
    throw new Error(
      "Runner-failure recovery requires its exact data-prepared source"
    );
  }
  return current;
}

function callable(value, label) {
  if (typeof value !== "function") {
    throw new Error(`Runner-failure recovery requires a callable ${label}`);
  }
  return value;
}

export async function commitRunnerFailureReplacement(
  journal,
  { releaseId, targetGitSha, at, attest } = {}
) {
  const current = source(journal);
  if (current.state === RELEASE_JOURNAL_STATES.REPLACED) {
    if (
      current.supersededBy.releaseId !== releaseId ||
      current.supersededBy.targetGitSha !== targetGitSha ||
      current.supersededBy.runnerFailureAttestation === undefined
    ) {
      throw new Error(
        "Linked runner-failure replacement identity changed before journal creation"
      );
    }
    return Object.freeze({ journal: current, evidence: null });
  }
  const evidence = await callable(attest, "attestor")(current);
  const replaced = replaceRunnerFailureReleaseJournal(current, {
    releaseId,
    targetGitSha,
    evidence,
    at
  });
  return Object.freeze({ journal: replaced, evidence });
}

export async function establishRunnerFailureReplacement(
  journal,
  {
    releaseId,
    targetGitSha,
    at,
    attest,
    persistReplaced,
    createSuccessor,
    persistSuccessor
  } = {}
) {
  const current = source(journal);
  const committed = await commitRunnerFailureReplacement(current, {
    releaseId,
    targetGitSha,
    at,
    attest
  });
  const replaced =
    current.state === RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE
      ? assertReleaseJournal(
          callable(persistReplaced, "terminal journal writer")(
            committed.journal
          )
        )
      : committed.journal;
  const successor = assertReleaseJournal(
    callable(createSuccessor, "successor factory")({
      predecessor: predecessorForReleaseReplacement(replaced),
      replaced
    })
  );
  assertReleaseReplacement(replaced, successor);
  const persistedSuccessor = assertReleaseJournal(
    callable(persistSuccessor, "successor journal writer")(successor)
  );
  assertReleaseReplacement(replaced, persistedSuccessor);
  return Object.freeze({ replaced, successor: persistedSuccessor });
}
