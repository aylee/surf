import {
  RELEASE_FAILURE_CODES,
  RELEASE_JOURNAL_STATES,
  RELEASE_LANE_STATE_PATHS,
  RELEASE_POINTER_KINDS,
  createReleasePointer,
  reconcileReleaseActivation,
  recordReleaseJournalFailure,
  resumeReleaseJournal,
  transitionReleaseJournal
} from "./release-journal.mjs";
import { RELEASE_LANES } from "./release-impact.mjs";
import { AmbiguousWorkerActivationError } from "./release-worker.mjs";

const FAILURE_BY_STATE = Object.freeze({
  [RELEASE_JOURNAL_STATES.PLANNED]: RELEASE_FAILURE_CODES.VERIFY_FAILED,
  [RELEASE_JOURNAL_STATES.VERIFIED]: RELEASE_FAILURE_CODES.PREPARE_FAILED,
  [RELEASE_JOURNAL_STATES.PREPARED]: RELEASE_FAILURE_CODES.UPLOAD_FAILED,
  [RELEASE_JOURNAL_STATES.WORKER_UPLOADED]:
    RELEASE_FAILURE_CODES.DATA_PREPARE_FAILED,
  [RELEASE_JOURNAL_STATES.DATA_PREPARED]: RELEASE_FAILURE_CODES.RUNNER_FAILED,
  [RELEASE_JOURNAL_STATES.RUNNER_READY]:
    RELEASE_FAILURE_CODES.PREDECESSOR_CHANGED,
  [RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED]:
    RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS,
  [RELEASE_JOURNAL_STATES.WORKER_ACTIVE]:
    RELEASE_FAILURE_CODES.TRIGGER_SYNC_FAILED,
  [RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED]:
    RELEASE_FAILURE_CODES.GENERATION_FAILED,
  [RELEASE_JOURNAL_STATES.GENERATION_VERIFIED]:
    RELEASE_FAILURE_CODES.LIVE_VERIFY_FAILED,
  [RELEASE_JOURNAL_STATES.VERIFIED_LIVE]:
    RELEASE_FAILURE_CODES.LIVE_VERIFY_FAILED
});

class ReleaseDependencyDriftError extends Error {
  constructor(phase, cause) {
    super(`Release dependency attestation failed during ${phase}`, { cause });
    this.name = "ReleaseDependencyDriftError";
  }
}

function failureCodeFor(journal, error) {
  if (error instanceof ReleaseDependencyDriftError) {
    return RELEASE_FAILURE_CODES.DEPENDENCY_DRIFT;
  }
  if (error instanceof AmbiguousWorkerActivationError) {
    return RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS;
  }
  if (
    journal.lane === RELEASE_LANES.ASSETS_ONLY &&
    journal.state === RELEASE_JOURNAL_STATES.WORKER_UPLOADED
  ) {
    return RELEASE_FAILURE_CODES.PREDECESSOR_CHANGED;
  }
  if (
    journal.lane === RELEASE_LANES.ASSETS_ONLY &&
    journal.state === RELEASE_JOURNAL_STATES.WORKER_ACTIVE
  ) {
    return RELEASE_FAILURE_CODES.LIVE_VERIFY_FAILED;
  }
  return FAILURE_BY_STATE[journal.state] ?? RELEASE_FAILURE_CODES.INTERRUPTED;
}

function timestamp(now) {
  const value = now().toISOString();
  if (new Date(value).toISOString() !== value) {
    throw new Error("Release controller clock must return a valid Date");
  }
  return value;
}

function hasActivated(journal) {
  const effective = [
    RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
    RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD
  ].includes(journal.state)
    ? journal.resumeFrom
    : journal.state;
  const path = RELEASE_LANE_STATE_PATHS[journal.lane];
  return (
    path.indexOf(effective) >= path.indexOf(RELEASE_JOURNAL_STATES.WORKER_ACTIVE)
  );
}

function requiredOperation(operations, name) {
  if (typeof operations?.[name] !== "function") {
    throw new Error(`Release controller requires operation ${name}`);
  }
  return operations[name];
}

function storageMutationRequired(journal) {
  const impact = journal.classification.impact;
  return impact.migrations || impact.seed;
}

