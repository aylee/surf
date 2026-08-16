import { isAbsolute } from "node:path";
import { assertWorkerVersionId } from "./worker-version.mjs";

export function workerVersionUploadArgs() {
  return ["versions", "upload"];
}

export function prebuiltWorkerVersionUploadArgs(workerBundlePath) {
  if (typeof workerBundlePath !== "string" || !isAbsolute(workerBundlePath)) {
    throw new Error("Prebuilt Worker bundle path must be absolute");
  }
  return ["versions", "upload", workerBundlePath, "--no-bundle"];
}

export function workerVersionActivationArgs(versionId) {
  assertWorkerVersionId(versionId, "staged Worker version ID");
  return ["versions", "deploy", `${versionId}@100%`, "--yes"];
}

export function workerTriggerSyncArgs() {
  return ["triggers", "deploy"];
}

export async function deployExistingWorker(steps) {
  const predecessorVersionId = steps.assertExistingDeploymentState();
  assertWorkerVersionId(predecessorVersionId, "predecessor Worker version ID");
  // Wrangler versions upload validates every configured Queue before it sends
  // the version to the API. Reconcile Queues first, but keep D1 behind the
  // authoritative upload/runtime capability proof.
  steps.ensureQueues();
  const upload = steps.uploadWorkerVersion();
  steps.inspectUploadedRuntime(upload);
  steps.migrateAndSeed();
  steps.assertPredecessorStillActive(predecessorVersionId);
  try {
    steps.activateUploadedVersion(upload);
  } catch (activationError) {
    try {
      // `versions deploy` creates the deployment before it patches
      // observability. A nonzero command can therefore mean "active but the
      // settings patch failed" rather than "not activated".
      steps.assertUploadedVersionActive(upload, activationError);
    } catch (reconciliationError) {
      throw new Error(
        "Worker activation failed, and control-plane reconciliation could not prove the staged target is the sole active version. Production activation is ambiguous; do not enqueue, retry activation, or roll back until the deployment is inspected.",
        {
          cause: new AggregateError([activationError, reconciliationError])
        }
      );
    }
  }
  steps.syncTriggers();
  await steps.completeRollout(upload);
  return upload;
}
