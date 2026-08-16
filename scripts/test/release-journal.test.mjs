import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RELEASE_FINGERPRINT_KEYS,
  classifyReleaseImpact,
  createTrustedActiveReleaseReceipt,
  fingerprintCanonicalReleaseValue
} from "../lib/release-impact.mjs";
import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  RELEASE_LANE_STATE_PATHS,
  RELEASE_POINTER_KINDS,
  assertBeforeUploadReplacementEvidence,
  assertReleaseReplacement,
  assertReleaseSupersession,
  assertReleaseJournal,
  assertReleasePointer,
  atomicWriteReleaseJsonSync,
  createReleaseJournal,
  createReleasePointer,
  createReleaseStateStore,
  fingerprintReleaseJournal,
  predecessorForReleaseReplacement,
  recordReleaseJournalFailure,
  reconcileReleaseActivation,
  resolveTrustedActiveReleaseReceipt,
  resumeReleaseJournal,
  replacePreMutationReleaseJournal,
  supersedeReleaseJournal,
  transitionReleaseJournal
} from "../lib/release-journal.mjs";
import {
  assertBeforeUploadReplacementArtifactsAbsent,
  attestNoTaggedWorkerUpload,
  commitBeforeUploadReplacement,
  previewBeforeUploadReplacement
} from "../lib/release-before-upload-replacement.mjs";

const workerVersionId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const preparedReceipts = Object.freeze({
  profileSha256: "1".repeat(64),
  operatorEnvironmentFingerprint: "4".repeat(64),
  wranglerConfigSha256: "2".repeat(64),
  workerSecretsFingerprint: "3".repeat(64)
});

function fingerprints(seed = "active") {
  return Object.fromEntries(
    RELEASE_FINGERPRINT_KEYS.map((key, index) => [
      key,
      fingerprintCanonicalReleaseValue(`${seed}:${index}:${key}`)
    ])
  );
}

function activeReceipt(activeFingerprints) {
  return createTrustedActiveReleaseReceipt({
    schemaVersion: 1,
    releaseId: "previous-release",
    targetGitSha: "a".repeat(40),
    workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    journalSha256: "c".repeat(64),
    state: "complete",
    fingerprints: activeFingerprints
  });
}

function assetsClassification(targetFingerprints = fingerprints()) {
  return classifyReleaseImpact({
    changedPaths: ["apps/web/src/App.tsx"],
    targetFingerprints,
    activeReceipt: activeReceipt({
      ...targetFingerprints,
      workerAssets: fingerprintCanonicalReleaseValue("previous-assets")
    })
  });
}

function conservativeClassification(targetFingerprints = fingerprints()) {
  return classifyReleaseImpact({
    changedPaths: ["pnpm-lock.yaml"],
    targetFingerprints,
    activeReceipt: null
  });
}

function predecessor() {
  return {
    releaseId: "previous-release",
    journalSha256: "c".repeat(64),
    workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    runnerActivationId: "runner-old-r1"
  };
}

function initialJournal() {
  const targetFingerprints = fingerprints();
  return createReleaseJournal({
    releaseId: "release-ui-1",
    targetGitSha: "d".repeat(40),
    classification: assetsClassification(targetFingerprints),
    targetFingerprints,
    predecessor: predecessor(),
    createdAt: "2026-08-15T22:00:00.000Z"
  });
}

function fullJournal() {
  const targetFingerprints = fingerprints("full");
  const classification = classifyReleaseImpact({
    changedPaths: ["pnpm-lock.yaml"],
    targetFingerprints,
    activeReceipt: null
  });
  return createReleaseJournal({
    releaseId: "release-full-1",
    targetGitSha: "e".repeat(40),
    classification,
    targetFingerprints,
    predecessor: predecessor(),
    createdAt: "2026-08-15T23:00:00.000Z"
  });
}

function componentFullJournal({ path, fingerprintKey = null, releaseId }) {
  const activeFingerprints = fingerprints(`active-${releaseId}`);
  const targetFingerprints = {
    ...activeFingerprints,
    ...(fingerprintKey
      ? {
          [fingerprintKey]: fingerprintCanonicalReleaseValue(
            `target-${releaseId}-${fingerprintKey}`
          )
        }
      : {})
  };
  const classification = classifyReleaseImpact({
    changedPaths: [path],
    targetFingerprints,
    activeReceipt: activeReceipt(activeFingerprints)
  });
  return createReleaseJournal({
    releaseId,
    targetGitSha: "9".repeat(40),
    classification,
    targetFingerprints,
    predecessor: predecessor(),
    createdAt: "2026-08-16T00:00:00.000Z"
  });
}

function stageAssetsRelease(journal = initialJournal()) {
  let current = transitionReleaseJournal(journal, RELEASE_JOURNAL_STATES.VERIFIED, {
    at: "2026-08-15T22:00:01.000Z"
  });
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.PREPARED, {
    at: "2026-08-15T22:00:02.000Z",
    receipts: preparedReceipts
  });
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
    {
      at: "2026-08-15T22:00:03.000Z",
      receipts: { workerVersionId }
    }
  );
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
    { at: "2026-08-15T22:00:04.000Z" }
  );
  return current;
}

function advanceAssetsRelease(journal = initialJournal()) {
  return transitionReleaseJournal(
    stageAssetsRelease(journal),
    RELEASE_JOURNAL_STATES.WORKER_ACTIVE,
    {
      at: "2026-08-15T22:00:05.000Z",
      receipts: { deploymentId }
    }
  );
}

function completeAssetsRelease(journal = initialJournal()) {
  let current = advanceAssetsRelease(journal);
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.VERIFIED_LIVE, {
    at: "2026-08-15T22:00:06.000Z"
  });
  return transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.COMPLETE, {
    at: "2026-08-15T22:00:07.000Z"
  });
}

