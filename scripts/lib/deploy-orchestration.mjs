export async function deployExistingWorker(steps) {
  steps.assertExistingDeploymentRuntime();
  steps.ensureQueues();
  steps.migrateAndSeed();
  const output = steps.deployWorker();
  steps.inspectUploadedRuntime(output);
  await steps.completeRollout(output);
  return output;
}
