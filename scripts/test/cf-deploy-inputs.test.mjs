import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { repoRoot } from "../lib/root-env.mjs";

test("deploy rejects a malformed legacy bootstrap UUID before running any command", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/cf-deploy.mjs", "deploy", "--dry-run"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SURF_INGEST_TOKEN: "test-only-token",
        SURF_LEGACY_PATCHLESS_WORKER_VERSION: "typo"
      }
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /legacy patchless Worker version ID must be a UUID/);
  assert.doesNotMatch(output, /^> pnpm /m);
  assert.doesNotMatch(output, /wrangler|whoami|migrations|queues/i);
});