test("assets-only journals take the narrow path and form a hash chain", () => {
  const initial = initialJournal();
  const complete = completeAssetsRelease(initial);
  assert.equal(complete.state, RELEASE_JOURNAL_STATES.COMPLETE);
  assert.equal(complete.revision, 7);
  assert.equal(complete.receipts.workerVersionId, workerVersionId);
  assert.equal(complete.receipts.deploymentId, deploymentId);
  assert.equal(complete.receipts.d1Bookmark, null);
  assert.match(fingerprintReleaseJournal(complete), /^[0-9a-f]{64}$/);
  assert.notEqual(complete.previousJournalSha256, fingerprintReleaseJournal(initial));
});

test("assets-only journals reject stateful work and illegal skips", () => {
  const initial = initialJournal();
  assert.throws(
    () =>
      transitionReleaseJournal(initial, RELEASE_JOURNAL_STATES.WORKER_ACTIVE, {
        at: "2026-08-15T22:00:01.000Z",
        receipts: { workerVersionId, deploymentId }
      }),
    /Illegal release transition/
  );

  let current = transitionReleaseJournal(initial, RELEASE_JOURNAL_STATES.VERIFIED, {
    at: "2026-08-15T22:00:01.000Z"
  });
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.PREPARED, {
    at: "2026-08-15T22:00:02.000Z",
    receipts: preparedReceipts
  });
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
    {
      at: "2026-08-15T22:00:03.000Z",
      receipts: { workerVersionId }
    }
  );
  assert.throws(
    () =>
      transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.DATA_PREPARED, {
        at: "2026-08-15T22:00:04.000Z",
        receipts: { d1Bookmark: "bookmark-should-not-exist" }
      }),
    /Illegal release transition/
  );
  assert.throws(
    () =>
      transitionReleaseJournal(
        current,
        RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
        {
          at: "2026-08-15T22:00:04.000Z",
          receipts: { d1Bookmark: "bookmark-should-not-exist" }
        }
      ),
    /cannot record stateful receipts/
  );
});

test("conservative-full journals require every stateful boundary in order", () => {
  assert.deepEqual(RELEASE_LANE_STATE_PATHS["conservative-full"], [
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
  ]);

  let current = transitionReleaseJournal(
    fullJournal(),
    RELEASE_JOURNAL_STATES.VERIFIED,
    { at: "2026-08-15T23:00:01.000Z" }
  );
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.PREPARED, {
    at: "2026-08-15T23:00:02.000Z",
    receipts: preparedReceipts
  });
  assert.throws(
    () =>
      transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.DATA_PREPARED, {
        at: "2026-08-15T23:00:03.000Z",
        receipts: { d1Bookmark: "bookmark-before-upload" }
      }),
    /Illegal release transition/
  );
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
    {
      at: "2026-08-15T23:00:03.000Z",
      receipts: { workerVersionId }
    }
  );
  assert.throws(
    () =>
      transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.DATA_PREPARED, {
        at: "2026-08-15T23:00:04.000Z"
      }),
    /requires a D1 rollback receipt/
  );
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.DATA_PREPARED,
    {
      at: "2026-08-15T23:00:04.000Z",
      receipts: {
        d1Bookmark: "bookmark-release-full-1",
        d1ExportSha256: "f".repeat(64)
      }
    }
  );
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.RUNNER_READY, {
    at: "2026-08-15T23:00:05.000Z",
    receipts: { runnerActivationId: "runner-release-full-1" }
  });
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
    { at: "2026-08-15T23:00:06.000Z" }
  );
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.WORKER_ACTIVE, {
    at: "2026-08-15T23:00:07.000Z",
    receipts: { deploymentId }
  });
  assert.throws(
    () =>
      transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.VERIFIED_LIVE, {
        at: "2026-08-15T23:00:08.000Z"
      }),
    /Illegal release transition/
  );
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED, {
    at: "2026-08-15T23:00:08.000Z"
  });
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.GENERATION_VERIFIED,
    {
      at: "2026-08-15T23:00:09.000Z",
      receipts: { generationId: "generation-release-full-1" }
    }
  );
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.VERIFIED_LIVE, {
    at: "2026-08-15T23:00:10.000Z"
  });
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.COMPLETE, {
    at: "2026-08-15T23:00:11.000Z"
  });
  assert.equal(current.state, RELEASE_JOURNAL_STATES.COMPLETE);
  assert.equal(current.receipts.d1Bookmark, "bookmark-release-full-1");
  assert.equal(current.receipts.d1ExportSha256, "f".repeat(64));
  assert.equal(current.receipts.runnerActivationId, "runner-release-full-1");
  assert.equal(current.receipts.generationId, "generation-release-full-1");
});

test("component-full journals require receipts only for inferred mutations", () => {
  const advanceToUpload = (journal) => {
    let current = transitionReleaseJournal(
      journal,
      RELEASE_JOURNAL_STATES.VERIFIED,
      { at: "2026-08-16T00:00:01.000Z" }
    );
    current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.PREPARED, {
      at: "2026-08-16T00:00:02.000Z",
      receipts: preparedReceipts
    });
    return transitionReleaseJournal(
      current,
      RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
      {
        at: "2026-08-16T00:00:03.000Z",
        receipts: { workerVersionId }
      }
    );
  };

  let docsOnly = advanceToUpload(
    componentFullJournal({
      path: "docs/architecture.md",
      releaseId: "release-docs-only"
    })
  );
  docsOnly = transitionReleaseJournal(
    docsOnly,
    RELEASE_JOURNAL_STATES.DATA_PREPARED,
    { at: "2026-08-16T00:00:04.000Z" }
  );
  docsOnly = transitionReleaseJournal(
    docsOnly,
    RELEASE_JOURNAL_STATES.RUNNER_READY,
    { at: "2026-08-16T00:00:05.000Z" }
  );
  docsOnly = transitionReleaseJournal(
    docsOnly,
    RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
    { at: "2026-08-16T00:00:06.000Z" }
  );
  docsOnly = transitionReleaseJournal(
    docsOnly,
    RELEASE_JOURNAL_STATES.WORKER_ACTIVE,
    {
      at: "2026-08-16T00:00:07.000Z",
      receipts: { deploymentId }
    }
  );
  docsOnly = transitionReleaseJournal(
    docsOnly,
    RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED,
    { at: "2026-08-16T00:00:08.000Z" }
  );
  docsOnly = transitionReleaseJournal(
    docsOnly,
    RELEASE_JOURNAL_STATES.GENERATION_VERIFIED,
    { at: "2026-08-16T00:00:09.000Z" }
  );
  assert.equal(docsOnly.receipts.d1Bookmark, null);
  assert.equal(docsOnly.receipts.runnerActivationId, null);
  assert.equal(docsOnly.receipts.generationId, null);

  const migration = advanceToUpload(
    componentFullJournal({
      path: "packages/db/migrations/0006_example.sql",
      fingerprintKey: "migrations",
      releaseId: "release-migration-only"
    })
  );
  assert.throws(
    () =>
      transitionReleaseJournal(
        migration,
        RELEASE_JOURNAL_STATES.DATA_PREPARED,
        { at: "2026-08-16T00:00:04.000Z" }
      ),
    /requires a D1 rollback receipt/
  );
});

