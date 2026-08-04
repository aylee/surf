import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapDeployedWorker } from "../lib/deploy-bootstrap.mjs";

function workflow(overrides = {}) {
  const events = [];
  return {
    events,
    options: {
      waitUntilServing: async () => events.push("ready"),
      enqueueAndWait: async () => events.push("enqueue"),
      smoke: async () => events.push("smoke"),
      ...overrides
    }
  };
}

test("deployment bootstrap crosses readiness, one ingest handoff, then smoke in order", async () => {
  const { events, options } = workflow();
  await bootstrapDeployedWorker(options);
  assert.deepEqual(events, ["ready", "enqueue", "smoke"]);
});

test("readiness failure leaves the activated Worker in place for queue-safe fix-forward", async () => {
  const { events, options } = workflow({
    waitUntilServing: async () => {
      events.push("ready");
      throw new Error("wrong version");
    }
  });
  await assert.rejects(
    bootstrapDeployedWorker(options),
    /remains active for a queue-safe fix-forward/
  );
  assert.deepEqual(events, ["ready"]);
});

test("enqueue failure stays on the new Worker for queue-safe fix-forward", async () => {
  const { events, options } = workflow({
    enqueueAndWait: async () => {
      events.push("enqueue");
      throw new Error("publication timed out");
    }
  });
  await assert.rejects(
    bootstrapDeployedWorker(options),
    /remains active for a queue-safe fix-forward/
  );
  assert.deepEqual(events, ["ready", "enqueue"]);
});

test("strict-smoke failure never rolls code behind a possibly new Queue message", async () => {
  const { events, options } = workflow({
    smoke: async () => {
      events.push("smoke");
      throw new Error("bad read model");
    }
  });
  await assert.rejects(
    bootstrapDeployedWorker(options),
    /remains active for a queue-safe fix-forward/
  );
  assert.deepEqual(events, ["ready", "enqueue", "smoke"]);
});
