import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapDeployedWorker } from "../lib/deploy-bootstrap.mjs";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  SURF_WORKER_VERSION_HEADER,
  waitForWorkerVersion
} from "../lib/worker-version.mjs";

const expectedVersionId = "11111111-2222-4333-8444-555555555555";
const predecessorVersionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

test("a callable 0%-traffic version cannot reach the ingest handoff", async () => {
  let clock = 0;
  let enqueueCalls = 0;
  let requests = 0;
  await assert.rejects(
    bootstrapDeployedWorker({
      waitUntilServing: () =>
        waitForWorkerVersion({
          baseUrl: "https://surf.example",
          expectedVersionId,
          expectedWorkerName: "surf",
          fetcher: async (_input, init) => {
            requests += 1;
            const hasOverride = new Headers(init.headers).has(
              CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER
            );
            return new Response(null, {
              headers: {
                [SURF_WORKER_VERSION_HEADER]: hasOverride
                  ? expectedVersionId
                  : predecessorVersionId
              }
            });
          },
          now: () => clock,
          sleep: async (delayMs) => {
            clock += delayMs;
          },
          pollIntervalMs: 1,
          timeoutMs: 4,
          requestTimeoutMs: 2
        }),
      enqueueAndWait: async () => {
        enqueueCalls += 1;
      },
      smoke: async () => undefined
    }),
    /remains active for a queue-safe fix-forward/
  );

  assert.ok(requests >= 2);
  assert.equal(enqueueCalls, 0);
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
