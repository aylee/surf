import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  RELEASE_FINGERPRINT_KEYS,
  classifyReleaseImpact,
  fingerprintCanonicalReleaseValue
} from "../lib/release-impact.mjs";
import { queueTopologyFingerprint } from "../lib/release-fingerprints.mjs";
import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  assertReleaseReplacement,
  assertRunnerFailureReplacementEvidence,
  assertRunnerFailureReplacementTargetFingerprints,
  createReleaseJournal,
  fingerprintReleaseJournal,
  recordReleaseJournalFailure,
  transitionReleaseJournal
} from "../lib/release-journal.mjs";
import {
  commitRunnerFailureReplacement,
  establishRunnerFailureReplacement
} from "../lib/release-runner-failure-replacement.mjs";
import { createRunnerFailureRecoveryAttestor } from "../lib/release-runner-failure-attestation.mjs";
import { attestD1BackupReceiptArtifact } from "../lib/release-storage.mjs";

const failedWorkerVersionId = "11111111-1111-4111-8111-111111111111";
const liveWorkerVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const liveDeploymentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const priorRunnerActivationId = "legacy-runner-r1";

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function privateJson(path, value) {
  const contents = `${JSON.stringify(value)}\n`;
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    contents,
    sha256: createHash("sha256").update(contents).digest("hex")
  };
}

function fingerprints(seed = "failed") {
  return Object.fromEntries(
    RELEASE_FINGERPRINT_KEYS.map((key) => [
      key,
      fingerprintCanonicalReleaseValue(`${seed}:${key}`)
    ])
  );
}

function failedRunnerJournal({
  d1ExportSha256 = "5".repeat(64),
  targetFingerprints = fingerprints(),
  wranglerConfigSha256 = "3".repeat(64)
} = {}) {
  const classification = classifyReleaseImpact({
    changedPaths: ["pnpm-lock.yaml"],
    targetFingerprints,
    activeReceipt: null
  });
  let current = createReleaseJournal({
    releaseId: "failed-runner-release",
    targetGitSha: "e".repeat(40),
    classification,
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: liveWorkerVersionId,
      deploymentId: liveDeploymentId,
      runnerActivationId: priorRunnerActivationId
    },
    createdAt: "2026-08-16T16:50:00.000Z"
  });
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.VERIFIED,
    { at: "2026-08-16T16:50:01.000Z" }
  );
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.PREPARED,
    {
      at: "2026-08-16T16:50:02.000Z",
      receipts: {
        profileSha256: "1".repeat(64),
        operatorEnvironmentFingerprint: "2".repeat(64),
        wranglerConfigSha256,
        workerSecretsFingerprint: "4".repeat(64)
      }
    }
  );
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
    {
      at: "2026-08-16T16:50:03.000Z",
      receipts: { workerVersionId: failedWorkerVersionId }
    }
  );
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.DATA_PREPARED,
    {
      at: "2026-08-16T16:50:04.000Z",
      receipts: {
        d1Bookmark: "bookmark-runner-failure-0001",
        d1ExportSha256
      }
    }
  );
  return recordReleaseJournalFailure(current, {
    code: RELEASE_FAILURE_CODES.RUNNER_FAILED,
    at: "2026-08-16T17:07:52.508Z"
  });
}

