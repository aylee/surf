import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  RELEASE_FINGERPRINT_KEYS,
  classifyReleaseImpact,
  fingerprintCanonicalReleaseValue
} from "../lib/release-impact.mjs";
import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  RELEASE_POINTER_KINDS,
  createReleaseJournal,
  createReleasePointer,
  createReleaseStateStore,
  fingerprintReleaseJournal,
  recordReleaseJournalFailure,
  replaceBeforeUploadReleaseJournal,
  replaceInactiveUploadReleaseJournal,
  replacePreMutationReleaseJournal,
  replaceRunnerFailureReleaseJournal,
  supersedeReleaseJournal,
  transitionReleaseJournal
} from "../lib/release-journal.mjs";

const surfRoot = resolve(new URL("../..", import.meta.url).pathname);
const workerVersionId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function privateFile(path, contents = "FIXTURE=value\n") {
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "surf-release-entrypoint-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repository");
  const remotePath = join(root, "origin.git");
  const serviceRoot = join(root, "service");
  mkdirSync(repositoryPath);
  mkdirSync(serviceRoot);
  runGit(repositoryPath, ["init", "-q"]);
  runGit(repositoryPath, ["config", "user.email", "test@example.invalid"]);
  runGit(repositoryPath, ["config", "user.name", "Release Test"]);
  mkdirSync(join(repositoryPath, "scripts"));
  writeFileSync(join(repositoryPath, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
  writeFileSync(
    join(repositoryPath, "package.json"),
    `${JSON.stringify({ private: true, packageManager: "pnpm@11.7.0" })}\n`
  );
  writeFileSync(
    join(repositoryPath, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n"
  );
  writeFileSync(
    join(repositoryPath, "scripts", "release-prod.mjs"),
    `process.stdout.write(JSON.stringify({ targetGitSha: process.env.SURF_RELEASE_TARGET_SHA, lane: "assets-only", readOnly: process.argv.includes("--plan") }) + "\\n");\n`
  );
  runGit(repositoryPath, ["add", "."]);
  runGit(repositoryPath, ["commit", "-qm", "fixture"]);
  runGit(repositoryPath, ["branch", "-M", "main"]);
  runGit(root, ["init", "--bare", "-q", remotePath]);
  runGit(repositoryPath, ["remote", "add", "origin", remotePath]);
  runGit(repositoryPath, ["push", "-q", "-u", "origin", "main"]);
  const targetGitSha = runGit(repositoryPath, ["rev-parse", "HEAD"]);
  const profile = {
    schemaVersion: 1,
    repositoryPath,
    serviceRoot,
    releasesDirectory: join(serviceRoot, "releases"),
    stateDirectory: join(serviceRoot, "release-state"),
    wranglerSourcePath: privateFile(join(serviceRoot, "wrangler.jsonc"), "{}\n"),
    workerSecretsSourcePath: privateFile(join(serviceRoot, "worker.env")),
    runnerEnvironmentPath: privateFile(join(serviceRoot, "runner.env")),
    operatorEnvironmentPath: privateFile(join(serviceRoot, "operator.env")),
    customOrigin: "https://surf.example",
    workersDevOrigin: "https://surf-test.workers.dev"
  };
  const profilePath = privateFile(
    join(serviceRoot, "production-profile.json"),
    `${JSON.stringify(profile)}\n`
  );
  return { profile, profilePath, repositoryPath, targetGitSha };
}

async function waitForPath(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

function fingerprints() {
  return Object.fromEntries(
    RELEASE_FINGERPRINT_KEYS.map((key) => [
      key,
      fingerprintCanonicalReleaseValue(`entrypoint:${key}`)
    ])
  );
}

function completeReleaseHistory(targetGitSha, releaseId = "release-complete") {
  const targetFingerprints = fingerprints();
  const classification = classifyReleaseImpact({
    changedPaths: ["package.json"],
    targetFingerprints,
    activeReceipt: null
  });
  let journal = createReleaseJournal({
    releaseId,
    targetGitSha,
    classification,
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runnerActivationId: null
    },
    createdAt: "2026-08-15T00:00:00.000Z"
  });
  const history = [journal];
  const steps = [
    [RELEASE_JOURNAL_STATES.VERIFIED, {}],
    [
      RELEASE_JOURNAL_STATES.PREPARED,
      {
        profileSha256: "1".repeat(64),
        operatorEnvironmentFingerprint: "4".repeat(64),
        wranglerConfigSha256: "2".repeat(64),
        workerSecretsFingerprint: "3".repeat(64)
      }
    ],
    [RELEASE_JOURNAL_STATES.WORKER_UPLOADED, { workerVersionId }],
    [
      RELEASE_JOURNAL_STATES.DATA_PREPARED,
      { d1Bookmark: "bookmark-release-complete", d1ExportSha256: "4".repeat(64) }
    ],
    [RELEASE_JOURNAL_STATES.RUNNER_READY, { runnerActivationId: "runner-r1" }],
    [RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED, {}],
    [RELEASE_JOURNAL_STATES.WORKER_ACTIVE, { deploymentId }],
    [RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED, {}],
    [RELEASE_JOURNAL_STATES.GENERATION_VERIFIED, { generationId: "generation-1" }],
    [RELEASE_JOURNAL_STATES.VERIFIED_LIVE, {}],
    [RELEASE_JOURNAL_STATES.COMPLETE, {}]
  ];
  for (const [index, [state, receipts]] of steps.entries()) {
    journal = transitionReleaseJournal(journal, state, {
      at: new Date(Date.UTC(2026, 7, 15, 0, 0, index + 1)).toISOString(),
      receipts
    });
    history.push(journal);
  }
  return history;
}

function completeRelease(store, targetGitSha) {
  const history = completeReleaseHistory(targetGitSha);
  for (const journal of history) store.writeJournal(journal);
  const journal = history.at(-1);
  const at = "2026-08-15T00:00:12.000Z";
  store.writePointer(createReleasePointer(journal, RELEASE_POINTER_KINDS.ACTIVE, { at }));
  store.writePointer(
    createReleasePointer(journal, RELEASE_POINTER_KINDS.LAST_COMPLETE, { at })
  );
  return journal;
}

function plannedFailure(store, targetGitSha, releaseId = "release-planned-failure") {
  const targetFingerprints = fingerprints();
  const classification = classifyReleaseImpact({
    changedPaths: ["package.json"],
    targetFingerprints,
    activeReceipt: null
  });
  const initial = createReleaseJournal({
    releaseId,
    targetGitSha,
    classification,
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runnerActivationId: "runner-prior"
    },
    createdAt: "2026-08-15T01:00:00.000Z"
  });
  store.writeJournal(initial);
  const failed = recordReleaseJournalFailure(initial, {
    code: RELEASE_FAILURE_CODES.VERIFY_FAILED,
    at: "2026-08-15T01:00:01.000Z"
  });
  return store.writeJournal(failed);
}

function verifiedPrepareFailure(
  store,
  targetGitSha,
  releaseId = "release-before-upload-failure"
) {
  const targetFingerprints = fingerprints();
  const classification = classifyReleaseImpact({
    changedPaths: ["package.json"],
    targetFingerprints,
    activeReceipt: null
  });
  let journal = createReleaseJournal({
    releaseId,
    targetGitSha,
    classification,
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runnerActivationId: "runner-prior"
    },
    createdAt: "2026-08-15T01:00:00.000Z"
  });
  store.writeJournal(journal);
  journal = transitionReleaseJournal(journal, RELEASE_JOURNAL_STATES.VERIFIED, {
    at: "2026-08-15T01:00:01.000Z"
  });
  store.writeJournal(journal);
  journal = recordReleaseJournalFailure(journal, {
    code: RELEASE_FAILURE_CODES.PREPARE_FAILED,
    at: "2026-08-15T01:00:02.000Z"
  });
  return store.writeJournal(journal);
}

