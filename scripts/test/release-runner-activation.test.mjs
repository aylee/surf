import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activateTargetRunner,
  stageRunnerEnvironment
} from "../lib/release-runner-activation.mjs";

function runnerEnv(sha, status) {
  return [
    `NARRATIVE_RUNNER_RELEASE_SHA=${sha}`,
    `NARRATIVE_RUNNER_STATUS_FILE=${status}`,
    "NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS=900000"
  ].join("\n") + "\n";
}

test("stages release-bound runner identity without changing the source", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "surf-runner-stage-")));
  try {
    const source = join(root, "source.env");
    const output = join(root, "target.env");
    writeFileSync(source, runnerEnv("1".repeat(40), join(root, "old.json")), {
      mode: 0o600
    });
    const staged = stageRunnerEnvironment({
      sourcePath: source,
      outputPath: output,
      sourceRevision: "2".repeat(40),
      statusFile: join(root, "new.json")
    });
    assert.equal(staged.values.NARRATIVE_RUNNER_RELEASE_SHA, "2".repeat(40));
    assert.equal(staged.values.NARRATIVE_RUNNER_STATUS_FILE, join(root, "new.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renders and activates v4 from an attested legacy predecessor", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "surf-runner-activate-")));
  try {
    const serviceRoot = join(root, "service");
    const releaseRoot = join(root, "release");
    mkdirSync(serviceRoot);
    mkdirSync(releaseRoot);
    const envSource = join(root, "runner.env");
    writeFileSync(envSource, runnerEnv("1".repeat(40), join(root, "old.json")), {
      mode: 0o600
    });
    const priorRecordPath = join(root, "prior.json");
    writeFileSync(
      priorRecordPath,
      `${JSON.stringify({
        schemaVersion: 3,
        executables: {
          node: { path: "/runtime/bin/node" },
          omlx: { path: "/runtime/bin/omlx" }
        },
        modelArtifact: { path: "/models-root/models/model-1" }
      })}\n`,
      { mode: 0o600 }
    );
    const calls = [];
    const result = await activateTargetRunner(
      {
        targetReleaseRoot: releaseRoot,
        targetGitSha: "2".repeat(40),
        activationId: "activation-2",
        serviceRoot,
        runnerEnvironmentSourcePath: envSource,
        runnerArtifactPath: join(releaseRoot, "runner.mjs"),
        runnerArtifactManifestPath: join(releaseRoot, "runner.json"),
        priorRecordPath,
        environment: {}
      },
      {
        verifyActivation: async (path, options) => {
          calls.push(["verify", path, options.allowLegacyV3, options.requireInstalled]);
        },
        render: async (options) => {
          calls.push(["render", options]);
          const recordPath = join(options.outputDir, "activation-record.json");
          writeFileSync(recordPath, "{}\n", { mode: 0o600 });
          return { activationRecordPath: recordPath };
        },
        activate: async (options) => {
          calls.push(["activate", options]);
        }
      }
    );
    assert.equal(result.activationId, "activation-2");
    assert.deepEqual(calls.map(([name]) => name), ["verify", "render", "activate", "verify"]);
    assert.equal(calls[0][2], true);
    assert.equal(calls[0][3], false);
    assert.equal(calls.at(-1)[2], false);
    assert.equal(calls.at(-1)[3], true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
