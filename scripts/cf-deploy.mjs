#!/usr/bin/env node

import {
  activeWranglerConfigPath,
  assertActiveWranglerConfig,
  cloudflareApiErrorCodes,
  ensureQueues,
  pinActiveWranglerConfigForDeploy,
  probeWrangler,
  repinActiveWranglerConfigForBootstrap,
  runPnpm,
  runWrangler,
  selectTrackedWranglerConfigForSecretlessDryRun,
  setCloudflareCommandGuard
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
import {
  assertNarrativeSetupDisabled,
  resolveNarrativeDeploySecrets
} from "./lib/deploy-secrets.mjs";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readProductionProfile } from "./lib/release-profile.mjs";
import {
  assertBootstrapWorkerDigest,
  assertDeployedBootstrapReleaseIdentity,
  resolveExactBootstrapSourceIdentity,
  stageExactBootstrapWranglerConfig
} from "./lib/bootstrap-release-identity.mjs";
import { repoRoot } from "./lib/root-env.mjs";

const mode = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const bootstrapNewInstance = process.argv.includes("--bootstrap-new-instance");
let workerSecretsFile = null;
let bootstrapSourceIdentity = null;

if (mode !== "setup" && mode !== "deploy") {
  throw new Error(
    "Usage: node scripts/cf-deploy.mjs <setup|deploy> [--dry-run] [--bootstrap-new-instance]"
  );
}
if (mode === "deploy") {
  throw new Error(
    "The legacy direct deploy entry point is retired; use pnpm release:prod so production mutations are classified and journaled."
  );
}
const unknownArguments = process.argv.slice(3).filter(
  (argument) => !new Set(["--dry-run", "--bootstrap-new-instance"]).has(argument)
);
if (unknownArguments.length > 0) {
  throw new Error(`Unknown setup argument: ${unknownArguments.join(", ")}`);
}
if (!dryRun && !bootstrapNewInstance) {
  throw new Error(
    "Cloudflare setup is a bootstrap-only first-install operation and requires explicit new-instance intent. Use pnpm setup:cloudflare for a new instance, or pnpm release:prod for established production."
  );
}

const productionProfilePath =
  process.env.SURF_PRODUCTION_PROFILE?.trim() ||
  resolve(homedir(), "Services/surf/production-profile.json");
const defaultReleaseStatePath = resolve(
  homedir(),
  "Services/surf/release-state"
);
const workerAbsentApiCodes = new Set([10007, 10090]);
let pinnedBootstrapProfileEvidence = null;

