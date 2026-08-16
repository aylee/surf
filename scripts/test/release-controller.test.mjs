import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  executeRelease,
  reconcileReleaseActivationBoundary
} from "../lib/release-controller.mjs";
import {
  RELEASE_JOURNAL_STATES,
  RELEASE_POINTER_KINDS,
  createReleaseJournal,
  createReleaseStateStore,
  fingerprintReleaseJournal,
  recordReleaseJournalFailure,
  transitionReleaseJournal
} from "../lib/release-journal.mjs";
import {
  RELEASE_LANES,
  classifyReleaseImpact,
  createTrustedActiveReleaseReceipt
} from "../lib/release-impact.mjs";

const target = "a".repeat(40);
const worker = "11111111-1111-4111-8111-111111111111";
const deployment = "22222222-2222-4222-8222-222222222222";
const predecessorWorker = "33333333-3333-4333-8333-333333333333";
const predecessorDeployment = "44444444-4444-4444-8444-444444444444";
const fingerprints = Object.freeze({
  workerAssets: "1".repeat(64),
  workerRuntime: "2".repeat(64),
  materialization: "3".repeat(64),
  migrations: "4".repeat(64),
  seed: "0".repeat(64),
  queueTopology: "5".repeat(64),
  triggerTopology: "6".repeat(64),
  runnerArtifact: "7".repeat(64),
  runnerRuntime: "e".repeat(64),
  narrativeContract: "8".repeat(64),
  logicalConfig: "9".repeat(64),
  workerSecrets: "a".repeat(64),
  dependencyLock: "b".repeat(64),
  sharedWorkspace: "c".repeat(64),
  releaseTooling: "d".repeat(64)
});

function classification(lane) {
  if (lane === RELEASE_LANES.ASSETS_ONLY) {
    const active = { fingerprints };
    // The classifier's trusted brand is deliberately not forgeable; use a
    // conservative classification then replace only through its own schema in
    // the fixture below.
    return Object.freeze({
      schemaVersion: 1,
      lane,
      impact: Object.freeze({
        workerAssets: true,
        workerRuntime: false,
        materialization: false,
        migrations: false,
        seed: false,
        queueTopology: false,
        triggerTopology: false,
        runner: false,
        narrativeContract: false,
        secrets: false
      }),
      changedPaths: Object.freeze(["apps/web/src/App.tsx"]),
      reasonCodes: Object.freeze(["assets_only_verified"]),
      comparedFingerprintKeys: Object.freeze(
        Object.keys(fingerprints).filter((key) => key !== "workerAssets").sort()
      ),
      mismatchKeys: Object.freeze([])
    });
  }
  return classifyReleaseImpact({
    changedPaths: ["package.json"],
    targetFingerprints: fingerprints,
    activeReceipt: null
  });
}

function fixture(lane, classificationOverride = null) {
  const root = mkdtempSync(join(tmpdir(), "surf-release-controller-"));
  const store = createReleaseStateStore({ rootDir: resolve(root) });
  const journal = createReleaseJournal({
    releaseId: `release-${lane}`,
    targetGitSha: target,
    classification: classificationOverride ?? classification(lane),
    targetFingerprints: fingerprints,
    predecessor: {
      releaseId: "release-predecessor",
      journalSha256: "f".repeat(64),
      workerVersionId: predecessorWorker,
      deploymentId: predecessorDeployment,
      runnerActivationId: "runner-predecessor"
    },
    createdAt: "2026-08-15T00:00:00.000Z"
  });
  store.writeJournal(journal);
  return { root, store, journal };
}

