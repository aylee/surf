import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { repoRoot } from "../lib/root-env.mjs";
import { stageWranglerConfigSnapshot } from "../lib/wrangler-config-snapshot.mjs";

const trackedWranglerConfig = new URL(
  "../../apps/web/wrangler.jsonc",
  import.meta.url
);

function operationalFixture({ managedState = false } = {}) {
  const temporaryRoot = realpathSync(
    mkdtempSync(resolve(tmpdir(), "surf-cf-bootstrap-"))
  );
  const serviceRoot = resolve(temporaryRoot, "service");
  const sourceConfig = resolve(temporaryRoot, "wrangler.source.jsonc");
  const snapshotConfig = resolve(temporaryRoot, "wrangler.snapshot.jsonc");
  const workerSecrets = resolve(temporaryRoot, "worker.env");
  const runnerEnvironment = resolve(temporaryRoot, "runner.env");
  const operatorEnvironment = resolve(temporaryRoot, "operator.env");
  const productionProfile = resolve(temporaryRoot, "production-profile.json");
  const stateDirectory = resolve(serviceRoot, "release-state");
  const releasesDirectory = resolve(serviceRoot, "releases");
  const binDirectory = resolve(temporaryRoot, "bin");
  const invocationLog = resolve(temporaryRoot, "pnpm.ndjson");
  mkdirSync(serviceRoot, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  if (managedState) mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(sourceConfig, readFileSync(trackedWranglerConfig), { mode: 0o600 });
  for (const path of [workerSecrets, runnerEnvironment, operatorEnvironment]) {
    writeFileSync(path, "TEST_ONLY=true\n", { mode: 0o600 });
  }
  const staged = stageWranglerConfigSnapshot({
    sourcePath: sourceConfig,
    outputPath: snapshotConfig,
    releaseRoot: repoRoot
  });
  writeFileSync(
    productionProfile,
    `${JSON.stringify({
      schemaVersion: 1,
      repositoryPath: repoRoot,
      serviceRoot,
      releasesDirectory,
      stateDirectory,
      wranglerSourcePath: sourceConfig,
      workerSecretsSourcePath: workerSecrets,
      runnerEnvironmentPath: runnerEnvironment,
      operatorEnvironmentPath: operatorEnvironment,
      customOrigin: "https://surf.example",
      workersDevOrigin: "https://surf-test.workers.dev"
    })}\n`,
    { mode: 0o600 }
  );
  return {
    temporaryRoot,
    binDirectory,
    invocationLog,
    productionProfile,
    wranglerConfig: staged.path,
    wranglerConfigSha256: staged.sha256
  };
}

function installInspectionFake(candidate) {
  const fakePnpm = resolve(candidate.binDirectory, "pnpm");
  const fakeGit = resolve(candidate.binDirectory, "git");
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).trim();
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.SURF_TEST_PNPM_LOG, JSON.stringify(args) + "\\n");
if (args.includes("deployments") && args.includes("status")) {
  if (process.env.SURF_TEST_WORKER_INSPECTION === "existing") {
    console.log(JSON.stringify({
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      strategy: "percentage",
      versions: [{
        version_id: "11111111-2222-4333-8444-555555555555",
        percentage: 100
      }]
    }));
    process.exit(0);
  }
  if (process.env.SURF_TEST_WORKER_INSPECTION === "absent") {
    console.error("Worker not found [code: 10007]");
    process.exit(1);
  }
  if (process.env.SURF_TEST_WORKER_INSPECTION === "worker-only") {
    console.error("The Worker surf has no deployments.");
    process.exit(1);
  }
  console.error("Authentication or network ambiguity [code: 9109]");
  process.exit(1);
}
if (args.includes("queues") && args.includes("info")) {
  console.error("Queue inspection intentionally stopped after bootstrap preflight");
  process.exit(1);
}
if (args.includes("@surf/web") && args.includes("build")) {
  console.error("Build intentionally stopped after exact bootstrap lineage preflight");
  process.exit(1);
}
`,
    { mode: 0o755 }
  );
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "rev-parse HEAD") {
  console.log(${JSON.stringify(sourceRevision)});
  process.exit(0);
}
if (args.includes("status")) process.exit(0);
console.error("Unexpected Git test invocation", args.join(" "));
process.exit(2);
`,
    { mode: 0o755 }
  );
  chmodSync(fakePnpm, 0o755);
  chmodSync(fakeGit, 0o755);
}

