import assert from "node:assert/strict";
import test from "node:test";
import { deployExistingWorker } from "../lib/deploy-orchestration.mjs";

function recordedSteps({ failAt } = {}) {
  const calls = [];
  const call = (name, value) => {
    calls.push(name);
    if (failAt === name) throw new Error(`failed at ${name}`);
    return value;
  };
  return {
    calls,
    steps: {
      assertExistingDeploymentRuntime: () => call("predecessor-runtime"),
      ensureQueues: () => call("queues"),
      migrateAndSeed: () => call("d1"),
      deployWorker: () => call("deploy", "deploy-output"),
      inspectUploadedRuntime: (output) => {
        assert.equal(output, "deploy-output");
        call("target-runtime");
      },
      completeRollout: async (output) => {
        assert.equal(output, "deploy-output");
        call("readiness");
        call("ingest");
      }
    }
  };
}

test("deployment proves predecessor runtime before mutation and target runtime before rollout", async () => {
  const { calls, steps } = recordedSteps();
  assert.equal(await deployExistingWorker(steps), "deploy-output");
  assert.deepEqual(calls, [
    "predecessor-runtime",
    "queues",
    "d1",
    "deploy",
    "target-runtime",
    "readiness",
    "ingest"
  ]);
});

test("failed runtime gates stop every later mutation or rollout step", async () => {
  for (const failAt of ["predecessor-runtime", "target-runtime"]) {
    const { calls, steps } = recordedSteps({ failAt });
    await assert.rejects(() => deployExistingWorker(steps), new RegExp(`failed at ${failAt}`));
    if (failAt === "predecessor-runtime") {
      assert.deepEqual(calls, ["predecessor-runtime"]);
    } else {
      assert.deepEqual(calls, [
        "predecessor-runtime",
        "queues",
        "d1",
        "deploy",
        "target-runtime"
      ]);
    }
  }
});