function preparedUploadFailure(
  store,
  targetGitSha,
  releaseId = "release-upload-failure"
) {
  const targetFingerprints = fingerprints();
  const classification = classifyReleaseImpact({
    changedPaths: ["package.json"],
    targetFingerprints,
    activeReceipt: null
  });
  let journal = createReleaseJournal({
    releaseId,
    targetGitSha,
    classification,
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runnerActivationId: "runner-prior"
    },
    createdAt: "2026-08-15T01:00:00.000Z"
  });
  store.writeJournal(journal);
  journal = transitionReleaseJournal(journal, RELEASE_JOURNAL_STATES.VERIFIED, {
    at: "2026-08-15T01:00:01.000Z"
  });
  store.writeJournal(journal);
  journal = transitionReleaseJournal(journal, RELEASE_JOURNAL_STATES.PREPARED, {
    at: "2026-08-15T01:00:02.000Z",
    receipts: {
      profileSha256: "1".repeat(64),
      operatorEnvironmentFingerprint: "4".repeat(64),
      wranglerConfigSha256: "2".repeat(64),
      workerSecretsFingerprint: "3".repeat(64)
    }
  });
  store.writeJournal(journal);
  journal = recordReleaseJournalFailure(journal, {
    code: RELEASE_FAILURE_CODES.UPLOAD_FAILED,
    at: "2026-08-15T01:00:03.000Z"
  });
  return store.writeJournal(journal);
}

