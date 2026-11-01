#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, writeSync, writeFileSync } from "node:fs";
import { createRawStorageSummary, validateObjectPage } from "./lib/raw-storage-audit.mjs";

// Read-only by construction. This tool has no delete, lifecycle, or write API.
const { values } = parseArgs({ options: {
  bucket: { type: "string" }, output: { type: "string" }, before: { type: "string" },
  prefix: { type: "string", default: "raw/" }, "max-pages": { type: "string", default: "300" }
} });
const maxPages = Number(values["max-pages"]);
if (!values.bucket || !values.output || !values.before || !Number.isFinite(Date.parse(values.before)) ||
    !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
  throw new Error("Use --bucket NAME --output INVENTORY.jsonl --before ISO_TIMESTAMP [--max-pages 300]");
}
const startedAt = new Date().toISOString();
const summaryPath = `${values.output}.summary.json`;
const summary = createRawStorageSummary({ bucket: values.bucket, prefix: values.prefix, before: values.before });
// Refuse overwrites. A partial audit is retained and explicitly marked incomplete.
const summaryFd = openSync(summaryPath, "wx", 0o600);
let inventoryFd;
let pages = 0, complete = false, after;
try {
  inventoryFd = openSync(values.output, "wx", 0o600);
  for (; pages < maxPages;) {
    const args = ["r2", "objects", "list", "--bucket-name", values.bucket,
      "--per-page", "1000", "--prefix", values.prefix];
    if (after !== undefined) args.push("--start-after", after);
    const result = spawnSync("cf", args, { encoding: "utf8", timeout: 35_000, maxBuffer: 16 * 1024 * 1024 });
    pages += 1;
    if (result.error || result.status !== 0) throw new Error(`Read-only listing failed on page ${pages}; no complete manifest produced`);
    const page = validateObjectPage(JSON.parse(result.stdout), { prefix: values.prefix, after });
    // cf exposes an array without cursor/truncated. Continue even after a short
    // page; only an empty start-after page establishes the end of this pass.
    if (page.length === 0) { complete = true; break; }
    for (const object of page) {
      const line = JSON.stringify(object) + "\n";
      writeSync(inventoryFd, line); summary.add(object, line);
    }
    after = page.at(-1).key;
    if (pages % 20 === 0) process.stderr.write(`Read ${pages} metadata pages from ${values.bucket}\n`);
  }
  if (!complete) throw new Error(`Reached ${maxPages}-page read budget; inventory is incomplete`);
} finally {
  if (inventoryFd !== undefined) closeSync(inventoryFd);
  const report = summary.finish({ complete, pages, startedAt, finishedAt: new Date().toISOString() });
  writeFileSync(summaryFd, JSON.stringify(report, null, 2) + "\n"); closeSync(summaryFd);
  console.log(JSON.stringify({ ...report, groups: undefined }, null, 2));
}
