#!/usr/bin/env node

import { resolve } from "node:path";
import { stageWranglerConfigSnapshot } from "./lib/wrangler-config-snapshot.mjs";
import { repoRoot } from "./lib/root-env.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? null : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(
      "Usage: stage-wrangler-config.mjs --source <absolute-path> --output <absolute-path>"
    );
  }
  return value;
}

const sourcePath = option("--source");
const outputPath = option("--output");
if (process.argv.length !== 6) {
  throw new Error(
    "Usage: stage-wrangler-config.mjs --source <absolute-path> --output <absolute-path>"
  );
}
const result = stageWranglerConfigSnapshot({
  sourcePath: resolve(sourcePath),
  outputPath: resolve(outputPath),
  releaseRoot: repoRoot
});
console.log(
  JSON.stringify({ path: result.path, sha256: result.sha256, workerName: result.config.name })
);
