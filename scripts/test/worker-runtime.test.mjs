import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkerRuntime,
  resolveSoleActiveWorkerVersionId
} from "../lib/worker-runtime.mjs";

const versionId = "11111111-2222-4333-8444-555555555555";
const deploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function deploymentStatus(overrides = {}) {
  return JSON.stringify({
    id: deploymentId,
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
    ...overrides
  });
}

function versionDetail({ id = versionId, usageModel = "standard", limits } = {}) {
  return JSON.stringify({
    id,
    resources: {
      script_runtime: {
        usage_model: usageModel,
        ...(limits === undefined ? {} : { limits })
      }
    }
  });
}

test("deployment preflight requires one active version at 100 percent", () => {
  assert.equal(resolveSoleActiveWorkerVersionId(deploymentStatus()), versionId);
  for (const status of [
    deploymentStatus({ versions: [] }),
    deploymentStatus({ versions: [{ version_id: versionId, percentage: 99 }] }),
    deploymentStatus({
      versions: [
        { version_id: versionId, percentage: 50 },
        { version_id: "66666666-7777-4888-8999-000000000000", percentage: 50 }
      ]
    }),
    deploymentStatus({ strategy: "unsupported" }),
    "not-json"
  ]) {
    assert.throws(() => resolveSoleActiveWorkerVersionId(status));
  }
});

test("preflight proves Standard without requiring an existing explicit CPU limit", () => {
  assert.deepEqual(parseWorkerRuntime(versionDetail(), { expectedVersionId: versionId }), {
    workerVersion: versionId,
    usageModel: "standard",
    cpuMs: null
  });
  assert.throws(
    () =>
      parseWorkerRuntime(versionDetail({ usageModel: "bundled" }), {
        expectedVersionId: versionId
      }),
    /must use the Standard usage model/
  );
});

test("post-deploy runtime proof requires the exact version and 2000 ms guard", () => {
  assert.deepEqual(
    parseWorkerRuntime(versionDetail({ limits: { cpu_ms: 2_000 } }), {
      expectedVersionId: versionId,
      requireCpuLimit: true
    }),
    {
      workerVersion: versionId,
      usageModel: "standard",
      cpuMs: 2_000
    }
  );

  for (const detail of [
    versionDetail(),
    versionDetail({ limits: { cpu_ms: 50 } }),
    versionDetail({ limits: { cpu_ms: "2000" } }),
    versionDetail({ id: "66666666-7777-4888-8999-000000000000", limits: { cpu_ms: 2_000 } }),
    JSON.stringify({ id: versionId, resources: {} })
  ]) {
    assert.throws(() =>
      parseWorkerRuntime(detail, {
        expectedVersionId: versionId,
        requireCpuLimit: true
      })
    );
  }
});
