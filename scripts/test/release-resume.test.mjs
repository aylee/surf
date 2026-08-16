import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  createReleaseJournal,
  recordReleaseJournalFailure,
  transitionReleaseJournal
} from "../lib/release-journal.mjs";
import {
  exactResumeJournalAcceptsLiveTarget,
  journalNeedsActivationBoundaryReconciliation
} from "../lib/release-resume.mjs";
import {
  RELEASE_FINGERPRINT_KEYS,
  classifyReleaseImpact,
  fingerprintCanonicalReleaseValue
} from "../lib/release-impact.mjs";

const targetGitSha = "a".repeat(40);
const targetWorkerVersionId = "11111111-1111-4111-8111-111111111111";

function fingerprints() {
  return Object.fromEntries(
    RELEASE_FINGERPRINT_KEYS.map((key) => [
      key,
      fingerprintCanonicalReleaseValue(`resume:${key}`)
    ])
  );
}

function activationBoundaryJournal() {
  const targetFingerprints = fingerprints();
  let journal = createReleaseJournal({
    releaseId: "resume-activation-boundary",
    targetGitSha,
    classification: classifyReleaseImpact({
      changedPaths: ["package.json"],
      targetFingerprints,
      activeReceipt: null
    }),
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runnerActivationId: null
    },
    createdAt: "2026-08-15T00:00:00.000Z"
  });
  const steps = [
    [RELEASE_JOURNAL_STATES.VERIFIED, {}],
    [
      RELEASE_JOURNAL_STATES.PREPARED,
      {
        profileSha256: "1".repeat(64),
        operatorEnvironmentFingerprint: "2".repeat(64),
        wranglerConfigSha256: "3".repeat(64),
        workerSecretsFingerprint: "4".repeat(64)
      }
    ],
    [
      RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
      { workerVersionId: targetWorkerVersionId }
    ],
    [
      RELEASE_JOURNAL_STATES.DATA_PREPARED,
      { d1Bookmark: "bookmark-resume", d1ExportSha256: "5".repeat(64) }
    ],
    [RELEASE_JOURNAL_STATES.RUNNER_READY, { runnerActivationId: "runner-r1" }],
    [RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED, {}]
  ];
  for (const [index, [state, receipts]] of steps.entries()) {
    journal = transitionReleaseJournal(journal, state, {
      at: new Date(Date.UTC(2026, 7, 15, 0, 0, index + 1)).toISOString(),
      receipts
    });
  }
  return journal;
}

test("exact resume admits only its uploaded target at the activation boundary", () => {
  const journal = activationBoundaryJournal();
  assert.equal(journalNeedsActivationBoundaryReconciliation(journal), true);
  assert.equal(
    exactResumeJournalAcceptsLiveTarget(journal, {
      targetGitSha,
      liveSourceRevision: targetGitSha,
      liveWorkerVersionId: targetWorkerVersionId
    }),
    true
  );
  for (const invalid of [
    { liveSourceRevision: "b".repeat(40) },
    { liveWorkerVersionId: "22222222-2222-4222-8222-222222222222" },
    { targetGitSha: "c".repeat(40) }
  ]) {
    assert.equal(
      exactResumeJournalAcceptsLiveTarget(journal, {
        targetGitSha,
        liveSourceRevision: targetGitSha,
        liveWorkerVersionId: targetWorkerVersionId,
        ...invalid
      }),
      false
    );
  }
});

test("activation ambiguity remains the only failed pre-transition reconciliation", () => {
  const boundary = activationBoundaryJournal();
  const ambiguous = recordReleaseJournalFailure(boundary, {
    code: RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS,
    at: "2026-08-15T00:01:00.000Z"
  });
  assert.equal(journalNeedsActivationBoundaryReconciliation(ambiguous), true);

  const dependencyDrift = recordReleaseJournalFailure(boundary, {
    code: RELEASE_FAILURE_CODES.DEPENDENCY_DRIFT,
    at: "2026-08-15T00:01:00.000Z"
  });
  assert.equal(journalNeedsActivationBoundaryReconciliation(dependencyDrift), false);
});