function beforeUploadEvidence() {
  return {
    liveWorkerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    liveDeploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    liveDeploymentCreatedOn: "2026-08-14T23:00:00.000000Z",
    liveRunnerActivationId: "runner-prior",
    failedConfigSha256: "9".repeat(64),
    failedQueueTopologyFingerprint: fingerprints().queueTopology,
    uploadArtifactAbsent: true,
    backupArtifactAbsent: true,
    rollbackArtifactAbsent: true,
    remoteUploadEvidence: null,
    queueEvidence: {
      expectedQueueNames: ["surf-ingest"],
      queues: [
        {
          name: "surf-ingest",
          createdOn: "2026-08-10T04:58:17.532408Z"
        }
      ]
    }
  };
}

function preparedUploadEvidence(failed) {
  return {
    ...beforeUploadEvidence(),
    failedConfigSha256: "2".repeat(64),
    remoteUploadEvidence: {
      schemaVersion: 1,
      workerName: "surf-prod",
      releaseTag: failed.releaseId,
      remoteVersionCount: 32,
      remoteVersionInventorySha256: "6".repeat(64),
      taggedUploadAbsent: true
    }
  };
}

function inactiveUploadEvidence(failed) {
  return {
    ...beforeUploadEvidence(),
    failedConfigSha256: "2".repeat(64),
    remoteUploadEvidence: {
      schemaVersion: 1,
      workerName: "surf-prod",
      releaseTag: failed.releaseId,
      releaseMessage: `surf release ${failed.releaseId}`,
      inactiveWorkerVersionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      inactiveWorkerVersionNumber: 33,
      inactiveWorkerCreatedOn: "2026-08-15T01:00:04.000000Z",
      sourceRevision: failed.targetGitSha,
      workerRuntimeDigest: failed.targetFingerprints.workerRuntime,
      clientBuildDigest: failed.targetFingerprints.workerAssets,
      runtimeCpuMs: 2_000,
      remoteVersionCount: 33,
      remoteVersionInventorySha256: "6".repeat(64),
      inactiveWorkerVersionDetailSha256: "7".repeat(64),
      predecessorWorkerVersionDetailSha256: "8".repeat(64)
    }
  };
}

