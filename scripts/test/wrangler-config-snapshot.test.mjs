import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  stageWranglerConfigSnapshot,
  verifyWranglerConfigSnapshot
} from "../lib/wrangler-config-snapshot.mjs";

const tracked = new URL("../../apps/web/wrangler.jsonc", import.meta.url);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "surf-wrangler-snapshot-"));
  const releaseRoot = join(root, "release");
  const trackedPath = join(releaseRoot, "apps/web/wrangler.jsonc");
  mkdirSync(dirname(trackedPath), { recursive: true });
  writeFileSync(trackedPath, readFileSync(tracked, "utf8"));
  const config = parse(readFileSync(tracked, "utf8"));
  config.vars.NARRATIVE_ENABLED = "true";
  const sourcePath = join(root, "source/wrangler.instance.jsonc");
  const outputPath = join(root, "activation/wrangler.instance.jsonc");
  mkdirSync(dirname(sourcePath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(sourcePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { root, releaseRoot, sourcePath, outputPath };
}

test("stages one release-bound private Wrangler snapshot and verifies its hash", () => {
  const candidate = fixture();
  try {
    const staged = stageWranglerConfigSnapshot(candidate);
    assert.match(staged.sha256, /^[0-9a-f]{64}$/);
    assert.equal(staged.path, realpathSync(candidate.outputPath));
    assert.equal(staged.config.main, join(realpathSync(candidate.releaseRoot), "apps/web/worker/index.ts"));
    assert.equal(
      staged.config.d1_databases[0].migrations_dir,
      join(realpathSync(candidate.releaseRoot), "packages/db/migrations")
    );
    assert.deepEqual(
      verifyWranglerConfigSnapshot({
        path: candidate.outputPath,
        releaseRoot: candidate.releaseRoot,
        expectedSha256: staged.sha256
      }),
      staged
    );

    writeFileSync(candidate.sourcePath, "{}\n", { mode: 0o600 });
    assert.equal(
      verifyWranglerConfigSnapshot({
        path: candidate.outputPath,
        releaseRoot: candidate.releaseRoot,
        expectedSha256: staged.sha256
      }).sha256,
      staged.sha256
    );
    writeFileSync(candidate.outputPath, `${readFileSync(candidate.outputPath, "utf8")} `, {
      mode: 0o600
    });
    assert.throws(
      () =>
        verifyWranglerConfigSnapshot({
          path: candidate.outputPath,
          releaseRoot: candidate.releaseRoot,
          expectedSha256: staged.sha256
        }),
      /SHA-256 does not match activation/
    );
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("pins exact release identity into the private snapshot", () => {
  const candidate = fixture();
  try {
    const staged = stageWranglerConfigSnapshot({
      ...candidate,
      releaseIdentity: {
        sourceRevision: "1".repeat(40),
        workerRuntimeDigest: "2".repeat(64),
        clientBuildDigest: "3".repeat(64)
      }
    });
    assert.equal(staged.config.vars.SURF_SOURCE_REVISION, "1".repeat(40));
    assert.equal(
      staged.config.vars.SURF_WORKER_RUNTIME_DIGEST,
      "2".repeat(64)
    );
    assert.equal(staged.config.vars.SURF_CLIENT_BUILD_DIGEST, "3".repeat(64));
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("repins a trusted private source from a prior immutable release layout", () => {
  const candidate = fixture();
  try {
    const source = parse(readFileSync(candidate.sourcePath, "utf8"));
    const prior = "/srv/surf/releases/" + "a".repeat(40);
    source.$schema = `${prior}/apps/web/node_modules/wrangler/config-schema.json`;
    source.main = `${prior}/apps/web/worker/index.ts`;
    source.assets.directory = `${prior}/apps/web/dist/client`;
    source.d1_databases[0].migrations_dir = `${prior}/packages/db/migrations`;
    writeFileSync(candidate.sourcePath, `${JSON.stringify(source)}\n`, { mode: 0o600 });
    const staged = stageWranglerConfigSnapshot(candidate);
    assert.equal(staged.config.main.endsWith("/apps/web/worker/index.ts"), true);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("rejects incomplete release identity before writing", () => {
  const candidate = fixture();
  try {
    assert.throws(
      () =>
        stageWranglerConfigSnapshot({
          ...candidate,
          releaseIdentity: {
            sourceRevision: "1".repeat(40),
            clientBuildDigest: "3".repeat(64)
          }
        }),
      /must contain exactly/
    );
    assert.throws(() => readFileSync(candidate.outputPath), /ENOENT/);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("rejects permissive, symlinked, in-release, and reused snapshot inputs", () => {
  const permissive = fixture();
  try {
    chmodSync(permissive.sourcePath, 0o640);
    assert.throws(() => stageWranglerConfigSnapshot(permissive), /mode 0600/);
  } finally {
    rmSync(permissive.root, { recursive: true, force: true });
  }

  const linked = fixture();
  try {
    const alias = join(linked.root, "source/current.jsonc");
    symlinkSync(linked.sourcePath, alias);
    assert.throws(
      () => stageWranglerConfigSnapshot({ ...linked, sourcePath: alias }),
      /non-symlink/
    );
  } finally {
    rmSync(linked.root, { recursive: true, force: true });
  }

  const inside = fixture();
  try {
    const outputPath = join(inside.releaseRoot, "apps/web/pinned.jsonc");
    assert.throws(
      () => stageWranglerConfigSnapshot({ ...inside, outputPath }),
      /outside the immutable release/
    );
  } finally {
    rmSync(inside.root, { recursive: true, force: true });
  }

  const reused = fixture();
  try {
    stageWranglerConfigSnapshot(reused);
    const config = parse(readFileSync(reused.sourcePath, "utf8"));
    config.name = "different-surf";
    writeFileSync(reused.sourcePath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    assert.throws(
      () => stageWranglerConfigSnapshot(reused),
      /Existing Wrangler config snapshot differs/
    );
  } finally {
    rmSync(reused.root, { recursive: true, force: true });
  }
});
