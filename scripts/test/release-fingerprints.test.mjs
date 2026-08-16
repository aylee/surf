import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertRoutineNarrativeContractTransition,
  assertRoutineRunnerRuntimeTransition,
  assertRoutineWorkerSecretTransition,
  computeReleaseFingerprints,
  fingerprintReleasePaths,
  logicalWranglerConfig,
  privateFileHmacFingerprint,
  queueTopologyFingerprint,
  runnerReplacementRequired,
  secretHmacFingerprint,
  sha256File
} from "../lib/release-fingerprints.mjs";

const repository = new URL("../..", import.meta.url).pathname;

test("logical Wrangler fingerprint omits per-release identity only", () => {
  const config = logicalWranglerConfig(join(repository, "apps/web/wrangler.jsonc"));
  assert.equal("SURF_SOURCE_REVISION" in config.vars, false);
  assert.equal("SURF_WORKER_RUNTIME_DIGEST" in config.vars, false);
  assert.equal("SURF_CLIENT_BUILD_DIGEST" in config.vars, false);
  assert.equal(typeof config.name, "string");
});

test("Queue-topology fingerprints authenticate the exact configured Queue set", () => {
  const config = logicalWranglerConfig(join(repository, "apps/web/wrangler.jsonc"));
  const expected = queueTopologyFingerprint(config);
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.notEqual(
    queueTopologyFingerprint({
      ...config,
      queues: {
        ...config.queues,
        producers: config.queues.producers.slice(1)
      }
    }),
    expected
  );
});

