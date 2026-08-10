#!/usr/bin/env node

import {
  assertActiveWranglerConfig,
  pinActiveWranglerConfigForDeploy
} from "./lib/cloudflare-commands.mjs";
import {
  assertNarrativeSetupDisabled,
  resolveNarrativeDeploySecrets
} from "./lib/deploy-secrets.mjs";
import { repoRoot } from "./lib/root-env.mjs";

if (process.argv.length !== 2) {
  throw new Error("Usage: node scripts/stage-narrative-deploy-inputs.mjs");
}

const wrangler = pinActiveWranglerConfigForDeploy();
if (!wrangler) {
  throw new Error(
    "Narrative activation requires SURF_WRANGLER_CONFIG to name the staged external snapshot."
  );
}
const config = assertActiveWranglerConfig();
assertNarrativeSetupDisabled("deploy", config);
if (config.vars?.NARRATIVE_ENABLED !== "true") {
  throw new Error(
    "Narrative deploy-input staging requires NARRATIVE_ENABLED=true in the staged config."
  );
}
const narrative = resolveNarrativeDeploySecrets({
  config,
  environment: process.env,
  root: repoRoot
});
if (!narrative) throw new Error("Narrative deploy inputs were not activated.");
narrative.assertUnchanged();
console.log(
  JSON.stringify({
    status: "narrative-deploy-inputs-staged",
    releaseSha: narrative.receipt.releaseSha,
    wranglerConfigPath: wrangler.path,
    wranglerConfigSha256: wrangler.sha256,
    workerSecretsPath: narrative.receipt.workerSecretsPath,
    workerSecretsFingerprint: narrative.receipt.workerSecretsFingerprint,
    runnerEnvPath: narrative.receipt.runnerEnvPath,
    runnerEnvFingerprint: narrative.receipt.runnerEnvFingerprint
  })
);