function operations(trace, overrides = {}) {
  let activated = false;
  let triggersSynced = false;
  let queueConsumersSynced = true;
  const call = (name, value) => async () => {
    trace.push(name);
    return value;
  };
  return {
    verify: call("verify"),
    prepare: call("prepare", {
      profileSha256: "1".repeat(64),
      operatorEnvironmentFingerprint: "4".repeat(64),
      wranglerConfigSha256: "2".repeat(64),
      workerSecretsFingerprint: "3".repeat(64)
    }),
    uploadWorker: call("uploadWorker", { workerVersionId: worker }),
    prepareData: call("prepareData", {
      d1Bookmark: "bookmark-1",
      d1ExportSha256: "e".repeat(64)
    }),
    ensureRunner: call("ensureRunner", { runnerActivationId: "runner-1" }),
    verifyDependencies: async ({ phase }) => {
      trace.push(`verifyDependencies:${phase}`);
    },
    recheckPredecessor: call("recheckPredecessor"),
    inspectActivation: async () => {
      trace.push("inspectActivation");
      return {
        state: activated ? "target" : "predecessor",
        workerVersionId: activated ? worker : predecessorWorker,
        deploymentId: activated ? deployment : predecessorDeployment
      };
    },
    activateWorker: async () => {
      trace.push("activateWorker");
      activated = true;
      return { deploymentId: deployment };
    },
    waitUntilServing: call("waitUntilServing"),
    inspectQueueConsumers: async () => {
      trace.push("inspectQueueConsumers");
      return { matches: queueConsumersSynced };
    },
    inspectTriggers: async () => {
      trace.push("inspectTriggers");
      return { matches: triggersSynced };
    },
    syncTriggers: async () => {
      trace.push("syncTriggers");
      queueConsumersSynced = true;
      triggersSynced = true;
    },
    inspectGeneration: call("inspectGeneration", null),
    generate: call("generate", { generationId: "generation-1" }),
    verifyLive: call("verifyLive"),
    ...overrides
  };
}

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 15, 0, 0, tick++));
}

function ambiguousJournal(initial) {
  let current = transitionReleaseJournal(
    initial,
    RELEASE_JOURNAL_STATES.VERIFIED,
    { at: "2026-08-15T00:00:01.000Z" }
  );
  current = transitionReleaseJournal(current, RELEASE_JOURNAL_STATES.PREPARED, {
    at: "2026-08-15T00:00:02.000Z",
    receipts: {
      profileSha256: "1".repeat(64),
      operatorEnvironmentFingerprint: "4".repeat(64),
      wranglerConfigSha256: "2".repeat(64),
      workerSecretsFingerprint: "3".repeat(64)
    }
  });
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
    {
      at: "2026-08-15T00:00:03.000Z",
      receipts: { workerVersionId: worker }
    }
  );
  current = transitionReleaseJournal(
    current,
    RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED,
    { at: "2026-08-15T00:00:04.000Z" }
  );
  return recordReleaseJournalFailure(current, {
    code: "activation_ambiguous",
    at: "2026-08-15T00:00:05.000Z"
  });
}

