#!/usr/bin/env node

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertActiveWranglerConfig,
  runWrangler
} from "./lib/cloudflare-commands.mjs";
import { repoRoot } from "./lib/root-env.mjs";

const persistenceDirectory = resolve(repoRoot, "dist/verify-local-d1");

assertActiveWranglerConfig();
rmSync(persistenceDirectory, { recursive: true, force: true });

try {
  runWrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    persistenceDirectory
  ]);
  runWrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    persistenceDirectory,
    "--yes",
    "--file",
    "../../packages/db/seeds/0000_v1_norcal.sql"
  ]);
} finally {
  rmSync(persistenceDirectory, { recursive: true, force: true });
}

console.log("Fresh isolated D1 migrations and generated seed applied successfully.");
