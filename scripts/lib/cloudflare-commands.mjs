import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import { loadRootEnv, repoRoot } from "./root-env.mjs";
import {
  wranglerEnvironmentFailures,
  wranglerStructureFailures
} from "./validate-wrangler-config.mjs";

loadRootEnv();

// A versioned deploy can deliberately wait through the hourly :17 cron settle
// window before spending its 10-minute publication budget. Keep the shared
// ceiling above that supported path while still making every pnpm/Wrangler
// child finite. Read-only callers may choose a shorter timeout.
export const CLOUDFLARE_COMMAND_TIMEOUT_MS = 45 * 60_000;

export const wranglerConfigPath = fileURLToPath(
  new URL("../../apps/web/wrangler.jsonc", import.meta.url)
);
const configuredWranglerPath = process.env.SURF_WRANGLER_CONFIG;
export const activeWranglerConfigPath = configuredWranglerPath
  ? isAbsolute(configuredWranglerPath)
    ? configuredWranglerPath
    : resolve(dirname(wranglerConfigPath), configuredWranglerPath)
  : wranglerConfigPath;

function displayCommand(args) {
  return ["pnpm", ...args].join(" ");
}

export function resolveCloudflareCommandTimeout(options = {}) {
  const timeoutPolicy = options.timeoutPolicy ?? "finite";
  if (timeoutPolicy === "unbounded") {
    if (options.timeoutMs !== undefined) {
      throw new Error(
        "An unbounded Cloudflare command cannot also configure timeoutMs."
      );
    }
    return undefined;
  }
  if (timeoutPolicy !== "finite") {
    throw new Error("Cloudflare command timeoutPolicy must be finite or unbounded.");
  }
  const timeoutMs = options.timeoutMs ?? CLOUDFLARE_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Cloudflare command timeout must be a positive integer in milliseconds.");
  }
  return timeoutMs;
}

function invokePnpm(args, options = {}) {
  const capture = options.capture ?? false;
  const timeoutMs = resolveCloudflareCommandTimeout(options);
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      ...options.env
    },
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit"
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      const error = new Error(
        `pnpm subprocess exceeded its ${timeoutMs}ms timeout; captured output was suppressed.`
      );
      error.name = "TimeoutError";
      throw error;
    }
    throw result.error;
  }

  return result;
}

export function runPnpm(args, options = {}) {
  resolveCloudflareCommandTimeout(options);
  console.log(`\n> ${displayCommand(args)}`);
  const result = invokePnpm(args, options);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (options.capture && options.echo !== false && output) {
    process.stdout.write(output);
  }

  if (result.status !== 0) {
    if (options.capture && options.echo === false && output) {
      process.stderr.write(output);
    }
    throw new Error(`${displayCommand(args)} exited with status ${result.status ?? "unknown"}`);
  }

  return output;
}

function wranglerPnpmArgs(args) {
  const configArgs = configuredWranglerPath
    ? ["--config", activeWranglerConfigPath]
    : [];
  return ["--filter", "@surf/web", "exec", "wrangler", ...args, ...configArgs];
}

export function runWrangler(args, options = {}) {
  return runPnpm(wranglerPnpmArgs(args), options);
}

export function probeWrangler(args, options = {}) {
  return invokePnpm(wranglerPnpmArgs(args), { ...options, capture: true });
}

export function readWranglerConfig(path = activeWranglerConfigPath) {
  const errors = [];
  const config = parse(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true
  });
  if (errors.length > 0 || !config || typeof config !== "object") {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(
      `Could not parse ${relative(repoRoot, path)}${details ? `: ${details}` : ""}`
    );
  }
  return config;
}

export function configuredQueueNames(config = readWranglerConfig()) {
  const names = new Set();
  for (const producer of config.queues?.producers ?? []) {
    if (producer.queue) names.add(producer.queue);
  }
  for (const consumer of config.queues?.consumers ?? []) {
    if (consumer.queue) names.add(consumer.queue);
    if (consumer.dead_letter_queue) names.add(consumer.dead_letter_queue);
  }
  return [...names];
}

export function assertActiveWranglerConfig() {
  const config = readWranglerConfig(activeWranglerConfigPath);
  const failures = [
    ...wranglerStructureFailures(config, activeWranglerConfigPath),
    ...wranglerEnvironmentFailures(config)
  ];
  if (failures.length > 0) {
    throw new Error(
      `Active Wrangler configuration is unsafe:\n${failures.map((failure) => `- ${failure}`).join("\n")}`
    );
  }
  return config;
}

export function ensureQueues() {
  const queueNames = configuredQueueNames(readWranglerConfig(activeWranglerConfigPath));
  if (queueNames.length === 0) {
    throw new Error("wrangler.jsonc does not configure any queues");
  }

  for (const queueName of queueNames) {
    const probe = probeWrangler(["queues", "info", queueName]);
    if (probe.status === 0) {
      console.log(`Queue '${queueName}' already exists.`);
      continue;
    }

    const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    if (!output.includes(`Queue "${queueName}" does not exist`)) {
      process.stderr.write(output);
      throw new Error(`Could not inspect queue '${queueName}'.`);
    }

    runWrangler(["queues", "create", queueName]);
  }
}
