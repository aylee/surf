import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProductionChildEnvironment,
  createReleaseLocalEnvironment,
  inspectWorkerSecrets,
  requireProductionIngestToken,
  stageWorkerSecretsSnapshot,
  validateProductionOperatorEnvironment
} from "../lib/release-secrets.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "surf-release-secrets-"));
  const privateRoot = realpathSync(root);
  mkdirSync(join(privateRoot, "snapshots"), { mode: 0o700 });
  const sourcePath = join(privateRoot, "worker.env");
  writeFileSync(
    sourcePath,
    `GEMINI_API_KEY=${"g".repeat(32)}\nNARRATIVE_RESULT_TOKEN=${"r".repeat(32)}\n`,
    { mode: 0o600 }
  );
  return {
    root,
    sourcePath,
    outputPath: join(privateRoot, "snapshots", "worker.json"),
    hmacKey: "h".repeat(32)
  };
}

test("inspects without writing and stages an immutable private snapshot", () => {
  const candidate = fixture();
  try {
    const inspected = inspectWorkerSecrets(candidate);
    assert.match(inspected.fingerprint, /^[0-9a-f]{64}$/);
    const staged = stageWorkerSecretsSnapshot(candidate);
    assert.equal(staged.fingerprint, inspected.fingerprint);
    assert.equal(stageWorkerSecretsSnapshot(candidate).path, staged.path);
    staged.assertUnchanged();
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("rejects drift, permissive input, extra keys, and snapshot reuse", () => {
  const candidate = fixture();
  try {
    const staged = stageWorkerSecretsSnapshot(candidate);
    writeFileSync(
      candidate.sourcePath,
      `GEMINI_API_KEY=${"x".repeat(32)}\nNARRATIVE_RESULT_TOKEN=${"r".repeat(32)}\n`,
      { mode: 0o600 }
    );
    assert.throws(staged.assertUnchanged, /changed/);
    assert.throws(() => stageWorkerSecretsSnapshot(candidate), /differs/);
    chmodSync(candidate.sourcePath, 0o640);
    assert.throws(() => inspectWorkerSecrets(candidate), /mode-0600/);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }

  const extra = fixture();
  try {
    writeFileSync(
      extra.sourcePath,
      `GEMINI_API_KEY=${"g".repeat(32)}\nNARRATIVE_RESULT_TOKEN=${"r".repeat(32)}\nEXTRA=no\n`,
      { mode: 0o600 }
    );
    assert.throws(() => inspectWorkerSecrets(extra), /exactly/);
  } finally {
    rmSync(extra.root, { recursive: true, force: true });
  }
});

test("rejects a secret source replaced by a symlink after inspection", () => {
  const candidate = fixture();
  try {
    const inspected = inspectWorkerSecrets(candidate);
    const movedPath = join(candidate.root, "moved-worker.env");
    renameSync(candidate.sourcePath, movedPath);
    symlinkSync(movedPath, candidate.sourcePath);
    assert.throws(inspected.assertUnchanged, /non-symlink/);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("rejects oversized secret sources before parsing them", () => {
  const candidate = fixture();
  try {
    writeFileSync(candidate.sourcePath, Buffer.alloc(1024 * 1024 + 1, 0x20), {
      mode: 0o600
    });
    assert.throws(() => inspectWorkerSecrets(candidate), /bounded/);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("rejects a symlinked preexisting snapshot without following it", () => {
  const candidate = fixture();
  try {
    const victimPath = join(candidate.root, "victim.json");
    const victimContents = "do not modify\n";
    writeFileSync(victimPath, victimContents, { mode: 0o600 });
    symlinkSync(victimPath, candidate.outputPath);
    assert.throws(() => stageWorkerSecretsSnapshot(candidate), /non-symlink/);
    assert.equal(readFileSync(victimPath, "utf8"), victimContents);
  } finally {
    rmSync(candidate.root, { recursive: true, force: true });
  }
});

test("operator environment rejects process-control injection and validates ingest early", () => {
  const valid = validateProductionOperatorEnvironment({
    CLOUDFLARE_API_TOKEN: "c".repeat(32),
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    SURF_INGEST_TOKEN: "i".repeat(32)
  });
  assert.equal(requireProductionIngestToken(valid), "i".repeat(32));
  for (const key of ["PATH", "HOME", "NODE_OPTIONS", "PNPM_HOME"]) {
    assert.throws(
      () =>
        validateProductionOperatorEnvironment({
          CLOUDFLARE_API_TOKEN: "c".repeat(32),
          CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
          [key]: "/tmp/attacker"
        }),
      /unsupported setting/
    );
  }
  assert.throws(
    () =>
      requireProductionIngestToken(
        validateProductionOperatorEnvironment({
          CLOUDFLARE_API_TOKEN: "c".repeat(32),
          CLOUDFLARE_ACCOUNT_ID: "a".repeat(32)
        })
      ),
    /SURF_INGEST_TOKEN/
  );
  assert.throws(
    () =>
      validateProductionOperatorEnvironment({
        CLOUDFLARE_API_TOKEN: "c".repeat(32)
      }),
    /CLOUDFLARE_ACCOUNT_ID/
  );
});

test("release child environments contain only bounded system and production keys", () => {
  const system = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/test",
    NODE_OPTIONS: "--require=/tmp/attack.cjs",
    CLOUDFLARE_API_KEY: "ambient-key",
    CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
    WRANGLER_CONFIG: "/tmp/wrong.jsonc"
  };
  assert.deepEqual(createReleaseLocalEnvironment(system), {
    HOME: "/Users/test",
    PATH: "/usr/bin:/bin"
  });
  const child = createProductionChildEnvironment({
    systemEnvironment: system,
    operatorEnvironment: {
      CLOUDFLARE_API_TOKEN: "c".repeat(32),
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      SURF_INGEST_TOKEN: "i".repeat(32)
    },
    baseUrl: "https://surf.example"
  });
  assert.equal(child.CLOUDFLARE_ACCOUNT_ID, "a".repeat(32));
  assert.equal(child.CLOUDFLARE_API_TOKEN, "c".repeat(32));
  assert.equal(child.SURF_INGEST_TOKEN, undefined);
  assert.equal(child.NODE_OPTIONS, undefined);
  assert.equal(child.CLOUDFLARE_API_KEY, undefined);
  assert.equal(child.WRANGLER_CONFIG, undefined);
});