function dataPreparedRunnerFailure(
  store,
  targetGitSha,
  releaseId = "release-runner-failure"
) {
  const targetFingerprints = fingerprints();
  const classification = classifyReleaseImpact({
    changedPaths: ["package.json"],
    targetFingerprints,
    activeReceipt: null
  });
  let journal = createReleaseJournal({
    releaseId,
    targetGitSha,
    classification,
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runnerActivationId: "runner-prior"
    },
    createdAt: "2026-08-15T01:00:00.000Z"
  });
  store.writeJournal(journal);
  journal = transitionReleaseJournal(journal, RELEASE_JOURNAL_STATES.VERIFIED, {
    at: "2026-08-15T01:00:01.000Z"
  });
  store.writeJournal(journal);
  journal = transitionReleaseJournal(journal, RELEASE_JOURNAL_STATES.PREPARED, {
    at: "2026-08-15T01:00:02.000Z",
    receipts: {
      profileSha256: "1".repeat(64),
      operatorEnvironmentFingerprint: "4".repeat(64),
      wranglerConfigSha256: "2".repeat(64),
      workerSecretsFingerprint: "3".repeat(64)
    }
  });
  store.writeJournal(journal);
  journal = transitionReleaseJournal(
    journal,
    RELEASE_JOURNAL_STATES.WORKER_UPLOADED,
    {
      at: "2026-08-15T01:00:03.000Z",
      receipts: {
        workerVersionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      }
    }
  );
  store.writeJournal(journal);
  journal = transitionReleaseJournal(
    journal,
    RELEASE_JOURNAL_STATES.DATA_PREPARED,
    {
      at: "2026-08-15T01:00:04.000Z",
      receipts: {
        d1Bookmark: "bookmark-runner-failure-0001",
        d1ExportSha256: "5".repeat(64)
      }
    }
  );
  store.writeJournal(journal);
  journal = recordReleaseJournalFailure(journal, {
    code: RELEASE_FAILURE_CODES.RUNNER_FAILED,
    at: "2026-08-15T01:00:05.000Z"
  });
  return store.writeJournal(journal);
}

function runnerFailureEvidence(failed) {
  return {
    failedJournalSha256: fingerprintReleaseJournal(failed),
    failedConfigSha256: failed.receipts.wranglerConfigSha256,
    workerUploadReceiptSha256: "6".repeat(64),
    d1BackupReceiptSha256: "7".repeat(64),
    d1ExportBytes: 1024,
    d1ExportSha256: failed.receipts.d1ExportSha256,
    priorRunnerActivationId: "runner-prior",
    priorRunnerRecordSha256: "a".repeat(64),
    priorRunnerReleaseSha: "c".repeat(40),
    liveWorkerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    liveDeploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    predecessorDeploymentCreatedOn: "2026-08-14T23:00:00.000000Z",
    queueTopologyFingerprint: failed.targetFingerprints.queueTopology,
    queueEvidence: beforeUploadEvidence().queueEvidence,
    remoteUploadEvidence: inactiveUploadEvidence(failed).remoteUploadEvidence
  };
}


function fileTree(root) {
  const result = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) visit(path);
      else result.push([path.slice(root.length), readFileSync(path, "utf8")]);
    }
  };
  visit(root);
  return result.sort(([left], [right]) => left.localeCompare(right));
}

test("--plan delegates to the exact origin/main release without creating production state", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const result = spawnSync(
    process.execPath,
    [join(surfRoot, "scripts/release-prod.mjs"), "--plan"],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.targetGitSha, targetGitSha);
  assert.equal(preview.lane, "assets-only");
  assert.equal(preview.readOnly, true);
  assert.equal(existsSync(profile.releasesDirectory), true);
  assert.equal(existsSync(profile.stateDirectory), false);
});

test("--plan previews a pre-mutation replacement without changing its journal", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const failed = plannedFailure(store, "a".repeat(40));
  const journalPath = join(
    profile.stateDirectory,
    "journals",
    `${failed.releaseId}.json`
  );
  const before = readFileSync(journalPath, "utf8");

  const result = spawnSync(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--plan",
      "--replace-pre-mutation",
      failed.releaseId
    ],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetGitSha, targetGitSha);
  assert.equal(readFileSync(journalPath, "utf8"), before);
  assert.equal(store.readJournal(failed.releaseId).state, failed.state);
});

test("--plan delegates a before-upload replacement without changing its journal", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const failed = verifiedPrepareFailure(store, "a".repeat(40));
  const journalPath = join(
    profile.stateDirectory,
    "journals",
    `${failed.releaseId}.json`
  );
  const before = readFileSync(journalPath, "utf8");

  const result = spawnSync(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--plan",
      "--replace-before-upload",
      failed.releaseId
    ],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetGitSha, targetGitSha);
  assert.equal(readFileSync(journalPath, "utf8"), before);
  assert.equal(store.readJournal(failed.releaseId).state, failed.state);
});

