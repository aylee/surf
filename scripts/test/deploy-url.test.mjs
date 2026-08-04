import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveActiveDeploymentId,
  resolveDeployedUrl,
  resolveDeployedVersionId
} from "../lib/deploy-url.mjs";

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

test("deploy smoke prefers the URL emitted by the rollout", () => {
  assert.equal(
    resolveDeployedUrl(
      "Deployed to https://new-surf.example.workers.dev.",
      "https://stale-surf.example.workers.dev"
    ),
    "https://new-surf.example.workers.dev"
  );
});

test("deploy smoke validates an explicit fallback origin", () => {
  assert.equal(resolveDeployedUrl("no route emitted", "https://surf.example/"), "https://surf.example");
  assert.throws(
    () => resolveDeployedUrl("no route emitted", "https://surf.example/wrong-instance"),
    /bare HTTPS origin/
  );
});

test("deploy version parser extracts the one exact Wrangler Current Version ID", () => {
  assert.equal(
    resolveDeployedVersionId(
      `Uploaded surf\n\u001b[32mCurrent Version ID: ${versionId}\u001b[0m\n`
    ),
    versionId
  );
});

test("deploy version parser rejects missing, ambiguous, and malformed IDs", () => {
  assert.throws(
    () => resolveDeployedVersionId("Uploaded surf without version evidence"),
    /exactly one Current Version ID line; found 0/
  );
  assert.throws(
    () =>
      resolveDeployedVersionId(
        `Current Version ID: ${versionId}\nCurrent Version ID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`
      ),
    /exactly one Current Version ID line; found 2/
  );
  assert.throws(
    () => resolveDeployedVersionId("Current Version ID: latest"),
    /invalid Current Version ID UUID/
  );
  assert.throws(
    () => resolveDeployedVersionId(`prefix Current Version ID: ${versionId}`),
    /exactly one Current Version ID line; found 0/
  );
});

test("deployment status parser proves one exact version at 100 percent", () => {
  assert.equal(resolveActiveDeploymentId(deploymentStatus(), versionId), deploymentId);
});

test("deployment status parser rejects malformed or non-object evidence", () => {
  for (const invalid of ["", "not json", "[]", "null", "true"]) {
    assert.throws(
      () => resolveActiveDeploymentId(invalid, versionId),
      /deployment status must be (exactly one JSON object|a JSON object)/i
    );
  }
  assert.throws(
    () => resolveActiveDeploymentId(deploymentStatus(), "latest"),
    /Expected Worker version must be a UUID/
  );
  assert.throws(
    () => resolveActiveDeploymentId(deploymentStatus({ id: "latest" }), versionId),
    /invalid deployment ID UUID/
  );
  assert.throws(
    () =>
      resolveActiveDeploymentId(
        deploymentStatus({ strategy: "unknown" }),
        versionId
      ),
    /unsupported strategy/
  );
});

test("deployment status parser rejects zero, multiple, duplicate, and malformed versions", () => {
  for (const versions of [
    [],
    [
      { version_id: versionId, percentage: 50 },
      { version_id: "66666666-7777-4888-8999-000000000000", percentage: 50 }
    ],
    [
      { version_id: versionId, percentage: 50 },
      { version_id: versionId, percentage: 50 }
    ]
  ]) {
    assert.throws(
      () => resolveActiveDeploymentId(deploymentStatus({ versions }), versionId),
      /exactly one version/
    );
  }
  assert.throws(
    () => resolveActiveDeploymentId(deploymentStatus({ versions: [null] }), versionId),
    /version must be a JSON object/
  );
  assert.throws(
    () => resolveActiveDeploymentId(deploymentStatus({ versions: {} }), versionId),
    /exactly one version/
  );
});

test("deployment status parser rejects wrong, missing, partial, and nonnumeric percentages", () => {
  const wrongVersion = "66666666-7777-4888-8999-000000000000";
  for (const activeVersion of [
    { version_id: wrongVersion, percentage: 100 },
    { percentage: 100 }
  ]) {
    assert.throws(
      () =>
        resolveActiveDeploymentId(
          deploymentStatus({ versions: [activeVersion] }),
          versionId
        ),
      /does not match the uploaded Worker version/
    );
  }
  for (const percentage of [undefined, null, "100", 99.999, 0, Number.NaN]) {
    assert.throws(
      () =>
        resolveActiveDeploymentId(
          deploymentStatus({ versions: [{ version_id: versionId, percentage }] }),
          versionId
        ),
      /exactly 100%/
    );
  }
});
