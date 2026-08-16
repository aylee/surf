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
  predecessorForReleaseReplacement,
  recordReleaseJournalFailure,
  replaceRunnerFailureReleaseJournal,
  transitionReleaseJournal
} from "../lib/release-journal.mjs";
import {
  commitRunnerFailureReplacement,
  establishRunnerFailureReplacement
} from "../lib/release-runner-failure-replacement.mjs";
import { createRunnerFailureRecoveryAttestor } from "../lib/release-runner-failure-attestation.mjs";
import {
  committedRunnerLineagePlan,
  committedRunnerResumeLineagePlan,
  runnerFailureRecoveryMode
} from "../lib/release-runner-failure-lineage.mjs";
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
  predecessor = {
    releaseId: null,
    journalSha256: null,
    workerVersionId: liveWorkerVersionId,
    deploymentId: liveDeploymentId,
    runnerActivationId: priorRunnerActivationId
  },
  releaseId = "failed-runner-release",
  targetGitSha = "e".repeat(40),
  targetFingerprints = fingerprints(),
  wranglerConfigSha256 = "3".repeat(64)
} = {}) {
  const classification = classifyReleaseImpact({
    changedPaths: ["pnpm-lock.yaml"],
    targetFingerprints,
    activeReceipt: null
  });
  let current = createReleaseJournal({
    releaseId,
    targetGitSha,
    classification,
    targetFingerprints,
    predecessor,
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

function committedReplacementEvidence(failed) {
  return {
    ...replacementEvidence(failed),
    committedRunnerActivationId: failed.releaseId,
    committedRunnerArtifactSha256: "8".repeat(64),
    committedRunnerProtocolFingerprint:
      failed.targetFingerprints.narrativeContract,
    committedRunnerRecordSha256: "b".repeat(64),
    liveWorkerSourceRevision: "d".repeat(40),
    runnerTransitionSha256: "c".repeat(64)
  };
}

function committedDrainEvidence({
  targetActivationId = "failed-runner-release",
  targetReleaseSha = "e".repeat(40),
  priorActivationId = null,
  priorReleaseSha = "d".repeat(40),
  targetRecordSha256 = "b".repeat(64),
  priorRecordSha256 = "a".repeat(64),
  semanticReceiptSha256 = "c".repeat(64)
} = {}) {
  return {
    schemaVersion: 1,
    targetActivationId,
    targetReleaseSha,
    priorActivationId,
    priorReleaseSha,
    targetRecordSha256,
    priorRecordSha256,
    semanticReceiptSha256
  };
}

function productionAttestorFixture(
  t,
  { committedRunner = false, failInactiveUpload = false } = {}
) {
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
      producers: [
        { binding: "INGEST_QUEUE", queue: "surf-ingest" },
        ...(committedRunner
          ? [{ binding: "NARRATIVE_QUEUE", queue: "surf-narrative" }]
          : [])
      ]
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
  const failedReleaseRoot = privateDirectory(
    join(releasesDirectory, failed.targetGitSha)
  );
  const activationDirectory = privateDirectory(
    join(launchAgents, priorRunnerActivationId)
  );
  const priorRecordPath = resolve(activationDirectory, "activation-record.json");
  const priorRecordArtifact = privateJson(priorRecordPath, {
    schemaVersion: 3,
    releaseSha
  });
  let committedArtifactSha256 = null;
  const committedProtocolFingerprint =
    failed.targetFingerprints.narrativeContract;
  let committedRecordSha256 = null;
  const transitionSha256 = "c".repeat(64);
  let committedRecordPath = null;
  if (committedRunner) {
    const dist = privateDirectory(
      join(failedReleaseRoot, "apps/narrative-runner/dist")
    );
    committedArtifactSha256 = privateJson(
      join(dist, "narrative-runner.mjs"),
      { fixture: "runner" }
    ).sha256;
    privateJson(join(dist, "narrative-runner.manifest.json"), {
      schemaVersion: 1,
      artifact: { sha256: committedArtifactSha256 },
      acceptedProtocols: [
        {
          family: "surf.narrative",
          fingerprint: committedProtocolFingerprint
        }
      ]
    });
    const committedDirectory = privateDirectory(
      join(launchAgents, failed.releaseId)
    );
    committedRecordPath = resolve(
      committedDirectory,
      "activation-record.json"
    );
    committedRecordSha256 = privateJson(committedRecordPath, {
      schemaVersion: 4
    }).sha256;
    privateJson(join(attemptDirectory, "runner-drain.json"), {
      schemaVersion: 2,
      outcome: "stopped"
    });
  }

  const liveStatus = JSON.stringify({
    id: liveDeploymentId,
    strategy: "percentage",
    created_on: "2026-08-15T20:00:00.000000Z",
    versions: [{ version_id: liveWorkerVersionId, percentage: 100 }]
  });
  const events = [];
  const remoteUploadEvidence = replacementEvidence(failed).remoteUploadEvidence;
  let currentJournal = failed;
  const linkedJournals = new Map();
  const store = {
    readJournal(releaseId) {
      return releaseId === failed.releaseId
        ? currentJournal
        : linkedJournals.get(releaseId) ?? null;
    }
  };
  const attestor = createRunnerFailureRecoveryAttestor(
    {
      profile: {
        stateDirectory,
        serviceRoot,
        releasesDirectory,
        customOrigin: "https://surf.example"
      },
      environment: {
        CLOUDFLARE_ACCOUNT_ID: "account-fixture",
        CLOUDFLARE_API_TOKEN: "token-fixture"
      },
      store,
      ...(committedRunner
        ? {
            workerSecrets: {
              geminiToken: "g".repeat(32),
              resultToken: "r".repeat(32),
              assertUnchanged() {}
            }
          }
        : {})
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
                },
                ...(committedRunner
                  ? [
                      {
                        name: "surf-narrative",
                        createdOn: "2026-08-10T15:18:13.808657Z"
                      },
                      {
                        name: "surf-prod-narrative-dlq",
                        createdOn: "2026-08-10T16:18:13.808657Z"
                      }
                    ]
                  : [])
              ]
            };
          },
          async inspectQueueIdentities() {
            return {
              accountId: "account-fixture",
              queues: { "surf-narrative": "queue-id-fixture" }
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
        if (committedRunner) {
          return {
            activationId: failed.releaseId,
            recordPath: committedRecordPath,
            recordSchemaVersion: 4,
            transitionOnly: false
          };
        }
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
      },
      async verifyActiveRunnerCompatibility(options) {
        events.push("healthy");
        assert.equal(options.activationId, failed.releaseId);
        assert.equal(options.expectedQueueId, "queue-id-fixture");
        return {
          schemaVersion: 1,
          activationId: failed.releaseId,
          runnerArtifactSha256: committedArtifactSha256,
          sourceRevision: failed.targetGitSha,
          acceptedProtocolFingerprints: [committedProtocolFingerprint],
          runtimeFingerprint: "1".repeat(64),
          resultTargetId: "target",
          bindingHmacs: {}
        };
      },
      async verifyCommittedRunnerDrainEvidence(options) {
        events.push("committed");
        assert.equal(options.targetRecordPath, committedRecordPath);
        assert.equal(options.priorRecordPath, priorRecordPath);
        assert.equal(
          options.attemptDrainReceiptPath,
          join(attemptDirectory, "runner-drain.json")
        );
        return {
          schemaVersion: 1,
          targetActivationId: failed.releaseId,
          targetReleaseSha: failed.targetGitSha,
          priorActivationId: null,
          priorReleaseSha: releaseSha,
          targetRecordSha256: committedRecordSha256,
          priorRecordSha256: priorRecordArtifact.sha256,
          semanticReceiptSha256: transitionSha256
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
    setLinkedJournal: (journal) => {
      linkedJournals.set(journal.releaseId, journal);
    },
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

test("runner failure preflight preserves exact legacy v3 recovery dispatch", () => {
  const failed = failedRunnerJournal();
  const legacy = {
    activationId: failed.predecessor.runnerActivationId,
    recordPath: "/fixture/legacy/activation-record.json",
    recordSchemaVersion: 3,
    transitionOnly: true,
    legacyCoupledSourceRevision: "d".repeat(40)
  };
  assert.equal(runnerFailureRecoveryMode(failed, legacy), "legacy");
  assert.equal(
    runnerFailureRecoveryMode(failed, {
      activationId: failed.releaseId,
      recordPath: "/fixture/committed/activation-record.json",
      recordSchemaVersion: 4,
      transitionOnly: false,
      legacyCoupledSourceRevision: null
    }),
    "committed"
  );
  for (const installed of [
    { ...legacy, activationId: "foreign-legacy" },
    { ...legacy, legacyCoupledSourceRevision: null },
    { ...legacy, recordSchemaVersion: 4, transitionOnly: false }
  ]) {
    assert.throws(
      () => runnerFailureRecoveryMode(failed, installed),
      /exact failed v4 target or legacy v3 predecessor/
    );
  }
});

test("committed target v4 evidence becomes the successor runner predecessor", async () => {
  const failed = failedRunnerJournal();
  const targetFingerprints = {
    ...failed.targetFingerprints,
    releaseTooling: fingerprintCanonicalReleaseValue("committed-runner-fix")
  };
  const result = await establishRunnerFailureReplacement(failed, {
    releaseId: "replacement-after-committed-runner",
    targetGitSha: "f".repeat(40),
    at: "2026-08-16T17:11:00.000Z",
    attest: async () => committedReplacementEvidence(failed),
    persistReplaced: (journal) => journal,
    createSuccessor: ({ predecessor }) =>
      createReleaseJournal({
        releaseId: "replacement-after-committed-runner",
        targetGitSha: "f".repeat(40),
        classification: classifyReleaseImpact({
          changedPaths: ["scripts/release-prod.mjs"],
          targetFingerprints,
          activeReceipt: null
        }),
        targetFingerprints,
        predecessor,
        createdAt: "2026-08-16T17:11:01.000Z"
      }),
    persistSuccessor: (journal) => journal
  });
  const attestation =
    result.replaced.supersededBy.runnerFailureAttestation;
  assert.equal(attestation.schemaVersion, 2);
  assert.equal(attestation.committedRunnerActivationId, failed.releaseId);
  assert.equal(
    result.successor.predecessor.runnerActivationId,
    failed.releaseId
  );
  assertReleaseReplacement(result.replaced, result.successor);

  const direct = committedRunnerLineagePlan(failed, {
    readJournal: () => null,
    drainEvidence: committedDrainEvidence()
  });
  assert.equal(direct.liveSourceRevision, "d".repeat(40));

  const priorFailure = failedRunnerJournal({
    releaseId: "prior-runner-failure",
    targetGitSha: "c".repeat(40)
  });
  const priorReplaced = replaceRunnerFailureReleaseJournal(priorFailure, {
    releaseId: failed.releaseId,
    targetGitSha: failed.targetGitSha,
    evidence: replacementEvidence(priorFailure),
    at: "2026-08-16T17:10:30.000Z"
  });
  const actualIncidentShape = failedRunnerJournal({
    predecessor: predecessorForReleaseReplacement(priorReplaced),
    targetFingerprints: {
      ...priorFailure.targetFingerprints,
      releaseTooling: fingerprintCanonicalReleaseValue(
        "previous-replacement-target"
      )
    }
  });
  const chained = committedRunnerLineagePlan(actualIncidentShape, {
    readJournal: (releaseId) =>
      releaseId === priorReplaced.releaseId ? priorReplaced : null,
    drainEvidence: committedDrainEvidence()
  });
  assert.equal(chained.liveSourceRevision, "d".repeat(40));
  for (const drift of [
    { priorReleaseSha: "9".repeat(40) },
    { priorRecordSha256: "0".repeat(64) }
  ]) {
    assert.throws(
      () =>
        committedRunnerLineagePlan(actualIncidentShape, {
          readJournal: (releaseId) =>
            releaseId === priorReplaced.releaseId ? priorReplaced : null,
          drainEvidence: committedDrainEvidence(drift)
        }),
      /differs from the failed target/
    );
  }

  const createChainedSuccessor = (
    liveWorkerSourceRevision,
    evidenceOverrides = {}
  ) => {
    const replacementReleaseId = `replacement-${liveWorkerSourceRevision[0]}`;
    const replaced = replaceRunnerFailureReleaseJournal(actualIncidentShape, {
      releaseId: replacementReleaseId,
      targetGitSha: "f".repeat(40),
      evidence: {
        ...committedReplacementEvidence(actualIncidentShape),
        liveWorkerSourceRevision,
        ...evidenceOverrides
      },
      at: "2026-08-16T17:10:45.000Z"
    });
    const successor = createReleaseJournal({
      releaseId: replacementReleaseId,
      targetGitSha: "f".repeat(40),
      classification: classifyReleaseImpact({
        changedPaths: ["scripts/release-prod.mjs"],
        targetFingerprints,
        activeReceipt: null
      }),
      targetFingerprints,
      predecessor: predecessorForReleaseReplacement(replaced),
      createdAt: "2026-08-16T17:10:46.000Z"
    });
    return { replaced, successor };
  };
  const chainedCommitted = createChainedSuccessor("d".repeat(40));
  const readChainedJournal = (releaseId) =>
    releaseId === chainedCommitted.replaced.releaseId
      ? chainedCommitted.replaced
      : releaseId === priorReplaced.releaseId
        ? priorReplaced
        : null;
  const chainedResume = committedRunnerResumeLineagePlan(
    chainedCommitted.successor,
    {
      readJournal: readChainedJournal,
      installedRunnerActivationId: actualIncidentShape.releaseId,
      installedRunnerRecordSha256: "b".repeat(64)
    }
  );
  assert.equal(chainedResume.liveSourceRevision, "d".repeat(40));

  const tamperedChain = createChainedSuccessor("9".repeat(40));
  assert.throws(
    () =>
      committedRunnerResumeLineagePlan(tamperedChain.successor, {
        readJournal: (releaseId) =>
          releaseId === tamperedChain.replaced.releaseId
            ? tamperedChain.replaced
            : releaseId === priorReplaced.releaseId
              ? priorReplaced
              : null,
        installedRunnerActivationId: actualIncidentShape.releaseId,
        installedRunnerRecordSha256: "b".repeat(64)
      }),
    /changed its hash-linked live Worker lineage/
  );
  for (const evidenceOverrides of [
    { priorRunnerReleaseSha: "9".repeat(40) },
    { priorRunnerRecordSha256: "0".repeat(64) }
  ]) {
    const tamperedPriorChain = createChainedSuccessor(
      "d".repeat(40),
      evidenceOverrides
    );
    assert.throws(
      () =>
        committedRunnerResumeLineagePlan(tamperedPriorChain.successor, {
          readJournal: (releaseId) =>
            releaseId === tamperedPriorChain.replaced.releaseId
              ? tamperedPriorChain.replaced
              : releaseId === priorReplaced.releaseId
                ? priorReplaced
                : null,
          installedRunnerActivationId: actualIncidentShape.releaseId,
          installedRunnerRecordSha256: "b".repeat(64)
        }),
      /changed its hash-linked live Worker lineage/
    );
  }

  const linked = committedRunnerLineagePlan(result.successor, {
    readJournal: (releaseId) =>
      releaseId === result.replaced.releaseId ? result.replaced : null,
    drainEvidence: committedDrainEvidence()
  });
  assert.equal(linked.liveSourceRevision, "d".repeat(40));
  assert.equal(linked.runnerActivationId, failed.releaseId);

  const successorCommitted = committedRunnerLineagePlan(result.successor, {
    readJournal: (releaseId) =>
      releaseId === result.replaced.releaseId ? result.replaced : null,
    drainEvidence: committedDrainEvidence({
      targetActivationId: result.successor.releaseId,
      targetReleaseSha: result.successor.targetGitSha,
      priorActivationId: failed.releaseId,
      priorReleaseSha: failed.targetGitSha,
      targetRecordSha256: "1".repeat(64),
      priorRecordSha256: "b".repeat(64),
      semanticReceiptSha256: "2".repeat(64)
    })
  });
  assert.equal(successorCommitted.liveSourceRevision, "d".repeat(40));
  assert.equal(
    successorCommitted.runnerActivationId,
    result.successor.releaseId
  );
  assert.throws(
    () =>
      committedRunnerLineagePlan(result.successor, {
        readJournal: (releaseId) =>
          releaseId === result.replaced.releaseId ? result.replaced : null,
        drainEvidence: committedDrainEvidence({
          targetActivationId: result.successor.releaseId,
          targetReleaseSha: result.successor.targetGitSha,
          priorActivationId: failed.releaseId,
          priorReleaseSha: failed.targetGitSha,
          targetRecordSha256: "1".repeat(64),
          priorRecordSha256: "0".repeat(64),
          semanticReceiptSha256: "2".repeat(64)
        })
      }),
    /differs from the linked recovery lineage/
  );

  const interruptedSuccessor = failedRunnerJournal({
    releaseId: result.successor.releaseId,
    targetGitSha: result.successor.targetGitSha,
    targetFingerprints,
    predecessor: result.successor.predecessor
  });
  const readJournal = (releaseId) =>
    releaseId === result.replaced.releaseId ? result.replaced : null;
  const sourceOnly = committedRunnerResumeLineagePlan(
    interruptedSuccessor,
    {
      readJournal,
      installedRunnerActivationId: failed.releaseId,
      installedRunnerRecordSha256: "b".repeat(64)
    }
  );
  assert.equal(sourceOnly.runnerActivationId, failed.releaseId);
  assert.equal(sourceOnly.validPrecommit, true);
  assert.equal(sourceOnly.targetCommitted, false);

  const precommitState = {
    schemaVersion: 1,
    targetActivationId: interruptedSuccessor.releaseId,
    targetReleaseSha: interruptedSuccessor.targetGitSha,
    targetRecordSha256: "1".repeat(64),
    priorActivationId: failed.releaseId,
    priorReleaseSha: failed.targetGitSha,
    priorRecordSha256: "b".repeat(64),
    narrativeRunner: "prior",
    omlxServer: "target",
    targetCommitted: false,
    validPrecommit: true
  };
  const priorOnly = committedRunnerResumeLineagePlan(
    interruptedSuccessor,
    {
      readJournal,
      installedRunnerActivationId: failed.releaseId,
      installedRunnerRecordSha256: "b".repeat(64),
      installState: { ...precommitState, omlxServer: "prior" }
    }
  );
  assert.equal(priorOnly.runnerActivationId, failed.releaseId);
  assert.equal(priorOnly.validPrecommit, true);
  const omlxFirst = committedRunnerResumeLineagePlan(
    interruptedSuccessor,
    {
      readJournal,
      installedRunnerActivationId: failed.releaseId,
      installedRunnerRecordSha256: "b".repeat(64),
      installState: precommitState
    }
  );
  assert.equal(omlxFirst.runnerActivationId, failed.releaseId);
  assert.equal(omlxFirst.validPrecommit, true);
  assert.equal(omlxFirst.targetCommitted, false);

  const targetDrainEvidence = committedDrainEvidence({
    targetActivationId: interruptedSuccessor.releaseId,
    targetReleaseSha: interruptedSuccessor.targetGitSha,
    priorActivationId: failed.releaseId,
    priorReleaseSha: failed.targetGitSha,
    targetRecordSha256: "1".repeat(64),
    priorRecordSha256: "b".repeat(64),
    semanticReceiptSha256: "2".repeat(64)
  });
  const committedTarget = committedRunnerResumeLineagePlan(
    interruptedSuccessor,
    {
      readJournal,
      installedRunnerActivationId: interruptedSuccessor.releaseId,
      installedRunnerRecordSha256: "1".repeat(64),
      installState: {
        ...precommitState,
        narrativeRunner: "target",
        targetCommitted: true,
        validPrecommit: false
      },
      targetDrainEvidence
    }
  );
  assert.equal(
    committedTarget.runnerActivationId,
    interruptedSuccessor.releaseId
  );
  assert.equal(committedTarget.targetCommitted, true);

  assert.throws(
    () =>
      committedRunnerResumeLineagePlan(interruptedSuccessor, {
        readJournal,
        installedRunnerActivationId: "foreign-runner",
        installedRunnerRecordSha256: "b".repeat(64)
      }),
    /differs from the attested committed predecessor/
  );
  assert.throws(
    () =>
      committedRunnerResumeLineagePlan(interruptedSuccessor, {
        readJournal,
        installedRunnerActivationId: interruptedSuccessor.releaseId,
        installedRunnerRecordSha256: "1".repeat(64),
        installState: {
          ...precommitState,
          narrativeRunner: "target",
          omlxServer: "prior"
        }
      }),
    /differs from the linked successor/
  );
  assert.throws(
    () =>
      committedRunnerResumeLineagePlan(interruptedSuccessor, {
        readJournal,
        installedRunnerActivationId: failed.releaseId,
        installedRunnerRecordSha256: "b".repeat(64),
        installState: {
          ...precommitState,
          priorRecordSha256: "0".repeat(64)
        }
      }),
    /differs from the linked successor/
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

test("production recovery terminally attests an exact healthy committed v4 runner", async (t) => {
  const fixture = productionAttestorFixture(t, { committedRunner: true });
  const evidence = await fixture.attestor(fixture.failed);
  assert.equal(
    Object.hasOwn(evidence, "committedRunnerActivationId"),
    true
  );
  assert.equal(
    evidence.committedRunnerActivationId,
    fixture.failed.releaseId
  );
  assert.equal(
    evidence.liveWorkerSourceRevision,
    evidence.priorRunnerReleaseSha
  );
  assert.deepEqual(fixture.events, [
    "d1",
    "queue",
    "inactive",
    "healthy",
    "committed",
    "healthy",
    "d1",
    "healthy",
    "committed",
    "healthy"
  ]);
  assert.equal(fixture.events.includes("restore"), false);
});

test("final committed-runner attestation rejects hash-linked prior record drift", async (t) => {
  const fixture = productionAttestorFixture(t, { committedRunner: true });
  const priorFailure = failedRunnerJournal({
    releaseId: "attestor-prior-runner-failure",
    targetGitSha: "c".repeat(40),
    targetFingerprints: {
      ...fixture.failed.targetFingerprints,
      releaseTooling: fingerprintCanonicalReleaseValue(
        "attestor-prior-release-tooling"
      )
    }
  });
  const priorReplaced = replaceRunnerFailureReleaseJournal(priorFailure, {
    releaseId: fixture.failed.releaseId,
    targetGitSha: fixture.failed.targetGitSha,
    evidence: replacementEvidence(priorFailure),
    at: "2026-08-16T17:10:30.000Z"
  });
  const linkedFailed = failedRunnerJournal({
    d1ExportSha256: fixture.failed.receipts.d1ExportSha256,
    predecessor: predecessorForReleaseReplacement(priorReplaced),
    targetFingerprints: fixture.failed.targetFingerprints,
    wranglerConfigSha256: fixture.failed.receipts.wranglerConfigSha256
  });
  fixture.setLinkedJournal(priorReplaced);
  fixture.setCurrentJournal(linkedFailed);

  await assert.rejects(
    fixture.attestor(linkedFailed),
    /differs from its hash-linked prior runner lineage/
  );
  assert.equal(
    fixture.events.filter((event) => event === "committed").length,
    2
  );
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
  assert.throws(() =>
    assertRunnerFailureReplacementEvidence(failed, {
      ...committedReplacementEvidence(failed),
      committedRunnerProtocolFingerprint: "0".repeat(64)
    })
  );
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