test("the outer owner process forwards terminal signals to the exact release group", async (t) => {
  const { profile, profilePath, repositoryPath } = fixture(t);
  const readyPath = join(profile.serviceRoot, "release-child-ready");
  const signalPath = join(profile.serviceRoot, "release-child-signal");
  writeFileSync(
    join(repositoryPath, "scripts", "release-prod.mjs"),
      `import { readFileSync, writeFileSync } from "node:fs";\n` +
      `const profile = JSON.parse(readFileSync(process.env.SURF_PRODUCTION_PROFILE, "utf8"));\n` +
      `process.on("SIGTERM", () => {\n` +
      `  writeFileSync(new URL("release-child-signal", new URL(\`file://\${profile.serviceRoot}/\`)), "SIGTERM");\n` +
      `  process.exit(143);\n` +
      `});\n` +
      `writeFileSync(new URL("release-child-ready", new URL(\`file://\${profile.serviceRoot}/\`)), String(process.pid));\n` +
      `setInterval(() => {}, 1_000);\n`
  );
  runGit(repositoryPath, ["add", "scripts/release-prod.mjs"]);
  runGit(repositoryPath, ["commit", "-qm", "signal fixture"]);
  runGit(repositoryPath, ["push", "-q", "origin", "main"]);
  const targetGitSha = runGit(repositoryPath, ["rev-parse", "HEAD"]);
  const owner = spawn(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--yes",
      "--sha",
      targetGitSha
    ],
    {
      cwd: surfRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );
  const stderr = [];
  owner.stderr?.on("data", (chunk) => stderr.push(chunk));
  await waitForPath(readyPath);
  process.kill(owner.pid, "SIGTERM");
  const result = await new Promise((resolveChild, rejectChild) => {
    owner.once("error", rejectChild);
    owner.once("close", (code, signal) => resolveChild({ code, signal }));
  });
  assert.deepEqual(result, { code: 143, signal: null }, Buffer.concat(stderr).toString());
  assert.equal(readFileSync(signalPath, "utf8"), "SIGTERM");
});

test("release:status verifies immutable history without changing state", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const journal = completeRelease(store, targetGitSha);
  const interrupted = createReleaseJournal({
    releaseId: "release-interrupted",
    targetGitSha,
    classification: classifyReleaseImpact({
      changedPaths: ["package.json"],
      targetFingerprints: fingerprints(),
      activeReceipt: null
    }),
    targetFingerprints: fingerprints(),
    createdAt: "2026-08-15T01:00:00.000Z"
  });
  store.writeJournal(interrupted);
  const replaceable = plannedFailure(
    store,
    "b".repeat(40),
    "release-replaced-terminal"
  );
  store.writeJournal(
    replacePreMutationReleaseJournal(replaceable, {
      releaseId: "release-replaced-successor",
      targetGitSha: "c".repeat(40),
      at: "2026-08-15T01:00:02.000Z"
    })
  );
  const before = fileTree(profile.stateDirectory);
  const result = spawnSync(process.execPath, [join(surfRoot, "scripts/release-status.mjs")], {
    cwd: surfRoot,
    encoding: "utf8",
    env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
  });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.active.releaseId, journal.releaseId);
  assert.equal(status["last-complete"].state, RELEASE_JOURNAL_STATES.COMPLETE);
  assert.deepEqual(
    status.incomplete.map((attempt) => attempt.releaseId),
    [interrupted.releaseId]
  );
  assert.deepEqual(fileTree(profile.stateDirectory), before);
});