function replacementEvidence(failed) {
  return {
    failedJournalSha256: fingerprintReleaseJournal(failed),
    failedConfigSha256: failed.receipts.wranglerConfigSha256,
    workerUploadReceiptSha256: "6".repeat(64),
    d1BackupReceiptSha256: "7".repeat(64),
    d1ExportBytes: 344_839_723,
    d1ExportSha256: failed.receipts.d1ExportSha256,
    priorRunnerActivationId,
    priorRunnerRecordSha256: "a".repeat(64),
    priorRunnerReleaseSha: "d".repeat(40),
    liveWorkerVersionId,
    liveDeploymentId,
    predecessorDeploymentCreatedOn: "2026-08-15T20:00:00.000000Z",
    queueTopologyFingerprint: failed.targetFingerprints.queueTopology,
    queueEvidence: {
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
    },
    remoteUploadEvidence: {
      schemaVersion: 1,
      workerName: "surf-prod",
      releaseTag: failed.releaseId,
      releaseMessage: `surf release ${failed.releaseId}`,
      inactiveWorkerVersionId: failedWorkerVersionId,
      inactiveWorkerVersionNumber: 42,
      inactiveWorkerCreatedOn: "2026-08-16T16:50:03.100000Z",
      sourceRevision: failed.targetGitSha,
      workerRuntimeDigest: failed.targetFingerprints.workerRuntime,
      clientBuildDigest: failed.targetFingerprints.workerAssets,
      runtimeCpuMs: 30_000,
      remoteVersionCount: 42,
      remoteVersionInventorySha256: "d".repeat(64),
      inactiveWorkerVersionDetailSha256: "e".repeat(64),
      predecessorWorkerVersionDetailSha256: "f".repeat(64)
    }
  };
}

function productionAttestorFixture(t, { failInactiveUpload = false } = {}) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "surf-runner-production-attestor-"))
  );
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDirectory = privateDirectory(join(root, "state"));
  const attempts = privateDirectory(join(stateDirectory, "attempts"));
  const serviceRoot = privateDirectory(join(root, "service"));
  const rollbacks = privateDirectory(join(serviceRoot, "rollbacks"));
  const releasesDirectory = privateDirectory(join(serviceRoot, "releases"));
  const launchAgents = privateDirectory(join(serviceRoot, "launch-agents"));
  const releaseSha = "d".repeat(40);
  const config = {
    name: "surf-prod",
    queues: {
      producers: [{ binding: "INGEST_QUEUE", queue: "surf-ingest" }]
    }
  };
  const targetFingerprints = {
    ...fingerprints(),
    queueTopology: queueTopologyFingerprint(config)
  };
  const exportContents = "select 1;\n";
  const exportSha256 = createHash("sha256")
    .update(exportContents)
    .digest("hex");
  const attemptDirectory = privateDirectory(
    join(attempts, "failed-runner-release")
  );
  const configArtifact = privateJson(
    join(attemptDirectory, "wrangler.jsonc"),
    config
  );
  const failed = failedRunnerJournal({
    d1ExportSha256: exportSha256,
    targetFingerprints,
    wranglerConfigSha256: configArtifact.sha256
  });
  const uploadArtifact = privateJson(
    join(attemptDirectory, "worker-upload.json"),
    { schemaVersion: 1, workerVersionId: failedWorkerVersionId }
  );
  const rollbackDirectory = privateDirectory(join(rollbacks, failed.releaseId));
  const exportPath = resolve(rollbackDirectory, "surf-before.sql");
  writeFileSync(exportPath, exportContents, { mode: 0o600 });
  chmodSync(exportPath, 0o600);
  const backupArtifact = privateJson(
    join(attemptDirectory, "d1-backup.json"),
    {
      schemaVersion: 1,
      databaseName: "DB",
      bookmark: failed.receipts.d1Bookmark,
      exportPath,
      exportBytes: Buffer.byteLength(exportContents),
      exportSha256
    }
  );
  privateDirectory(join(releasesDirectory, failed.targetGitSha));
  const activationDirectory = privateDirectory(
    join(launchAgents, priorRunnerActivationId)
  );
  const priorRecordPath = resolve(activationDirectory, "activation-record.json");
  privateJson(priorRecordPath, { schemaVersion: 3, releaseSha });

  const liveStatus = JSON.stringify({
    id: liveDeploymentId,
    strategy: "percentage",
    created_on: "2026-08-15T20:00:00.000000Z",
    versions: [{ version_id: liveWorkerVersionId, percentage: 100 }]
  });
  const events = [];
  const remoteUploadEvidence = replacementEvidence(failed).remoteUploadEvidence;
  let currentJournal = failed;
  const store = {
    readJournal(releaseId) {
      return releaseId === failed.releaseId ? currentJournal : null;
    }
  };
  const attestor = createRunnerFailureRecoveryAttestor(
    {
      profile: { stateDirectory, serviceRoot, releasesDirectory },
      environment: {
        CLOUDFLARE_ACCOUNT_ID: "account-fixture",
        CLOUDFLARE_API_TOKEN: "token-fixture"
      },
      store
    },
    {
      validateImmutableRelease() {},
      createCloudflareCommandContext() {
        return {
          readConfig: () => structuredClone(config),
          runWrangler: () => liveStatus,
          async attestPreexistingQueues() {
            events.push("queue");
            return {
              queues: [
                {
                  name: "surf-ingest",
                  createdOn: "2026-08-10T04:58:17.532408Z"
                }
              ]
            };
          }
        };
      },
      async attestD1BackupReceiptArtifact(receipt) {
        events.push("d1");
        return attestD1BackupReceiptArtifact(receipt);
      },
      async attestTaggedInactiveWorkerUpload(options) {
        events.push("inactive");
        assert.equal(options.releaseTag, failed.releaseId);
        assert.equal(options.activeWorkerVersionId, liveWorkerVersionId);
        options.guard();
        if (failInactiveUpload) {
          throw new Error("injected inactive upload attestation failure");
        }
        return remoteUploadEvidence;
      },
      async discoverRunnerActivationFromInstalledPlist() {
        return {
          activationId: priorRunnerActivationId,
          recordPath: priorRecordPath,
          recordSchemaVersion: 3,
          transitionOnly: true
        };
      },
      async verifyLaunchActivation() {
        return { status: "ok", schemaVersion: 3, transitionOnly: true };
      },
      async activateLaunchAgents(options) {
        events.push("restore");
        assert.deepEqual(options, {
          recordPath: priorRecordPath,
          priorRecordPath,
          environment: {
            CLOUDFLARE_ACCOUNT_ID: "account-fixture",
            CLOUDFLARE_API_TOKEN: "token-fixture"
          },
          transitionMode: "rollback"
        });
        return {
          status: "ok",
          releaseSha,
          activationId: null,
          changed: false,
          drainReceipt: null
        };
      }
    }
  );
  return {
    attestor,
    backupArtifact,
    configArtifact,
    events,
    failed,
    setCurrentJournal: (journal) => {
      currentJournal = journal;
    },
    uploadArtifact
  };
}

