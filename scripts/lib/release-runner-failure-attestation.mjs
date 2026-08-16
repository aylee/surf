import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertRunnerFailureReplacementEvidence,
  fingerprintReleaseJournal
} from "./release-journal.mjs";
import { validateImmutableRelease } from "./immutable-release.mjs";
import { readVerifiedFileSnapshot } from "./verified-file-snapshot.mjs";
import { createCloudflareCommandContext } from "./cloudflare-command-context.mjs";
import {
  configuredReleaseQueueNames
} from "./cloudflare-command-context.mjs";
import { queueTopologyFingerprint } from "./release-fingerprints.mjs";
import {
  attestD1BackupReceiptArtifact,
  validateD1BackupReceipt
} from "./release-storage.mjs";
import {
  expectedWorkerBindingDescriptor
} from "./release-worker.mjs";
import {
  discoverRunnerActivationFromInstalledPlist
} from "./release-runner-compatibility.mjs";
import { attestTaggedInactiveWorkerUpload } from "./release-inactive-upload-replacement.mjs";
import { resolveSoleActiveWorkerVersionId } from "./worker-runtime.mjs";
import { resolveActiveDeploymentEvidence } from "./deploy-url.mjs";
import { activateLaunchAgents } from "../../apps/narrative-runner/scripts/manage-launch-agents.mjs";
import { verifyLaunchActivation } from "../../apps/narrative-runner/scripts/render-launch-agents.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PRIVATE_JSON_BYTES = 4 * 1024 * 1024;

const DEFAULT_DEPENDENCIES = Object.freeze({
  activateLaunchAgents,
  attestD1BackupReceiptArtifact,
  attestTaggedInactiveWorkerUpload,
  createCloudflareCommandContext,
  discoverRunnerActivationFromInstalledPlist,
  validateImmutableRelease,
  verifyLaunchActivation
});

function dependencies(overrides) {
  const result = { ...DEFAULT_DEPENDENCIES, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (typeof value !== "function") {
      throw new Error(`Runner-failure attestation dependency ${name} is invalid`);
    }
  }
  return Object.freeze(result);
}

function existingPrivateSubdirectory(parent, name, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) {
    throw new Error(`${label} has an unsafe directory name`);
  }
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== resolve(parent)) {
    throw new Error(`${label} parent must be canonical`);
  }
  const path = resolve(canonicalParent, name);
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  ) {
    throw new Error(
      `${label} must be a canonical non-symlink mode-0700 directory`
    );
  }
  return path;
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

function exactSnapshot(path, label) {
  const value = readVerifiedFileSnapshot(path, {
    label,
    maximumBytes: MAX_PRIVATE_JSON_BYTES,
    requireMode0600: true,
    requireCanonical: true
  });
  return Object.freeze({
    ...value,
    sha256: createHash("sha256").update(value.contents).digest("hex")
  });
}

async function restorePriorRunner({
  deps,
  environment,
  failed,
  priorRecordPath,
  profile
}) {
  const discoveredBefore =
    await deps.discoverRunnerActivationFromInstalledPlist({
      serviceRoot: profile.serviceRoot,
      allowLegacyV3: true
    });
  if (
    discoveredBefore.activationId !== failed.predecessor.runnerActivationId ||
    discoveredBefore.recordPath !== priorRecordPath ||
    discoveredBefore.recordSchemaVersion !== 3 ||
    discoveredBefore.transitionOnly !== true
  ) {
    throw new Error(
      "Runner-failure replacement requires the exact installed legacy v3 predecessor"
    );
  }
  const recordBefore = exactSnapshot(
    priorRecordPath,
    "Prior legacy runner activation record"
  );
  const priorRecord = JSON.parse(recordBefore.contents.toString("utf8"));
  if (
    priorRecord.schemaVersion !== 3 ||
    !SHA_PATTERN.test(priorRecord.releaseSha ?? "")
  ) {
    throw new Error(
      "Runner-failure replacement predecessor is not an exact legacy v3 activation"
    );
  }
  await deps.verifyLaunchActivation(priorRecordPath, {
    requireInstalled: true,
    allowLegacyV3: true
  });
  const restored = await deps.activateLaunchAgents({
    recordPath: priorRecordPath,
    priorRecordPath,
    environment,
    transitionMode: "rollback"
  });
  if (
    restored?.status !== "ok" ||
    restored.releaseSha !== priorRecord.releaseSha ||
    restored.activationId !== null ||
    restored.drainReceipt !== null
  ) {
    throw new Error(
      "Legacy runner restoration returned unexpected activation evidence"
    );
  }
  const discoveredAfter =
    await deps.discoverRunnerActivationFromInstalledPlist({
      serviceRoot: profile.serviceRoot,
      allowLegacyV3: true
    });
  await deps.verifyLaunchActivation(priorRecordPath, {
    requireInstalled: true,
    allowLegacyV3: true
  });
  const recordAfter = exactSnapshot(
    priorRecordPath,
    "Restored legacy runner activation record"
  );
  if (
    discoveredAfter.activationId !== discoveredBefore.activationId ||
    discoveredAfter.recordPath !== priorRecordPath ||
    discoveredAfter.recordSchemaVersion !== 3 ||
    discoveredAfter.transitionOnly !== true ||
    recordAfter.sha256 !== recordBefore.sha256
  ) {
    throw new Error("Legacy runner identity changed during restoration");
  }
  return Object.freeze({
    activationId: discoveredAfter.activationId,
    recordSha256: recordAfter.sha256,
    releaseSha: priorRecord.releaseSha
  });
}