test("failure states preserve the exact resume boundary without raw errors", () => {
  let current = transitionReleaseJournal(
    initialJournal(),
    RELEASE_JOURNAL_STATES.VERIFIED,
    { at: "2026-08-15T22:00:01.000Z" }
  );
  const failed = recordReleaseJournalFailure(current, {
    code: RELEASE_FAILURE_CODES.PREPARE_FAILED,
    at: "2026-08-15T22:00:02.000Z"
  });
  assert.equal(failed.state, RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE);
  assert.equal(failed.resumeFrom, RELEASE_JOURNAL_STATES.VERIFIED);
  const resumed = resumeReleaseJournal(failed, {
    at: "2026-08-15T22:00:03.000Z"
  });
  assert.equal(resumed.state, RELEASE_JOURNAL_STATES.VERIFIED);
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.failureCode, null);

  const active = advanceAssetsRelease();
  const needsFixForward = recordReleaseJournalFailure(active, {
    code: RELEASE_FAILURE_CODES.LIVE_VERIFY_FAILED,
    at: "2026-08-15T22:00:06.000Z"
  });
  assert.equal(needsFixForward.state, RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD);
  assert.equal(needsFixForward.resumeFrom, RELEASE_JOURNAL_STATES.WORKER_ACTIVE);
  assert.throws(
    () =>
      assertReleaseJournal({
        ...needsFixForward,
        receipts: { ...needsFixForward.receipts, deploymentId: null }
      }),
    /worker-active requires a deployment receipt/
  );
  assert.throws(
    () =>
      recordReleaseJournalFailure(current, {
        code: "token_value_copied_from_output",
        at: "2026-08-15T22:00:02.000Z"
      }),
    /bounded reason code/
  );
});

test("a receipt-free planned failure can be terminally linked to a new target", () => {
  const failed = recordReleaseJournalFailure(initialJournal(), {
    code: RELEASE_FAILURE_CODES.VERIFY_FAILED,
    at: "2026-08-15T22:00:01.000Z"
  });
  const replacementSha = "f".repeat(40);
  const replaced = replacePreMutationReleaseJournal(failed, {
    releaseId: "release-replacement-2",
    targetGitSha: replacementSha,
    at: "2026-08-15T22:00:02.000Z"
  });
  assert.equal(replaced.state, RELEASE_JOURNAL_STATES.REPLACED);
  assert.equal(replaced.resumeFrom, RELEASE_JOURNAL_STATES.PLANNED);
  assert.equal(replaced.failureCode, RELEASE_FAILURE_CODES.VERIFY_FAILED);
  assert.deepEqual(replaced.supersededBy, {
    releaseId: "release-replacement-2",
    targetGitSha: replacementSha
  });
  assert.deepEqual(predecessorForReleaseReplacement(replaced), {
    releaseId: replaced.releaseId,
    journalSha256: fingerprintReleaseJournal(replaced),
    workerVersionId: predecessor().workerVersionId,
    deploymentId: predecessor().deploymentId,
    runnerActivationId: predecessor().runnerActivationId
  });
  assert.throws(
    () =>
      assertReleaseJournal({
        ...replaced,
        resumeFrom: RELEASE_JOURNAL_STATES.VERIFIED
      }),
    /allowed replacement boundary and exact live predecessor/
  );

  const targetFingerprints = fingerprints("replacement");
  const replacement = createReleaseJournal({
    releaseId: replaced.supersededBy.releaseId,
    targetGitSha: replaced.supersededBy.targetGitSha,
    classification: assetsClassification(targetFingerprints),
    targetFingerprints,
    predecessor: predecessorForReleaseReplacement(replaced),
    createdAt: "2026-08-15T22:00:03.000Z"
  });
  assert.doesNotThrow(() =>
    assertReleaseReplacement(replaced, replacement)
  );

  const verifiedFailure = recordReleaseJournalFailure(
    transitionReleaseJournal(initialJournal(), RELEASE_JOURNAL_STATES.VERIFIED, {
      at: "2026-08-15T22:00:01.000Z"
    }),
    {
      code: RELEASE_FAILURE_CODES.PREPARE_FAILED,
      at: "2026-08-15T22:00:02.000Z"
    }
  );
  assert.throws(
    () =>
      replacePreMutationReleaseJournal(verifiedFailure, {
        releaseId: "release-too-late",
        targetGitSha: replacementSha,
        at: "2026-08-15T22:00:03.000Z"
      }),
    /receipt-free release that failed from planned/
  );
});

