#!/usr/bin/env node

import {
  assertActiveWranglerConfig,
  ensureQueues,
  runPnpm,
  runWrangler
} from "./lib/cloudflare-commands.mjs";
import { bootstrapDeployedWorker } from "./lib/deploy-bootstrap.mjs";
import {
  deployExistingWorker,
  workerTriggerSyncArgs,
  workerVersionActivationArgs,
  workerVersionUploadArgs
} from "./lib/deploy-orchestration.mjs";
import {
  resolveActiveDeploymentId,
  resolveDeployedUrl,
  resolveDeployedVersionId,
  resolveUploadedVersionId
} from "./lib/deploy-url.mjs";
import {
  parseWorkerRuntime,
  resolveSoleActiveWorkerVersionId
} from "./lib/worker-runtime.mjs";
import {
  assertWorkerVersionId,
  waitForWorkerVersion
} from "./lib/worker-version.mjs";
import { workerVersionUploadFailure } from "./lib/worker-release-errors.mjs";

const mode = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (mode !== "setup" && mode !== "deploy") {
  throw new Error("Usage: node scripts/cf-deploy.mjs <setup|deploy> [--dry-run]");
}

const legacyPatchlessVersionId =
  process.env.SURF_LEGACY_PATCHLESS_WORKER_VERSION?.trim();
if (legacyPatchlessVersionId) {
  // Validate the bootstrap-only input before build, Queue inspection, D1
  // migration/seed, or Worker activation. The target version is not known
  // until upload, so inequality is rechecked by the ingest client.
  assertWorkerVersionId(
    legacyPatchlessVersionId,
    "legacy patchless Worker version ID"
  );
}

function buildAndValidate() {
  runPnpm(["--filter", "@surf/web", "build"]);
  runWrangler([
    "deploy",
    "--dry-run",
    "--outdir",
    "../../dist/wrangler-dry-run"
  ]);
}

function deployWorker() {
  return runWrangler(["deploy"], {
    capture: true,
    env: { CI: "true" }
  });
}

function uploadWorkerVersion() {
  let output;
  try {
    output = runWrangler(workerVersionUploadArgs(), {
      capture: true,
      env: { CI: "true" }
    });
  } catch (error) {
    throw workerVersionUploadFailure(error);
  }
  return {
    output,
    versionId: resolveUploadedVersionId(output)
  };
}

function activateUploadedVersion({ versionId }) {
  runWrangler(workerVersionActivationArgs(versionId), {
    env: { CI: "true" }
  });
}

function syncTriggers() {
  // `versions deploy` syncs non-versioned Worker settings, but routes, cron,
  // and Queue consumers remain a separate Wrangler operation.
  runWrangler(workerTriggerSyncArgs(), { env: { CI: "true" } });
}

function migrateAndSeed() {
  runWrangler(["d1", "migrations", "apply", "DB", "--remote"], {
    env: { CI: "true" }
  });
  runWrangler([
    "d1",
    "execute",
    "DB",
    "--remote",
    "--yes",
    "--file",
    "../../packages/db/seeds/0000_v1_norcal.sql"
  ]);
}

function deployedUrl(output) {
  return resolveDeployedUrl(output, process.env.SURF_BASE_URL);
}

function smoke(url, requireForecastData, expectedVersionId, expectedWorkerName) {
  runPnpm(["--filter", "@surf/web", "smoke:cloudflare"], {
    env: {
      SURF_BASE_URL: url,
      SURF_REQUIRE_FORECAST_DATA: requireForecastData ? "true" : "false",
      ...(expectedVersionId
        ? {
            SURF_EXPECTED_WORKER_VERSION: expectedVersionId,
            SURF_EXPECTED_WORKER_NAME: expectedWorkerName
          }
        : {})
    }
  });
}

function refreshForecastReadModels(
  url,
  expectedVersionId,
  expectedWorkerName
) {
  runPnpm(["ingest:remote"], {
    env: {
      SURF_BASE_URL: url,
      SURF_EXPECTED_WORKER_VERSION: expectedVersionId,
      SURF_EXPECTED_WORKER_NAME: expectedWorkerName
    }
  });
}

function assertDeploymentActive(expectedVersionId, checkpoint) {
  const deploymentStatusOutput = runWrangler(
    ["deployments", "status", "--json"],
    { capture: true, echo: false }
  );
  const deploymentId = resolveActiveDeploymentId(
    deploymentStatusOutput,
    expectedVersionId
  );
  console.log(
    JSON.stringify({
      status: "deployment-active",
      checkpoint,
      deploymentId,
      workerVersion: expectedVersionId,
      percentage: 100
    })
  );
  return deploymentId;
}

function inspectWorkerRuntime(expectedVersionId, { requireCpuLimit, checkpoint }) {
  const versionOutput = runWrangler(
    ["versions", "view", expectedVersionId, "--json"],
    { capture: true, echo: false }
  );
  const runtime = parseWorkerRuntime(versionOutput, {
    expectedVersionId,
    requireCpuLimit
  });
  console.log(JSON.stringify({
    status: "worker-runtime",
    checkpoint,
    ...runtime
  }));
  return runtime;
}