function optionalPathMetadata(path, label) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not inspect ${label}; refusing bootstrap`, {
      cause: error
    });
  }
}

function assertManagedReleaseStateAbsent() {
  const explicitProfile = Boolean(
    process.env.SURF_PRODUCTION_PROFILE?.trim()
  );
  const profileMetadata = optionalPathMetadata(
    productionProfilePath,
    "the production profile"
  );
  let statePath = defaultReleaseStatePath;
  let profileSha256 = null;
  if (profileMetadata) {
    let profile;
    try {
      ({ profile, sha256: profileSha256 } = readProductionProfile(
        productionProfilePath
      ));
    } catch (error) {
      throw new Error(
        "Could not prove managed production release state is absent because the production profile is unsafe or unreadable; use pnpm release:prod for established production.",
        { cause: error }
      );
    }
    statePath = profile.stateDirectory;
  } else if (explicitProfile) {
    throw new Error(
      "Could not prove managed production release state is absent because SURF_PRODUCTION_PROFILE does not name an existing profile; refusing bootstrap."
    );
  }

  const profileEvidence = JSON.stringify({
    profilePath: productionProfilePath,
    profileSha256,
    statePath
  });
  if (pinnedBootstrapProfileEvidence === null) {
    pinnedBootstrapProfileEvidence = profileEvidence;
  } else if (pinnedBootstrapProfileEvidence !== profileEvidence) {
    throw new Error(
      "Production profile identity changed during bootstrap; refusing further remote operations."
    );
  }

  if (optionalPathMetadata(statePath, "managed production release state")) {
    throw new Error(
      `Managed production release state already exists at ${statePath}; setup:cloudflare is bootstrap-only. Use pnpm release:prod.`
    );
  }
}

function assertBootstrapWorkerAbsent(workerName, checkpoint) {
  const inspection = probeWrangler(
    ["deployments", "status", "--name", workerName, "--json"],
    { timeoutMs: 60_000 }
  );
  const output = `${inspection.stdout ?? ""}${inspection.stderr ?? ""}`;
  if (inspection.status === 0) {
    throw new Error(
      `Worker '${workerName}' already has deployment state; setup:cloudflare is bootstrap-only. Use pnpm release:prod.`
    );
  }
  const apiCodes = cloudflareApiErrorCodes(output);
  if (
    apiCodes.length === 1 &&
    workerAbsentApiCodes.has(apiCodes[0])
  ) {
    console.log(
      JSON.stringify({
        status: "bootstrap-worker-absence-proved",
        checkpoint,
        workerName,
        cloudflareApiCode: apiCodes[0]
      })
    );
    return;
  }
  if (output.includes(`The Worker ${workerName} has no deployments.`)) {
    throw new Error(
      `Worker '${workerName}' already exists without versioned deployment state; setup:cloudflare will not adopt it. Use pnpm release:prod.`
    );
  }
  throw new Error(
    `Could not prove Worker '${workerName}' is absent from Cloudflare at ${checkpoint}; refusing bootstrap before any remote mutation. Inspect it read-only, then use pnpm release:prod for established production.`
  );
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

function secretlessDryRunEnvironment(expectedWorkerName) {
  return {
    CF_ACCOUNT_ID: "",
    CF_API_KEY: "",
    CF_API_TOKEN: "",
    CF_EMAIL: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    CLOUDFLARE_API_KEY: "",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_EMAIL: "",
    CLOUDFLARE_ENV: "",
    GEMINI_API_KEY: "",
    NARRATIVE_RESULT_TOKEN: "",
    NARRATIVE_RUNNER_CF_API_TOKEN: "",
    NARRATIVE_RUNNER_OMLX_API_TOKEN: "",
    NARRATIVE_RUNNER_STATUS_HMAC_KEY: "",
    SURF_BASE_URL: "",
    SURF_INGEST_TOKEN: "",
    SURF_NARRATIVE_RESULT_TOKEN: "",
    SURF_NARRATIVE_RUNNER_ENV_FILE: "",
    SURF_WORKER_SECRETS_FILE: "",
    SURF_WORKER_SECRETS_SNAPSHOT: "",
    SURF_WRANGLER_CONFIG: "",
    SURF_WRANGLER_CONFIG_SHA256: "",
    WRANGLER_CI_OVERRIDE_NAME: expectedWorkerName,
    WRANGLER_LOG_PATH: `${repoRoot}/dist/wrangler-dry-run.log`
  };
}

function buildAndValidate(environment) {
  const options = environment ? { env: environment } : undefined;
  runPnpm(["--filter", "@surf/web", "build"], options);
  runWrangler([
    "deploy",
    "--dry-run",
    "--outdir",
    "../../dist/wrangler-dry-run"
  ], options);
}

function deployWorker() {
  return runWrangler([
    "deploy",
    ...(workerSecretsFile ? ["--secrets-file", workerSecretsFile] : [])
  ], {
    capture: true,
    env: { CI: "true" }
  });
}

function uploadWorkerVersion() {
  let output;
  try {
    output = runWrangler([
      ...workerVersionUploadArgs(),
      ...(workerSecretsFile ? ["--secrets-file", workerSecretsFile] : [])
    ], {
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

function inspectBootstrapReleaseIdentity(expectedVersionId, identity) {
  const versionOutput = runWrangler(
    ["versions", "view", expectedVersionId, "--json"],
    { capture: true, echo: false }
  );
  const receipt = assertDeployedBootstrapReleaseIdentity(versionOutput, {
    versionId: expectedVersionId,
    sourceRevision: identity.sourceRevision,
    workerRuntimeDigest: identity.workerRuntimeDigest,
    clientBuildDigest: identity.clientBuildDigest
  });
  console.log(
    JSON.stringify({ status: "bootstrap-release-identity-live", ...receipt })
  );
  return receipt;
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

let activeWranglerConfig;
if (dryRun) {
  activeWranglerConfig = selectTrackedWranglerConfigForSecretlessDryRun();
} else {
  pinActiveWranglerConfigForDeploy(process.env, { required: true });
  activeWranglerConfig = assertActiveWranglerConfig();
}
assertNarrativeSetupDisabled(mode, activeWranglerConfig);
const expectedWorkerName = activeWranglerConfig.name;

if (dryRun) {
  buildAndValidate(secretlessDryRunEnvironment(expectedWorkerName));
  console.log("Cloudflare dry run passed. No remote resources were changed.");
  process.exit(0);
}

const narrativeDeployInputs = resolveNarrativeDeploySecrets({
  config: activeWranglerConfig,
  environment: process.env,
  root: repoRoot
});
if (narrativeDeployInputs) {
  workerSecretsFile = narrativeDeployInputs.workerSecretsFile;
  console.log(
    JSON.stringify({ status: "narrative-deploy-inputs-pinned", ...narrativeDeployInputs.receipt })
  );
}
setCloudflareCommandGuard(() => {
  narrativeDeployInputs?.assertUnchanged();
  bootstrapSourceIdentity?.assertUnchanged();
  assertManagedReleaseStateAbsent();
});

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

assertManagedReleaseStateAbsent();
runWrangler(["whoami"]);
assertBootstrapWorkerAbsent(expectedWorkerName, "pre-build");
bootstrapSourceIdentity = resolveExactBootstrapSourceIdentity(repoRoot);
const bootstrapBuildEnvironment = {
  SURF_RELEASE_SHA: bootstrapSourceIdentity.sourceRevision,
  SURF_CLIENT_BUILD_DIGEST: bootstrapSourceIdentity.clientBuildDigest
};
buildAndValidate(bootstrapBuildEnvironment);
const bootstrapConfig = stageExactBootstrapWranglerConfig({
  sourcePath: activeWranglerConfigPath,
  releaseRoot: repoRoot,
  sourceRevision: bootstrapSourceIdentity.sourceRevision,
  clientBuildDigest: bootstrapSourceIdentity.clientBuildDigest,
  workerBundlePath: resolve(repoRoot, "dist/wrangler-dry-run/index.js")
});
if (bootstrapConfig.config.name !== expectedWorkerName) {
  throw new Error("Bootstrap release identity changed the Worker name");
}
repinActiveWranglerConfigForBootstrap({
  path: bootstrapConfig.path,
  sha256: bootstrapConfig.sha256
});
buildAndValidate(bootstrapBuildEnvironment);
assertBootstrapWorkerDigest(
  resolve(repoRoot, "dist/wrangler-dry-run/index.js"),
  bootstrapConfig.workerRuntimeDigest
);
console.log(
  JSON.stringify({
    status: "bootstrap-release-identity-ready",
    sourceRevision: bootstrapConfig.sourceRevision,
    clientBuildDigest: bootstrapConfig.clientBuildDigest,
    workerRuntimeDigest: bootstrapConfig.workerRuntimeDigest,
    wranglerConfigPath: bootstrapConfig.path,
    wranglerConfigSha256: bootstrapConfig.sha256
  })
);
assertManagedReleaseStateAbsent();
assertBootstrapWorkerAbsent(expectedWorkerName, "pre-mutation");

let output;
if (mode === "setup") {
  ensureQueues();
  assertBootstrapWorkerAbsent(expectedWorkerName, "pre-worker-upload");
  output = deployWorker();
  let setupVersionId;
  try {
    setupVersionId = resolveDeployedVersionId(output);
    inspectWorkerRuntime(setupVersionId, {
      requireCpuLimit: true,
      checkpoint: "post-upload"
    });
    inspectBootstrapReleaseIdentity(setupVersionId, bootstrapConfig);
    assertDeploymentActive(setupVersionId, "bootstrap-pre-storage");
  } catch (error) {
    throw new Error(
      "The bootstrap Worker now exists, but its exact runtime/release identity could not be proved. Do not rerun bootstrap: preserve the printed identity snapshot receipt, configure the production profile, and use pnpm release:prod to inspect and fix forward.",
      { cause: error }
    );
  }
  try {
    migrateAndSeed();
  } catch (error) {
    throw new Error(
      "The Worker and storage bindings were provisioned, but D1 initialization failed. Do not rerun bootstrap: configure the production profile and use pnpm release:prod to adopt and fix forward the existing Worker.",
      { cause: error }
    );
  }
  const setupUrl = deployedUrl(output);
  if (!setupUrl) {
    throw new Error(
      "The bootstrap Worker exists, but its production URL could not be inferred. Configure the production profile and use pnpm release:prod to adopt and verify it; setup:cloudflare will not overwrite it."
    );
  }
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