test("a pre-mutation replacement is recoverable after its terminal link is stored", (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "surf-replace-release-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const store = createReleaseStateStore({ rootDir: stateRoot });
  const failed = recordReleaseJournalFailure(initialJournal(), {
    code: RELEASE_FAILURE_CODES.VERIFY_FAILED,
    at: "2026-08-15T22:00:01.000Z"
  });
  store.writeJournal(initialJournal());
  store.writeJournal(failed);
  const replaced = store.writeJournal(
    replacePreMutationReleaseJournal(failed, {
      releaseId: "release-after-interruption",
      targetGitSha: "f".repeat(40),
      at: "2026-08-15T22:00:02.000Z"
    })
  );

  assert.equal(store.readJournal(replaced.supersededBy.releaseId), null);
  assert.equal(store.readPointer(RELEASE_POINTER_KINDS.ACTIVE), null);
  assert.equal(store.readPointer(RELEASE_POINTER_KINDS.LAST_COMPLETE), null);

  const targetFingerprints = fingerprints("after-interruption");
  const replacement = createReleaseJournal({
    releaseId: replaced.supersededBy.releaseId,
    targetGitSha: replaced.supersededBy.targetGitSha,
    classification: assetsClassification(targetFingerprints),
    targetFingerprints,
    predecessor: predecessorForReleaseReplacement(replaced),
    createdAt: "2026-08-15T22:00:03.000Z"
  });
  const storedReplacement = store.writeJournal(replacement);
  assert.doesNotThrow(() =>
    assertReleaseReplacement(replaced, storedReplacement)
  );
});

test("a verified prepare failure requires exact before-upload evidence", async () => {
  const verified = transitionReleaseJournal(
    initialJournal(),
    RELEASE_JOURNAL_STATES.VERIFIED,
    { at: "2026-08-15T22:00:01.000Z" }
  );
  const failed = recordReleaseJournalFailure(verified, {
    code: RELEASE_FAILURE_CODES.PREPARE_FAILED,
    at: "2026-08-15T22:00:02.000Z"
  });
  const queueEvidence = {
    expectedQueueNames: ["surf-ingest", "surf-narrative"],
    queues: [
      {
        name: "surf-ingest",
        createdOn: "2026-08-10T04:58:17.532408Z"
      },
      {
        name: "surf-narrative",
        createdOn: "2026-08-10T15:18:13.808657Z"
      }
    ]
  };
  const evidence = {
    liveWorkerVersionId: predecessor().workerVersionId,
    liveDeploymentId: predecessor().deploymentId,
    liveDeploymentCreatedOn: "2026-08-14T22:00:00.000000Z",
    liveRunnerActivationId: predecessor().runnerActivationId,
    failedConfigSha256: "9".repeat(64),
    failedQueueTopologyFingerprint: failed.targetFingerprints.queueTopology,
    uploadArtifactAbsent: true,
    backupArtifactAbsent: true,
    rollbackArtifactAbsent: true,
    remoteUploadEvidence: null,
    queueEvidence
  };
  assert.doesNotThrow(() =>
    assertBeforeUploadReplacementEvidence(failed, evidence)
  );

  for (const patch of [
    { liveWorkerVersionId: workerVersionId },
    { liveDeploymentId: deploymentId },
    { liveRunnerActivationId: "runner-other" }
  ]) {
    assert.throws(
      () =>
        assertBeforeUploadReplacementEvidence(failed, {
          ...evidence,
          ...patch
        }),
      /live predecessor differs/
    );
  }
  for (const patch of [
    { uploadArtifactAbsent: false },
    { backupArtifactAbsent: false },
    { rollbackArtifactAbsent: false }
  ]) {
    assert.throws(
      () =>
        assertBeforeUploadReplacementEvidence(failed, {
          ...evidence,
          ...patch
        }),
      /upload, backup, or rollback artifact/
    );
  }
  assert.throws(
    () =>
      assertBeforeUploadReplacementEvidence(failed, {
        ...evidence,
        failedQueueTopologyFingerprint: "8".repeat(64)
      }),
    /Queue topology differs/
  );
  assert.throws(
    () =>
      assertBeforeUploadReplacementEvidence(failed, {
        ...evidence,
        queueEvidence: {
          ...queueEvidence,
          queues: queueEvidence.queues.slice(0, 1)
        }
      }),
    /Queue evidence is incomplete/
  );
  assert.throws(
    () =>
      assertBeforeUploadReplacementEvidence(failed, {
        ...evidence,
        queueEvidence: {
          ...queueEvidence,
          queues: queueEvidence.queues.map((queue, index) =>
            index === 0
              ? { ...queue, createdOn: "2026-08-14T22:00:00.000001Z" }
              : queue
          )
        }
      }),
    /does not predate/
  );

  let attestationCalls = 0;
  const attest = async (source) => {
    assert.equal(source.releaseId, failed.releaseId);
    attestationCalls += 1;
    return evidence;
  };
  assert.deepEqual(
    await previewBeforeUploadReplacement(failed, attest),
    assertBeforeUploadReplacementEvidence(failed, evidence)
  );
  assert.equal(attestationCalls, 1);
  const committed = await commitBeforeUploadReplacement(failed, {
    releaseId: "release-before-upload-2",
    targetGitSha: "f".repeat(40),
    at: "2026-08-15T22:00:03.000Z",
    attest
  });
  const replaced = committed.journal;
  assert.equal(attestationCalls, 2);
  assert.equal(replaced.state, RELEASE_JOURNAL_STATES.REPLACED);
  assert.equal(replaced.resumeFrom, RELEASE_JOURNAL_STATES.VERIFIED);
  assert.equal(replaced.failureCode, RELEASE_FAILURE_CODES.PREPARE_FAILED);
  assert.deepEqual(replaced.supersededBy, {
    releaseId: "release-before-upload-2",
    targetGitSha: "f".repeat(40),
    beforeUploadAttestation: {
      schemaVersion: 1,
      failedConfigSha256: evidence.failedConfigSha256,
      queueTopologyFingerprint: evidence.failedQueueTopologyFingerprint,
      predecessorDeploymentCreatedOn: evidence.liveDeploymentCreatedOn,
      queueEvidence
    }
  });
  assert.throws(
    () =>
      assertReleaseJournal({
        ...replaced,
        supersededBy: {
          releaseId: replaced.supersededBy.releaseId,
          targetGitSha: replaced.supersededBy.targetGitSha
        }
      }),
    /allowed replacement boundary/
  );
  assert.throws(
    () =>
      assertReleaseJournal({
        ...replaced,
        supersededBy: {
          ...replaced.supersededBy,
          beforeUploadAttestation: {
            ...replaced.supersededBy.beforeUploadAttestation,
            queueTopologyFingerprint: "7".repeat(64)
          }
        }
      }),
    /allowed replacement boundary/
  );
  assert.equal(
    await previewBeforeUploadReplacement(replaced, attest),
    null
  );
  const retry = await commitBeforeUploadReplacement(replaced, {
    releaseId: replaced.supersededBy.releaseId,
    targetGitSha: replaced.supersededBy.targetGitSha,
    at: "2026-08-15T22:00:04.000Z",
    attest
  });
  assert.deepEqual(retry.journal, replaced);
  assert.equal(retry.evidence, null);
  assert.equal(attestationCalls, 2);

  const targetFingerprints = fingerprints("before-upload");
  const replacement = createReleaseJournal({
    releaseId: replaced.supersededBy.releaseId,
    targetGitSha: replaced.supersededBy.targetGitSha,
    classification: conservativeClassification(targetFingerprints),
    targetFingerprints,
    predecessor: predecessorForReleaseReplacement(replaced),
    createdAt: "2026-08-15T22:00:04.000Z"
  });
  assert.doesNotThrow(() =>
    assertReleaseReplacement(replaced, replacement)
  );
  assert.throws(
    () =>
      assertReleaseReplacement(replaced, {
        ...replacement,
        lane: "assets-only",
        classification: assetsClassification(targetFingerprints)
      }),
    /does not exactly link/
  );
});

