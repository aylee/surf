import assert from "node:assert/strict";
import test from "node:test";
import {
  deployExistingWorker,
  workerTriggerSyncArgs,
  workerVersionActivationArgs,
  workerVersionUploadArgs
} from "../lib/deploy-orchestration.mjs";

function recordedSteps({ failAt } = {}) {
  const calls = [];
  const failures = new Set(Array.isArray(failAt) ? failAt : [failAt]);
  const predecessorVersionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const upload = {
    output: "upload-output",
    versionId: "11111111-2222-4333-8444-555555555555"
  };
  const call = (name, value) => {
    calls.push(name);
    if (failures.has(name)) throw new Error(`failed at ${name}`);
    return value;
  };
  return {
    calls,
    predecessorVersionId,
    upload,
    steps: {
      assertExistingDeploymentState: () =>
        call("predecessor-state", predecessorVersionId),
      ensureQueues: () => call("queues"),
      uploadWorkerVersion: () => call("upload", upload),
      inspectUploadedRuntime: (receivedUpload) => {
        assert.equal(receivedUpload, upload);
        call("target-runtime");
      },
      migrateAndSeed: () => call("d1"),
      assertPredecessorStillActive: (receivedVersionId) => {
        assert.equal(receivedVersionId, predecessorVersionId);
        call("predecessor-recheck");
      },
      activateUploadedVersion: (receivedUpload) => {
        assert.equal(receivedUpload, upload);
        call("activate");
      },
      assertUploadedVersionActive: (receivedUpload, activationError) => {
        assert.equal(receivedUpload, upload);
        assert.match(activationError.message, /failed at activate/);
        call("activation-reconcile");
      },
      syncTriggers: () => call("triggers"),
      completeRollout: async (receivedUpload) => {
        assert.equal(receivedUpload, upload);
        call("readiness");
        call("ingest");
      }
    }
  };
}

test("staged Wrangler commands upload, activate one exact version, then sync triggers", () => {
  const versionId = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(workerVersionUploadArgs(), ["versions", "upload"]);
  assert.deepEqual(workerVersionActivationArgs(versionId), [
    "versions",
    "deploy",
    `${versionId}@100%`,
    "--yes"
  ]);
  assert.deepEqual(workerTriggerSyncArgs(), ["triggers", "deploy"]);
  assert.throws(
    () => workerVersionActivationArgs("latest"),
    /staged Worker version ID must be a UUID/
  );
});

test("deployment reconciles Queues, proves the exact target before D1, and rechecks the predecessor", async () => {
  const { calls, steps, upload } = recordedSteps();
  assert.equal(await deployExistingWorker(steps), upload);
  assert.deepEqual(calls, [
    "predecessor-state",
    "queues",
    "upload",
    "target-runtime",
    "d1",
    "predecessor-recheck",
    "activate",
    "triggers",
    "readiness",
    "ingest"
  ]);
});

test("failed state, Queue, upload, and target-runtime gates stop D1 mutation", async () => {
  for (const failAt of [
    "predecessor-state",
    "queues",
    "upload",
    "target-runtime"
  ]) {
    const { calls, steps } = recordedSteps({ failAt });
    await assert.rejects(() => deployExistingWorker(steps), new RegExp(`failed at ${failAt}`));
    if (failAt === "predecessor-state") {
      assert.deepEqual(calls, ["predecessor-state"]);
    } else if (failAt === "queues") {
      assert.deepEqual(calls, ["predecessor-state", "queues"]);
    } else if (failAt === "upload") {
      assert.deepEqual(calls, ["predecessor-state", "queues", "upload"]);
    } else {
      assert.deepEqual(calls, [
        "predecessor-state",
        "queues",
        "upload",
        "target-runtime"
      ]);
    }
  }
});

test("storage, predecessor-race, and trigger failures leave later rollout steps untouched", async () => {
  const expectedCalls = {
    d1: ["predecessor-state", "queues", "upload", "target-runtime", "d1"],
    "predecessor-recheck": [
      "predecessor-state",
      "queues",
      "upload",
      "target-runtime",
      "d1",
      "predecessor-recheck"
    ],
    triggers: [
      "predecessor-state",
      "queues",
      "upload",
      "target-runtime",
      "d1",
      "predecessor-recheck",
      "activate",
      "triggers"
    ]
  };
  for (const failAt of Object.keys(expectedCalls)) {
    const { calls, steps } = recordedSteps({ failAt });
    await assert.rejects(() => deployExistingWorker(steps), new RegExp(`failed at ${failAt}`));
    assert.deepEqual(calls, expectedCalls[failAt]);
  }
});

test("an activation command failure continues only when the exact target reconciles active", async () => {
  const { calls, steps, upload } = recordedSteps({ failAt: "activate" });
  assert.equal(await deployExistingWorker(steps), upload);
  assert.deepEqual(calls, [
    "predecessor-state",
    "queues",
    "upload",
    "target-runtime",
    "d1",
    "predecessor-recheck",
    "activate",
    "activation-reconcile",
    "triggers",
    "readiness",
    "ingest"
  ]);
});

test("an activation error with inconclusive control-plane state stops before triggers", async () => {
  const { calls, steps } = recordedSteps({
    failAt: ["activate", "activation-reconcile"]
  });
  await assert.rejects(
    () => deployExistingWorker(steps),
    /Production activation is ambiguous/
  );
  assert.deepEqual(calls, [
    "predecessor-state",
    "queues",
    "upload",
    "target-runtime",
    "d1",
    "predecessor-recheck",
    "activate",
    "activation-reconcile"
  ]);
});