export function createRunnerFailureRecoveryAttestor(
  { profile, environment, store },
  overrides = {}
) {
  if (!profile || !environment || typeof store?.readJournal !== "function") {
    throw new Error("Runner-failure attestation requires production context");
  }
  const deps = dependencies(overrides);
  return async function attestRunnerFailureReplacement(failed) {
    const failedJournalSha256 = fingerprintReleaseJournal(failed);
    const attemptsRoot = existingPrivateSubdirectory(
      profile.stateDirectory,
      "attempts",
      "Release attempts directory"
    );
    const failedAttemptDirectory = existingPrivateSubdirectory(
      attemptsRoot,
      failed.releaseId,
      "Failed release attempt directory"
    );
    const failedConfigPath = resolve(failedAttemptDirectory, "wrangler.jsonc");
    const workerUploadReceiptPath = resolve(
      failedAttemptDirectory,
      "worker-upload.json"
    );
    const d1BackupReceiptPath = resolve(
      failedAttemptDirectory,
      "d1-backup.json"
    );
    if (existsSync(resolve(failedAttemptDirectory, "runner-drain.json"))) {
      throw new Error(
        "Runner-failure replacement cannot recover a release with a committed runner drain receipt"
      );
    }
    const failedConfigSnapshot = exactSnapshot(
      failedConfigPath,
      "Failed release Wrangler config"
    );
    const uploadSnapshot = exactSnapshot(
      workerUploadReceiptPath,
      "Failed release Worker upload receipt"
    );
    const backupSnapshot = exactSnapshot(
      d1BackupReceiptPath,
      "Failed release D1 backup receipt"
    );
    if (failedConfigSnapshot.sha256 !== failed.receipts.wranglerConfigSha256) {
      throw new Error(
        "Failed release Wrangler config differs from its prepared receipt"
      );
    }
    const uploadReceipt = exactUploadReceipt(
      JSON.parse(uploadSnapshot.contents.toString("utf8"))
    );
    if (uploadReceipt.workerVersionId !== failed.receipts.workerVersionId) {
      throw new Error(
        "Failed release Worker upload receipt differs from its journal"
      );
    }
    const rollbackRoot = existingPrivateSubdirectory(
      profile.serviceRoot,
      "rollbacks",
      "Release rollback store"
    );
    const failedRollbackDirectory = existingPrivateSubdirectory(
      rollbackRoot,
      failed.releaseId,
      "Failed release rollback directory"
    );
    const expectedExportPath = resolve(
      failedRollbackDirectory,
      "surf-before.sql"
    );
    const backupReceipt = validateD1BackupReceipt(
      JSON.parse(backupSnapshot.contents.toString("utf8")),
      { databaseName: "DB", destination: expectedExportPath }
    );
    if (
      backupReceipt.bookmark !== failed.receipts.d1Bookmark ||
      backupReceipt.exportSha256 !== failed.receipts.d1ExportSha256
    ) {
      throw new Error(
        "Failed release D1 backup receipt differs from its journal"
      );
    }
    const failedReleaseRoot = resolve(
      profile.releasesDirectory,
      failed.targetGitSha
    );
    deps.validateImmutableRelease(failedReleaseRoot, failed.targetGitSha);
    const guardFailedAttempt = () => {
      deps.validateImmutableRelease(failedReleaseRoot, failed.targetGitSha);
      const current = store.readJournal(failed.releaseId);
      if (
        !current ||
        fingerprintReleaseJournal(current) !== failedJournalSha256
      ) {
        throw new Error(
          "Failed release journal changed during runner-failure attestation"
        );
      }
      for (const [path, label, sha256] of [
        [failedConfigPath, "Failed release Wrangler config", failedConfigSnapshot.sha256],
        [workerUploadReceiptPath, "Failed release Worker upload receipt", uploadSnapshot.sha256],
        [d1BackupReceiptPath, "Failed release D1 backup receipt", backupSnapshot.sha256]
      ]) {
        if (exactSnapshot(path, label).sha256 !== sha256) {
          throw new Error(`${label} changed during runner-failure attestation`);
        }
      }
      if (existsSync(resolve(failedAttemptDirectory, "runner-drain.json"))) {
        throw new Error(
          "Runner drain receipt appeared during runner-failure attestation"
        );
      }
    };
    guardFailedAttempt();
    const failedContext = deps.createCloudflareCommandContext({
      releaseRoot: failedReleaseRoot,
      configPath: failedConfigSnapshot.path,
      configSha256: failedConfigSnapshot.sha256,
      environment,
      guard: guardFailedAttempt
    });
    const failedConfig = failedContext.readConfig();
    const failedQueueTopologyFingerprint = queueTopologyFingerprint(failedConfig);
    if (
      failedQueueTopologyFingerprint !==
      failed.targetFingerprints.queueTopology
    ) {
      throw new Error(
        "Failed release Wrangler Queue topology differs from its journal"
      );
    }
    const readLiveDeployment = () => {
      const status = failedContext.runWrangler(
        ["deployments", "status", "--json"],
        { capture: true, echo: false }
      );
      const workerVersionId = resolveSoleActiveWorkerVersionId(status);
      const deployment = resolveActiveDeploymentEvidence(
        status,
        workerVersionId
      );
      return Object.freeze({
        workerVersionId,
        deploymentId: deployment.deploymentId,
        createdOn: deployment.createdOn
      });
    };
    const before = readLiveDeployment();
    if (
      before.workerVersionId !== failed.predecessor.workerVersionId ||
      before.deploymentId !== failed.predecessor.deploymentId
    ) {
      throw new Error(
        "Runner-failure replacement live Worker predecessor differs from the failed release"
      );
    }

    // Complete every fallible read-only proof before restoring LaunchAgents.
    const d1Artifact = await deps.attestD1BackupReceiptArtifact(backupReceipt);
    const expectedQueueNames = configuredReleaseQueueNames(failedConfig);
    const queueEvidence = await failedContext.attestPreexistingQueues(
      before.createdOn
    );
    const remoteUploadEvidence = await deps.attestTaggedInactiveWorkerUpload({
      accountId: environment.CLOUDFLARE_ACCOUNT_ID,
      apiToken: environment.CLOUDFLARE_API_TOKEN,
      workerName: failedConfig.name,
      releaseTag: failed.releaseId,
      activeWorkerVersionId: before.workerVersionId,
      predecessorWorkerVersionId: failed.predecessor.workerVersionId,
      sourceRevision: failed.targetGitSha,
      workerRuntimeDigest: failed.targetFingerprints.workerRuntime,
      clientBuildDigest: failed.targetFingerprints.workerAssets,
      expectedBindings: expectedWorkerBindingDescriptor(failedConfig),
      inspectVersion: (versionId) =>
        failedContext.runWrangler(
          ["versions", "view", versionId, "--json"],
          { capture: true, echo: false }
        ),
      guard: guardFailedAttempt
    });
    const afterReadOnly = readLiveDeployment();
    if (
      afterReadOnly.workerVersionId !== before.workerVersionId ||
      afterReadOnly.deploymentId !== before.deploymentId ||
      afterReadOnly.createdOn !== before.createdOn
    ) {
      throw new Error(
        "Production predecessor changed before legacy runner restoration"
      );
    }

    const priorRecordPath = resolve(
      profile.serviceRoot,
      "launch-agents",
      failed.predecessor.runnerActivationId,
      "activation-record.json"
    );
    const restoredRunner = await restorePriorRunner({
      deps,
      environment,
      failed,
      priorRecordPath,
      profile
    });
    const d1ArtifactAfter = await deps.attestD1BackupReceiptArtifact(
      backupReceipt
    );
    const after = readLiveDeployment();
    const restoredRunnerAfter = await restorePriorRunner({
      deps,
      environment,
      failed,
      priorRecordPath,
      profile
    });
    if (
      after.workerVersionId !== before.workerVersionId ||
      after.deploymentId !== before.deploymentId ||
      after.createdOn !== before.createdOn ||
      d1ArtifactAfter.databaseName !== d1Artifact.databaseName ||
      d1ArtifactAfter.bookmark !== d1Artifact.bookmark ||
      d1ArtifactAfter.exportPath !== d1Artifact.exportPath ||
      d1ArtifactAfter.exportBytes !== d1Artifact.exportBytes ||
      d1ArtifactAfter.exportSha256 !== d1Artifact.exportSha256 ||
      restoredRunnerAfter.activationId !== restoredRunner.activationId ||
      restoredRunnerAfter.recordSha256 !== restoredRunner.recordSha256 ||
      restoredRunnerAfter.releaseSha !== restoredRunner.releaseSha
    ) {
      throw new Error(
        "Production predecessor changed during runner-failure attestation"
      );
    }
    guardFailedAttempt();
    return assertRunnerFailureReplacementEvidence(failed, {
      failedJournalSha256,
      failedConfigSha256: failedConfigSnapshot.sha256,
      workerUploadReceiptSha256: uploadSnapshot.sha256,
      d1BackupReceiptSha256: backupSnapshot.sha256,
      d1ExportBytes: d1Artifact.exportBytes,
      d1ExportSha256: d1Artifact.exportSha256,
      priorRunnerActivationId: restoredRunner.activationId,
      priorRunnerRecordSha256: restoredRunner.recordSha256,
      priorRunnerReleaseSha: restoredRunner.releaseSha,
      liveWorkerVersionId: after.workerVersionId,
      liveDeploymentId: after.deploymentId,
      predecessorDeploymentCreatedOn: after.createdOn,
      queueTopologyFingerprint: failedQueueTopologyFingerprint,
      queueEvidence: {
        expectedQueueNames,
        queues: queueEvidence.queues
      },
      remoteUploadEvidence
    });
  };
}