function operationalEnvironment(candidate, inspection) {
  return {
    ...process.env,
    PATH: `${candidate.binDirectory}:${process.env.PATH}`,
    SURF_TEST_PNPM_LOG: candidate.invocationLog,
    SURF_TEST_WORKER_INSPECTION: inspection,
    SURF_PRODUCTION_PROFILE: candidate.productionProfile,
    SURF_WRANGLER_CONFIG: candidate.wranglerConfig,
    SURF_WRANGLER_CONFIG_SHA256: candidate.wranglerConfigSha256,
    SURF_LEGACY_PATCHLESS_WORKER_VERSION: ""
  };
}

function isRemoteMutation(args) {
  const wranglerIndex = args.indexOf("wrangler");
  const command = wranglerIndex === -1 ? [] : args.slice(wranglerIndex + 1);
  return (
    (command[0] === "deploy" && !command.includes("--dry-run")) ||
    (command[0] === "queues" && command[1] === "create") ||
    command[0] === "d1" ||
    command[0] === "versions"
  );
}

test("package setup entry point carries explicit bootstrap intent", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8")
  );
  assert.equal(
    packageJson.scripts["setup:cloudflare"],
    "node scripts/cf-deploy.mjs setup --bootstrap-new-instance"
  );
});

test("legacy direct deploy is retired before running any command", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/cf-deploy.mjs", "deploy", "--dry-run"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SURF_INGEST_TOKEN: "test-only-token",
        SURF_LEGACY_PATCHLESS_WORKER_VERSION: "typo"
      }
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /legacy direct deploy entry point is retired/);
  assert.doesNotMatch(output, /^> pnpm /m);
  assert.doesNotMatch(output, /wrangler|whoami|migrations|queues/i);
});

test("real setup requires explicit new-instance intent before running any command", () => {
  const result = spawnSync(process.execPath, ["scripts/cf-deploy.mjs", "setup"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /requires explicit new-instance intent/);
  assert.doesNotMatch(output, /^> pnpm /m);
});

test("real setup refuses to run without a pinned external Wrangler snapshot", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/cf-deploy.mjs", "setup", "--bootstrap-new-instance"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        SURF_WRANGLER_CONFIG: "",
        SURF_WRANGLER_CONFIG_SHA256: "",
        SURF_LEGACY_PATCHLESS_WORKER_VERSION: ""
      }
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(
    output,
    /SURF_WRANGLER_CONFIG and SURF_WRANGLER_CONFIG_SHA256 are required/
  );
  assert.doesNotMatch(output, /^> pnpm /m);
  assert.doesNotMatch(output, /wrangler whoami|migrations|queues create/i);
});

test("bootstrap refuses managed release state before running any command", () => {
  const candidate = operationalFixture({ managedState: true });
  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/cf-deploy.mjs", "setup", "--bootstrap-new-instance"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: operationalEnvironment(candidate, "absent")
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.notEqual(result.status, 0);
    assert.match(output, /Managed production release state already exists/);
    assert.match(output, /pnpm release:prod/);
    assert.doesNotMatch(output, /^> pnpm /m);
  } finally {
    rmSync(candidate.temporaryRoot, { recursive: true, force: true });
  }
});

