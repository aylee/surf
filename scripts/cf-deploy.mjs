#!/usr/bin/env node

import {
  assertActiveWranglerConfig,
  ensureQueues,
  runPnpm,
  runWrangler
} from "./lib/cloudflare-commands.mjs";
import { resolveDeployedUrl } from "./lib/deploy-url.mjs";

const mode = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (mode !== "setup" && mode !== "deploy") {
  throw new Error("Usage: node scripts/cf-deploy.mjs <setup|deploy> [--dry-run]");
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

function smoke(output, requireForecastData) {
  const url = deployedUrl(output);
  if (!url) {
    throw new Error(
      "Deployment completed, but its URL could not be inferred. Set SURF_BASE_URL and rerun pnpm deploy so the required smoke test can finish."
    );
  }

  runPnpm(["--filter", "@surf/web", "smoke:cloudflare"], {
    env: {
      SURF_BASE_URL: url,
      SURF_REQUIRE_FORECAST_DATA: requireForecastData ? "true" : "false"
    }
  });
}

function refreshForecastReadModels(output) {
  const url = deployedUrl(output);
  if (!url) {
    throw new Error(
      "Deployment completed, but its URL could not be inferred. Set SURF_BASE_URL before deployment so forecast read models can be published."
    );
  }
  runPnpm(["ingest:remote"], {
    env: { SURF_BASE_URL: url }
  });
}

function rollbackFailedDeployment(cause) {
  try {
    runWrangler([
      "rollback",
      "--message",
      "Automatic rollback: forecast read-model bootstrap failed",
      "--yes"
    ], {
      env: { CI: "true" }
    });
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      "Forecast read-model bootstrap failed after deployment, and the automatic Worker rollback also failed."
    );
  }
  throw new Error(
    "Forecast read-model bootstrap or strict smoke failed after deployment; the Worker was automatically rolled back.",
    { cause }
  );
}

assertActiveWranglerConfig();
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
  smoke(output, false);
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
  try {
    // Forecast GETs intentionally serve precomputed D1 read models. Queue the
    // first generation and wait for publication before strict post-deploy smoke.
    refreshForecastReadModels(output);
    smoke(output, true);
  } catch (error) {
    rollbackFailedDeployment(error);
  }
}