test("release:status reports a crash-persisted next revision without repairing state", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const history = completeReleaseHistory(targetGitSha, "release-crash-window");
  const activeIndex = history.findIndex(
    (journal) => journal.state === RELEASE_JOURNAL_STATES.WORKER_ACTIVE
  );
  assert.notEqual(activeIndex, -1);
  for (const journal of history.slice(0, activeIndex + 1)) {
    store.writeJournal(journal);
  }
  const activeJournal = history[activeIndex];
  const pendingJournal = history[activeIndex + 1];
  assert.equal(pendingJournal.state, RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED);
  store.writePointer(
    createReleasePointer(activeJournal, RELEASE_POINTER_KINDS.ACTIVE, {
      at: "2026-08-15T00:00:08.500Z"
    })
  );

  const revisionPath = join(
    profile.stateDirectory,
    "journals",
    `${activeJournal.releaseId}.revisions`,
    `${String(pendingJournal.revision).padStart(6, "0")}.json`
  );
  writeFileSync(revisionPath, `${JSON.stringify(pendingJournal)}\n`, {
    mode: 0o600
  });

  const before = fileTree(profile.stateDirectory);
  const result = spawnSync(
    process.execPath,
    [join(surfRoot, "scripts/release-status.mjs")],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.active.state, RELEASE_JOURNAL_STATES.WORKER_ACTIVE);
  assert.deepEqual(
    status.incomplete.map(({ releaseId, state }) => ({ releaseId, state })),
    [
      {
        releaseId: pendingJournal.releaseId,
        state: RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED
      }
    ]
  );
  assert.deepEqual(fileTree(profile.stateDirectory), before);
});

test("release:status streams more than 256 completed journals", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const journalsDirectory = join(profile.stateDirectory, "journals");
  mkdirSync(journalsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(profile.stateDirectory, "pointers"), {
    recursive: true,
    mode: 0o700
  });
  for (let index = 0; index < 257; index += 1) {
    const releaseId = `historical-complete-${String(index).padStart(3, "0")}`;
    const history = completeReleaseHistory(targetGitSha, releaseId);
    const revisionDirectory = join(
      journalsDirectory,
      `${releaseId}.revisions`
    );
    mkdirSync(revisionDirectory, { mode: 0o700 });
    for (const revision of history) {
      writeFileSync(
        join(
          revisionDirectory,
          `${String(revision.revision).padStart(6, "0")}.json`
        ),
        `${JSON.stringify(revision)}\n`,
        { mode: 0o600 }
      );
    }
    writeFileSync(
      join(journalsDirectory, `${releaseId}.json`),
      `${JSON.stringify(history.at(-1))}\n`,
      { mode: 0o600 }
    );
  }

  const result = spawnSync(
    process.execPath,
    [join(surfRoot, "scripts/release-status.mjs")],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.active, null);
  assert.equal(status["last-complete"], null);
  assert.deepEqual(status.incomplete, []);
});

test("a linked fix-forward retry stays pinned when origin/main advances", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const targetFingerprints = fingerprints();
  const classification = classifyReleaseImpact({
    changedPaths: ["package.json"],
    targetFingerprints,
    activeReceipt: null
  });
  let failed = createReleaseJournal({
    releaseId: "release-failed",
    targetGitSha: "a".repeat(40),
    classification,
    targetFingerprints,
    predecessor: {
      releaseId: null,
      journalSha256: null,
      workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runnerActivationId: "runner-prior"
    },
    createdAt: "2026-08-15T02:00:00.000Z"
  });
  store.writeJournal(failed);
  const steps = [
    [RELEASE_JOURNAL_STATES.VERIFIED, {}],
    [
      RELEASE_JOURNAL_STATES.PREPARED,
      {
        profileSha256: "1".repeat(64),
        operatorEnvironmentFingerprint: "4".repeat(64),
        wranglerConfigSha256: "2".repeat(64),
        workerSecretsFingerprint: "3".repeat(64)
      }
    ],
    [RELEASE_JOURNAL_STATES.WORKER_UPLOADED, { workerVersionId }],
    [
      RELEASE_JOURNAL_STATES.DATA_PREPARED,
      { d1Bookmark: "bookmark-failed", d1ExportSha256: "4".repeat(64) }
    ],
    [RELEASE_JOURNAL_STATES.RUNNER_READY, { runnerActivationId: "runner-failed" }],
    [RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED, {}],
    [RELEASE_JOURNAL_STATES.WORKER_ACTIVE, { deploymentId }]
  ];
  for (const [index, [state, receipts]] of steps.entries()) {
    failed = transitionReleaseJournal(failed, state, {
      at: new Date(Date.UTC(2026, 7, 15, 2, 0, index + 1)).toISOString(),
      receipts
    });
    store.writeJournal(failed);
  }
  failed = recordReleaseJournalFailure(failed, {
    code: RELEASE_FAILURE_CODES.LIVE_VERIFY_FAILED,
    at: "2026-08-15T02:00:08.000Z"
  });
  store.writeJournal(failed);
  failed = supersedeReleaseJournal(failed, {
    releaseId: "release-linked-fix",
    targetGitSha,
    at: "2026-08-15T02:00:09.000Z"
  });
  store.writeJournal(failed);
  store.writePointer(
    createReleasePointer(failed, RELEASE_POINTER_KINDS.ACTIVE, {
      at: "2026-08-15T02:00:10.000Z"
    })
  );

  writeFileSync(join(profile.repositoryPath, "README.md"), "newer main\n");
  runGit(profile.repositoryPath, ["add", "README.md"]);
  runGit(profile.repositoryPath, ["commit", "-qm", "advance main"]);
  runGit(profile.repositoryPath, ["push", "-q", "origin", "main"]);
  assert.notEqual(runGit(profile.repositoryPath, ["rev-parse", "HEAD"]), targetGitSha);

  const result = spawnSync(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--fix-forward",
      failed.releaseId
    ],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetGitSha, targetGitSha);
});