test("file fingerprints are order-independent and reject traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "surf-fingerprints-"));
  try {
    writeFileSync(join(root, "a"), "a");
    writeFileSync(join(root, "b"), "b");
    assert.equal(
      fingerprintReleasePaths(root, ["a", "b"]),
      fingerprintReleasePaths(root, ["b", "a"])
    );
    assert.throws(() => fingerprintReleasePaths(root, ["../a"]), /unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source fingerprints ignore installed dependency links but reject source links", () => {
  const root = mkdtempSync(join(tmpdir(), "surf-fingerprint-links-"));
  try {
    const packageRoot = join(root, "packages/contracts");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "index.ts"), "export const value = 1;\n");
    const expected = fingerprintReleasePaths(root, ["packages/contracts"]);

    mkdirSync(join(packageRoot, "node_modules"));
    symlinkSync(root, join(packageRoot, "node_modules/typescript"));
    assert.equal(
      fingerprintReleasePaths(root, ["packages/contracts"]),
      expected
    );

    symlinkSync(join(packageRoot, "index.ts"), join(packageRoot, "alias.ts"));
    assert.throws(
      () => fingerprintReleasePaths(root, ["packages/contracts"]),
      /must not be a symlink/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config and digest snapshots reject symlink and oversized inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "surf-config-snapshot-"));
  try {
    const configPath = join(root, "wrangler.jsonc");
    const digestPath = join(root, "artifact.js");
    writeFileSync(configPath, "{}\n");
    writeFileSync(digestPath, "artifact\n");
    const configAlias = join(root, "wrangler-alias.jsonc");
    const digestAlias = join(root, "artifact-alias.js");
    symlinkSync(configPath, configAlias);
    symlinkSync(digestPath, digestAlias);
    assert.throws(() => logicalWranglerConfig(configAlias), /non-symlink/);
    assert.throws(() => sha256File(digestAlias), /non-symlink/);

    writeFileSync(configPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    assert.throws(() => logicalWranglerConfig(configPath), /bounded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret fingerprints require private input and do not expose contents", () => {
  const root = mkdtempSync(join(tmpdir(), "surf-secret-fingerprint-"));
  const path = join(root, "worker.env");
  try {
    writeFileSync(path, "TOKEN=very-secret-value\n", { mode: 0o600 });
    const fingerprint = secretHmacFingerprint({
      secretPath: path,
      hmacKey: "k".repeat(32)
    });
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(fingerprint.includes("secret"), false);
    assert.notEqual(
      privateFileHmacFingerprint({
        path,
        hmacKey: "k".repeat(32),
        domain: "surf-release-runner-runtime-v1"
      }),
      fingerprint
    );
    const alias = join(root, "worker-alias.env");
    symlinkSync(path, alias);
    assert.throws(
      () => secretHmacFingerprint({ secretPath: alias, hmacKey: "k".repeat(32) }),
      /non-symlink/
    );
    chmodSync(path, 0o640);
    assert.throws(
      () => secretHmacFingerprint({ secretPath: path, hmacKey: "k".repeat(32) }),
      /mode-0600/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("computes the complete exact fingerprint schema", () => {
  const root = mkdtempSync(join(tmpdir(), "surf-complete-fingerprints-"));
  try {
    for (const input of [
      "apps/web/worker",
      "packages/forecast-core/src",
      "services/extractor/src",
      "packages/db/migrations",
      "packages/db/seeds",
      "packages/contracts",
      "scripts"
    ]) {
      mkdirSync(join(root, input), { recursive: true });
      writeFileSync(join(root, input, "input.txt"), input);
    }
    for (const file of [
      "apps/web/worker/forecast-history.ts",
      "apps/web/worker/forecast-read-model.ts",
      "apps/web/worker/forecast-readiness.ts",
      "apps/web/worker/forecast.ts",
      "apps/web/worker/index.ts",
      "apps/web/package.json",
      "apps/web/vite.config.ts",
      "services/extractor/pyproject.toml",
      "services/extractor/uv.lock",
      "package.json",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "pnpm-lock.yaml"
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), file);
    }
    for (const file of [
      "apps/narrative-runner/package.json",
      "apps/narrative-runner/examples/runner.plist.example",
      "apps/narrative-runner/scripts/build-runner.mjs",
      "apps/narrative-runner/scripts/install-launch-agents.mjs",
      "apps/narrative-runner/scripts/manage-launch-agents.mjs",
      "apps/narrative-runner/scripts/render-launch-agents.mjs",
      "apps/narrative-runner/scripts/run-verified-runner.mjs",
      "apps/narrative-runner/scripts/supervise-omlx.sh"
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), file);
    }
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    writeFileSync(join(root, "scripts/lib/strict-env-file.mjs"), "strict env");
    writeFileSync(
      join(root, "scripts/lib/verified-file-snapshot.mjs"),
      "verified snapshot"
    );
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    mkdirSync(join(root, "apps/web/public"), { recursive: true });
    writeFileSync(join(root, "apps/web/index.html"), "index");
    writeFileSync(join(root, "apps/web/src/App.tsx"), "app");
    writeFileSync(join(root, "apps/web/public/icon.svg"), "icon");
    const wranglerPath = join(root, "wrangler.jsonc");
    cpSync(join(repository, "apps/web/wrangler.jsonc"), wranglerPath);
    const secretPath = join(root, "worker.env");
    writeFileSync(secretPath, "TOKEN=value\n", { mode: 0o600 });
    const workerBundlePath = join(root, "worker.js");
    const runnerBundlePath = join(root, "runner.js");
    const runnerEnvironmentPath = join(root, "runner.env");
    writeFileSync(workerBundlePath, "worker");
    writeFileSync(runnerBundlePath, "runner");
    writeFileSync(runnerEnvironmentPath, "RUNNER=value\n", { mode: 0o600 });
    const fingerprints = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.equal(Object.keys(fingerprints).length, 15);
    assert.ok(Object.values(fingerprints).every((value) => /^[0-9a-f]{64}$/.test(value)));

    writeFileSync(join(root, "apps/web/worker/index.ts"), "changed dispatch");
    const dispatchChanged = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.notEqual(dispatchChanged.materialization, fingerprints.materialization);

    writeFileSync(join(root, "apps/web/worker/time.ts"), "changed time semantics");
    const timeChanged = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.notEqual(timeChanged.materialization, dispatchChanged.materialization);

    mkdirSync(join(root, "apps/web/worker/brief"), { recursive: true });
    writeFileSync(join(root, "apps/web/worker/brief/facts.ts"), "changed facts");
    const briefChanged = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.notEqual(briefChanged.materialization, timeChanged.materialization);

    writeFileSync(join(root, "apps/web/worker/time.test.ts"), "test-only change");
    mkdirSync(join(root, "services/extractor/src/__pycache__"), {
      recursive: true
    });
    writeFileSync(
      join(root, "services/extractor/src/__pycache__/extractor.pyc"),
      "generated bytecode"
    );
    const testChanged = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.equal(testChanged.materialization, briefChanged.materialization);

    writeFileSync(
      wranglerPath,
      readFileSync(wranglerPath, "utf8").replace(
        '"queue": "surf-narrative"',
        '"queue": "surf-narrative-v2"'
      )
    );
    const queueChanged = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.notEqual(queueChanged.queueTopology, fingerprints.queueTopology);
    assert.equal(queueChanged.logicalConfig, fingerprints.logicalConfig);

    writeFileSync(
      wranglerPath,
      readFileSync(wranglerPath, "utf8").replace(
        '"crons": ["17 * * * *"]',
        '"crons": ["23 * * * *"]'
      )
    );
    const triggerChanged = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.notEqual(triggerChanged.triggerTopology, queueChanged.triggerTopology);
    assert.equal(triggerChanged.logicalConfig, fingerprints.logicalConfig);

    writeFileSync(
      join(root, "apps/narrative-runner/scripts/run-verified-runner.mjs"),
      "changed guard"
    );
    const changed = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.notEqual(changed.runnerArtifact, fingerprints.runnerArtifact);
    writeFileSync(
      join(root, "scripts/lib/verified-file-snapshot.mjs"),
      "changed verified snapshot"
    );
    const transitiveChanged = computeReleaseFingerprints({
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath: wranglerPath,
      workerSecretsPath: secretPath,
      secretFingerprintKey: "h".repeat(32),
      narrativeProtocolFingerprint: "f".repeat(64)
    });
    assert.notEqual(transitiveChanged.runnerArtifact, changed.runnerArtifact);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner replacement depends on artifact and runtime configuration", () => {
  const fingerprints = Object.fromEntries(
    [
      "workerAssets",
      "workerRuntime",
      "materialization",
      "migrations",
      "seed",
      "queueTopology",
      "triggerTopology",
      "runnerArtifact",
      "runnerRuntime",
      "narrativeContract",
      "logicalConfig",
      "workerSecrets",
      "dependencyLock",
      "sharedWorkspace",
      "releaseTooling"
    ].map((key, index) => [key, index.toString(16).padStart(64, "0")])
  );
  assert.equal(
    runnerReplacementRequired({
      targetFingerprints: fingerprints,
      activeFingerprints: fingerprints
    }),
    false
  );
  assert.equal(
    runnerReplacementRequired({
      targetFingerprints: fingerprints,
      activeFingerprints: { ...fingerprints, runnerRuntime: "f".repeat(64) }
    }),
    true
  );
  assert.equal(
    runnerReplacementRequired({
      targetFingerprints: fingerprints,
      activeFingerprints: null
    }),
    true
  );
});

test("routine releases reject protocol changes even with a dual-compatible runner", () => {
  const activeFingerprint = "a".repeat(64);
  const targetFingerprint = "b".repeat(64);
  assert.throws(
    () =>
      assertRoutineNarrativeContractTransition({
        activeFingerprint,
        targetFingerprint,
        runnerAcceptedFingerprints: [activeFingerprint, targetFingerprint]
      }),
    /outside the routine release command/
  );
  assert.throws(
    () =>
      assertRoutineNarrativeContractTransition({
        activeFingerprint,
        targetFingerprint,
        runnerAcceptedFingerprints: [targetFingerprint]
      }),
    /expand\/migrate\/contract/
  );
  assert.doesNotThrow(() =>
    assertRoutineNarrativeContractTransition({
      activeFingerprint,
      targetFingerprint: activeFingerprint,
      runnerAcceptedFingerprints: [activeFingerprint]
    })
  );
});

test("Worker secret changes are excluded from routine releases", () => {
  const activeFingerprint = "a".repeat(64);
  assert.doesNotThrow(() =>
    assertRoutineWorkerSecretTransition({
      activeFingerprint,
      targetFingerprint: activeFingerprint
    })
  );
  assert.throws(
    () =>
      assertRoutineWorkerSecretTransition({
        activeFingerprint,
        targetFingerprint: "b".repeat(64)
      }),
    /explicit coordinated rotation/
  );
});

test("runner tunables may change while model and secret changes stay coordinated", (t) => {
  const activeFingerprint = "a".repeat(64);
  assert.doesNotThrow(() =>
    assertRoutineRunnerRuntimeTransition({
      activeFingerprint,
      targetFingerprint: activeFingerprint
    })
  );
  assert.throws(
    () =>
      assertRoutineRunnerRuntimeTransition({
        activeFingerprint,
        targetFingerprint: "b".repeat(64)
      }),
    /exact active and target environment evidence/
  );
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "surf-runner-runtime-transition-"))
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const activePath = join(root, "active.env");
  const targetPath = join(root, "target.env");
  const environment = {
    NARRATIVE_RUNNER_OMLX_MODEL: "model-v1",
    NARRATIVE_RUNNER_STATUS_HMAC_KEY: "h".repeat(32),
    NARRATIVE_RUNNER_CF_API_TOKEN: "c".repeat(32),
    NARRATIVE_RUNNER_OMLX_API_TOKEN: "o".repeat(32),
    NARRATIVE_RUNNER_TARGET_MAP_JSON:
      '{"norcal":{"tokenEnv":"SURF_NARRATIVE_RESULT_TOKEN"}}',
    SURF_NARRATIVE_RESULT_TOKEN: "r".repeat(32),
    NARRATIVE_RUNNER_CONCURRENCY: "1"
  };
  const writeEnvironment = (path, values) => {
    writeFileSync(
      path,
      `${Object.entries(values)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 }
    );
    chmodSync(path, 0o600);
  };
  writeEnvironment(activePath, environment);
  writeEnvironment(targetPath, {
    ...environment,
    NARRATIVE_RUNNER_CONCURRENCY: "2"
  });
  assert.doesNotThrow(() =>
    assertRoutineRunnerRuntimeTransition({
      activeFingerprint,
      targetFingerprint: "b".repeat(64),
      activeEnvironmentPath: activePath,
      targetEnvironmentPath: targetPath,
      hmacKey: "k".repeat(32)
    })
  );
  writeEnvironment(targetPath, {
    ...environment,
    NARRATIVE_RUNNER_CF_API_TOKEN: "x".repeat(32)
  });
  assert.throws(
    () =>
      assertRoutineRunnerRuntimeTransition({
        activeFingerprint,
        targetFingerprint: "b".repeat(64),
        activeEnvironmentPath: activePath,
        targetEnvironmentPath: targetPath,
        hmacKey: "k".repeat(32)
      }),
    /secret rotation/
  );
  writeEnvironment(targetPath, {
    ...environment,
    NARRATIVE_RUNNER_OMLX_MODEL: "model-v2"
  });
  assert.throws(
    () =>
      assertRoutineRunnerRuntimeTransition({
        activeFingerprint,
        targetFingerprint: "b".repeat(64),
        activeEnvironmentPath: activePath,
        targetEnvironmentPath: targetPath,
        hmacKey: "k".repeat(32)
      }),
    /model changes/
  );
});