test("a prepared upload failure requires an exact remote-upload absence attestation", async () => {
  let prepared = transitionReleaseJournal(
    fullJournal(),
    RELEASE_JOURNAL_STATES.VERIFIED,
    { at: "2026-08-15T23:00:01.000Z" }
  );
  prepared = transitionReleaseJournal(
    prepared,
    RELEASE_JOURNAL_STATES.PREPARED,
    {
      at: "2026-08-15T23:00:02.000Z",
      receipts: preparedReceipts
    }
  );
  const failed = recordReleaseJournalFailure(prepared, {
    code: RELEASE_FAILURE_CODES.UPLOAD_FAILED,
    at: "2026-08-15T23:00:03.000Z"
  });
  const remoteUploadEvidence = {
    schemaVersion: 1,
    workerName: "surf-prod",
    releaseTag: failed.releaseId,
    remoteVersionCount: 32,
    remoteVersionInventorySha256: "6".repeat(64),
    taggedUploadAbsent: true
  };
  const evidence = {
    liveWorkerVersionId: predecessor().workerVersionId,
    liveDeploymentId: predecessor().deploymentId,
    liveDeploymentCreatedOn: "2026-08-14T22:00:00.000000Z",
    liveRunnerActivationId: predecessor().runnerActivationId,
    failedConfigSha256: preparedReceipts.wranglerConfigSha256,
    failedQueueTopologyFingerprint: failed.targetFingerprints.queueTopology,
    uploadArtifactAbsent: true,
    backupArtifactAbsent: true,
    rollbackArtifactAbsent: true,
    remoteUploadEvidence,
    queueEvidence: {
      expectedQueueNames: ["surf-ingest"],
      queues: [
        {
          name: "surf-ingest",
          createdOn: "2026-08-10T04:58:17.532408Z"
        }
      ]
    }
  };

  assert.doesNotThrow(() =>
    assertBeforeUploadReplacementEvidence(failed, evidence)
  );
  assert.throws(
    () =>
      assertBeforeUploadReplacementEvidence(failed, {
        ...evidence,
        failedConfigSha256: "7".repeat(64)
      }),
    /config differs from the prepared receipt/
  );
  assert.throws(
    () =>
      assertBeforeUploadReplacementEvidence(failed, {
        ...evidence,
        remoteUploadEvidence: null
      }),
    /Remote Worker-upload replacement attestation/
  );
  assert.throws(
    () =>
      assertBeforeUploadReplacementEvidence(failed, {
        ...evidence,
        remoteUploadEvidence: {
          ...remoteUploadEvidence,
          releaseTag: "another-release"
        }
      }),
    /does not name the failed release/
  );

  const committed = await commitBeforeUploadReplacement(failed, {
    releaseId: "release-after-upload-failure",
    targetGitSha: "f".repeat(40),
    at: "2026-08-15T23:00:04.000Z",
    attest: async () => evidence
  });
  assert.equal(committed.journal.state, RELEASE_JOURNAL_STATES.REPLACED);
  assert.equal(committed.journal.resumeFrom, RELEASE_JOURNAL_STATES.PREPARED);
  assert.equal(
    committed.journal.supersededBy.beforeUploadAttestation.schemaVersion,
    2
  );
  assert.deepEqual(
    committed.journal.supersededBy.beforeUploadAttestation.remoteUploadEvidence,
    remoteUploadEvidence
  );
  assert.throws(
    () =>
      assertReleaseJournal({
        ...committed.journal,
        supersededBy: {
          ...committed.journal.supersededBy,
          beforeUploadAttestation: {
            ...committed.journal.supersededBy.beforeUploadAttestation,
            remoteUploadEvidence: {
              ...remoteUploadEvidence,
              releaseTag: "another-release"
            }
          }
        }
      }),
    /allowed replacement boundary/
  );
});

