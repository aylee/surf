import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { repoRoot } from "../lib/root-env.mjs";
import { stageWranglerConfigSnapshot } from "../lib/wrangler-config-snapshot.mjs";

const trackedWranglerConfig = new URL(
  "../../apps/web/wrangler.jsonc",
  import.meta.url
);
const cloudflareCommandsUrl = new URL(
  "../lib/cloudflare-commands.mjs",
  import.meta.url
).href;

test("bootstrap repin keeps the original and exact-identity snapshots pinned", () => {
  const root = realpathSync(
    mkdtempSync(resolve(tmpdir(), "surf-bootstrap-repin-"))
  );
  try {
    const bin = resolve(root, "bin");
    const sourcePath = resolve(root, "wrangler.source.jsonc");
    const originalPath = resolve(root, "wrangler.original.jsonc");
    const finalPath = resolve(root, "wrangler.final.jsonc");
    const spawnMarker = resolve(root, "pnpm-spawned");
    mkdirSync(bin);
    writeFileSync(sourcePath, readFileSync(trackedWranglerConfig), {
      mode: 0o600
    });
    const original = stageWranglerConfigSnapshot({
      sourcePath,
      outputPath: originalPath,
      releaseRoot: repoRoot
    });
    const final = stageWranglerConfigSnapshot({
      sourcePath: original.path,
      outputPath: finalPath,
      releaseRoot: repoRoot,
      releaseIdentity: {
        sourceRevision: "a".repeat(40),
        workerRuntimeDigest: "b".repeat(64),
        clientBuildDigest: "c".repeat(64)
      }
    });
    const fakePnpm = resolve(bin, "pnpm");
    writeFileSync(
      fakePnpm,
      `#!/bin/sh
touch ${JSON.stringify(spawnMarker)}
exit 0
`,
      { mode: 0o755 }
    );
    chmodSync(fakePnpm, 0o755);

    const script = `
import { writeFileSync } from "node:fs";
import {
  pinActiveWranglerConfigForDeploy,
  repinActiveWranglerConfigForBootstrap,
  runWrangler
} from ${JSON.stringify(cloudflareCommandsUrl)};
pinActiveWranglerConfigForDeploy(process.env, { required: true });
repinActiveWranglerConfigForBootstrap({
  path: process.env.SURF_TEST_FINAL_CONFIG,
  sha256: process.env.SURF_TEST_FINAL_SHA256
});
writeFileSync(process.env.SURF_WRANGLER_CONFIG, "{}\\n");
try {
  runWrangler(["--version"]);
  process.exit(3);
} catch (error) {
  if (!/SHA-256 does not match activation/.test(error.message)) throw error;
}
`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SURF_WRANGLER_CONFIG: original.path,
          SURF_WRANGLER_CONFIG_SHA256: original.sha256,
          SURF_TEST_FINAL_CONFIG: final.path,
          SURF_TEST_FINAL_SHA256: final.sha256
        }
      }
    );

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(spawnMarker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
