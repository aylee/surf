import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { clientBuildDigest } from "../lib/build-identity.mjs";
import { executeRelease } from "../lib/release-controller.mjs";
import { listChangedReleasePaths } from "../lib/immutable-release.mjs";
import { computeReleaseFingerprints } from "../lib/release-fingerprints.mjs";
import {
  RELEASE_LANES,
  classifyReleaseImpact,
  createTrustedActiveReleaseReceipt
} from "../lib/release-impact.mjs";
import {
  RELEASE_JOURNAL_STATES,
  createReleaseJournal,
  createReleaseStateStore
} from "../lib/release-journal.mjs";

const predecessorSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const predecessorWorkerVersionId =
  "11111111-1111-4111-8111-111111111111";
const predecessorDeploymentId =
  "22222222-2222-4222-8222-222222222222";
const targetWorkerVersionId = "33333333-3333-4333-8333-333333333333";
const targetDeploymentId = "44444444-4444-4444-8444-444444444444";
const protocolFingerprint = "5".repeat(64);
const secretFingerprintKey = "acceptance-test-hmac-key-material";

const stableFiles = Object.freeze({
  "apps/narrative-runner/examples/runner.plist.example": "runner plist",
  "apps/narrative-runner/package.json": "narrative runner package",
  "apps/narrative-runner/scripts/build-runner.mjs": "build runner",
  "apps/narrative-runner/scripts/install-launch-agents.mjs": "install agents",
  "apps/narrative-runner/scripts/manage-launch-agents.mjs": "manage agents",
  "apps/narrative-runner/scripts/render-launch-agents.mjs": "render agents",
  "apps/narrative-runner/scripts/run-verified-runner.mjs": "verify runner",
  "apps/narrative-runner/scripts/supervise-omlx.sh": "supervise omlx",
  "apps/web/index.html": "<main id=\"root\"></main>",
  "apps/web/package.json": "web package",
  "apps/web/public/favicon.svg": "<svg></svg>",
  "apps/web/vite.config.ts": "export default {};",
  "apps/web/worker/adapters/provider.ts": "export const provider = true;",
  "apps/web/worker/forecast-history.ts": "export const history = true;",
  "apps/web/worker/forecast-read-model.ts": "export const readModel = true;",
  "apps/web/worker/forecast-readiness.ts": "export const readiness = true;",
  "apps/web/worker/forecast.ts": "export const forecast = true;",
  "apps/web/worker/index.ts": "export default {};",
  "apps/web/worker/ingest/index.ts": "export const ingest = true;",
  "apps/web/worker/time.ts": "export const time = true;",
  "package.json": "root package",
  "packages/contracts/src/index.ts": "export const contract = true;",
  "packages/db/migrations/0001.sql": "create table spot (id text);",
  "packages/db/seeds/spots.sql": "insert into spot values ('cowells');",
  "packages/forecast-core/src/index.ts": "export const score = true;",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
  "scripts/lib/strict-env-file.mjs": "export const strict = true;",
  "scripts/lib/verified-file-snapshot.mjs": "export const verified = true;",
  "services/extractor/pyproject.toml": "[project]\nname = 'extractor'\n",
  "services/extractor/src/extractor.py": "def extract(): return True\n",
  "services/extractor/uv.lock": "version = 1\n",
  "tsconfig.base.json": "{}"
});

function writeFixtureFile(root, path, contents, mode = undefined) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents, mode === undefined ? undefined : { mode });
  return destination;
}

function runGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createReleaseRoot(parent, name, { app, appTest, styles }) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  for (const [path, contents] of Object.entries(stableFiles)) {
    writeFixtureFile(root, path, contents);
  }
  writeFixtureFile(root, "apps/web/src/App.tsx", app);
  writeFixtureFile(root, "apps/web/src/App.test.tsx", appTest);
  writeFixtureFile(root, "apps/web/src/styles.css", styles);

  const wranglerSourcePath = writeFixtureFile(
    root,
    "release-inputs/wrangler.jsonc",
    JSON.stringify({
      name: "surf-acceptance",
      vars: {
        SURF_SOURCE_REVISION: targetSha,
        SURF_WORKER_RUNTIME_DIGEST: "6".repeat(64),
        SURF_CLIENT_BUILD_DIGEST: "7".repeat(64),
        PUBLIC_VALUE: "stable"
      },
      queues: {
        producers: [{ binding: "NARRATIVE_JOBS_QUEUE", queue: "jobs" }],
        consumers: [{ queue: "jobs", dead_letter_queue: "jobs-dlq" }]
      },
      triggers: { crons: ["17 * * * *"] }
    })
  );
  const workerBundlePath = writeFixtureFile(
    root,
    "release-inputs/worker.js",
    "export default { fetch() {} };"
  );
  const runnerBundlePath = writeFixtureFile(
    root,
    "release-inputs/runner.js",
    "export const run = true;"
  );
  const runnerEnvironmentPath = writeFixtureFile(
    root,
    "release-inputs/runner.env",
    "MODEL=stable\n",
    0o600
  );
  const workerSecretsPath = writeFixtureFile(
    root,
    "release-inputs/worker.env",
    "INGEST_TOKEN=stable\n",
    0o600
  );

  return {
    root,
    inputs: {
      releaseRoot: root,
      workerBundlePath,
      runnerBundlePath,
      runnerEnvironmentPath,
      wranglerSourcePath,
      workerSecretsPath,
      secretFingerprintKey,
      narrativeProtocolFingerprint: protocolFingerprint
    }
  };
}

function releaseOperations(trace) {
  let activated = false;
  const record = (name, value) => async () => {
    trace.push(name);
    return value;
  };
  return {
    verify: record("release:verify"),
    prepare: record("worker:prepare", {
      profileSha256: "8".repeat(64),
      operatorEnvironmentFingerprint: "9".repeat(64),
      wranglerConfigSha256: "9".repeat(64),
      workerSecretsFingerprint: "a".repeat(64)
    }),
    uploadWorker: record("worker:upload", {
      workerVersionId: targetWorkerVersionId
    }),
    prepareData: async () => {
      trace.push(
        "d1:backup",
        "d1:migrate",
        "d1:seed",
        "queue:reconcile"
      );
      return { d1Bookmark: "bookmark", d1ExportSha256: "b".repeat(64) };
    },
    ensureRunner: record("runner:ensure", {
      runnerActivationId: "runner-target"
    }),
    recheckPredecessor: record("worker:recheck-predecessor"),
    inspectActivation: async () => {
      trace.push("worker:inspect-activation");
      return activated
        ? {
            state: "target",
            workerVersionId: targetWorkerVersionId,
            deploymentId: targetDeploymentId
          }
        : {
            state: "predecessor",
            workerVersionId: predecessorWorkerVersionId,
            deploymentId: predecessorDeploymentId
          };
    },
    activateWorker: async () => {
      trace.push("worker:activate");
      activated = true;
      return { deploymentId: targetDeploymentId };
    },
    waitUntilServing: record("worker:wait-until-serving"),
    inspectTriggers: record("trigger:inspect", { matches: false }),
    syncTriggers: record("trigger:sync"),
    inspectGeneration: record("generation:inspect", null),
    generate: record("generation:force", { generationId: "generation-target" }),
    verifyLive: record("release:verify-live")
  };
}

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 15, 12, 0, tick++));
}

