#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  boundedReleasePreview,
  parseReleaseProdArguments,
  releaseIdFor
} from "./lib/release-cli.mjs";
import {
  RELEASE_CLASSIFICATION_REASON_CODES,
  RELEASE_LANES,
  classifyReleaseImpact,
  forceConservativeReleaseClassification
} from "./lib/release-impact.mjs";
import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  RELEASE_POINTER_KINDS,
  assertPreMutationReleaseReplacement,
  assertReleaseJournal,
  assertReleaseSupersession,
  atomicWriteReleaseJsonSync,
  createReleaseJournal,
  createReleasePointer,
  createReleaseStateStore,
  fingerprintReleaseJournal,
  predecessorForPreMutationReplacement,
  releasePointerMatchesJournal,
  replacePreMutationReleaseJournal,
  supersedeReleaseJournal
} from "./lib/release-journal.mjs";
import {
  executeRelease,
  persistPreControllerPreparationFailure,
  reconcileReleaseActivationBoundary
} from "./lib/release-controller.mjs";
import {
  exactResumeJournalAcceptsLiveTarget,
  journalNeedsActivationBoundaryReconciliation
} from "./lib/release-resume.mjs";
import {
  assertAppendOnlyMigrationHistory,
  listChangedReleasePaths,
  prepareImmutableRelease,
  resolveGitRevision,
  validateImmutableRelease
} from "./lib/immutable-release.mjs";
import { readProductionProfile } from "./lib/release-profile.mjs";
import { stageWranglerConfigSnapshot } from "./lib/wrangler-config-snapshot.mjs";
import { createCloudflareCommandContext } from "./lib/cloudflare-command-context.mjs";
import { clientBuildDigest } from "./lib/build-identity.mjs";
import {
  assertRoutineNarrativeContractTransition,
  assertRoutineRunnerRuntimeTransition,
  assertRoutineWorkerSecretTransition,
  computeReleaseFingerprints,
  privateFileHmacFingerprint,
  runnerReplacementRequired,
  sha256File
} from "./lib/release-fingerprints.mjs";
import {
  createProductionChildEnvironment,
  createReleaseLocalEnvironment,
  inspectWorkerSecrets,
  requireProductionIngestToken,
  stageWorkerSecretsSnapshot,
  validateProductionOperatorEnvironment
} from "./lib/release-secrets.mjs";
import {
  buildWorkerCandidate,
  createWorkerReleaseOperations,
  resolveOptionalWorkerSourceRevision
} from "./lib/release-worker.mjs";
import { createReleaseStorage } from "./lib/release-storage.mjs";
import { acquireReleaseLock } from "./lib/release-lock.mjs";
import { readStrictDotenvFile } from "./lib/strict-env-file.mjs";
import {
  discoverRunnerActivationFromInstalledPlist,
  verifyActiveRunnerCompatibility,
  verifyRunnerEnvironmentBindings
} from "./lib/release-runner-compatibility.mjs";
import { activateTargetRunner } from "./lib/release-runner-activation.mjs";
import { readVerifiedFileSnapshot } from "./lib/verified-file-snapshot.mjs";

const INTERNAL_ENV = "SURF_RELEASE_EXECUTION_ROOT";
const TARGET_ENV = "SURF_RELEASE_TARGET_SHA";
const PROFILE_ENV = "SURF_PRODUCTION_PROFILE";
const HANDOFF_PATH_ENV = "SURF_RELEASE_HANDOFF_PATH";
const HANDOFF_TOKEN_ENV = "SURF_RELEASE_HANDOFF_TOKEN";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FORWARDED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });
const PROCESS_GROUP_STOP_TIMEOUT_MS = 10_000;
const MAX_RELEASE_PRIVATE_JSON_BYTES = 4 * 1024 * 1024;

function handoffTokenHash(token) {
  return createHash("sha256")
    .update("surf-release-inner-handoff-v1\0")
    .update(token)
    .digest("hex");
}