test("runner failure replacement terminally links before creating its successor", async () => {
  const failed = failedRunnerJournal();
  const evidence = replacementEvidence(failed);
  let calls = 0;
  const attest = async (source) => {
    assert.equal(source.releaseId, failed.releaseId);
    calls += 1;
    return evidence;
  };
  const targetFingerprints = {
    ...failed.targetFingerprints,
    runnerArtifact: fingerprintCanonicalReleaseValue("fixed-runner"),
    releaseTooling: fingerprintCanonicalReleaseValue("fixed-release-tool")
  };
  const result = await establishRunnerFailureReplacement(failed, {
    releaseId: "replacement-runner-release",
    targetGitSha: "f".repeat(40),
    at: "2026-08-16T17:10:00.000Z",
    attest,
    persistReplaced: (journal) => journal,
    createSuccessor: ({ predecessor }) =>
      createReleaseJournal({
        releaseId: "replacement-runner-release",
        targetGitSha: "f".repeat(40),
        classification: classifyReleaseImpact({
          changedPaths: ["scripts/release-prod.mjs"],
          targetFingerprints,
          activeReceipt: null
        }),
        targetFingerprints,
        predecessor,
        createdAt: "2026-08-16T17:10:01.000Z"
      }),
    persistSuccessor: (journal) => journal
  });
  assert.equal(calls, 1);
  assert.equal(result.replaced.state, RELEASE_JOURNAL_STATES.REPLACED);
  assert.equal(
    result.replaced.supersededBy.runnerFailureAttestation.failedJournalSha256,
    fingerprintReleaseJournal(failed)
  );
  assert.doesNotThrow(() =>
    assertReleaseReplacement(result.replaced, result.successor)
  );
  assert.throws(
    () =>
      assertReleaseReplacement(result.replaced, {
        ...result.successor,
        targetFingerprints: {
          ...result.successor.targetFingerprints,
          narrativeContract: fingerprintCanonicalReleaseValue("drift")
        }
      }),
    /changes forbidden fingerprints/
  );
});

