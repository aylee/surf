#!/usr/bin/env node

import {
  assertActiveWranglerConfig,
  ensureQueues,
  runPnpm,
  runWrangler
} from "./lib/cloudflare-commands.mjs";
import { bootstrapDeployedWorker } from "./lib/deploy-bootstrap.mjs";
import {
  resolveActiveDeploymentId,
  resolveDeployedUrl,
  resolveDeployedVersionId
} from "./lib/deploy-url.mjs";
import {
  assertWorkerVersionId,
  waitForWorkerVersion
} from "./lib/worker-version.mjs";

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

function smoke(
  output,
  requireForecastData,
  expectedVersionId,
  expectedWorkerName
) {
  const url = deployedUrl(output);
  if (!url) {
    throw new Error(
      "Deployment completed, but its URL could not be inferred. Set SURF_BASE_URL and rerun pnpm deploy so the required smoke test can finish."
    );
  }

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
  output,
  expectedVersionId,
  expectedWorkerName
) {
  const url = deployedUrl(output);
  if (!url) {
    throw new Error(
      "Deployment completed, but its URL could not be inferred. Set SURF_BASE_URL before deployment so forecast read models can be published."
    );
  }
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

async function waitUntilServing(output, expectedWorkerName) {
  const url = deployedUrl(output);
  if (!url) {
    throw new Error(
      "Deployment completed, but its URL could not be inferred. Set SURF_BASE_URL so exact-version readiness can run."
    );
  }
  const expectedVersionId = resolveDeployedVersionId(output);
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

runWrangler(["whoami"]);
ensureQueues();

let output;
if (mode === "setup") {
  output = deployWorker();
  try {
    migrateAndSeed();
  } catch (error) {
    throw new Error(
      "The Worker and storage bindings were provisioned, but D1 initialization failed. Fix the reported error and rerun pnpm setup:cloudflare.",
      { cause: error }
    );
  }
  const rollout = await waitUntilServing(output, expectedWorkerName);
  smoke(
    output,
    false,
    rollout.expectedVersionId,
    rollout.expectedWorkerName
  );
  assertDeploymentActive(rollout.expectedVersionId, "post-smoke");
} else {
  try {
    migrateAndSeed();
  } catch (error) {
    throw new Error(
      "Cloudflare storage is not initialized. For a first deployment, run pnpm setup:cloudflare; for an existing deployment, fix the reported D1 error before retrying pnpm deploy.",
      { cause: error }
    );
  }
  output = deployWorker();
  let rollout;
  await bootstrapDeployedWorker({
    waitUntilServing: async () => {
      rollout = await waitUntilServing(output, expectedWorkerName);
    },
    // Forecast GETs intentionally serve precomputed D1 read models. Queue the
    // first generation only after the exact rollout version is stable, then
    // wait for publication before strict post-deploy smoke.
    enqueueAndWait: () =>
      refreshForecastReadModels(
        output,
        rollout.expectedVersionId,
        rollout.expectedWorkerName
      ),
    smoke: () => {
      smoke(
        output,
        true,
        rollout.expectedVersionId,
        rollout.expectedWorkerName
      );
      assertDeploymentActive(rollout.expectedVersionId, "post-smoke");
    }
  });
}
