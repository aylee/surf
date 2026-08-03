import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../lib/cloudflare-commands.mjs";
import { wranglerStructureFailures } from "../lib/validate-wrangler-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const configPath = resolve(root, "apps/web/wrangler.jsonc");
const canonical = readWranglerConfig(configPath);

test("Wrangler instance config follows the subcommand arguments", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/wrangler.mjs", "whoami", "--help"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SURF_WRANGLER_CONFIG: "wrangler.jsonc",
        WRANGLER_LOG_PATH: resolve(tmpdir(), `surf-wrangler-order-${process.pid}.log`)
      }
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /wrangler whoami/);
  assert.doesNotMatch(output, /Unknown argument/);
});

test("canonical Wrangler configuration satisfies the supported instance contract", () => {
  assert.deepEqual(wranglerStructureFailures(canonical, configPath), []);
});

test("instance validation rejects namespace, region, and contact drift", () => {
  const config = structuredClone(canonical);
  config.d1_databases[0].database_name = "someone-elses-database";
  config.r2_buckets[0].bucket_name = "shared-raw-data";
  config.vars.SURF_REGION = "socal";
  config.vars.SURF_USER_AGENT = "surf";

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "D1 database_name must match the Worker name.",
    "Manual RAW_ARTIFACTS bucket_name must be surf-raw-artifacts.",
    "SURF_REGION must remain norcal until another runtime catalog is implemented.",
    "SURF_USER_AGENT must identify the instance with an operator contact."
  ]);
});

test("instance validation protects the Agent lifecycle and secret boundary", () => {
  const config = structuredClone(canonical);
  config.durable_objects.bindings[0].class_name = "WrongAgent";
  config.exports.ForecastBriefAgent.storage = "kv";
  config.vars.FORECAST_BRIEF_ENABLED = "true";
  config.vars.GEMINI_API_KEY = "must-not-be-tracked";

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "FORECAST_BRIEF_AGENT must bind exactly once to ForecastBriefAgent.",
    "ForecastBriefAgent must be declared as a live SQLite durable-object export.",
    "The tracked config must keep FORECAST_BRIEF_ENABLED=false for the first Durable Object lifecycle deploy.",
    "GEMINI_API_KEY must be a Wrangler secret, never a tracked Worker var."
  ]);
});

test("instance validation preserves serialized ingest generations", () => {
  const config = structuredClone(canonical);
  config.queues.consumers[0].max_batch_size = 10;
  delete config.queues.consumers[0].max_concurrency;

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "Ingest queue consumption must be serialized one message at a time."
  ]);
});

test("instance validation preserves version-scoped Worker response caching", () => {
  const config = structuredClone(canonical);
  config.cache.cross_version_cache = true;

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "Worker response caching must be enabled with version-scoped cache keys."
  ]);
});

test("an ignored instance config may enable the brief after the lifecycle deploy", () => {
  const config = structuredClone(canonical);
  config.vars.FORECAST_BRIEF_ENABLED = "true";
  const instanceConfigPath = resolve(root, "apps/web/wrangler.instance.jsonc");

  assert.deepEqual(wranglerStructureFailures(config, instanceConfigPath), []);
});
