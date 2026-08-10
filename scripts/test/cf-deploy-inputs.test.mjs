import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { repoRoot } from "../lib/root-env.mjs";

test("deploy rejects a malformed legacy bootstrap UUID before running any command", () => {
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
  assert.match(output, /legacy patchless Worker version ID must be a UUID/);
  assert.doesNotMatch(output, /^> pnpm /m);
  assert.doesNotMatch(output, /wrangler|whoami|migrations|queues/i);
});

test("real setup refuses to run without a pinned external Wrangler snapshot", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/cf-deploy.mjs", "setup"],
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