test("remote upload absence inspects the complete paginated inventory", async () => {
  const releaseTag = "release-upload-failed";
  const version = {
    id: "11111111-1111-4111-8111-111111111111",
    number: 32,
    metadata: { created_on: "2026-08-16T05:00:00.123456Z" },
    annotations: { "workers/triggered_by": "upload" }
  };
  const payload = (items, resultInfo = {}) => ({
    success: true,
    result: { items },
    result_info: {
      page: 1,
      per_page: 100,
      count: items.length,
      total_count: items.length,
      ...resultInfo
    }
  });
  const responseFor = (value) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  let guardCalls = 0;
  const attestation = await attestNoTaggedWorkerUpload({
    accountId: "a".repeat(32),
    apiToken: "token".repeat(8),
    workerName: "surf-prod",
    releaseTag,
    guard: () => {
      guardCalls += 1;
    },
    fetcher: async (url, options) => {
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(options.method, "GET");
      return responseFor(payload([version]));
    }
  });
  assert.equal(guardCalls, 2);
  assert.deepEqual(
    {
      ...attestation,
      remoteVersionInventorySha256: "<sha256>"
    },
    {
      schemaVersion: 1,
      workerName: "surf-prod",
      releaseTag,
      remoteVersionCount: 1,
      remoteVersionInventorySha256: "<sha256>",
      taggedUploadAbsent: true
    }
  );
  assert.match(attestation.remoteVersionInventorySha256, /^[0-9a-f]{64}$/);

  const versions = Array.from({ length: 101 }, (_unused, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    number: index + 1,
    metadata: { created_on: "2026-08-16T05:00:00.123456Z" },
    annotations: { "workers/triggered_by": "upload" }
  }));
  let pageCalls = 0;
  const paginated = await attestNoTaggedWorkerUpload({
    accountId: "a".repeat(32),
    apiToken: "token".repeat(8),
    workerName: "surf-prod",
    releaseTag,
    fetcher: async (url) => {
      const page = Number(url.searchParams.get("page"));
      pageCalls += 1;
      return responseFor(
        payload(versions.slice((page - 1) * 100, page * 100), {
          page,
          total_count: versions.length
        })
      );
    }
  });
  assert.equal(pageCalls, 2);
  assert.equal(paginated.remoteVersionCount, versions.length);

  await assert.rejects(
    attestNoTaggedWorkerUpload({
      accountId: "a".repeat(32),
      apiToken: "token".repeat(8),
      workerName: "surf-prod",
      releaseTag,
      fetcher: async (url) => {
        const page = Number(url.searchParams.get("page"));
        return responseFor(
          payload(versions.slice((page - 1) * 100, page * 100), {
            page,
            total_count: page === 1 ? versions.length : versions.length + 1
          })
        );
      }
    }),
    /inventory changed while reading/
  );
  await assert.rejects(
    attestNoTaggedWorkerUpload({
      accountId: "a".repeat(32),
      apiToken: "token".repeat(8),
      workerName: "surf-prod",
      releaseTag,
      fetcher: async (url) => {
        const page = Number(url.searchParams.get("page"));
        const items = page === 1 ? versions.slice(0, 100) : [versions[99]];
        return responseFor(
          payload(items, { page, total_count: versions.length })
        );
      }
    }),
    /Worker-version identity is invalid/
  );

  await assert.rejects(
    attestNoTaggedWorkerUpload({
      accountId: "a".repeat(32),
      apiToken: "token".repeat(8),
      workerName: "surf-prod",
      releaseTag,
      fetcher: async () =>
        responseFor(
          payload([
            {
              ...version,
              annotations: { "workers/tag": releaseTag }
            }
          ])
        )
    }),
    /tagged remote Worker upload/
  );
  await assert.rejects(
    attestNoTaggedWorkerUpload({
      accountId: "a".repeat(32),
      apiToken: "token".repeat(8),
      workerName: "surf-prod",
      releaseTag,
      fetcher: async () =>
        responseFor(payload([version], { total_count: 2 }))
    }),
    /inventory is incomplete/
  );
});

