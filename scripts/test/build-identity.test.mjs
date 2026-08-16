import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  clientBuildDigest,
  clientProductionFiles,
  digestFiles,
  resolveWebBuildIdentity,
  workerBundleDigest
} from "../lib/build-identity.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "surf-build-identity-"));
  mkdirSync(join(root, "apps/web/public"), { recursive: true });
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  writeFileSync(join(root, "apps/web/index.html"), "<main></main>\n");
  writeFileSync(join(root, "apps/web/package.json"), "{}\n");
  writeFileSync(join(root, "apps/web/vite.config.ts"), "export default {};\n");
  writeFileSync(join(root, "apps/web/public/favicon.svg"), "<svg/>\n");
  writeFileSync(join(root, "apps/web/src/main.tsx"), "export const ui = 1;\n");
  writeFileSync(join(root, "apps/web/src/main.test.tsx"), "throw new Error();\n");
  return root;
}

test("client identity is stable, path-framed, and excludes tests", () => {
  const root = fixtureRoot();
  const files = clientProductionFiles(root);
  assert.deepEqual(files, [
    "apps/web/index.html",
    "apps/web/package.json",
    "apps/web/public/favicon.svg",
    "apps/web/src/main.tsx",
    "apps/web/vite.config.ts"
  ]);
  const first = clientBuildDigest(root);
  const second = clientBuildDigest(root);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);

  writeFileSync(join(root, "apps/web/src/main.test.tsx"), "changed test\n");
  assert.equal(clientBuildDigest(root), first);
  writeFileSync(join(root, "apps/web/src/main.tsx"), "export const ui = 2;\n");
  assert.notEqual(clientBuildDigest(root), first);
});

test("client identity rejects symlinked production inputs", () => {
  const root = fixtureRoot();
  symlinkSync("main.tsx", join(root, "apps/web/src/alias.tsx"));
  assert.throws(() => clientProductionFiles(root), /symbolic link/);
});

test("file framing distinguishes path/content boundary collisions", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, "left"), "ab");
  writeFileSync(join(root, "right"), "c");
  const leftRight = digestFiles(root, ["left", "right"]);
  writeFileSync(join(root, "left"), "a");
  writeFileSync(join(root, "right"), "bc");
  assert.notEqual(digestFiles(root, ["left", "right"]), leftRight);
});

test("configured client identity must match the canonical value", () => {
  const root = fixtureRoot();
  const sourceRevision = "a".repeat(40);
  const expected = clientBuildDigest(root);
  assert.deepEqual(
    resolveWebBuildIdentity({
      root,
      environment: {
        SURF_RELEASE_SHA: sourceRevision,
        SURF_CLIENT_BUILD_DIGEST: expected
      }
    }),
    { schemaVersion: 1, sourceRevision, clientBuildDigest: expected }
  );
  assert.throws(
    () =>
      resolveWebBuildIdentity({
        root,
        environment: {
          SURF_RELEASE_SHA: sourceRevision,
          SURF_CLIENT_BUILD_DIGEST: "b".repeat(64)
        }
      }),
    /must exactly match/
  );
});

test("Worker bundle identity hashes exact bytes and rejects symlinks", () => {
  const root = fixtureRoot();
  const bundle = join(root, "worker.js");
  writeFileSync(bundle, "export default {};\n");
  assert.match(workerBundleDigest(bundle), /^[0-9a-f]{64}$/);
  symlinkSync("worker.js", join(root, "worker-link.js"));
  assert.throws(() => workerBundleDigest(join(root, "worker-link.js")), /non-symlink/);
});
