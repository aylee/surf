#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { generateNorcalSeedSql } from "../src/norcal-seed";

const outputUrl = new URL("../seeds/0000_v1_norcal.sql", import.meta.url);
const generatedSql = generateNorcalSeedSql();

if (process.argv.includes("--check")) {
  const currentSql = readFileSync(outputUrl, "utf8");
  if (currentSql !== generatedSql) {
    console.error("Generated NorCal seed is stale. Run: pnpm --filter @surf/db seed:generate");
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputUrl, generatedSql);
  console.log(`Generated ${outputUrl.pathname}`);
}