test("before-upload artifact proof checks the exact upload, backup, and rollback paths", () => {
  const root = mkdtempSync(join(tmpdir(), "surf-before-upload-artifacts-"));
  const attemptDirectory = join(root, "attempt");
  const releaseId = "release-before-upload-failed";
  mkdirSync(attemptDirectory);
  try {
    const options = { attemptDirectory, serviceRoot: root, releaseId };
    assert.deepEqual(assertBeforeUploadReplacementArtifactsAbsent(options), {
      uploadArtifactAbsent: true,
      backupArtifactAbsent: true,
      rollbackArtifactAbsent: true
    });

    for (const artifact of ["worker-upload.json", "d1-backup.json"]) {
      const path = join(attemptDirectory, artifact);
      writeFileSync(path, "{}\n", { mode: 0o600 });
      assert.throws(
        () => assertBeforeUploadReplacementArtifactsAbsent(options),
        /must be absent before replacement/
      );
      rmSync(path);
    }

    const rollbackPath = join(root, "rollbacks", releaseId);
    mkdirSync(rollbackPath, { recursive: true });
    assert.throws(
      () => assertBeforeUploadReplacementArtifactsAbsent(options),
      /rollback artifact directory must be absent/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fix-forward appends an immutable supersession link to the failed journal", () => {
  const failed = recordReleaseJournalFailure(advanceAssetsRelease(), {
    code: RELEASE_FAILURE_CODES.LIVE_VERIFY_FAILED,
    at: "2026-08-15T22:00:06.000Z"
  });
  const replacementSha = "f".repeat(40);
  const superseded = supersedeReleaseJournal(failed, {
    releaseId: "release-fix-2",
    targetGitSha: replacementSha,
    at: "2026-08-15T22:00:07.000Z"
  });
  assert.equal(superseded.state, RELEASE_JOURNAL_STATES.SUPERSEDED);
  assert.deepEqual(superseded.supersededBy, {
    releaseId: "release-fix-2",
    targetGitSha: replacementSha
  });
  assert.equal(superseded.resumeFrom, failed.resumeFrom);
  assert.equal(superseded.failureCode, failed.failureCode);
  assert.equal(
    superseded.previousJournalSha256,
    fingerprintReleaseJournal(failed)
  );
  assert.throws(
    () =>
      resumeReleaseJournal(superseded, {
        at: "2026-08-15T22:00:08.000Z"
      }),
    /Only a failed release journal may resume/
  );

  const targetFingerprints = fingerprints("fix-forward");
  const replacement = createReleaseJournal({
    releaseId: superseded.supersededBy.releaseId,
    targetGitSha: superseded.supersededBy.targetGitSha,
    classification: assetsClassification(targetFingerprints),
    targetFingerprints,
    predecessor: {
      releaseId: superseded.releaseId,
      journalSha256: fingerprintReleaseJournal(superseded),
      workerVersionId: superseded.receipts.workerVersionId,
      deploymentId: superseded.receipts.deploymentId,
      runnerActivationId:
        superseded.receipts.runnerActivationId ??
        superseded.predecessor.runnerActivationId
    },
    createdAt: "2026-08-15T22:00:08.000Z"
  });
  assert.doesNotThrow(() =>
    assertReleaseSupersession(superseded, replacement)
  );
  assert.throws(
    () =>
      assertReleaseSupersession(superseded, {
        ...replacement,
        predecessor: {
          ...replacement.predecessor,
          journalSha256: fingerprintReleaseJournal(failed)
        }
      }),
    /does not exactly link/
  );
});

test("release receipts are immutable after they are recorded", () => {
  const active = advanceAssetsRelease();
  assert.throws(
    () =>
      transitionReleaseJournal(active, RELEASE_JOURNAL_STATES.VERIFIED_LIVE, {
        at: "2026-08-15T22:00:06.000Z",
        receipts: {
          workerVersionId: "33333333-3333-4333-8333-333333333333"
        }
      }),
    /immutable once recorded/
  );
  assert.throws(
    () =>
      transitionReleaseJournal(active, RELEASE_JOURNAL_STATES.VERIFIED_LIVE, {
        at: "2026-08-15T22:00:06.000Z",
        receipts: { deploymentId: null }
      }),
    /immutable once recorded/
  );
});

test("ambiguous activation fails closed until an exact reconciliation", () => {
  const staged = stageAssetsRelease();
  const ambiguous = recordReleaseJournalFailure(staged, {
    code: RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS,
    at: "2026-08-15T22:00:05.000Z"
  });
  assert.equal(ambiguous.state, RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD);
  assert.throws(
    () =>
      resumeReleaseJournal(ambiguous, {
        at: "2026-08-15T22:00:06.000Z"
      }),
    /must be reconciled/
  );
  assert.throws(
    () =>
      reconcileReleaseActivation(ambiguous, {
        targetIsActive: true,
        at: "2026-08-15T22:00:06.000Z"
      }),
    /deployment ID only when target is active/
  );

  const active = reconcileReleaseActivation(ambiguous, {
    targetIsActive: true,
    deploymentId,
    at: "2026-08-15T22:00:06.000Z"
  });
  assert.equal(active.state, RELEASE_JOURNAL_STATES.WORKER_ACTIVE);
  assert.equal(active.receipts.deploymentId, deploymentId);
  assert.equal(active.attempt, 2);

  const confirmedInactive = reconcileReleaseActivation(ambiguous, {
    targetIsActive: false,
    at: "2026-08-15T22:00:06.000Z"
  });
  assert.equal(
    confirmedInactive.state,
    RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED
  );
  assert.equal(confirmedInactive.receipts.deploymentId, null);
});

test("active and last-complete pointers encode different durability boundaries", () => {
  const activeJournal = advanceAssetsRelease();
  const activePointer = createReleasePointer(
    activeJournal,
    RELEASE_POINTER_KINDS.ACTIVE,
    { at: "2026-08-15T22:00:05.000Z" }
  );
  assert.equal(activePointer.workerVersionId, workerVersionId);
  assert.throws(
    () =>
      createReleasePointer(activeJournal, RELEASE_POINTER_KINDS.LAST_COMPLETE, {
        at: "2026-08-15T22:00:05.000Z"
      }),
    /requires a complete release/
  );

  const complete = completeAssetsRelease();
  const completeActive = createReleasePointer(
    complete,
    RELEASE_POINTER_KINDS.ACTIVE,
    { at: "2026-08-15T22:00:07.000Z" }
  );
  const trusted = resolveTrustedActiveReleaseReceipt({
    pointer: completeActive,
    journal: complete
  });
  assert.equal(trusted.releaseId, complete.releaseId);
  assert.deepEqual(trusted.fingerprints, complete.targetFingerprints);

  assert.throws(
    () =>
      resolveTrustedActiveReleaseReceipt({
        pointer: { ...completeActive, journalSha256: "0".repeat(64) },
        journal: complete
      }),
    /does not match/
  );
});

test("journal schemas reject extra secret-bearing fields and malformed pointers", () => {
  const journal = initialJournal();
  assert.throws(
    () => assertReleaseJournal({ ...journal, authorizationToken: "do-not-store" }),
    /must contain exactly/
  );
  const complete = completeAssetsRelease();
  const pointer = createReleasePointer(complete, RELEASE_POINTER_KINDS.ACTIVE, {
    at: "2026-08-15T22:00:07.000Z"
  });
  assert.throws(
    () => assertReleasePointer({ ...pointer, token: "do-not-store" }),
    /must contain exactly/
  );
});

test("the first journal may attest an exact external production predecessor", () => {
  const targetFingerprints = fingerprints("first-managed");
  const classification = classifyReleaseImpact({
    changedPaths: ["package.json"],
    targetFingerprints,
    activeReceipt: null
  });
  const journal = createReleaseJournal({
    releaseId: "first-managed-release",
    targetGitSha: "a".repeat(40),
    classification,
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: "11111111-1111-4111-8111-111111111111",
      deploymentId: "22222222-2222-4222-8222-222222222222",
      runnerActivationId: null
    },
    createdAt: "2026-08-15T00:00:00.000Z"
  });
  assert.equal(journal.predecessor.workerVersionId, "11111111-1111-4111-8111-111111111111");
});

test("the local state store writes private atomic journals and trusted pointers", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "surf-release-state-"));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const stateRoot = join(temporaryRoot, "state");
  const store = createReleaseStateStore({ rootDir: stateRoot });

  let current = initialJournal();
  store.writeJournal(current);
  const transitions = [
    [RELEASE_JOURNAL_STATES.VERIFIED, "2026-08-15T22:00:01.000Z", {}],
    [
      RELEASE_JOURNAL_STATES.PREPARED,
      "2026-08-15T22:00:02.000Z",
      preparedReceipts
    ],
    [
      RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
      "2026-08-15T22:00:03.000Z",
      { workerVersionId }
    ],
    [
      RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
      "2026-08-15T22:00:04.000Z",
      {}
    ],
    [
      RELEASE_JOURNAL_STATES.WORKER_ACTIVE,
      "2026-08-15T22:00:05.000Z",
      { deploymentId }
    ],
    [RELEASE_JOURNAL_STATES.VERIFIED_LIVE, "2026-08-15T22:00:06.000Z", {}],
    [RELEASE_JOURNAL_STATES.COMPLETE, "2026-08-15T22:00:07.000Z", {}]
  ];
  for (const [state, at, receipts] of transitions) {
    current = transitionReleaseJournal(current, state, { at, receipts });
    store.writeJournal(current);
  }

  const activePointer = createReleasePointer(
    current,
    RELEASE_POINTER_KINDS.ACTIVE,
    { at: "2026-08-15T22:00:07.000Z" }
  );
  const completePointer = createReleasePointer(
    current,
    RELEASE_POINTER_KINDS.LAST_COMPLETE,
    { at: "2026-08-15T22:00:07.000Z" }
  );
  store.writePointer(activePointer);
  store.writePointer(completePointer);

  assert.equal(store.readJournal(current.releaseId).state, "complete");
  assert.equal(store.readTrustedActiveReceipt().releaseId, current.releaseId);
  const revisionDirectory = join(
    stateRoot,
    "journals",
    `${current.releaseId}.revisions`
  );
  assert.equal(readdirSync(revisionDirectory).length, current.revision + 1);
  for (const path of [
    join(stateRoot, "journals", `${current.releaseId}.json`),
    join(stateRoot, "pointers", "active.json"),
    join(stateRoot, "pointers", "last-complete.json")
  ]) {
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(path, "utf8"), /token|password|authorization/i);
  }
  writeFileSync(join(revisionDirectory, "000000.json"), "{}\n", {
    mode: 0o600
  });
  assert.throws(
    () => store.readJournal(current.releaseId),
    /Release journal must contain exactly/
  );
});

