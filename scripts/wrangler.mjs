#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWrangler } from "./lib/cloudflare-commands.mjs";

export function wranglerPassthroughOptions(args) {
  // `tail` is an operator-held stream and may intentionally span a complete
  // hourly cycle. Keep this exact exception at the passthrough boundary;
  // automation and every other generic command retain the shared finite cap.
  return args[0] === "tail" ? { timeoutPolicy: "unbounded" } : {};
}

export function runWranglerPassthrough(rawArgs, runner = runWrangler) {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (args.length === 0) {
    throw new Error("Usage: pnpm wrangler -- <command> [arguments]");
  }
  return runner(args, wranglerPassthroughOptions(args));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runWranglerPassthrough(process.argv.slice(2));
}
