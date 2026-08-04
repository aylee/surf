import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDeployedUrl,
  resolveDeployedVersionId
} from "../lib/deploy-url.mjs";

const versionId = "11111111-2222-4333-8444-555555555555";

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
