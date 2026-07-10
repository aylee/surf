import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../lib/cloudflare-commands.mjs";
import { wranglerStructureFailures } from "../lib/validate-wrangler-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const configPath = resolve(root, "apps/web/wrangler.jsonc");
const canonical = readWranglerConfig(configPath);

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
