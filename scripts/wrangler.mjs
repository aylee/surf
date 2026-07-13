#!/usr/bin/env node

import { runWrangler } from "./lib/cloudflare-commands.mjs";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
if (args.length === 0) {
  throw new Error("Usage: pnpm wrangler -- <command> [arguments]");
}
runWrangler(args);