test("the state store adopts only an exact orphaned initial journal revision", (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "surf-release-orphaned-initial-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const store = createReleaseStateStore({ rootDir: stateRoot });
  const initial = initialJournal();
  store.writeJournal(initial);
  rmSync(join(stateRoot, "journals", `${initial.releaseId}.json`));

  const retry = assertReleaseJournal({
    ...initial,
    createdAt: "2026-08-15T22:05:00.000Z",
    updatedAt: "2026-08-15T22:05:00.000Z"
  });
  const adopted = store.writeJournal(retry);
  assert.equal(adopted.createdAt, initial.createdAt);
  assert.equal(
    fingerprintReleaseJournal(store.readJournal(initial.releaseId)),
    fingerprintReleaseJournal(initial)
  );

  rmSync(join(stateRoot, "journals", `${initial.releaseId}.json`));
  const different = assertReleaseJournal({
    ...retry,
    targetGitSha: "e".repeat(40)
  });
  assert.throws(
    () => store.writeJournal(different),
    /Orphaned initial release journal differs/
  );
});

test("the state store adopts a linked immutable revision after a snapshot crash", (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "surf-release-orphaned-update-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const store = createReleaseStateStore({ rootDir: stateRoot });
  const initial = initialJournal();
  store.writeJournal(initial);
  const verified = transitionReleaseJournal(
    initial,
    RELEASE_JOURNAL_STATES.VERIFIED,
    { at: "2026-08-15T22:00:01.000Z" }
  );
  const revisionPath = join(
    stateRoot,
    "journals",
    `${initial.releaseId}.revisions`,
    "000001.json"
  );
  writeFileSync(revisionPath, `${JSON.stringify(verified)}\n`, { mode: 0o600 });

  const recovered = store.readJournal(initial.releaseId);
  assert.equal(recovered.state, RELEASE_JOURNAL_STATES.VERIFIED);
  assert.equal(recovered.revision, 1);
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        join(stateRoot, "journals", `${initial.releaseId}.json`),
        "utf8"
      )
    ),
    verified
  );
});

test("the state store scans more than 256 lifetime journals in bounded batches", (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "surf-release-batched-scan-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const store = createReleaseStateStore({ rootDir: stateRoot });

  for (let index = 0; index < 257; index += 1) {
    store.writeJournal(
      assertReleaseJournal({
        ...initialJournal(),
        releaseId: `historical-release-${String(index).padStart(3, "0")}`
      })
    );
  }

  const releaseIds = new Set();
  let largestBatch = 0;
  for (const batch of store.scanJournalBatches({ batchSize: 32 })) {
    largestBatch = Math.max(largestBatch, batch.length);
    for (const journal of batch) releaseIds.add(journal.releaseId);
  }
  assert.equal(releaseIds.size, 257);
  assert.equal(largestBatch, 32);
  assert.throws(
    () => [...store.scanJournalBatches({ batchSize: 257 })],
    /between 1 and 256/
  );
});

test("the state store rejects stale journal writers and symlink pointer targets", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "surf-release-state-"));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const stateRoot = join(temporaryRoot, "state");
  const store = createReleaseStateStore({ rootDir: stateRoot });
  const initial = initialJournal();
  store.writeJournal(initial);

  const first = transitionReleaseJournal(initial, RELEASE_JOURNAL_STATES.VERIFIED, {
    at: "2026-08-15T22:00:01.000Z"
  });
  const stale = transitionReleaseJournal(initial, RELEASE_JOURNAL_STATES.VERIFIED, {
    at: "2026-08-15T22:00:02.000Z"
  });
  store.writeJournal(first);
  assert.throws(() => store.writeJournal(stale), /stale or not linked/);

  const victim = join(temporaryRoot, "victim.json");
  atomicWriteReleaseJsonSync(victim, { safe: true });
  const pointerPath = join(stateRoot, "pointers", "active.json");
  symlinkSync(victim, pointerPath);
  assert.throws(
    () =>
      atomicWriteReleaseJsonSync(pointerPath, { safe: false }),
    /not a mode-0600 regular file/
  );
  assert.deepEqual(JSON.parse(readFileSync(victim, "utf8")), { safe: true });
});