test("ambiguous activation reconciles only the exact target or predecessor", () => {
  const candidate = fixture(RELEASE_LANES.ASSETS_ONLY);
  try {
    const ambiguous = ambiguousJournal(candidate.journal);
    const targetResult = reconcileReleaseActivationBoundary(ambiguous, {
      liveWorkerVersionId: worker,
      liveDeploymentId: deployment,
      at: "2026-08-15T00:00:06.000Z"
    });
    assert.equal(targetResult.targetIsActive, true);
    assert.equal(
      targetResult.journal.state,
      RELEASE_JOURNAL_STATES.WORKER_ACTIVE
    );

    const predecessorResult = reconcileReleaseActivationBoundary(ambiguous, {
      liveWorkerVersionId: predecessorWorker,
      liveDeploymentId: predecessorDeployment,
      at: "2026-08-15T00:00:06.000Z"
    });
    assert.equal(predecessorResult.targetIsActive, false);
    assert.equal(
      predecessorResult.journal.state,
      RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED
    );

    assert.throws(
      () =>
        reconcileReleaseActivationBoundary(ambiguous, {
          liveWorkerVersionId: "55555555-5555-4555-8555-555555555555",
          liveDeploymentId: "66666666-6666-4666-8666-666666666666",
          at: "2026-08-15T00:00:06.000Z"
        }),
      /exact target or predecessor/
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("assets-only executes no D1, Queue, trigger, ingest, or runner step", async () => {
  const candidate = fixture(RELEASE_LANES.ASSETS_ONLY);
  const trace = [];
  try {
    const result = await executeRelease({
      journal: candidate.journal,
      store: candidate.store,
      operations: operations(trace),
      now: clock()
    });
    assert.equal(result.state, RELEASE_JOURNAL_STATES.COMPLETE);
    assert.deepEqual(trace, [
      "verify",
      "prepare",
      "uploadWorker",
      "recheckPredecessor",
      "inspectActivation",
      "activateWorker",
      "waitUntilServing",
      "verifyLive",
      "inspectActivation"
    ]);
    for (const forbidden of [
      "prepareData",
      "ensureRunner",
      "inspectQueueConsumers",
      "syncTriggers",
      "generate"
    ]) {
      assert.equal(trace.includes(forbidden), false);
    }
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.ACTIVE).releaseId,
      result.releaseId
    );
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.LAST_COMPLETE).releaseId,
      result.releaseId
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("full lane preserves guarded storage, runner, trigger, and generation order", async () => {
  const candidate = fixture(RELEASE_LANES.CONSERVATIVE_FULL);
  const trace = [];
  try {
    const result = await executeRelease({
      journal: candidate.journal,
      store: candidate.store,
      operations: operations(trace),
      now: clock()
    });
    assert.equal(result.state, RELEASE_JOURNAL_STATES.COMPLETE);
    assert.ok(trace.indexOf("prepareData") < trace.indexOf("ensureRunner"));
    assert.ok(trace.indexOf("ensureRunner") < trace.indexOf("activateWorker"));
    assert.ok(trace.indexOf("activateWorker") < trace.indexOf("syncTriggers"));
    assert.ok(trace.indexOf("syncTriggers") < trace.indexOf("generate"));
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("dependency drift immediately before activation remains retryable and never activates", async () => {
  const candidate = fixture(RELEASE_LANES.CONSERVATIVE_FULL);
  const trace = [];
  try {
    await assert.rejects(
      executeRelease({
        journal: candidate.journal,
        store: candidate.store,
        operations: operations(trace, {
          verifyDependencies: async ({ phase }) => {
            trace.push(`verifyDependencies:${phase}`);
            throw new Error("queue drift");
          }
        }),
        now: clock()
      }),
      /dependency_drift/
    );
    const stored = candidate.store.readJournal(candidate.journal.releaseId);
    assert.equal(stored.state, RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE);
    assert.equal(
      stored.resumeFrom,
      RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED
    );
    assert.equal(stored.failureCode, "dependency_drift");
    assert.equal(trace.includes("activateWorker"), false);
    assert.equal(candidate.store.readPointer(RELEASE_POINTER_KINDS.ACTIVE), null);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("final dependency drift requires fix-forward and cannot publish last-complete", async () => {
  const candidate = fixture(RELEASE_LANES.CONSERVATIVE_FULL);
  const trace = [];
  try {
    await assert.rejects(
      executeRelease({
        journal: candidate.journal,
        store: candidate.store,
        operations: operations(trace, {
          verifyDependencies: async ({ phase }) => {
            trace.push(`verifyDependencies:${phase}`);
            if (phase === "final") throw new Error("runner drift");
          }
        }),
        now: clock()
      }),
      /dependency_drift/
    );
    const stored = candidate.store.readJournal(candidate.journal.releaseId);
    assert.equal(stored.state, RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD);
    assert.equal(stored.resumeFrom, RELEASE_JOURNAL_STATES.VERIFIED_LIVE);
    assert.equal(stored.failureCode, "dependency_drift");
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.ACTIVE).releaseId,
      stored.releaseId
    );
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.LAST_COMPLETE),
      null
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("full-lane resume reconciles triggers and generation before mutating", async () => {
  const candidate = fixture(RELEASE_LANES.CONSERVATIVE_FULL);
  const trace = [];
  try {
    const result = await executeRelease({
      journal: candidate.journal,
      store: candidate.store,
      operations: operations(trace, {
        inspectTriggers: async () => {
          trace.push("inspectTriggers");
          return { matches: true };
        },
        inspectGeneration: async (notBefore) => {
          trace.push(`inspectGeneration:${notBefore}`);
          return { generationId: "generation-reconciled" };
        }
      }),
      now: clock()
    });
    assert.equal(result.receipts.generationId, "generation-reconciled");
    assert.equal(trace.includes("syncTriggers"), false);
    assert.equal(trace.includes("generate"), false);
    assert.ok(
      trace.includes("inspectGeneration:2026-08-15T00:00:00.000Z")
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("Queue consumer topology is applied exactly once and reconciled after a crash", async () => {
  const activeFingerprints = {
    ...fingerprints,
    queueTopology: "f".repeat(64)
  };
  const queueClassification = classifyReleaseImpact({
    changedPaths: ["apps/web/wrangler.jsonc"],
    targetFingerprints: fingerprints,
    activeReceipt: createTrustedActiveReleaseReceipt({
      schemaVersion: 1,
      releaseId: "release-active",
      targetGitSha: "f".repeat(40),
      workerVersionId: predecessorWorker,
      journalSha256: "e".repeat(64),
      state: "complete",
      fingerprints: activeFingerprints
    })
  });
  const candidate = fixture(
    RELEASE_LANES.CONSERVATIVE_FULL,
    queueClassification
  );
  const firstTrace = [];
  let queueConsumersMatch = false;
  let crashAfterSync = true;
  let activated = false;
  const releaseOperations = operations(firstTrace, {
    inspectActivation: async () => {
      firstTrace.push("inspectActivation");
      return {
        state: activated ? "target" : "predecessor",
        workerVersionId: activated ? worker : predecessorWorker,
        deploymentId: activated ? deployment : predecessorDeployment
      };
    },
    activateWorker: async () => {
      firstTrace.push("activateWorker");
      activated = true;
      return { deploymentId: deployment };
    },
    inspectQueueConsumers: async () => {
      firstTrace.push("inspectQueueConsumers");
      if (crashAfterSync && queueConsumersMatch) {
        crashAfterSync = false;
        throw new Error("simulated crash after Queue consumer synchronization");
      }
      return { matches: queueConsumersMatch };
    },
    syncTriggers: async () => {
      firstTrace.push("syncTriggers");
      queueConsumersMatch = true;
    }
  });
  const now = clock();
  try {
    await assert.rejects(
      executeRelease({
        journal: candidate.journal,
        store: candidate.store,
        operations: releaseOperations,
        now
      }),
      /trigger_sync_failed/
    );
    assert.equal(
      firstTrace.filter((entry) => entry === "syncTriggers").length,
      1
    );
    const failed = candidate.store.readJournal(candidate.journal.releaseId);
    assert.equal(failed.resumeFrom, RELEASE_JOURNAL_STATES.WORKER_ACTIVE);

    const resumeTrace = [];
    const complete = await executeRelease({
      journal: failed,
      store: candidate.store,
      operations: operations(resumeTrace, {
        inspectActivation: async () => ({
          state: "target",
          workerVersionId: worker,
          deploymentId: deployment
        }),
        inspectQueueConsumers: async () => {
          resumeTrace.push("inspectQueueConsumers");
          return { matches: queueConsumersMatch };
        },
        inspectTriggers: async () => {
          resumeTrace.push("inspectTriggers");
          return { matches: true };
        },
        syncTriggers: async () => {
          resumeTrace.push("syncTriggers");
          throw new Error("resume must not duplicate Queue consumer mutation");
        }
      }),
      now
    });
    assert.equal(complete.state, RELEASE_JOURNAL_STATES.COMPLETE);
    assert.equal(resumeTrace.includes("syncTriggers"), false);
    assert.equal(resumeTrace.includes("inspectQueueConsumers"), true);
    assert.equal(resumeTrace.includes("inspectTriggers"), true);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("component-full execution skips every unrelated stateful operation", async () => {
  const componentClassification = classifyReleaseImpact({
    changedPaths: ["docs/architecture.md"],
    targetFingerprints: fingerprints,
    activeReceipt: createTrustedActiveReleaseReceipt({
      schemaVersion: 1,
      releaseId: "release-active",
      targetGitSha: "f".repeat(40),
      workerVersionId: predecessorWorker,
      journalSha256: "e".repeat(64),
      state: "complete",
      fingerprints
    })
  });
  const candidate = fixture(
    RELEASE_LANES.CONSERVATIVE_FULL,
    componentClassification
  );
  const trace = [];
  const forbidden = async () => {
    throw new Error("unrelated stateful operation was called");
  };
  try {
    const result = await executeRelease({
      journal: candidate.journal,
      store: candidate.store,
      operations: operations(trace, {
        prepareData: forbidden,
        ensureRunner: forbidden,
        inspectQueueConsumers: forbidden,
        inspectTriggers: forbidden,
        syncTriggers: forbidden,
        inspectGeneration: forbidden,
        generate: forbidden
      }),
      now: clock()
    });
    assert.equal(result.state, RELEASE_JOURNAL_STATES.COMPLETE);
    for (const name of [
      "prepareData",
      "ensureRunner",
      "inspectQueueConsumers",
      "inspectTriggers",
      "syncTriggers",
      "inspectGeneration",
      "generate"
    ]) {
      assert.equal(trace.includes(name), false);
    }
    assert.equal(result.receipts.d1Bookmark, null);
    assert.equal(result.receipts.runnerActivationId, null);
    assert.equal(result.receipts.generationId, null);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("seed releases prove runner compatibility before publishing Analysis work", async () => {
  const activeFingerprints = { ...fingerprints, seed: "f".repeat(64) };
  const seedClassification = classifyReleaseImpact({
    changedPaths: ["packages/db/seeds/0000_v1_norcal.sql"],
    targetFingerprints: fingerprints,
    activeReceipt: createTrustedActiveReleaseReceipt({
      schemaVersion: 1,
      releaseId: "release-active",
      targetGitSha: "f".repeat(40),
      workerVersionId: predecessorWorker,
      journalSha256: "e".repeat(64),
      state: "complete",
      fingerprints: activeFingerprints
    })
  });
  const candidate = fixture(
    RELEASE_LANES.CONSERVATIVE_FULL,
    seedClassification
  );
  const trace = [];
  try {
    const result = await executeRelease({
      journal: candidate.journal,
      store: candidate.store,
      operations: operations(trace),
      now: clock()
    });
    assert.equal(result.state, RELEASE_JOURNAL_STATES.COMPLETE);
    assert.ok(trace.indexOf("prepareData") < trace.indexOf("ensureRunner"));
    assert.ok(trace.indexOf("ensureRunner") < trace.indexOf("generate"));
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("post-activation failure advances active but not last-complete", async () => {
  const candidate = fixture(RELEASE_LANES.ASSETS_ONLY);
  const trace = [];
  try {
    await assert.rejects(
      executeRelease({
        journal: candidate.journal,
        store: candidate.store,
        operations: operations(trace, {
          verifyLive: async () => {
            trace.push("verifyLive");
            throw new Error("stale edge");
          }
        }),
        now: clock()
      }),
      /live_verify_failed/
    );
    const stored = candidate.store.readJournal(candidate.journal.releaseId);
    assert.equal(stored.state, RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD);
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.ACTIVE).releaseId,
      stored.releaseId
    );
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.LAST_COMPLETE),
      null
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("failed final deployment reconciliation never marks the release complete", async () => {
  const candidate = fixture(RELEASE_LANES.ASSETS_ONLY);
  const trace = [];
  let inspection = 0;
  try {
    await assert.rejects(
      executeRelease({
        journal: candidate.journal,
        store: candidate.store,
        operations: operations(trace, {
          inspectActivation: async () => {
            trace.push("inspectActivation");
            inspection += 1;
            return inspection === 1
              ? {
                  state: "predecessor",
                  workerVersionId: predecessorWorker,
                  deploymentId: predecessorDeployment
                }
              : {
                  state: "ambiguous",
                  workerVersionId: worker,
                  deploymentId: deployment
                };
          }
        }),
        now: clock()
      }),
      /live_verify_failed/
    );
    const stored = candidate.store.readJournal(candidate.journal.releaseId);
    assert.equal(stored.state, RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD);
    assert.equal(stored.resumeFrom, RELEASE_JOURNAL_STATES.VERIFIED_LIVE);
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.LAST_COMPLETE),
      null
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("resume continues after the exact persisted boundary without reupload", async () => {
  const candidate = fixture(RELEASE_LANES.ASSETS_ONLY);
  const firstTrace = [];
  const now = clock();
  try {
    await assert.rejects(
      executeRelease({
        journal: candidate.journal,
        store: candidate.store,
        operations: operations(firstTrace, {
          recheckPredecessor: async () => {
            firstTrace.push("recheckPredecessor");
            throw new Error("changed");
          }
        }),
        now
      })
    );
    const failed = candidate.store.readJournal(candidate.journal.releaseId);
    const resumeTrace = [];
    const complete = await executeRelease({
      journal: failed,
      store: candidate.store,
      operations: operations(resumeTrace),
      now
    });
    assert.equal(complete.state, RELEASE_JOURNAL_STATES.COMPLETE);
    assert.equal(resumeTrace.includes("uploadWorker"), false);
    assert.equal(resumeTrace[0], "recheckPredecessor");
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("exact resume reconciles a complete journal and repairs both pointers", async () => {
  const candidate = fixture(RELEASE_LANES.ASSETS_ONLY);
  const trace = [];
  const releaseOperations = operations(trace);
  const now = clock();
  let interrupted = false;
  const crashingStore = {
    writeJournal: (journal) => candidate.store.writeJournal(journal),
    writePointer: (pointer) => {
      const current = candidate.store.readJournal(pointer.releaseId);
      if (
        !interrupted &&
        pointer.kind === RELEASE_POINTER_KINDS.ACTIVE &&
        current.state === RELEASE_JOURNAL_STATES.COMPLETE
      ) {
        interrupted = true;
        throw new Error("simulated pointer crash");
      }
      return candidate.store.writePointer(pointer);
    }
  };

  try {
    await assert.rejects(
      executeRelease({
        journal: candidate.journal,
        store: crashingStore,
        operations: releaseOperations,
        now
      }),
      /simulated pointer crash/
    );
    const complete = candidate.store.readJournal(candidate.journal.releaseId);
    assert.equal(complete.state, RELEASE_JOURNAL_STATES.COMPLETE);
    assert.throws(
      () => candidate.store.readTrustedActiveReceipt(),
      /does not match its journal/
    );
    await assert.rejects(
      executeRelease({
        journal: complete,
        store: candidate.store,
        operations: releaseOperations,
        now
      }),
      /exact --resume ID/
    );

    const recovered = await executeRelease({
      journal: complete,
      store: candidate.store,
      operations: releaseOperations,
      resumeReleaseId: complete.releaseId,
      now
    });
    assert.equal(recovered.state, RELEASE_JOURNAL_STATES.COMPLETE);
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.ACTIVE).journalSha256,
      fingerprintReleaseJournal(recovered)
    );
    assert.equal(
      candidate.store.readPointer(RELEASE_POINTER_KINDS.LAST_COMPLETE)
        .journalSha256,
      fingerprintReleaseJournal(recovered)
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});
