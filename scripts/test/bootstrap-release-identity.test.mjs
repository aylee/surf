import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
import {
  assertDeployedBootstrapReleaseIdentity,
  resolveExactBootstrapSourceIdentity,
  stageExactBootstrapWranglerConfig
} from "../lib/bootstrap-release-identity.mjs";
import { resolveOptionalWorkerSourceRevision } from "../lib/release-worker.mjs";
import { repoRoot } from "../lib/root-env.mjs";

const trackedWranglerConfig = new URL(
  "../../apps/web/wrangler.jsonc",
  import.meta.url
);

function temporaryDirectory(prefix) {
  return realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
}

test("setup-staged baseline exposes exact nonzero source lineage to managed release", () => {
  const root = temporaryDirectory("surf-bootstrap-identity-");
  try {
    const sourcePath = resolve(root, "wrangler.source.jsonc");
    const bundlePath = resolve(root, "index.js");
    const sourceRevision = "a".repeat(40);
    const clientBuildDigest = "b".repeat(64);
    writeFileSync(sourcePath, readFileSync(trackedWranglerConfig), {
      mode: 0o600
    });
    writeFileSync(bundlePath, "export default { fetch() {} };\n", {
      mode: 0o600
    });

    const staged = stageExactBootstrapWranglerConfig({
      sourcePath,
      releaseRoot: repoRoot,
      sourceRevision,
      clientBuildDigest,
      workerBundlePath: bundlePath
    });

    assert.equal(staged.config.vars.SURF_SOURCE_REVISION, sourceRevision);
    assert.notEqual(staged.config.vars.SURF_SOURCE_REVISION, "0".repeat(40));
    assert.equal(
      staged.config.vars.SURF_WORKER_RUNTIME_DIGEST,
      staged.workerRuntimeDigest
    );
    assert.equal(
      staged.config.vars.SURF_CLIENT_BUILD_DIGEST,
      clientBuildDigest
    );
    const versionId = "11111111-2222-4333-8444-555555555555";
    const versionDetail = JSON.stringify({
      id: versionId,
      resources: {
        bindings: [
          {
            name: "SURF_SOURCE_REVISION",
            type: "plain_text",
            text: staged.config.vars.SURF_SOURCE_REVISION
          },
          {
            name: "SURF_WORKER_RUNTIME_DIGEST",
            type: "plain_text",
            text: staged.config.vars.SURF_WORKER_RUNTIME_DIGEST
          },
          {
            name: "SURF_CLIENT_BUILD_DIGEST",
            type: "plain_text",
            text: staged.config.vars.SURF_CLIENT_BUILD_DIGEST
          }
        ]
      }
    });
    assert.equal(
      resolveOptionalWorkerSourceRevision(versionDetail, versionId),
      sourceRevision
    );
    assert.deepEqual(
      assertDeployedBootstrapReleaseIdentity(versionDetail, {
        versionId,
        sourceRevision,
        workerRuntimeDigest: staged.workerRuntimeDigest,
        clientBuildDigest
      }),
      {
        versionId,
        sourceRevision,
        workerRuntimeDigest: staged.workerRuntimeDigest,
        clientBuildDigest
      }
    );
    assert.equal(staged.path.startsWith(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap live identity proof rejects a zero or mismatched source binding", () => {
  const versionId = "11111111-2222-4333-8444-555555555555";
  const expected = {
    versionId,
    sourceRevision: "a".repeat(40),
    workerRuntimeDigest: "b".repeat(64),
    clientBuildDigest: "c".repeat(64)
  };
  const detail = (sourceRevision) =>
    JSON.stringify({
      id: versionId,
      resources: {
        bindings: [
          {
            name: "SURF_SOURCE_REVISION",
            type: "plain_text",
            text: sourceRevision
          },
          {
            name: "SURF_WORKER_RUNTIME_DIGEST",
            type: "plain_text",
            text: expected.workerRuntimeDigest
          },
          {
            name: "SURF_CLIENT_BUILD_DIGEST",
            type: "plain_text",
            text: expected.clientBuildDigest
          }
        ]
      }
    });
  assert.throws(
    () =>
      assertDeployedBootstrapReleaseIdentity(detail("0".repeat(40)), expected),
    /SURF_SOURCE_REVISION/
  );
  assert.throws(
    () =>
      assertDeployedBootstrapReleaseIdentity(detail(expected.sourceRevision), {
        ...expected,
        sourceRevision: "0".repeat(40)
      }),
    /Expected bootstrap release identity is invalid/
  );
});

test("bootstrap release identity refuses the all-zero source sentinel", () => {
  const root = temporaryDirectory("surf-bootstrap-zero-identity-");
  try {
    const sourcePath = resolve(root, "wrangler.source.jsonc");
    const bundlePath = resolve(root, "index.js");
    writeFileSync(sourcePath, readFileSync(trackedWranglerConfig), {
      mode: 0o600
    });
    writeFileSync(bundlePath, "export default {};\n", { mode: 0o600 });
    assert.throws(
      () =>
        stageExactBootstrapWranglerConfig({
          sourcePath,
          releaseRoot: repoRoot,
          sourceRevision: "0".repeat(40),
          clientBuildDigest: "b".repeat(64),
          workerBundlePath: bundlePath
        }),
      /exact nonzero Git commit/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap source identity is bound to a clean exact Git commit", () => {
  const root = temporaryDirectory("surf-bootstrap-git-identity-");
  try {
    for (const path of ["apps/web/public", "apps/web/src"]) {
      mkdirSync(resolve(root, path), { recursive: true });
    }
    for (const [path, contents] of [
      ["apps/web/index.html", "<main></main>\n"],
      ["apps/web/package.json", "{}\n"],
      ["apps/web/public/favicon.svg", "<svg/>\n"],
      ["apps/web/src/main.tsx", "export {};\n"],
      ["apps/web/vite.config.ts", "export default {};\n"]
    ]) {
      writeFileSync(resolve(root, path), contents);
    }
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Surf Test",
        "-c",
        "user.email=surf-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture"
      ],
      { cwd: root }
    );

    const identity = resolveExactBootstrapSourceIdentity(root);
    assert.match(identity.sourceRevision, /^[0-9a-f]{40}$/);
    assert.notEqual(identity.sourceRevision, "0".repeat(40));
    assert.match(identity.clientBuildDigest, /^[0-9a-f]{64}$/);
    identity.assertUnchanged();

    writeFileSync(
      resolve(root, "apps/web/src/main.tsx"),
      "export const drift = true;\n"
    );
    assert.throws(
      identity.assertUnchanged,
      /changed after build identity was pinned/
    );
    assert.throws(
      () => resolveExactBootstrapSourceIdentity(root),
      /requires a clean Git worktree/
    );
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
