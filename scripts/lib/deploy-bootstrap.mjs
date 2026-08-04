export async function bootstrapDeployedWorker(options) {
  const {
    waitUntilServing,
    enqueueAndWait,
    smoke
  } = options;

  try {
    await waitUntilServing();
  } catch (cause) {
    throw new Error(
      "The new Worker did not become version-ready after activation. It remains active for a queue-safe fix-forward because scheduled, manual, or backlog work may already have crossed the version boundary.",
      { cause }
    );
  }

  try {
    // A Queue message may already exist from cron, manual traffic, or backlog
    // processing. This call is exactly once for the supported deploy itself.
    await enqueueAndWait();
    await smoke();
  } catch (cause) {
    throw new Error(
      "Deployment verification failed after the ingest handoff began. The new Worker remains active for a queue-safe fix-forward; do not roll it back unless the Queue is first proven quiescent and schema-compatible.",
      { cause }
    );
  }
}