test("a linked retry creates the successor without repeating attestation", async () => {
  const failed = failedRunnerJournal();
  let replaced = null;
  const common = {
    releaseId: "replacement-runner-retry",
    targetGitSha: "f".repeat(40),
    at: "2026-08-16T17:10:00.000Z",
    attest: async () => replacementEvidence(failed),
    persistReplaced: (journal) => {
      replaced = journal;
      return journal;
    },
    createSuccessor: () => {
      throw new Error("injected interruption after terminal link");
    },
    persistSuccessor: (journal) => journal
  };
  await assert.rejects(
    establishRunnerFailureReplacement(failed, common),
    /injected interruption/
  );
  assert.equal(replaced.state, RELEASE_JOURNAL_STATES.REPLACED);
  let attestCalled = false;
  const targetFingerprints = {
    ...failed.targetFingerprints,
    runnerArtifact: fingerprintCanonicalReleaseValue("fixed-runner"),
    releaseTooling: fingerprintCanonicalReleaseValue("fixed-release-tool")
  };
  const retried = await establishRunnerFailureReplacement(replaced, {
    ...common,
    attest: async () => {
      attestCalled = true;
      throw new Error("linked retry must not attest");
    },
    createSuccessor: ({ predecessor }) =>
      createReleaseJournal({
        releaseId: common.releaseId,
        targetGitSha: common.targetGitSha,
        classification: classifyReleaseImpact({
          changedPaths: ["scripts/release-prod.mjs"],
          targetFingerprints,
          activeReceipt: null
        }),
        targetFingerprints,
        predecessor,
        createdAt: "2026-08-16T17:10:01.000Z"
      })
  });
  assert.equal(attestCalled, false);
  assertReleaseReplacement(retried.replaced, retried.successor);
});

test("production recovery attests read-only evidence before restoring and survives a linked retry", async (t) => {
  const fixture = productionAttestorFixture(t);
  let linked = null;
  await assert.rejects(
    establishRunnerFailureReplacement(fixture.failed, {
      releaseId: "replacement-production-runner",
      targetGitSha: "f".repeat(40),
      at: "2026-08-16T17:10:00.000Z",
      attest: fixture.attestor,
      persistReplaced: (journal) => {
        linked = journal;
        fixture.setCurrentJournal(journal);
        return journal;
      },
      createSuccessor: () => {
        throw new Error("injected interruption after production terminal link");
      },
      persistSuccessor: (journal) => journal
    }),
    /injected interruption after production terminal link/
  );
  assert.deepEqual(fixture.events, [
    "d1",
    "queue",
    "inactive",
    "restore",
    "d1",
    "restore"
  ]);
  assert.equal(linked.state, RELEASE_JOURNAL_STATES.REPLACED);
  assert.equal(
    linked.supersededBy.runnerFailureAttestation.failedConfigSha256,
    fixture.configArtifact.sha256
  );
  assert.equal(
    linked.supersededBy.runnerFailureAttestation.workerUploadReceiptSha256,
    fixture.uploadArtifact.sha256
  );
  assert.equal(
    linked.supersededBy.runnerFailureAttestation.d1BackupReceiptSha256,
    fixture.backupArtifact.sha256
  );

  let attestCalled = false;
  const targetFingerprints = {
    ...fixture.failed.targetFingerprints,
    releaseTooling: fingerprintCanonicalReleaseValue("production-fix")
  };
  const retried = await establishRunnerFailureReplacement(linked, {
    releaseId: linked.supersededBy.releaseId,
    targetGitSha: linked.supersededBy.targetGitSha,
    at: "2026-08-16T17:10:01.000Z",
    attest: async () => {
      attestCalled = true;
      throw new Error("linked retry must not repeat production recovery");
    },
    persistReplaced: (journal) => journal,
    createSuccessor: ({ predecessor }) =>
      createReleaseJournal({
        releaseId: linked.supersededBy.releaseId,
        targetGitSha: linked.supersededBy.targetGitSha,
        classification: classifyReleaseImpact({
          changedPaths: ["scripts/release-prod.mjs"],
          targetFingerprints,
          activeReceipt: null
        }),
        targetFingerprints,
        predecessor,
        createdAt: "2026-08-16T17:10:02.000Z"
      }),
    persistSuccessor: (journal) => journal
  });
  assert.equal(attestCalled, false);
  assertReleaseReplacement(retried.replaced, retried.successor);
});

