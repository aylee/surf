#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertActiveWranglerConfig,
  pinActiveWranglerConfigForDeploy,
  runWrangler
} from "./lib/cloudflare-commands.mjs";

export function wranglerPassthroughOptions(args) {
  // `tail` is an operator-held stream and may intentionally span a complete
  // hourly cycle. Keep this exact exception at the passthrough boundary;
  // automation and every other generic command retain the shared finite cap.
  return args[0] === "tail" ? { timeoutPolicy: "unbounded" } : {};
}

export function prepareWranglerPassthrough(environment = process.env) {
  pinActiveWranglerConfigForDeploy(environment, { required: true });
  return assertActiveWranglerConfig(environment);
}

export function isSecretlessLocalWranglerInvocation(args) {
  return args.length === 1 && args[0] === "--version";
}

export function runWranglerPassthrough(
  rawArgs,
  runner = runWrangler,
  prepare = prepareWranglerPassthrough
) {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (args.length === 0) {
    throw new Error("Usage: pnpm wrangler -- <command> [arguments]");
  }
  // The canonical wrapper check only asks the local binary for its version;
  // it cannot read or mutate Cloudflare state. Every other invocation remains
  // fail-closed behind the attested configuration and ambient-env guards.
  if (!isSecretlessLocalWranglerInvocation(args)) prepare();
  return runner(args, wranglerPassthroughOptions(args));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runWranglerPassthrough(process.argv.slice(2));
}