function createInternalHandoff({ releaseRoot, targetGitSha, profile, argv }) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "surf-release-handoff-"))
  );
  chmodSync(directory, 0o700);
  const path = resolve(directory, "handoff.json");
  const token = randomBytes(32).toString("hex");
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      releaseRoot,
      targetGitSha,
      profilePath: profile,
      argv,
      parentPid: process.pid,
      tokenSha256: handoffTokenHash(token)
    })}\n`,
    { mode: 0o600, flag: "wx" }
  );
  return Object.freeze({ directory, path, token });
}

function consumeInternalHandoff(options) {
  const path = process.env[HANDOFF_PATH_ENV];
  const token = process.env[HANDOFF_TOKEN_ENV];
  if (
    typeof path !== "string" ||
    typeof token !== "string" ||
    !/^[0-9a-f]{64}$/.test(token)
  ) {
    throw new Error("Internal release execution requires an authenticated handoff");
  }
  const snapshot = readVerifiedFileSnapshot(path, {
    label: "Internal release handoff",
    maximumBytes: 64 * 1024,
    requireMode0600: true,
    requireCanonical: true
  });
  const value = JSON.parse(snapshot.contents.toString("utf8"));
  rmSync(path);
  const expectedKeys = [
    "argv",
    "parentPid",
    "profilePath",
    "releaseRoot",
    "schemaVersion",
    "targetGitSha",
    "tokenSha256"
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== expectedKeys.sort().join(",") ||
    value.schemaVersion !== 1 ||
    value.parentPid !== process.ppid ||
    value.releaseRoot !== process.env[INTERNAL_ENV] ||
    value.targetGitSha !== process.env[TARGET_ENV] ||
    value.profilePath !== process.env[PROFILE_ENV] ||
    JSON.stringify(value.argv) !== JSON.stringify(process.argv.slice(2)) ||
    !SHA_PATTERN.test(value.targetGitSha ?? "") ||
    (options.sha !== null && options.sha !== value.targetGitSha)
  ) {
    throw new Error("Internal release handoff identity is invalid");
  }
  const actualHash = Buffer.from(handoffTokenHash(token), "hex");
  const expectedHash = Buffer.from(value.tokenSha256 ?? "", "hex");
  if (
    actualHash.byteLength !== expectedHash.byteLength ||
    !timingSafeEqual(actualHash, expectedHash)
  ) {
    throw new Error("Internal release handoff authentication failed");
  }
}

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options
  }).trim();
}

function profilePath() {
  return (
    process.env[PROFILE_ENV]?.trim() ||
    resolve(homedir(), "Services/surf/production-profile.json")
  );
}

function ensurePrivateSubdirectory(parent, name, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) {
    throw new Error(`${label} has an unsafe directory name`);
  }
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== resolve(parent)) {
    throw new Error(`${label} parent must be canonical`);
  }
  const path = resolve(canonicalParent, name);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if (realpathSync(path) !== path) {
    throw new Error(`${label} must use its canonical path`);
  }
  chmodSync(path, 0o700);
  return path;
}

function fetchTarget(repositoryPath) {
  run("git", ["-C", repositoryPath, "fetch", "--prune", "origin", "main"]);
}

function recoveryJournal(profile, releaseId) {
  const path = resolve(profile.stateDirectory, "journals", `${releaseId}.json`);
  const snapshot = readVerifiedFileSnapshot(path, {
    label: "Resume journal",
    maximumBytes: MAX_RELEASE_PRIVATE_JSON_BYTES,
    requireMode0600: true,
    requireCanonical: true
  });
  const value = assertReleaseJournal(
    JSON.parse(snapshot.contents.toString("utf8"))
  );
  if (value.releaseId !== releaseId) {
    throw new Error("Recovery journal identity does not match its filename");
  }
  return value;
}

function journalTargetForResume(profile, releaseId) {
  return recoveryJournal(profile, releaseId).targetGitSha;
}

function journalTargetForFixForwardRetry(profile, releaseId) {
  const failed = recoveryJournal(profile, releaseId);
  if (failed.state === RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD) return null;
  if (failed.state !== RELEASE_JOURNAL_STATES.SUPERSEDED) {
    throw new Error("Fix-forward requires a needs-fix-forward or linked journal");
  }
  return failed.supersededBy.targetGitSha;
}

function journalTargetForPreMutationReplacementRetry(profile, releaseId) {
  const failed = recoveryJournal(profile, releaseId);
  if (
    failed.state === RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE &&
    failed.resumeFrom === RELEASE_JOURNAL_STATES.PLANNED &&
    Object.values(failed.receipts).every((value) => value === null) &&
    failed.predecessor.workerVersionId !== null &&
    failed.predecessor.deploymentId !== null
  ) {
    return null;
  }
  if (failed.state !== RELEASE_JOURNAL_STATES.REPLACED) {
    throw new Error(
      "Pre-mutation replacement requires a receipt-free failure from planned or its linked journal"
    );
  }
  return failed.supersededBy.targetGitSha;
}

function runnerCompatibilityRequired(impact) {
  return (
    impact.workerRuntime ||
    impact.materialization ||
    impact.seed ||
    impact.queueTopology ||
    impact.runner ||
    impact.narrativeContract ||
    impact.secrets
  );
}

function generationRequired(impact) {
  return impact.materialization || impact.seed;
}

function mutationsForClassification(
  classification,
  { analysisEnabled = true } = {}
) {
  if (classification.lane === RELEASE_LANES.ASSETS_ONLY) {
    return [
      "stage private release config and Worker-secret snapshots",
      "upload one inactive Worker version",
      "validate Worker runtime limits",
      "recheck predecessor and activate the exact target at 100%",
      "verify exact API and static build identity on both production origins"
    ];
  }
  const impact = classification.impact;
  const mutations = ["stage private release config and Worker-secret snapshots"];
  if (impact.queueTopology) {
    mutations.push("reconcile configured Queue names");
  }
  mutations.push("upload one inactive Worker version and validate runtime limits");
  if (impact.migrations || impact.seed) {
    mutations.push("capture a D1 Time Travel bookmark and full SQL export");
  }
  if (impact.migrations) mutations.push("apply pending additive migrations");
  if (impact.seed) mutations.push("apply the deterministic seed");
  if (analysisEnabled && runnerCompatibilityRequired(impact)) {
    mutations.push(
      impact.runner
        ? "verify and, if required, activate the target narrative runner"
        : "verify the unchanged compatible narrative runner"
    );
  }
  mutations.push(
    "recheck predecessor and activate the exact Worker target at 100%"
  );
  if (impact.queueTopology || impact.triggerTopology) {
    mutations.push(
      "reconcile stale and configured Queue consumers, then deploy and verify Queue/cron topology"
    );
  }
  if (generationRequired(impact)) {
    mutations.push("publish one exact-lineage forecast generation");
  }
  mutations.push(
    "verify exact API and static build identity on both production origins"
  );
  return mutations;
}

async function outerMain(options) {
  const { profile } = readProductionProfile(profilePath());
  const localEnvironment = createReleaseLocalEnvironment(process.env);
  let targetSha;
  if (options.resume) {
    targetSha = journalTargetForResume(profile, options.resume);
  } else {
    const linkedFixForwardSha = options.fixForward
      ? journalTargetForFixForwardRetry(profile, options.fixForward)
      : null;
    const linkedPreMutationReplacementSha = options.replacePreMutation
      ? journalTargetForPreMutationReplacementRetry(
          profile,
          options.replacePreMutation
        )
      : null;
    fetchTarget(profile.repositoryPath);
    const linkedTargetSha =
      linkedFixForwardSha ?? linkedPreMutationReplacementSha;
    if (linkedTargetSha !== null) {
      if (options.sha !== null && options.sha !== linkedTargetSha) {
        throw new Error(
          "--sha must match the exact linked pre-mutation replacement target"
        );
      }
      targetSha = linkedTargetSha;
    } else {
      const fetchedMain = resolveGitRevision(profile.repositoryPath, "origin/main");
      if (options.sha !== null && options.sha !== fetchedMain) {
        throw new Error("--sha must equal the freshly fetched origin/main commit");
      }
      targetSha = options.sha ?? fetchedMain;
    }
  }
  const prepared = prepareImmutableRelease({
    repositoryPath: profile.repositoryPath,
    releasesDirectory: profile.releasesDirectory,
    targetSha,
    install: true,
    environment: localEnvironment
  });
  const runTargetRelease = async () => {
    const handoff = createInternalHandoff({
      releaseRoot: prepared.path,
      targetGitSha: targetSha,
      profile: profilePath(),
      argv: process.argv.slice(2)
    });
    try {
      const child = spawn(
        process.execPath,
        [resolve(prepared.path, "scripts/release-prod.mjs"), ...process.argv.slice(2)],
        {
          cwd: prepared.path,
          stdio: ["pipe", "inherit", "inherit"],
          detached: true,
          env: {
            ...localEnvironment,
            [INTERNAL_ENV]: prepared.path,
            [TARGET_ENV]: targetSha,
            [PROFILE_ENV]: profilePath(),
            [HANDOFF_PATH_ENV]: handoff.path,
            [HANDOFF_TOKEN_ENV]: handoff.token
          }
        }
      );
      const childCompletion = new Promise((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("close", (code, signal) => resolveChild({ code, signal }));
      });
      if (!Number.isSafeInteger(child.pid) || child.pid < 1 || !child.stdin) {
        await childCompletion;
        throw new Error("Release supervisor could not establish the target process group");
      }
      let supervisorError = null;
      child.stdin.on("error", (error) => {
        if (error?.code !== "EPIPE") supervisorError ??= error;
      });
      process.stdin.pipe(child.stdin);

      let forwardedSignal = null;
      const handlers = new Map();
      const sendGroupSignal = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error?.code !== "ESRCH") supervisorError ??= error;
        }
      };
      for (const signal of FORWARDED_SIGNALS) {
        const handler = () => {
          forwardedSignal ??= signal;
          sendGroupSignal(signal);
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
      let result;
      try {
        result = await childCompletion;
      } finally {
        process.stdin.unpipe(child.stdin);
        child.stdin.destroy();
        for (const [signal, handler] of handlers) {
          process.off(signal, handler);
        }
      }

      const groupAlive = () => {
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          if (error?.code === "EPERM") return true;
          if (error?.code === "ESRCH") return false;
          throw error;
        }
      };
      const waitForGroupExit = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (groupAlive() && Date.now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
        return !groupAlive();
      };
      if (!(await waitForGroupExit(PROCESS_GROUP_STOP_TIMEOUT_MS))) {
        sendGroupSignal("SIGTERM");
        if (!(await waitForGroupExit(PROCESS_GROUP_STOP_TIMEOUT_MS))) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error?.code !== "ESRCH") throw error;
          }
          if (!(await waitForGroupExit(PROCESS_GROUP_STOP_TIMEOUT_MS))) {
            throw new Error(
              "Release process group remained alive after bounded termination"
            );
          }
        }
      }
      if (forwardedSignal !== null) {
        process.exitCode = SIGNAL_EXIT_CODES[forwardedSignal] ?? 1;
      } else if (result.code !== 0) {
        process.exitCode = result.code ?? SIGNAL_EXIT_CODES[result.signal] ?? 1;
      }
      if (supervisorError !== null) throw supervisorError;
    } finally {
      rmSync(handoff.directory, { recursive: true, force: true });
    }
  };
  if (options.plan) {
    await runTargetRelease();
    return;
  }
  await runTargetRelease();
}

function exactRunnerManifest(path) {
  const snapshot = readVerifiedFileSnapshot(path, {
    label: "Runner build manifest",
    maximumBytes: 1024 * 1024
  });
  const value = JSON.parse(snapshot.contents.toString("utf8"));
  if (
    value?.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(value.artifact?.sha256 ?? "") ||
    !Array.isArray(value.acceptedProtocols) ||
    value.acceptedProtocols.length < 1 ||
    value.acceptedProtocols.some(
      (candidate) => !/^[0-9a-f]{64}$/.test(candidate?.fingerprint ?? "")
    ) ||
    new Set(value.acceptedProtocols.map((candidate) => candidate.fingerprint)).size !==
      value.acceptedProtocols.length
  ) {
    throw new Error("Runner build manifest is invalid");
  }
  const descriptor = value.acceptedProtocols.find(
    (candidate) => candidate?.family === "surf.narrative"
  );
  if (!/^[0-9a-f]{64}$/.test(descriptor?.fingerprint ?? "")) {
    throw new Error("Runner build manifest lacks the Surf narrative protocol");
  }
  return Object.freeze({
    artifactSha256: value.artifact.sha256,
    protocolFingerprint: descriptor.fingerprint,
    acceptedProtocolFingerprints: Object.freeze(
      value.acceptedProtocols.map((candidate) => candidate.fingerprint)
    )
  });
}

function activeRunnerId(journal) {
  return (
    journal?.receipts?.runnerActivationId ??
    journal?.predecessor?.runnerActivationId ??
    null
  );
}

function predecessorFromJournal(journal, journalSha256) {
  return {
    releaseId: journal.releaseId,
    journalSha256,
    workerVersionId: journal.receipts.workerVersionId,
    deploymentId: journal.receipts.deploymentId,
    runnerActivationId: activeRunnerId(journal)
  };
}

function journalHasActivatedWorker(journal) {
  const state = [
    RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
    RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD
  ].includes(journal.state)
    ? journal.resumeFrom
    : journal.state;
  return [
    RELEASE_JOURNAL_STATES.WORKER_ACTIVE,
    RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED,
    RELEASE_JOURNAL_STATES.GENERATION_VERIFIED,
    RELEASE_JOURNAL_STATES.VERIFIED_LIVE,
    RELEASE_JOURNAL_STATES.COMPLETE
  ].includes(state);
}

function loadExistingReceipt(path) {
  if (!existsSync(path)) return null;
  const snapshot = readVerifiedFileSnapshot(path, {
    label: "Release operation receipt",
    maximumBytes: MAX_RELEASE_PRIVATE_JSON_BYTES,
    requireMode0600: true,
    requireCanonical: true
  });
  return JSON.parse(snapshot.contents.toString("utf8"));
}

function exactUploadReceipt(value) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "schemaVersion,workerVersionId" ||
    value.schemaVersion !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.workerVersionId ?? ""
    )
  ) {
    throw new Error("Worker upload receipt is invalid");
  }
  return value;
}

async function confirmPreview(preview, yes) {
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  if (yes) return;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question("Execute exactly this production release? [y/N] ");
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Release cancelled");
  } finally {
    input.close();
  }
}

async function internalMain(options) {
  const releaseRoot = realpathSync(process.env[INTERNAL_ENV]);
  const targetGitSha = process.env[TARGET_ENV];
  validateImmutableRelease(releaseRoot, targetGitSha);
  const { profile, sha256: profileSha256 } = readProductionProfile(profilePath());
  const temporaryRoot = realpathSync(
    mkdtempSync(join(tmpdir(), `surf-release-${targetGitSha.slice(0, 12)}-`))
  );
  chmodSync(temporaryRoot, 0o700);
  let stateDirectory = profile.stateDirectory;
  if (options.plan) {
    stateDirectory = resolve(temporaryRoot, "release-state");
    if (existsSync(profile.stateDirectory)) {
      cpSync(profile.stateDirectory, stateDirectory, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true
      });
    } else {
      mkdirSync(stateDirectory, { mode: 0o700 });
    }
  }
  const store = createReleaseStateStore({ rootDir: stateDirectory });
  const operatorEnvironment = validateProductionOperatorEnvironment(
    readStrictDotenvFile(
      profile.operatorEnvironmentPath,
      "Production operator environment"
    )
  );
  const runnerEnvironment = readStrictDotenvFile(
    profile.runnerEnvironmentPath,
    "Production runner environment source"
  );
  const secretFingerprintKey = runnerEnvironment.NARRATIVE_RUNNER_STATUS_HMAC_KEY;
  if (typeof secretFingerprintKey !== "string" || secretFingerprintKey.length < 32) {
    throw new Error("Production runner environment lacks a strong status HMAC key");
  }
  const inspectedSecrets = inspectWorkerSecrets({
    sourcePath: profile.workerSecretsSourcePath,
    hmacKey: secretFingerprintKey
  });
  const localEnvironment = createReleaseLocalEnvironment(process.env);
  const environment = createProductionChildEnvironment({
    systemEnvironment: process.env,
    operatorEnvironment,
    baseUrl: profile.customOrigin
  });

  let activePointer = store.readPointer(RELEASE_POINTER_KINDS.ACTIVE);
  let lastCompletePointer = store.readPointer(
    RELEASE_POINTER_KINDS.LAST_COMPLETE
  );
  let activeJournal = activePointer ? store.readJournal(activePointer.releaseId) : null;
  if (activePointer && !activeJournal) throw new Error("Active release journal is missing");
  const resumeJournal = options.resume ? store.readJournal(options.resume) : null;
  if (
    options.resume &&
    (!resumeJournal || resumeJournal.targetGitSha !== targetGitSha)
  ) {
    throw new Error("Resume journal does not match the exact target release");
  }
  const explicitlySelectedReleaseId =
    options.resume ?? options.fixForward ?? options.replacePreMutation;
  for (const journalBatch of store.scanJournalBatches()) {
    for (const journal of journalBatch) {
      if (journal.state === RELEASE_JOURNAL_STATES.SUPERSEDED) {
        const replacement = store.readJournal(journal.supersededBy.releaseId);
        if (replacement) {
          assertReleaseSupersession(journal, replacement);
          if (options.fixForward === journal.releaseId) {
            throw new Error(
              `Fix-forward journal ${replacement.releaseId} already exists; use --resume ${replacement.releaseId}`
            );
          }
        } else if (options.fixForward !== journal.releaseId) {
          throw new Error(
            `Superseded release ${journal.releaseId} requires exact --fix-forward recovery before its linked journal exists`
          );
        }
        continue;
      }
      if (journal.state === RELEASE_JOURNAL_STATES.REPLACED) {
        const replacement = store.readJournal(journal.supersededBy.releaseId);
        if (replacement) {
          assertPreMutationReleaseReplacement(journal, replacement);
          if (options.replacePreMutation === journal.releaseId) {
            throw new Error(
              `Pre-mutation replacement journal ${replacement.releaseId} already exists; use --resume ${replacement.releaseId}`
            );
          }
        } else if (options.replacePreMutation !== journal.releaseId) {
          throw new Error(
            `Replaced release ${journal.releaseId} requires exact --replace-pre-mutation recovery before its linked journal exists`
          );
        }
        continue;
      }
      if (
        journal.state !== RELEASE_JOURNAL_STATES.COMPLETE &&
        journal.releaseId !== explicitlySelectedReleaseId
      ) {
        throw new Error(
          `Incomplete production release requires explicit recovery: ${journal.releaseId}`
        );
      }
    }
  }
  const activeCompletionNeedsRepair = Boolean(
    activeJournal?.state === RELEASE_JOURNAL_STATES.COMPLETE &&
      (!releasePointerMatchesJournal(
        activePointer,
        activeJournal,
        RELEASE_POINTER_KINDS.ACTIVE
      ) ||
        !releasePointerMatchesJournal(
          lastCompletePointer,
          activeJournal,
          RELEASE_POINTER_KINDS.LAST_COMPLETE
        ))
  );
  if (
    activeCompletionNeedsRepair &&
    options.resume !== activeJournal.releaseId
  ) {
    throw new Error(
      `Complete production release ${activeJournal.releaseId} requires exact --resume pointer repair`
    );
  }
  if (
    activeJournal &&
    ![
      RELEASE_JOURNAL_STATES.COMPLETE,
      RELEASE_JOURNAL_STATES.SUPERSEDED,
      RELEASE_JOURNAL_STATES.REPLACED
    ].includes(activeJournal.state) &&
    options.resume !== activeJournal.releaseId &&
    options.fixForward !== activeJournal.releaseId
  ) {
    throw new Error(
      `Production points at incomplete release ${activeJournal.releaseId}; use --resume ${activeJournal.releaseId} or --fix-forward ${activeJournal.releaseId}`
    );
  }
  if (activeJournal?.state === RELEASE_JOURNAL_STATES.SUPERSEDED) {
    const linkedReleaseId = activeJournal.supersededBy.releaseId;
    const exactLinkedRecovery =
      options.resume === linkedReleaseId ||
      options.fixForward === activeJournal.releaseId;
    if (!exactLinkedRecovery) {
      throw new Error(
        `Production points at superseded release ${activeJournal.releaseId}; recover linked release ${linkedReleaseId}`
      );
    }
  }
  if (activeJournal?.state === RELEASE_JOURNAL_STATES.REPLACED) {
    throw new Error(
      "A pre-mutation replaced journal cannot be the active production release"
    );
  }
  let activeReceipt = null;
  if (
    activeJournal?.state === RELEASE_JOURNAL_STATES.COMPLETE &&
    releasePointerMatchesJournal(
      activePointer,
      activeJournal,
      RELEASE_POINTER_KINDS.ACTIVE
    )
  ) {
    activeReceipt = store.readTrustedActiveReceipt();
  }

  const verifyOutput = spawnSync("pnpm", ["verify"], {
    cwd: releaseRoot,
    stdio: "inherit",
    env: { ...localEnvironment, CI: "true" }
  });
  if (verifyOutput.error) throw verifyOutput.error;
  if (verifyOutput.status !== 0) throw new Error("pnpm verify failed for the target release");
  run("pnpm", ["--filter", "@surf/narrative-runner", "build"], {
    cwd: releaseRoot,
    stdio: "pipe",
    env: { ...localEnvironment, CI: "true" }
  });
  validateImmutableRelease(releaseRoot, targetGitSha);

  const runnerArtifactPath = resolve(
    releaseRoot,
    "apps/narrative-runner/dist/narrative-runner.mjs"
  );
  const runnerManifestPath = resolve(
    releaseRoot,
    "apps/narrative-runner/dist/narrative-runner.manifest.json"
  );
  const runnerManifest = exactRunnerManifest(runnerManifestPath);
  if (sha256File(runnerArtifactPath) !== runnerManifest.artifactSha256) {
    throw new Error("Runner artifact differs from its build manifest");
  }
  const clientDigest = clientBuildDigest(releaseRoot);
  let probeContext;
  let finalProbeContext;
  let workerBuild;
  const configSourceSha256 = sha256File(profile.wranglerSourcePath);
  const workerSecretsSourceSha256 = sha256File(profile.workerSecretsSourcePath);
  const runnerEnvironmentSha256 = sha256File(profile.runnerEnvironmentPath);
  const operatorEnvironmentSha256 = sha256File(profile.operatorEnvironmentPath);
  const operatorEnvironmentFingerprint = privateFileHmacFingerprint({
    path: profile.operatorEnvironmentPath,
    hmacKey: secretFingerprintKey,
    domain: "surf-release-operator-environment-v1"
  });
  const guardSources = () => {
    validateImmutableRelease(releaseRoot, targetGitSha);
    inspectedSecrets.assertUnchanged();
    if (
      readProductionProfile(profilePath()).sha256 !== profileSha256 ||
      sha256File(profile.wranglerSourcePath) !== configSourceSha256 ||
      sha256File(profile.workerSecretsSourcePath) !== workerSecretsSourceSha256 ||
      sha256File(profile.runnerEnvironmentPath) !== runnerEnvironmentSha256 ||
      sha256File(profile.operatorEnvironmentPath) !== operatorEnvironmentSha256
    ) {
      throw new Error("Production profile input changed during release");
    }
  };
  try {
    const provisional = stageWranglerConfigSnapshot({
      sourcePath: profile.wranglerSourcePath,
      outputPath: resolve(temporaryRoot, "wrangler-probe.jsonc"),
      releaseRoot,
      releaseIdentity: {
        sourceRevision: targetGitSha,
        workerRuntimeDigest: "0".repeat(64),
        clientBuildDigest: clientDigest
      }
    });
    probeContext = createCloudflareCommandContext({
      releaseRoot,
      configPath: provisional.path,
      configSha256: provisional.sha256,
      environment,
      guard: guardSources
    });
    workerBuild = buildWorkerCandidate({
      context: probeContext,
      outputDirectory: resolve(releaseRoot, "dist/release-worker-probe"),
      sourceRevision: targetGitSha,
      clientBuildDigest: clientDigest
    });
    const finalProbe = stageWranglerConfigSnapshot({
      sourcePath: profile.wranglerSourcePath,
      outputPath: resolve(temporaryRoot, "wrangler-final.jsonc"),
      releaseRoot,
      releaseIdentity: {
        sourceRevision: targetGitSha,
        workerRuntimeDigest: workerBuild.workerRuntimeDigest,
        clientBuildDigest: clientDigest
      }
    });
    finalProbeContext = createCloudflareCommandContext({
      releaseRoot,
      configPath: finalProbe.path,
      configSha256: finalProbe.sha256,
      environment,
      guard: guardSources
    });
    const secondBuild = buildWorkerCandidate({
      context: finalProbeContext,
      outputDirectory: resolve(releaseRoot, "dist/release-worker-final"),
      sourceRevision: targetGitSha,
      clientBuildDigest: clientDigest
    });
    if (secondBuild.workerRuntimeDigest !== workerBuild.workerRuntimeDigest) {
      throw new Error("Worker runtime digest changed after release identity was pinned");
    }
    workerBuild = secondBuild;

    const fingerprints = computeReleaseFingerprints({
      releaseRoot,
      workerBundlePath: workerBuild.bundlePath,
      runnerBundlePath: runnerArtifactPath,
      runnerEnvironmentPath: profile.runnerEnvironmentPath,
      wranglerSourcePath: profile.wranglerSourcePath,
      workerSecretsPath: profile.workerSecretsSourcePath,
      secretFingerprintKey,
      narrativeProtocolFingerprint: runnerManifest.protocolFingerprint
    });
    const runnerRequiresReplacement = runnerReplacementRequired({
      targetFingerprints: fingerprints,
      activeFingerprints: activeJournal?.targetFingerprints ?? null
    });
    assertRoutineNarrativeContractTransition({
      activeFingerprint:
        activeJournal?.targetFingerprints.narrativeContract ?? null,
      targetFingerprint: fingerprints.narrativeContract,
      runnerAcceptedFingerprints: runnerManifest.acceptedProtocolFingerprints
    });
    assertRoutineWorkerSecretTransition({
      activeFingerprint:
        activeJournal?.targetFingerprints.workerSecrets ?? null,
      targetFingerprint: fingerprints.workerSecrets
    });
    const activeRunnerRuntimeFingerprint =
      activeJournal?.targetFingerprints.runnerRuntime ?? null;
    if (
      activeRunnerRuntimeFingerprint !== null &&
      activeRunnerRuntimeFingerprint !== fingerprints.runnerRuntime
    ) {
      const installedRunner = await discoverRunnerActivationFromInstalledPlist({
        serviceRoot: profile.serviceRoot,
        allowLegacyV3: true
      });
      if (installedRunner.recordSchemaVersion !== 4) {
        throw new Error(
          "Managed runner runtime changes require an active v4 runner baseline"
        );
      }
      const recordSnapshot = readVerifiedFileSnapshot(installedRunner.recordPath, {
        label: "Active runner activation record",
        maximumBytes: 1024 * 1024,
        requireMode0600: true,
        requireCanonical: true
      });
      const activeRunnerRecord = JSON.parse(
        recordSnapshot.contents.toString("utf8")
      );
      const activeRunnerEnvironmentPath =
        activeRunnerRecord?.runtime?.environmentPath;
      if (typeof activeRunnerEnvironmentPath !== "string") {
        throw new Error("Active v4 runner record lacks its environment path");
      }
      assertRoutineRunnerRuntimeTransition({
        activeFingerprint: activeRunnerRuntimeFingerprint,
        targetFingerprint: fingerprints.runnerRuntime,
        activeEnvironmentPath: activeRunnerEnvironmentPath,
        targetEnvironmentPath: profile.runnerEnvironmentPath,
        hmacKey: secretFingerprintKey
      });
    }

    const readOnlyActive = finalProbeContext.runWrangler(
      ["deployments", "status", "--json"],
      { capture: true, echo: false }
    );
    const { resolveSoleActiveWorkerVersionId } = await import(
      "./lib/worker-runtime.mjs"
    );
    const { resolveActiveDeploymentId } = await import("./lib/deploy-url.mjs");
    const livePredecessorVersionId = resolveSoleActiveWorkerVersionId(readOnlyActive);
    const livePredecessorDeploymentId = resolveActiveDeploymentId(
      readOnlyActive,
      livePredecessorVersionId
    );
    const liveVersionDetail = finalProbeContext.runWrangler(
      ["versions", "view", livePredecessorVersionId, "--json"],
      { capture: true, echo: false }
    );
    let legacyLineageEvidence = null;
    let liveSourceRevision = resolveOptionalWorkerSourceRevision(
      liveVersionDetail,
      livePredecessorVersionId
    );
    if (liveSourceRevision === null) {
      if (activeReceipt !== null) {
        throw new Error(
          "Trusted active receipt exists but the live Worker lacks managed source identity"
        );
      }
      legacyLineageEvidence =
        await discoverRunnerActivationFromInstalledPlist({
          serviceRoot: profile.serviceRoot,
          allowLegacyV3: true
        });
      if (
        legacyLineageEvidence.recordSchemaVersion !== 3 ||
        legacyLineageEvidence.transitionOnly !== true ||
        !SHA_PATTERN.test(
          legacyLineageEvidence.legacyCoupledSourceRevision ?? ""
        )
      ) {
        throw new Error(
          "Unmanaged Worker adoption requires exact legacy v3 coupled-lineage evidence"
        );
      }
      liveSourceRevision = legacyLineageEvidence.legacyCoupledSourceRevision;
      if (
        resolveGitRevision(profile.repositoryPath, liveSourceRevision) !==
        liveSourceRevision
      ) {
        throw new Error("Legacy Worker source revision is not an exact local commit");
      }
    }
    const exactResumeTargetIsLive = Boolean(
      resumeJournal &&
        exactResumeJournalAcceptsLiveTarget(resumeJournal, {
          targetGitSha,
          liveSourceRevision,
          liveWorkerVersionId: livePredecessorVersionId
        })
    );
    if (
      activeReceipt !== null &&
      activeReceipt.targetGitSha !== liveSourceRevision &&
      !exactResumeTargetIsLive
    ) {
      throw new Error("Trusted active receipt differs from the live Worker source revision");
    }
    const baseSha = activeReceipt?.targetGitSha ?? liveSourceRevision;
    assertAppendOnlyMigrationHistory(
      profile.repositoryPath,
      baseSha,
      targetGitSha
    );
    const paths = listChangedReleasePaths(
      profile.repositoryPath,
      baseSha,
      targetGitSha
    );
    let classification = classifyReleaseImpact({
      changedPaths: paths,
      targetFingerprints: fingerprints,
      activeReceipt
    });
    if (options.forceFull) {
      classification = forceConservativeReleaseClassification(classification);
    }
    if (options.fixForward) {
      classification = forceConservativeReleaseClassification(
        classification,
        RELEASE_CLASSIFICATION_REASON_CODES.FIX_FORWARD_REQUIRED
      );
    }
    let managedJournal = resumeJournal;
    let fixForwardSource = null;
    let preMutationReplacementSource = null;
    let predecessor;
    if (options.resume) {
      classification = managedJournal.classification;
      predecessor = managedJournal.predecessor;
    } else if (options.fixForward) {
      const failed = store.readJournal(options.fixForward);
      if (
        !failed ||
        activePointer?.releaseId !== failed.releaseId ||
        ![
          RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD,
          RELEASE_JOURNAL_STATES.SUPERSEDED
        ].includes(failed.state)
      ) {
        throw new Error("Fix-forward must name the currently active failed release");
      }
      if (failed.targetGitSha === targetGitSha) {
        throw new Error("Fix-forward requires a new target SHA; resume the failed release instead");
      }
      if (
        failed.state === RELEASE_JOURNAL_STATES.SUPERSEDED &&
        failed.supersededBy.targetGitSha !== targetGitSha
      ) {
        throw new Error("Linked fix-forward target differs from its immutable journal");
      }
      fixForwardSource = failed;
      predecessor = predecessorFromJournal(failed, fingerprintReleaseJournal(failed));
    } else if (options.replacePreMutation) {
      const failed = store.readJournal(options.replacePreMutation);
      if (
        !failed ||
        ![
          RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
          RELEASE_JOURNAL_STATES.REPLACED
        ].includes(failed.state)
      ) {
        throw new Error(
          "Pre-mutation replacement must name a receipt-free failure from planned or its linked journal"
        );
      }
      if (
        activePointer?.releaseId === failed.releaseId ||
        lastCompletePointer?.releaseId === failed.releaseId
      ) {
        throw new Error(
          "Pre-mutation replacement cannot target an active or last-complete release"
        );
      }
      if (failed.targetGitSha === targetGitSha) {
        throw new Error(
          "Pre-mutation replacement requires a new target SHA; resume the failed release instead"
        );
      }
      if (
        failed.state === RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE &&
        (failed.resumeFrom !== RELEASE_JOURNAL_STATES.PLANNED ||
          Object.values(failed.receipts).some((value) => value !== null) ||
          failed.predecessor.workerVersionId === null ||
          failed.predecessor.deploymentId === null)
      ) {
        throw new Error(
          "Pre-mutation replacement is limited to a receipt-free failure from planned with an exact live predecessor"
        );
      }
      if (
        failed.state === RELEASE_JOURNAL_STATES.REPLACED &&
        failed.supersededBy.targetGitSha !== targetGitSha
      ) {
        throw new Error(
          "Linked pre-mutation replacement target differs from its immutable journal"
        );
      }
      preMutationReplacementSource = failed;
      predecessor =
        failed.state === RELEASE_JOURNAL_STATES.REPLACED
          ? predecessorForPreMutationReplacement(failed)
          : failed.predecessor;
    } else if (activeJournal) {
      predecessor = predecessorFromJournal(activeJournal, activePointer.journalSha256);
    } else {
      let discoveredRunner = legacyLineageEvidence;
      try {
        discoveredRunner ??=
          await discoverRunnerActivationFromInstalledPlist({
            serviceRoot: profile.serviceRoot,
            allowLegacyV3: true
          });
      } catch {
        // A first managed release can proceed only after ensureRunner obtains
        // explicit transition evidence; keep the journal predecessor secret-free.
      }
      predecessor = {
        releaseId: null,
        journalSha256: null,
        workerVersionId: livePredecessorVersionId,
        deploymentId: livePredecessorDeploymentId,
        runnerActivationId: discoveredRunner?.activationId ?? null
      };
    }

    if (generationRequired(classification.impact)) {
      requireProductionIngestToken(operatorEnvironment);
    }

    if (
      options.resume &&
      journalNeedsActivationBoundaryReconciliation(managedJournal)
    ) {
      const reconciled = reconcileReleaseActivationBoundary(managedJournal, {
        liveWorkerVersionId: livePredecessorVersionId,
        liveDeploymentId: livePredecessorDeploymentId,
        at: new Date().toISOString()
      });
      if (reconciled.journal !== managedJournal) {
        managedJournal = store.writeJournal(reconciled.journal);
      }
      if (reconciled.targetIsActive) {
        activePointer = store.writePointer(
          createReleasePointer(managedJournal, RELEASE_POINTER_KINDS.ACTIVE, {
            at: new Date().toISOString()
          })
        );
        activeJournal = managedJournal;
      }
    }

    const expectedLiveVersionId =
      managedJournal && journalHasActivatedWorker(managedJournal)
        ? managedJournal.receipts.workerVersionId
        : predecessor.workerVersionId;
    const expectedLiveDeploymentId =
      managedJournal && journalHasActivatedWorker(managedJournal)
        ? managedJournal.receipts.deploymentId
        : predecessor.deploymentId;
    if (
      expectedLiveVersionId !== livePredecessorVersionId ||
      expectedLiveDeploymentId !== livePredecessorDeploymentId
    ) {
      throw new Error(
        "Journal predecessor does not match the sole active Worker deployment"
      );
    }

    const releaseId =
      managedJournal?.releaseId ??
      fixForwardSource?.supersededBy?.releaseId ??
      preMutationReplacementSource?.supersededBy?.releaseId ??
      releaseIdFor(targetGitSha);
    const analysisEnabled =
      finalProbeContext.readConfig().vars?.NARRATIVE_ENABLED === "true";
    const preview = boundedReleasePreview({
      releaseId,
      targetGitSha,
      lane: classification.lane,
      changedPaths: classification.changedPaths,
      reasonCodes: classification.reasonCodes,
      mismatchKeys: classification.mismatchKeys,
      predecessorWorkerVersionId: livePredecessorVersionId,
      mutations: mutationsForClassification(classification, {
        analysisEnabled
      })
    });
    if (options.plan) {
      process.stdout.write(
        `${JSON.stringify({ ...preview, readOnly: true }, null, 2)}\n`
      );
      return;
    }
    await confirmPreview(preview, options.yes);

    if (fixForwardSource) {
      if (fixForwardSource.state === RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD) {
        fixForwardSource = store.writeJournal(
          supersedeReleaseJournal(fixForwardSource, {
            releaseId,
            targetGitSha,
            at: new Date().toISOString()
          })
        );
      } else if (
        fixForwardSource.supersededBy.releaseId !== releaseId ||
        fixForwardSource.supersededBy.targetGitSha !== targetGitSha
      ) {
        throw new Error("Linked fix-forward identity changed before journal creation");
      }
      predecessor = predecessorFromJournal(
        fixForwardSource,
        fingerprintReleaseJournal(fixForwardSource)
      );
      activeJournal = fixForwardSource;
      activePointer = store.writePointer(
        createReleasePointer(fixForwardSource, RELEASE_POINTER_KINDS.ACTIVE, {
          at: new Date().toISOString()
        })
      );
    }

    if (preMutationReplacementSource) {
      if (
        preMutationReplacementSource.state ===
        RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE
      ) {
        preMutationReplacementSource = store.writeJournal(
          replacePreMutationReleaseJournal(preMutationReplacementSource, {
            releaseId,
            targetGitSha,
            at: new Date().toISOString()
          })
        );
      } else if (
        preMutationReplacementSource.supersededBy.releaseId !== releaseId ||
        preMutationReplacementSource.supersededBy.targetGitSha !== targetGitSha
      ) {
        throw new Error(
          "Linked pre-mutation replacement identity changed before journal creation"
        );
      }
      predecessor = predecessorForPreMutationReplacement(
        preMutationReplacementSource
      );
    }

    const attemptsDirectory = ensurePrivateSubdirectory(
      profile.stateDirectory,
      "attempts",
      "Release attempts directory"
    );
    const attemptDirectory = ensurePrivateSubdirectory(
      attemptsDirectory,
      releaseId,
      "Release attempt directory"
    );
    if (!managedJournal) {
      managedJournal = createReleaseJournal({
        releaseId,
        targetGitSha,
        classification,
        targetFingerprints: fingerprints,
        predecessor,
        createdAt: new Date().toISOString()
      });
      if (fixForwardSource) {
        assertReleaseSupersession(fixForwardSource, managedJournal);
      }
      if (preMutationReplacementSource) {
        assertPreMutationReleaseReplacement(
          preMutationReplacementSource,
          managedJournal
        );
      }
      managedJournal = store.writeJournal(managedJournal);
    } else if (
      JSON.stringify(managedJournal.targetFingerprints) !== JSON.stringify(fingerprints)
    ) {
      throw new Error("Resume target fingerprints differ from the journal");
    }

    let finalContext;
    let workerOperations;
    let secretSnapshot;
    let currentRunnerActivationId =
      managedJournal.receipts.runnerActivationId ??
      activeRunnerId(activeJournal) ??
      predecessor.runnerActivationId;
    let targetWorkerVersionId = managedJournal.receipts.workerVersionId;
    const uploadReceiptPath = resolve(attemptDirectory, "worker-upload.json");
    const backupReceiptPath = resolve(attemptDirectory, "d1-backup.json");
    let rollbackDirectory = null;

    const prepareRuntime = () => {
      if (finalContext) return;
      const config = stageWranglerConfigSnapshot({
        sourcePath: profile.wranglerSourcePath,
        outputPath: resolve(attemptDirectory, "wrangler.jsonc"),
        releaseRoot,
        releaseIdentity: {
          sourceRevision: targetGitSha,
          workerRuntimeDigest: workerBuild.workerRuntimeDigest,
          clientBuildDigest: clientDigest
        }
      });
      secretSnapshot = stageWorkerSecretsSnapshot({
        sourcePath: profile.workerSecretsSourcePath,
        outputPath: resolve(attemptDirectory, "worker-secrets.json"),
        hmacKey: secretFingerprintKey
      });
      finalContext = createCloudflareCommandContext({
        releaseRoot,
        configPath: config.path,
        configSha256: config.sha256,
        environment,
        guard: () => {
          guardSources();
          secretSnapshot.assertUnchanged();
        }
      });
      workerOperations = createWorkerReleaseOperations({
        context: finalContext,
        workerSecretsFile: secretSnapshot.path,
        customOrigin: profile.customOrigin,
        workersDevOrigin: profile.workersDevOrigin,
        clientDirectory: workerBuild.clientDirectory,
        sourceRevision: targetGitSha,
        clientBuildDigest: clientDigest,
        workerRuntimeDigest: workerBuild.workerRuntimeDigest,
        narrativeProtocolFingerprint: runnerManifest.protocolFingerprint,
        releaseTag: releaseId
      });
    };

    try {
      prepareRuntime();
      if (managedJournal.receipts.profileSha256 !== null) {
        const preparedReceipts = managedJournal.receipts;
        if (
          preparedReceipts.profileSha256 !== profileSha256 ||
          preparedReceipts.operatorEnvironmentFingerprint !==
            operatorEnvironmentFingerprint ||
          preparedReceipts.wranglerConfigSha256 !== finalContext.configSha256 ||
          preparedReceipts.workerSecretsFingerprint !== secretSnapshot.fingerprint
        ) {
          throw new Error(
            "Resume production inputs differ from the journaled prepared release"
          );
        }
      }
    } catch (error) {
      managedJournal = persistPreControllerPreparationFailure({
        journal: managedJournal,
        store,
        at: new Date().toISOString()
      });
      throw error;
    }

    let queueIdentityReceipt = null;
    const runnerBindingOptions = async () => {
      prepareRuntime();
      const config = finalContext.readConfig();
      const producer = (config.queues?.producers ?? []).find(
        (candidate) => candidate.binding === "NARRATIVE_QUEUE"
      );
      if (!producer?.queue) throw new Error("Release config lacks NARRATIVE_QUEUE");
      queueIdentityReceipt ??= await finalContext.inspectQueueIdentities();
      const queueId = queueIdentityReceipt.queues[producer.queue];
      if (!queueId) {
        throw new Error("Release Queue identity receipt lacks NARRATIVE_QUEUE");
      }
      return {
        expectedCloudflareAccountId: queueIdentityReceipt.accountId,
        expectedQueueId: queueId,
        expectedQueueName: producer.queue,
        expectedDeadLetterQueueName: `${config.name}-narrative-dlq`,
        expectedCallbackOrigin: profile.customOrigin,
        workerGeminiToken: secretSnapshot.geminiToken,
        workerResultToken: secretSnapshot.resultToken
      };
    };
    const narrativeAnalysisEnabled = () => {
      prepareRuntime();
      return finalContext.readConfig().vars?.NARRATIVE_ENABLED === "true";
    };
    const runnerCompatibilityOptions = async (activationId) => ({
      activationId,
      serviceRoot: profile.serviceRoot,
      expectedProtocolFingerprint: runnerManifest.protocolFingerprint,
      ...(await runnerBindingOptions())
    });

    const operations = {
      async verify() {
        validateImmutableRelease(releaseRoot, targetGitSha);
        guardSources();
        if (profileSha256 !== readProductionProfile(profilePath()).sha256) {
          throw new Error("Production profile changed after planning");
        }
      },
      async prepare() {
        prepareRuntime();
        if (classification.impact.queueTopology) {
          finalContext.ensureQueues();
        }
        if (
          runnerCompatibilityRequired(classification.impact) &&
          narrativeAnalysisEnabled()
        ) {
          verifyRunnerEnvironmentBindings(
            runnerEnvironment,
            await runnerBindingOptions()
          );
        }
        return {
          profileSha256,
          operatorEnvironmentFingerprint,
          wranglerConfigSha256: finalContext.configSha256,
          workerSecretsFingerprint: secretSnapshot.fingerprint
        };
      },
      async uploadWorker() {
        prepareRuntime();
        const existing = loadExistingReceipt(uploadReceiptPath);
        if (existing) {
          const receipt = exactUploadReceipt(existing);
          workerOperations.inspectVersion(receipt.workerVersionId);
          targetWorkerVersionId = receipt.workerVersionId;
          return receipt;
        }
        const reconciled = workerOperations.findTaggedUpload();
        if (reconciled) {
          targetWorkerVersionId = reconciled.versionId;
          const receipt = {
            schemaVersion: 1,
            workerVersionId: reconciled.versionId
          };
          atomicWriteReleaseJsonSync(uploadReceiptPath, receipt);
          return receipt;
        }
        const finalBuild = buildWorkerCandidate({
          context: finalContext,
          outputDirectory: resolve(releaseRoot, "dist/release-worker-upload"),
          sourceRevision: targetGitSha,
          clientBuildDigest: clientDigest
        });
        if (finalBuild.workerRuntimeDigest !== workerBuild.workerRuntimeDigest) {
          throw new Error("Final Worker dry-run differs from the planned runtime digest");
        }
        const uploaded = workerOperations.upload();
        targetWorkerVersionId = uploaded.versionId;
        const receipt = { schemaVersion: 1, workerVersionId: uploaded.versionId };
        atomicWriteReleaseJsonSync(uploadReceiptPath, receipt);
        return receipt;
      },
      async prepareData() {
        prepareRuntime();
        const rollbacksDirectory = ensurePrivateSubdirectory(
          profile.serviceRoot,
          "rollbacks",
          "Release rollback store"
        );
        rollbackDirectory = ensurePrivateSubdirectory(
          rollbacksDirectory,
          releaseId,
          "Release rollback directory"
        );
        const storage = createReleaseStorage({ commandContext: finalContext });
        const migrationDirectory = resolve(releaseRoot, "packages/db/migrations");
        const migrationPaths = readdirSync(migrationDirectory)
          .filter((name) => name.endsWith(".sql"))
          .sort()
          .map((name) => resolve(migrationDirectory, name));
        const inspection = classification.impact.migrations
          ? await storage.inspectPendingMigrations({
              databaseName: "DB",
              migrationPaths
            })
          : null;
        const existing = loadExistingReceipt(backupReceiptPath);
        const backup = await storage.prepareBackup({
          databaseName: "DB",
          destination: resolve(rollbackDirectory, "surf-before.sql"),
          receipt: existing
        });
        if (!existing) atomicWriteReleaseJsonSync(backupReceiptPath, backup);
        if (inspection?.hasPending) {
          workerOperations.migrate();
          const afterMigration = await storage.inspectPendingMigrations({
            databaseName: "DB",
            migrationPaths
          });
          if (afterMigration.hasPending) {
            throw new Error(
              "D1 still reports pending migrations after the bounded migration command"
            );
          }
        }
        if (classification.impact.seed) workerOperations.seed();
        return {
          d1Bookmark: backup.bookmark,
          d1ExportSha256: backup.exportSha256
        };
      },
      async ensureRunner() {
        prepareRuntime();
        guardSources();
        if (!narrativeAnalysisEnabled()) {
          return {
            runnerActivationId: null,
            runnerDrainSha256: null
          };
        }
        const installedRunner =
          await discoverRunnerActivationFromInstalledPlist({
            serviceRoot: profile.serviceRoot,
            allowLegacyV3: true
          });
        const replacementRequired =
          runnerRequiresReplacement ||
          installedRunner.recordSchemaVersion === 3;
        if (!replacementRequired && currentRunnerActivationId) {
          try {
            const compatible = await verifyActiveRunnerCompatibility(
              await runnerCompatibilityOptions(currentRunnerActivationId)
            );
            if (compatible.runnerArtifactSha256 === runnerManifest.artifactSha256) {
              return { runnerActivationId: currentRunnerActivationId };
            }
          } catch (error) {
            throw new Error(
              "The unchanged narrative runner is not healthy and compatible; routine release will not restart it",
              { cause: error }
            );
          }
        }
        if (!classification.impact.runner) {
          throw new Error(
            "Narrative runner replacement was not authorized by the inferred release impact"
          );
        }
        const priorRecordPath = currentRunnerActivationId
          ? resolve(
              profile.serviceRoot,
              "launch-agents",
              currentRunnerActivationId,
              "activation-record.json"
            )
          : installedRunner.recordPath;
        const activated = await activateTargetRunner({
          targetReleaseRoot: releaseRoot,
          targetGitSha,
          activationId: releaseId,
          serviceRoot: profile.serviceRoot,
          runnerEnvironmentSourcePath: profile.runnerEnvironmentPath,
          runnerArtifactPath,
          runnerArtifactManifestPath: runnerManifestPath,
          priorRecordPath,
          environment
        });
        let runnerDrainSha256 = null;
        if (activated.drainReceipt !== null) {
          const drainPath = resolve(attemptDirectory, "runner-drain.json");
          atomicWriteReleaseJsonSync(drainPath, activated.drainReceipt);
          runnerDrainSha256 = sha256File(drainPath);
        }
        guardSources();
        currentRunnerActivationId = activated.activationId;
        await verifyActiveRunnerCompatibility(
          await runnerCompatibilityOptions(currentRunnerActivationId)
        );
        return {
          runnerActivationId: currentRunnerActivationId,
          runnerDrainSha256
        };
      },
      async verifyDependencies({ phase }) {
        prepareRuntime();
        guardSources();
        if (!new Set(["pre-activation", "final"]).has(phase)) {
          throw new Error("Release dependency verification phase is invalid");
        }
        if (classification.impact.queueTopology) {
          const queues = finalContext.inspectQueues();
          if (!queues.matches) {
            throw new Error("Configured Queue topology drifted after preparation");
          }
        }
        if (
          narrativeAnalysisEnabled() &&
          runnerCompatibilityRequired(classification.impact)
        ) {
          if (!currentRunnerActivationId) {
            throw new Error("Analysis release lacks a runner activation to re-attest");
          }
          const compatible = await verifyActiveRunnerCompatibility(
            await runnerCompatibilityOptions(currentRunnerActivationId)
          );
          if (compatible.runnerArtifactSha256 !== runnerManifest.artifactSha256) {
            throw new Error("Active runner artifact drifted from the target release");
          }
        }
        if (
          phase === "final" &&
          (classification.impact.queueTopology ||
            classification.impact.triggerTopology)
        ) {
          const queueConsumers = await workerOperations.inspectQueueConsumers();
          const triggers = await finalContext.inspectCronTriggers();
          if (!queueConsumers.matches || !triggers.matches) {
            throw new Error(
              "Queue consumer or cron trigger topology drifted before completion"
            );
          }
        }
        guardSources();
      },
      async recheckPredecessor() {
        prepareRuntime();
        const active = workerOperations.inspectActive();
        if (
          active.workerVersionId !== predecessor.workerVersionId ||
          active.deploymentId !== predecessor.deploymentId
        ) {
          throw new Error(
            "Active Worker predecessor deployment changed after preparation"
          );
        }
      },
      async inspectActivation() {
        prepareRuntime();
        return workerOperations.reconcileActivation({
          targetVersionId: targetWorkerVersionId,
          targetDeploymentId: managedJournal.receipts.deploymentId,
          predecessorVersionId: predecessor.workerVersionId,
          predecessorDeploymentId: predecessor.deploymentId
        });
      },
      async activateWorker() {
        prepareRuntime();
        const result = workerOperations.activate(
          targetWorkerVersionId,
          predecessor
        );
        return { deploymentId: result.deploymentId };
      },
      async waitUntilServing() {
        await workerOperations.waitUntilServing(targetWorkerVersionId);
      },
      async inspectTriggers() {
        return workerOperations.inspectTriggers();
      },
      async inspectQueueConsumers() {
        return workerOperations.inspectQueueConsumers();
      },
      async syncTriggers() {
        return workerOperations.syncTriggers();
      },
      async inspectGeneration(notBefore) {
        return workerOperations.inspectGeneration(
          targetWorkerVersionId,
          notBefore
        );
      },
      async generate() {
        const token = requireProductionIngestToken(operatorEnvironment);
        return workerOperations.generate(targetWorkerVersionId, token);
      },
      async verifyLive() {
        return workerOperations.verifyLive(targetWorkerVersionId, {
          requireForecastData: true
        });
      }
    };

    const complete = await executeRelease({
      journal: managedJournal,
      store,
      operations,
      resumeReleaseId: options.resume
    });
    process.stdout.write(
      `${JSON.stringify({
        status: "complete",
        releaseId: complete.releaseId,
        targetGitSha: complete.targetGitSha,
        lane: complete.lane,
        workerVersionId: complete.receipts.workerVersionId,
        deploymentId: complete.receipts.deploymentId
      })}\n`
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const options = parseReleaseProdArguments(process.argv.slice(2));
if (process.env[INTERNAL_ENV]) {
  consumeInternalHandoff(options);
  if (options.plan) {
    await internalMain(options);
  } else {
    const targetGitSha = process.env[TARGET_ENV];
    const { profile } = readProductionProfile(profilePath());
    const releaseLock = acquireReleaseLock({
      stateDirectory: profile.stateDirectory,
      targetGitSha
    });
    let completed = false;
    try {
      await internalMain(options);
      completed = true;
    } finally {
      if (completed) releaseLock.release();
    }
  }
} else {
  await outerMain(options);
}
