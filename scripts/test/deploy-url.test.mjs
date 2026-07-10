import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeployedUrl } from "../lib/deploy-url.mjs";

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