for (const inspection of ["existing", "worker-only", "ambiguous"]) {
  test(`bootstrap fails closed when Worker inspection is ${inspection}`, () => {
    const candidate = operationalFixture();
    try {
      installInspectionFake(candidate);
      const result = spawnSync(
        process.execPath,
        ["scripts/cf-deploy.mjs", "setup", "--bootstrap-new-instance"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: operationalEnvironment(candidate, inspection)
        }
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      assert.notEqual(result.status, 0);
      assert.match(
        output,
        inspection === "existing"
          ? /already has deployment state/
          : inspection === "worker-only"
            ? /already exists without versioned deployment state/
          : /Could not prove Worker 'surf' is absent/
      );
      const invocations = readFileSync(candidate.invocationLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(invocations.some(isRemoteMutation), false);
      assert.equal(
        invocations.some(
          (args) => args.includes("deployments") && args.includes("status")
        ),
        true
      );
    } finally {
      rmSync(candidate.temporaryRoot, { recursive: true, force: true });
    }
  });
}

test("bootstrap accepts only authoritative Worker absence before exact lineage build", () => {
  const candidate = operationalFixture();
  try {
    installInspectionFake(candidate);
    const result = spawnSync(
      process.execPath,
      ["scripts/cf-deploy.mjs", "setup", "--bootstrap-new-instance"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: operationalEnvironment(candidate, "absent")
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.notEqual(result.status, 0);
    assert.equal(
      output.match(/bootstrap-worker-absence-proved/g)?.length,
      1,
      output
    );
    assert.match(
      output,
      /Build intentionally stopped after exact bootstrap lineage preflight/
    );
    const invocations = readFileSync(candidate.invocationLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(invocations.some(isRemoteMutation), false);
    assert.equal(
      invocations.some(
        (args) => args.includes("@surf/web") && args.includes("build")
      ),
      true
    );
  } finally {
    rmSync(candidate.temporaryRoot, { recursive: true, force: true });
  }
});

test("secretless Cloudflare check ignores an enabled operator overlay and cannot mutate remote state", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "surf-cf-dry-run-"));
  try {
    const binDirectory = resolve(temporaryRoot, "bin");
    const fakePnpm = resolve(binDirectory, "pnpm");
    const invocationLog = resolve(temporaryRoot, "pnpm.ndjson");
    const enabledOverlay = resolve(temporaryRoot, "wrangler.instance.jsonc");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(
      enabledOverlay,
      `${JSON.stringify({
        name: "operator-overlay-must-not-be-read",
        vars: { NARRATIVE_ENABLED: "true" }
      })}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const names = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ENV",
  "GEMINI_API_KEY",
  "SURF_INGEST_TOKEN",
  "SURF_WRANGLER_CONFIG",
  "SURF_WRANGLER_CONFIG_SHA256",
  "WRANGLER_CI_OVERRIDE_NAME"
];
appendFileSync(
  process.env.SURF_TEST_PNPM_LOG,
  JSON.stringify({
    args: process.argv.slice(2),
    environment: Object.fromEntries(names.map((name) => [name, process.env[name]]))
  }) + "\\n"
);
`,
      { mode: 0o755 }
    );
    chmodSync(fakePnpm, 0o755);

    const result = spawnSync(
      process.execPath,
      ["scripts/cf-deploy.mjs", "setup", "--dry-run"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH}`,
          SURF_TEST_PNPM_LOG: invocationLog,
          SURF_WRANGLER_CONFIG: enabledOverlay,
          SURF_WRANGLER_CONFIG_SHA256: "0".repeat(64),
          CLOUDFLARE_API_TOKEN: "operator-token-must-not-reach-child",
          CLOUDFLARE_ENV: "operator-environment-must-not-apply",
          GEMINI_API_KEY: "operator-gemini-must-not-reach-child",
          SURF_INGEST_TOKEN: "operator-ingest-must-not-reach-child",
          WRANGLER_CI_OVERRIDE_NAME: "operator-name-must-not-apply"
        }
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /Cloudflare dry run passed\. No remote resources were changed\./);

    const invocations = readFileSync(invocationLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[0].args, ["--filter", "@surf/web", "build"]);
    assert.deepEqual(invocations[1].args, [
      "--filter",
      "@surf/web",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      "../../dist/wrangler-dry-run",
      "--config",
      resolve(repoRoot, "apps/web/wrangler.jsonc")
    ]);
    for (const invocation of invocations) {
      assert.deepEqual(invocation.environment, {
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ENV: "",
        GEMINI_API_KEY: "",
        SURF_INGEST_TOKEN: "",
        SURF_WRANGLER_CONFIG: "",
        SURF_WRANGLER_CONFIG_SHA256: "",
        WRANGLER_CI_OVERRIDE_NAME: "surf"
      });
      assert.equal(
        invocation.args.some((argument) =>
          ["whoami", "queues", "migrations", "execute", "versions"].includes(argument)
        ),
        false
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