test("the spot-ordering PR executes as a proven assets-only release", async () => {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "surf-assets-acceptance-"))
  );
  try {
    const predecessor = createReleaseRoot(parent, "predecessor", {
      app: "export const spots = ['Cowell'];",
      appTest: "test('old ordering');",
      styles: ".spots { display: block; }"
    });
    const target = createReleaseRoot(parent, "target", {
      app: "export const spots = ['OB North', 'OB Central', 'OB South'];",
      appTest: "test('Outer Richmond ordering');",
      styles: ".spots { display: grid; }"
    });
    runGit(target.root, ["init", "-q"]);
    runGit(target.root, ["config", "user.email", "release@example.invalid"]);
    runGit(target.root, ["config", "user.name", "Release Acceptance"]);
    writeFixtureFile(target.root, "apps/web/src/App.tsx", "export const spots = ['Cowell'];");
    writeFixtureFile(target.root, "apps/web/src/App.test.tsx", "test('old ordering');");
    writeFixtureFile(target.root, "apps/web/src/styles.css", ".spots { display: block; }");
    runGit(target.root, ["add", "."]);
    runGit(target.root, ["commit", "-qm", "predecessor"]);
    const fixturePredecessorSha = runGit(target.root, ["rev-parse", "HEAD"]);
    writeFixtureFile(
      target.root,
      "apps/web/src/App.tsx",
      "export const spots = ['OB North', 'OB Central', 'OB South'];"
    );
    writeFixtureFile(
      target.root,
      "apps/web/src/App.test.tsx",
      "test('Outer Richmond ordering');"
    );
    writeFixtureFile(target.root, "apps/web/src/styles.css", ".spots { display: grid; }");
    runGit(target.root, ["add", "."]);
    runGit(target.root, ["commit", "-qm", "target"]);
    const fixtureTargetSha = runGit(target.root, ["rev-parse", "HEAD"]);
    const changedPaths = listChangedReleasePaths(
      target.root,
      fixturePredecessorSha,
      fixtureTargetSha
    );

    const predecessorClientIdentity = clientBuildDigest(predecessor.root);
    const targetClientIdentity = clientBuildDigest(target.root);
    const predecessorFingerprints = computeReleaseFingerprints(
      predecessor.inputs
    );
    const targetFingerprints = computeReleaseFingerprints(target.inputs);

    assert.notEqual(targetClientIdentity, predecessorClientIdentity);
    assert.equal(predecessorFingerprints.workerAssets, predecessorClientIdentity);
    assert.equal(targetFingerprints.workerAssets, targetClientIdentity);
    assert.notEqual(
      targetFingerprints.workerAssets,
      predecessorFingerprints.workerAssets
    );

    const stableFingerprintKeys = [
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
    ];
    for (const key of stableFingerprintKeys) {
      assert.equal(
        targetFingerprints[key],
        predecessorFingerprints[key],
        `${key} must remain byte-identical`
      );
    }

    const activeReceipt = createTrustedActiveReleaseReceipt({
      schemaVersion: 1,
      releaseId: "spot-ordering-predecessor",
      targetGitSha: predecessorSha,
      workerVersionId: predecessorWorkerVersionId,
      journalSha256: "c".repeat(64),
      state: "complete",
      fingerprints: predecessorFingerprints
    });
    const classification = classifyReleaseImpact({
      changedPaths,
      targetFingerprints,
      activeReceipt
    });
    assert.equal(classification.lane, RELEASE_LANES.ASSETS_ONLY);
    assert.deepEqual(classification.changedPaths, [
      "apps/web/src/App.test.tsx",
      "apps/web/src/App.tsx",
      "apps/web/src/styles.css"
    ]);
    assert.deepEqual(classification.impact, {
      workerAssets: true,
      workerRuntime: false,
      materialization: false,
      migrations: false,
      seed: false,
      queueTopology: false,
      triggerTopology: false,
      runner: false,
      narrativeContract: false,
      secrets: false
    });

    const store = createReleaseStateStore({
      rootDir: resolve(parent, "release-state")
    });
    const initialJournal = createReleaseJournal({
      releaseId: "spot-ordering-target",
      targetGitSha: targetSha,
      classification,
      targetFingerprints,
      predecessor: {
        releaseId: activeReceipt.releaseId,
        journalSha256: activeReceipt.journalSha256,
        workerVersionId: activeReceipt.workerVersionId,
        deploymentId: predecessorDeploymentId,
        runnerActivationId: "runner-predecessor"
      },
      createdAt: "2026-08-15T12:00:00.000Z"
    });
    store.writeJournal(initialJournal);
    const trace = [];
    const result = await executeRelease({
      journal: initialJournal,
      store,
      operations: releaseOperations(trace),
      now: clock()
    });

    assert.equal(result.state, RELEASE_JOURNAL_STATES.COMPLETE);
    assert.equal(result.receipts.workerVersionId, targetWorkerVersionId);
    assert.notEqual(
      result.receipts.workerVersionId,
      predecessorWorkerVersionId
    );
    assert.deepEqual(trace, [
      "release:verify",
      "worker:prepare",
      "worker:upload",
      "worker:recheck-predecessor",
      "worker:inspect-activation",
      "worker:activate",
      "worker:wait-until-serving",
      "release:verify-live",
      "worker:inspect-activation"
    ]);
    assert.deepEqual(
      trace.filter((entry) =>
        /^(?:d1|queue|trigger|generation|runner):/.test(entry)
      ),
      []
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
