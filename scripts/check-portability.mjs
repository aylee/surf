#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "./lib/cloudflare-commands.mjs";
import { wranglerStructureFailures } from "./lib/validate-wrangler-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = resolve(root, "apps/web/wrangler.jsonc");
const config = readWranglerConfig(configPath);
const failures = wranglerStructureFailures(config, configPath);

function assert(condition, message) {
  if (!condition) failures.push(message);
}

assert(config.account_id === undefined, "Do not commit a Cloudflare account_id.");
assert(
  config.vars?.CLOUDFLARE_ACCOUNT_ID === undefined,
  "Do not expose CLOUDFLARE_ACCOUNT_ID as a Worker runtime variable."
);

const db = (config.d1_databases ?? []).find((entry) => entry.binding === "DB") ?? {};
assert(db.database_id === undefined, "D1 database_id must be auto-provisioned, not committed.");
const rawArtifacts =
  (config.r2_buckets ?? []).find((entry) => entry.binding === "RAW_ARTIFACTS") ?? {};
assert(
  rawArtifacts.bucket_name === undefined,
  "R2 bucket_name must be auto-provisioned, not owner-specific."
);

const packagePaths = ["package.json"];
for (const workspaceDirectory of ["apps", "packages"]) {
  for (const entry of readdirSync(resolve(root, workspaceDirectory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packagePath = `${workspaceDirectory}/${entry.name}/package.json`;
    if (existsSync(resolve(root, packagePath))) packagePaths.push(packagePath);
  }
}
for (const packagePath of packagePaths) {
  const manifest = JSON.parse(readFileSync(resolve(root, packagePath), "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      assert(version !== "latest", `${packagePath}: ${section}.${name} must not use 'latest'.`);
    }
  }
}

const trackedFiles = execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8"
})
  .split("\n")
  .filter(Boolean);
const worktreeFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean);

for (const file of worktreeFiles.filter(
  (candidate) =>
    candidate.endsWith(".md") &&
    !candidate.startsWith("cc_state/") &&
    existsSync(resolve(root, candidate))
)) {
  const markdown = readFileSync(resolve(root, file), "utf8");
  const links = markdown.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))/g);
  for (const match of links) {
    const target = match[1] ?? match[2];
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
    const localPath = decodeURIComponent(target.split("#", 1)[0]);
    assert(
      existsSync(resolve(root, dirname(file), localPath)),
      `${file} links to missing local file ${target}.`
    );
  }
}

const dashboardImage = readFileSync(resolve(root, "docs/assets/dashboard.png"));
assert(
  dashboardImage.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  "docs/assets/dashboard.png must contain PNG bytes."
);

for (const file of worktreeFiles.filter(
  (candidate) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(candidate) &&
    existsSync(resolve(root, candidate))
)) {
  const workflow = readFileSync(resolve(root, file), "utf8");
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
    const action = match[1];
    if (action?.startsWith("./")) continue;
    assert(
      /@[0-9a-f]{40}$/i.test(action ?? ""),
      `${file} must pin third-party action ${action ?? "<unknown>"} to a full commit SHA.`
    );
  }
}

const portableFiles = [...new Set([
  ".env.example",
  "apps/web/wrangler.jsonc",
  "apps/web/scripts/smoke-cloudflare.mjs",
  "scripts/cf-deploy.mjs",
  ...trackedFiles.filter((file) => /(^|\/)wrangler[^/]*\.(jsonc|json|toml)$/i.test(file))
])];
const forbiddenPatterns = [
  {
    pattern: /\b[0-9a-f]{32}\b/i,
    description: "a Cloudflare account or KV namespace ID"
  },
  {
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    description: "a Cloudflare resource UUID"
  },
  {
    pattern: /https:\/\/(?!your-worker\.)[^\s"']+\.workers\.dev/i,
    description: "a hard-coded workers.dev deployment URL"
  }
];
for (const file of portableFiles) {
  const contents = readFileSync(resolve(root, file), "utf8");
  for (const { pattern, description } of forbiddenPatterns) {
    assert(!pattern.test(contents), `${file} contains ${description}.`);
  }
}

for (const file of worktreeFiles.filter(
  (candidate) => candidate.endsWith(".mjs") && existsSync(resolve(root, candidate))
)) {
  try {
    execFileSync(process.execPath, ["--check", resolve(root, file)], { stdio: "pipe" });
  } catch {
    failures.push(`${file} does not pass node --check.`);
  }
}

if (failures.length > 0) {
  console.error("Cloudflare portability check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Repository configuration is portable and dependency/action versions are explicit.");
