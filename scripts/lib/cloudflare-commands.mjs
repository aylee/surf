import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import { loadRootEnv, repoRoot } from "./root-env.mjs";
import { wranglerStructureFailures } from "./validate-wrangler-config.mjs";

loadRootEnv();

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

function invokePnpm(args, options = {}) {
  const capture = options.capture ?? false;
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      ...options.env
    },
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

export function runPnpm(args, options = {}) {
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

export function runWrangler(args, options = {}) {
  const configArgs = configuredWranglerPath
    ? ["--config", activeWranglerConfigPath]
    : [];
  return runPnpm(
    ["--filter", "@surf/web", "exec", "wrangler", ...configArgs, ...args],
    options
  );
}

export function probeWrangler(args) {
  const configArgs = configuredWranglerPath
    ? ["--config", activeWranglerConfigPath]
    : [];
  return invokePnpm(
    ["--filter", "@surf/web", "exec", "wrangler", ...configArgs, ...args],
    { capture: true }
  );
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
  const failures = wranglerStructureFailures(config, activeWranglerConfigPath);
  if (failures.length > 0) {
    throw new Error(
      `Active Wrangler configuration is unsafe:\n${failures.map((failure) => `- ${failure}`).join("\n")}`
    );
  }
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