test("a linked pre-mutation replacement retry stays pinned after interruption", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const failed = plannedFailure(store, "a".repeat(40));
  const replaced = replacePreMutationReleaseJournal(failed, {
    releaseId: "release-linked-pre-mutation",
    targetGitSha,
    at: "2026-08-15T01:00:02.000Z"
  });
  store.writeJournal(replaced);

  writeFileSync(join(profile.repositoryPath, "README.md"), "newer main\n");
  runGit(profile.repositoryPath, ["add", "README.md"]);
  runGit(profile.repositoryPath, ["commit", "-qm", "advance main"]);
  runGit(profile.repositoryPath, ["push", "-q", "origin", "main"]);
  assert.notEqual(runGit(profile.repositoryPath, ["rev-parse", "HEAD"]), targetGitSha);

  const result = spawnSync(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--plan",
      "--replace-pre-mutation",
      failed.releaseId
    ],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetGitSha, targetGitSha);
  assert.equal(
    store.readJournal(failed.releaseId).state,
    RELEASE_JOURNAL_STATES.REPLACED
  );
  assert.equal(store.readJournal(replaced.supersededBy.releaseId), null);
});

test("a linked before-upload replacement retry stays pinned after interruption", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const failed = verifiedPrepareFailure(store, "a".repeat(40));
  const replaced = replaceBeforeUploadReleaseJournal(failed, {
    releaseId: "release-linked-before-upload",
    targetGitSha,
    evidence: beforeUploadEvidence(),
    at: "2026-08-15T01:00:03.000Z"
  });
  store.writeJournal(replaced);

  writeFileSync(join(profile.repositoryPath, "README.md"), "newer main\n");
  runGit(profile.repositoryPath, ["add", "README.md"]);
  runGit(profile.repositoryPath, ["commit", "-qm", "advance main"]);
  runGit(profile.repositoryPath, ["push", "-q", "origin", "main"]);
  assert.notEqual(runGit(profile.repositoryPath, ["rev-parse", "HEAD"]), targetGitSha);

  const result = spawnSync(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--plan",
      "--replace-before-upload",
      failed.releaseId
    ],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetGitSha, targetGitSha);
  assert.equal(
    store.readJournal(failed.releaseId).state,
    RELEASE_JOURNAL_STATES.REPLACED
  );
  assert.equal(store.readJournal(replaced.supersededBy.releaseId), null);
});