test("a read-only proof failure occurs before any runner restoration", async (t) => {
  const fixture = productionAttestorFixture(t, {
    failInactiveUpload: true
  });
  await assert.rejects(
    fixture.attestor(fixture.failed),
    /injected inactive upload attestation failure/
  );
  assert.deepEqual(fixture.events, ["d1", "queue", "inactive"]);
});

test("D1 export drift aborts the second attestation before a terminal link", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "surf-runner-recovery-d1-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exportPath = join(root, "surf-before.sql");
  writeFileSync(exportPath, "select 1;\n", { mode: 0o600 });
  chmodSync(exportPath, 0o600);
  const first = await attestD1BackupReceiptArtifact({
    schemaVersion: 1,
    databaseName: "DB",
    bookmark: "bookmark-runner-recovery-0001",
    exportPath,
    exportBytes: 10,
    exportSha256:
      "4a45092ccf992ea92250053a80b931b787924ba61648f420555511b84f10ab6c"
  });
  assert.equal(first.exportBytes, 10);
  writeFileSync(exportPath, "select 2;\n", { mode: 0o600 });
  const failed = failedRunnerJournal();
  await assert.rejects(
    commitRunnerFailureReplacement(failed, {
      releaseId: "replacement-after-d1-drift",
      targetGitSha: "f".repeat(40),
      at: "2026-08-16T17:10:00.000Z",
      attest: async () => {
        await attestD1BackupReceiptArtifact({
          schemaVersion: 1,
          databaseName: "DB",
          bookmark: "bookmark-runner-recovery-0001",
          exportPath,
          exportBytes: first.exportBytes,
          exportSha256: first.exportSha256
        });
        return replacementEvidence(failed);
      }
    }),
    /no longer matches its exact evidence/
  );
  assert.equal(failed.state, RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE);
  assert.equal(failed.supersededBy, null);
});

test("runner failure replacement rejects artifact and restored-runner drift", () => {
  const failed = failedRunnerJournal();
  const evidence = replacementEvidence(failed);
  for (const patch of [
    { d1ExportSha256: "0".repeat(64) },
    { liveDeploymentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    { priorRunnerActivationId: "other-runner" },
    { priorRunnerRecordSha256: "0".repeat(63) },
    { priorRunnerReleaseSha: "0".repeat(39) }
  ]) {
    assert.throws(() =>
      assertRunnerFailureReplacementEvidence(failed, {
        ...evidence,
        ...patch
      })
    );
  }
});

test("runner failure replacement requires a release-tool or runner fix", () => {
  const failed = failedRunnerJournal();
  assert.throws(
    () =>
      assertRunnerFailureReplacementTargetFingerprints(
        failed,
        failed.targetFingerprints
      ),
    /must change runnerArtifact or releaseTooling/
  );
  assert.doesNotThrow(() =>
    assertRunnerFailureReplacementTargetFingerprints(failed, {
      ...failed.targetFingerprints,
      releaseTooling: fingerprintCanonicalReleaseValue("fixed-release-tool")
    })
  );
});