function assertExistingDeploymentState() {
  const deploymentOutput = runWrangler(
    ["deployments", "status", "--json"],
    { capture: true, echo: false }
  );
  const activeVersionId = resolveSoleActiveWorkerVersionId(deploymentOutput);
  // A predecessor's usage_model is version metadata, not account-plan proof.
  // The target versions-upload request below is the capability gate.
  console.log(JSON.stringify({
    status: "predecessor-deployment",
    workerVersion: activeVersionId,
    percentage: 100
  }));
  return activeVersionId;
}

function assertPredecessorStillActive(expectedVersionId) {
  try {
    return assertDeploymentActive(
      expectedVersionId,
      "pre-activation-predecessor"
    );
  } catch (error) {
    throw new Error(
      `The active Worker changed after staging/storage preparation; refusing to overwrite a concurrent deployment. Expected predecessor ${expectedVersionId}. Inspect deployments before retrying.`,
      { cause: error }
    );
  }
}

function assertUploadedVersionActive({ versionId }) {
  const deploymentId = assertDeploymentActive(
    versionId,
    "activation-error-reconciled"
  );
  console.warn(
    JSON.stringify({
      status: "activation-command-failed-target-active",
      deploymentId,
      workerVersion: versionId,
      action: "continue-fix-forward-through-trigger-sync-and-readiness"
    })
  );
  return deploymentId;
}

async function waitUntilServing(url, expectedVersionId, expectedWorkerName) {
  const result = await waitForWorkerVersion({
    baseUrl: url,
    expectedVersionId,
    expectedWorkerName
  });
  console.log(JSON.stringify(result));
  const deploymentId = assertDeploymentActive(expectedVersionId, "pre-enqueue");
  return { deploymentId, expectedVersionId, expectedWorkerName };
}

const activeWranglerConfig = assertActiveWranglerConfig();
const expectedWorkerName = activeWranglerConfig.name;
buildAndValidate();

if (dryRun) {
  console.log("Cloudflare dry run passed. No remote resources were changed.");
  process.exit(0);
}

if (mode === "deploy" && !process.env.SURF_INGEST_TOKEN?.trim()) {
  throw new Error(
    "Deployment requires SURF_INGEST_TOKEN in the shell or root .env so forecast read models can be refreshed after rollout."
  );
}

const updateDeploymentUrl = mode === "deploy" ? deployedUrl("") : undefined;
if (mode === "deploy" && !updateDeploymentUrl) {
  throw new Error(
    "Deployment requires SURF_BASE_URL to be a bare HTTPS production origin. Wrangler versions upload emits a preview URL, which is deliberately never used as production readiness evidence."
  );
}

runWrangler(["whoami"]);

let output;
if (mode === "setup") {
  ensureQueues();
  output = deployWorker();
  inspectWorkerRuntime(resolveDeployedVersionId(output), {
    requireCpuLimit: true,
    checkpoint: "post-upload"
  });
  try {
    migrateAndSeed();
  } catch (error) {
    throw new Error(
      "The Worker and storage bindings were provisioned, but D1 initialization failed. Fix the reported error and rerun pnpm setup:cloudflare.",
      { cause: error }
    );
  }
  const setupUrl = deployedUrl(output);
  if (!setupUrl) {
    throw new Error(
      "Setup completed, but its production URL could not be inferred. Set SURF_BASE_URL and rerun pnpm setup:cloudflare so the required smoke test can finish."
    );
  }
  const setupVersionId = resolveDeployedVersionId(output);
  const rollout = await waitUntilServing(
    setupUrl,
    setupVersionId,
    expectedWorkerName
  );
  smoke(
    setupUrl,
    false,
    rollout.expectedVersionId,
    rollout.expectedWorkerName
  );
  assertDeploymentActive(rollout.expectedVersionId, "post-smoke");
} else {
  let rollout;
  await deployExistingWorker({
    assertExistingDeploymentState,
    uploadWorkerVersion,
    inspectUploadedRuntime: ({ versionId }) =>
      inspectWorkerRuntime(versionId, {
        requireCpuLimit: true,
        checkpoint: "staged-pre-mutation"
      }),
    ensureQueues,
    migrateAndSeed: () => {
      try {
        migrateAndSeed();
      } catch (error) {
        throw new Error(
          "Cloudflare storage is not initialized. For a first deployment, run pnpm setup:cloudflare; for an existing deployment, fix the reported D1 error before retrying pnpm deploy.",
          { cause: error }
        );
      }
    },
    assertPredecessorStillActive,
    activateUploadedVersion,
    assertUploadedVersionActive,
    syncTriggers,
    completeRollout: async ({ versionId }) => {
      await bootstrapDeployedWorker({
        waitUntilServing: async () => {
          rollout = await waitUntilServing(
            updateDeploymentUrl,
            versionId,
            expectedWorkerName
          );
        },
        // Forecast GETs intentionally serve precomputed D1 read models. Queue
        // the first generation only after the exact rollout version is stable,
        // then wait for publication before strict post-deploy smoke.
        enqueueAndWait: () =>
          refreshForecastReadModels(
            updateDeploymentUrl,
            rollout.expectedVersionId,
            rollout.expectedWorkerName
          ),
        smoke: () => {
          smoke(
            updateDeploymentUrl,
            true,
            rollout.expectedVersionId,
            rollout.expectedWorkerName
          );
          assertDeploymentActive(rollout.expectedVersionId, "post-smoke");
        }
      });
    }
  });
}