test("a linked prepared-upload replacement retry stays pinned after interruption", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const failed = preparedUploadFailure(store, "a".repeat(40));
  const replaced = replaceBeforeUploadReleaseJournal(failed, {
    releaseId: "release-linked-prepared-upload",
    targetGitSha,
    evidence: preparedUploadEvidence(failed),
    at: "2026-08-15T01:00:04.000Z"
  });
  store.writeJournal(replaced);

  writeFileSync(join(profile.repositoryPath, "README.md"), "newer main\n");
  runGit(profile.repositoryPath, ["add", "README.md"]);
  runGit(profile.repositoryPath, ["commit", "-qm", "advance main"]);
  runGit(profile.repositoryPath, ["push", "-q", "origin", "main"]);
  assert.notEqual(runGit(profile.repositoryPath, ["rev-parse", "HEAD"]), targetGitSha);

  const result = spawnSync(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--plan",
      "--replace-before-upload",
      failed.releaseId
    ],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetGitSha, targetGitSha);
  assert.equal(
    store.readJournal(failed.releaseId).state,
    RELEASE_JOURNAL_STATES.REPLACED
  );
  assert.equal(store.readJournal(replaced.supersededBy.releaseId), null);
});

test("a linked inactive-upload replacement retry stays pinned without re-attestation", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const failed = preparedUploadFailure(
    store,
    "a".repeat(40),
    "release-inactive-upload-failure"
  );
  const replaced = replaceInactiveUploadReleaseJournal(failed, {
    releaseId: "release-linked-inactive-upload",
    targetGitSha,
    evidence: inactiveUploadEvidence(failed),
    at: "2026-08-15T01:00:05.000Z"
  });
  store.writeJournal(replaced);

  writeFileSync(join(profile.repositoryPath, "README.md"), "newer main\n");
  runGit(profile.repositoryPath, ["add", "README.md"]);
  runGit(profile.repositoryPath, ["commit", "-qm", "advance main"]);
  runGit(profile.repositoryPath, ["push", "-q", "origin", "main"]);
  assert.notEqual(runGit(profile.repositoryPath, ["rev-parse", "HEAD"]), targetGitSha);

  const result = spawnSync(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--plan",
      "--replace-inactive-upload",
      failed.releaseId
    ],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetGitSha, targetGitSha);
  assert.equal(
    store.readJournal(failed.releaseId).state,
    RELEASE_JOURNAL_STATES.REPLACED
  );
  assert.equal(store.readJournal(replaced.supersededBy.releaseId), null);
});

test("a linked runner-failure replacement retry stays pinned without re-attestation", (t) => {
  const { profile, profilePath, targetGitSha } = fixture(t);
  const store = createReleaseStateStore({ rootDir: profile.stateDirectory });
  const failed = dataPreparedRunnerFailure(store, "a".repeat(40));
  const replaced = replaceRunnerFailureReleaseJournal(failed, {
    releaseId: "release-linked-runner-failure",
    targetGitSha,
    evidence: runnerFailureEvidence(failed),
    at: "2026-08-15T01:00:06.000Z"
  });
  store.writeJournal(replaced);

  writeFileSync(join(profile.repositoryPath, "README.md"), "newer main\n");
  runGit(profile.repositoryPath, ["add", "README.md"]);
  runGit(profile.repositoryPath, ["commit", "-qm", "advance main"]);
  runGit(profile.repositoryPath, ["push", "-q", "origin", "main"]);
  assert.notEqual(runGit(profile.repositoryPath, ["rev-parse", "HEAD"]), targetGitSha);

  const result = spawnSync(
    process.execPath,
    [
      join(surfRoot, "scripts/release-prod.mjs"),
      "--plan",
      "--replace-runner-failure",
      failed.releaseId
    ],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: { ...process.env, SURF_PRODUCTION_PROFILE: profilePath }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetGitSha, targetGitSha);
  assert.equal(
    store.readJournal(failed.releaseId).state,
    RELEASE_JOURNAL_STATES.REPLACED
  );
  assert.equal(store.readJournal(replaced.supersededBy.releaseId), null);
});


test("ambient internal-execution variables cannot bypass the outer release gate", () => {
  const result = spawnSync(
    process.execPath,
    [join(surfRoot, "scripts/release-prod.mjs"), "--plan"],
    {
      cwd: surfRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SURF_RELEASE_EXECUTION_ROOT: surfRoot,
        SURF_RELEASE_TARGET_SHA: "a".repeat(40)
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authenticated handoff/);
});