function runnerCompatibilityRequired(journal) {
  const impact = journal.classification.impact;
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

function generationRequired(journal) {
  const impact = journal.classification.impact;
  return impact.materialization || impact.seed;
}

function topologySynchronizationRequired(journal) {
  const impact = journal.classification.impact;
  return impact.queueTopology || impact.triggerTopology;
}

export function reconcileReleaseActivationBoundary(
  journal,
  { liveWorkerVersionId, liveDeploymentId, at } = {}
) {
  const isAmbiguous =
    journal.state === RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD &&
    journal.failureCode === RELEASE_FAILURE_CODES.ACTIVATION_AMBIGUOUS;
  if (
    !isAmbiguous &&
    journal.state !== RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED
  ) {
    throw new Error("Release is not at the Worker activation boundary");
  }
  if (
    liveWorkerVersionId === journal.receipts.workerVersionId &&
    liveDeploymentId !== null
  ) {
    return Object.freeze({
      targetIsActive: true,
      journal: isAmbiguous
        ? reconcileReleaseActivation(journal, {
            targetIsActive: true,
            deploymentId: liveDeploymentId,
            at
          })
        : transitionReleaseJournal(journal, RELEASE_JOURNAL_STATES.WORKER_ACTIVE, {
            at,
            receipts: { deploymentId: liveDeploymentId }
          })
    });
  }
  if (
    liveWorkerVersionId === journal.predecessor.workerVersionId &&
    liveDeploymentId === journal.predecessor.deploymentId
  ) {
    return Object.freeze({
      targetIsActive: false,
      journal: isAmbiguous
        ? reconcileReleaseActivation(journal, {
            targetIsActive: false,
            at
          })
        : journal
    });
  }
  throw new Error(
    "Ambiguous activation does not match the exact target or predecessor"
  );
}

export async function executeRelease({
  journal: initialJournal,
  store,
  operations,
  resumeReleaseId = null,
  now = () => new Date()
}) {
  if (!store || typeof store.writeJournal !== "function") {
    throw new Error("Release controller requires a state store");
  }
  let journal = initialJournal;
  if (
    journal.state === RELEASE_JOURNAL_STATES.COMPLETE &&
    resumeReleaseId !== journal.releaseId
  ) {
    throw new Error("Complete release pointer repair requires its exact --resume ID");
  }

  const writeActivePointer = () => {
    if (!hasActivated(journal)) return;
    store.writePointer(
      createReleasePointer(journal, RELEASE_POINTER_KINDS.ACTIVE, {
        at: timestamp(now)
      })
    );
  };
  const persist = (next) => {
    journal = store.writeJournal(next);
    writeActivePointer();
    return journal;
  };
  const transition = (nextState, receipts = {}) =>
    persist(
      transitionReleaseJournal(journal, nextState, {
        at: timestamp(now),
        receipts
      })
    );
  const verifyDependencies = async (phase) => {
    try {
      await requiredOperation(operations, "verifyDependencies")({ phase });
    } catch (error) {
      throw new ReleaseDependencyDriftError(phase, error);
    }
  };

  let completionReconciled = false;
  const reconcileCompletedDeployment = async () => {
    if (journal.lane === RELEASE_LANES.CONSERVATIVE_FULL) {
      await verifyDependencies("final");
    }
    const inspection = await requiredOperation(
      operations,
      "inspectActivation"
    )();
    if (
      inspection.state !== "target" ||
      inspection.workerVersionId !== journal.receipts.workerVersionId ||
      inspection.deploymentId !== journal.receipts.deploymentId
    ) {
      throw new Error(
        "Completed release no longer matches the exact active deployment"
      );
    }
    completionReconciled = true;
  };
  const finalizeCompletePointers = async () => {
    if (!completionReconciled) await reconcileCompletedDeployment();
    store.writePointer(
      createReleasePointer(journal, RELEASE_POINTER_KINDS.ACTIVE, {
        at: timestamp(now)
      })
    );
    store.writePointer(
      createReleasePointer(journal, RELEASE_POINTER_KINDS.LAST_COMPLETE, {
        at: timestamp(now)
      })
    );
  };

  if (
    [
      RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
      RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD
    ].includes(journal.state)
  ) {
    journal = persist(resumeReleaseJournal(journal, { at: timestamp(now) }));
  }

  try {
    while (journal.state !== RELEASE_JOURNAL_STATES.COMPLETE) {
      switch (journal.state) {
        case RELEASE_JOURNAL_STATES.PLANNED:
          await requiredOperation(operations, "verify")();
          transition(RELEASE_JOURNAL_STATES.VERIFIED);
          break;
        case RELEASE_JOURNAL_STATES.VERIFIED:
          {
            const receipt = await requiredOperation(operations, "prepare")();
            transition(RELEASE_JOURNAL_STATES.PREPARED, {
              profileSha256: receipt.profileSha256,
              operatorEnvironmentFingerprint:
                receipt.operatorEnvironmentFingerprint,
              wranglerConfigSha256: receipt.wranglerConfigSha256,
              workerSecretsFingerprint: receipt.workerSecretsFingerprint
            });
          }
          break;
        case RELEASE_JOURNAL_STATES.PREPARED: {
          const receipt = await requiredOperation(operations, "uploadWorker")();
          transition(RELEASE_JOURNAL_STATES.WORKER_UPLOADED, {
            workerVersionId: receipt.workerVersionId
          });
          break;
        }
        case RELEASE_JOURNAL_STATES.WORKER_UPLOADED:
          if (journal.lane === RELEASE_LANES.CONSERVATIVE_FULL) {
            const receipt = storageMutationRequired(journal)
              ? await requiredOperation(operations, "prepareData")()
              : {};
            transition(RELEASE_JOURNAL_STATES.DATA_PREPARED, {
              d1Bookmark: receipt.d1Bookmark ?? null,
              d1ExportSha256: receipt.d1ExportSha256 ?? null
            });
          } else {
            await requiredOperation(operations, "recheckPredecessor")();
            transition(RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED);
          }
          break;
        case RELEASE_JOURNAL_STATES.DATA_PREPARED: {
          const receipt = runnerCompatibilityRequired(journal)
            ? await requiredOperation(operations, "ensureRunner")()
            : {};
          transition(RELEASE_JOURNAL_STATES.RUNNER_READY, {
            runnerActivationId: receipt.runnerActivationId ?? null,
            runnerDrainSha256: receipt.runnerDrainSha256 ?? null
          });
          break;
        }
        case RELEASE_JOURNAL_STATES.RUNNER_READY:
          await requiredOperation(operations, "recheckPredecessor")();
          transition(RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED);
          break;
        case RELEASE_JOURNAL_STATES.PREDECESSOR_RECHECKED: {
          if (journal.lane === RELEASE_LANES.CONSERVATIVE_FULL) {
            await verifyDependencies("pre-activation");
          }
          const inspection = await requiredOperation(
            operations,
            "inspectActivation"
          )();
          let deploymentId;
          if (inspection.state === "target") {
            deploymentId = inspection.deploymentId;
          } else if (inspection.state === "predecessor") {
            const receipt = await requiredOperation(operations, "activateWorker")();
            deploymentId = receipt.deploymentId;
          } else {
            throw new AmbiguousWorkerActivationError();
          }
          transition(RELEASE_JOURNAL_STATES.WORKER_ACTIVE, { deploymentId });
          break;
        }
        case RELEASE_JOURNAL_STATES.WORKER_ACTIVE:
          await requiredOperation(operations, "waitUntilServing")();
          if (journal.lane === RELEASE_LANES.CONSERVATIVE_FULL) {
            if (topologySynchronizationRequired(journal)) {
              const inspectTopology = async () => {
                // Wrangler's trigger deployment owns both cron schedules and
                // Queue consumers. Attest both surfaces whenever either one
                // changes so the combined command cannot silently drift the
                // otherwise-unchanged half of its mutation boundary.
                const queueConsumers = await requiredOperation(
                  operations,
                  "inspectQueueConsumers"
                )();
                const triggers = await requiredOperation(
                  operations,
                  "inspectTriggers"
                )();
                return {
                  queueConsumers,
                  triggers,
                  matches:
                    queueConsumers.matches === true && triggers.matches === true
                };
              };
              const before = await inspectTopology();
              if (before.matches !== true) {
                await requiredOperation(operations, "syncTriggers")();
                const after = await inspectTopology();
                if (after.matches !== true) {
                  throw new Error(
                    "Queue consumer or cron trigger topology still differs after synchronization"
                  );
                }
              }
            }
            transition(RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED);
          } else {
            await requiredOperation(operations, "verifyLive")();
            transition(RELEASE_JOURNAL_STATES.VERIFIED_LIVE);
          }
          break;
        case RELEASE_JOURNAL_STATES.TRIGGERS_SYNCED: {
          let receipt = {};
          if (generationRequired(journal)) {
            const existing = await requiredOperation(
              operations,
              "inspectGeneration"
            )(journal.createdAt);
            receipt =
              existing ?? (await requiredOperation(operations, "generate")());
          }
          transition(RELEASE_JOURNAL_STATES.GENERATION_VERIFIED, {
            generationId: receipt.generationId ?? null
          });
          break;
        }
        case RELEASE_JOURNAL_STATES.GENERATION_VERIFIED:
          await requiredOperation(operations, "verifyLive")();
          transition(RELEASE_JOURNAL_STATES.VERIFIED_LIVE);
          break;
        case RELEASE_JOURNAL_STATES.VERIFIED_LIVE:
          await reconcileCompletedDeployment();
          transition(RELEASE_JOURNAL_STATES.COMPLETE);
          break;
        default:
          throw new Error(`Release controller cannot execute state ${journal.state}`);
      }
    }
    await finalizeCompletePointers();
    return journal;
  } catch (error) {
    if (
      [
        RELEASE_JOURNAL_STATES.RETRYABLE_FAILURE,
        RELEASE_JOURNAL_STATES.NEEDS_FIX_FORWARD,
        RELEASE_JOURNAL_STATES.SUPERSEDED,
        RELEASE_JOURNAL_STATES.COMPLETE
      ].includes(journal.state)
    ) {
      throw error;
    }
    const code = failureCodeFor(journal, error);
    persist(
      recordReleaseJournalFailure(journal, {
        code,
        at: timestamp(now)
      })
    );
    throw new Error(`Release stopped safely with ${code}`, { cause: error });
  }
}
