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
import { verifyWranglerConfigSnapshot } from "./wrangler-config-snapshot.mjs";

loadRootEnv();

// A versioned deploy can deliberately wait through the hourly :17 cron settle
// window before spending its 10-minute publication budget. Keep the shared
// ceiling above that supported path while still making every pnpm/Wrangler
// child finite. Read-only callers may choose a shorter timeout.
export const CLOUDFLARE_COMMAND_TIMEOUT_MS = 45 * 60_000;

export const wranglerConfigPath = fileURLToPath(
  new URL("../../apps/web/wrangler.jsonc", import.meta.url)
);
const initialWranglerPath = process.env.SURF_WRANGLER_CONFIG;
export let activeWranglerConfigPath = initialWranglerPath
  ? isAbsolute(initialWranglerPath)
    ? initialWranglerPath
    : resolve(dirname(wranglerConfigPath), initialWranglerPath)
  : wranglerConfigPath;
let useActiveConfigArgument = Boolean(initialWranglerPath);
let pinnedWranglerConfigSha256 = null;
let cloudflareCommandGuard = null;

export function setCloudflareCommandGuard(guard) {
  if (cloudflareCommandGuard) {
    throw new Error("Cloudflare command guard is already configured");
  }
  if (typeof guard !== "function") throw new Error("Cloudflare command guard must be callable");
  cloudflareCommandGuard = guard;
}

export function pinActiveWranglerConfigForDeploy(
  environment = process.env,
  { required = false } = {}
) {
  const configuredWranglerPath = environment.SURF_WRANGLER_CONFIG?.trim();
  if (!configuredWranglerPath) {
    if (required) {
      throw new Error(
        "SURF_WRANGLER_CONFIG and SURF_WRANGLER_CONFIG_SHA256 are required for this operational Wrangler command"
      );
    }
    return null;
  }
  activeWranglerConfigPath = isAbsolute(configuredWranglerPath)
    ? configuredWranglerPath
    : resolve(dirname(wranglerConfigPath), configuredWranglerPath);
  const pinned = verifyWranglerConfigSnapshot({
    path: activeWranglerConfigPath,
    releaseRoot: repoRoot,
    expectedSha256: environment.SURF_WRANGLER_CONFIG_SHA256
  });
  activeWranglerConfigPath = pinned.path;
  useActiveConfigArgument = true;
  pinnedWranglerConfigSha256 = pinned.sha256;
  console.log(
    JSON.stringify({
      status: "wrangler-config-pinned",
      path: pinned.path,
      sha256: pinned.sha256,
      workerName: pinned.config.name
    })
  );
  return pinned;
}

export function selectTrackedWranglerConfigForSecretlessDryRun() {
  activeWranglerConfigPath = wranglerConfigPath;
  useActiveConfigArgument = true;
  pinnedWranglerConfigSha256 = null;
  return assertActiveWranglerConfig({});
}

function assertPinnedWranglerConfigUnchanged() {
  if (!pinnedWranglerConfigSha256) return;
  verifyWranglerConfigSnapshot({
    path: activeWranglerConfigPath,
    releaseRoot: repoRoot,
    expectedSha256: pinnedWranglerConfigSha256
  });
}

function displayCommand(args) {
  return ["pnpm", ...args].join(" ");
}

export function cloudflareApiErrorCodes(output) {
  if (typeof output !== "string") return [];
  const codes = new Set();
  for (const match of output.matchAll(/\[code:\s*(\d+)\]/gi)) {
    codes.add(Number(match[1]));
  }
  return [...codes];
}

export function hasCloudflareApiErrorCode(error, expectedCode) {
  if (!Number.isInteger(expectedCode) || expectedCode <= 0) {
    throw new Error("Cloudflare API error code must be a positive integer.");
  }
  let current = error;
  const visited = new Set();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (current.cloudflareApiErrorCodes?.includes?.(expectedCode)) return true;
    current = current.cause;
  }
  return false;
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
    const error = new Error(
      `${displayCommand(args)} exited with status ${result.status ?? "unknown"}`
    );
    Object.defineProperty(error, "cloudflareApiErrorCodes", {
      value: cloudflareApiErrorCodes(output),
      enumerable: false
    });
    throw error;
  }

  return output;
}

function assertCloudflareCommandInputsUnchanged() {
  cloudflareCommandGuard?.();
  assertPinnedWranglerConfigUnchanged();
}

function wranglerPnpmArgs(args) {
  assertCloudflareCommandInputsUnchanged();
  const configArgs = useActiveConfigArgument
    ? ["--config", activeWranglerConfigPath]
    : [];
  return ["--filter", "@surf/web", "exec", "wrangler", ...args, ...configArgs];
}

function stableWranglerCaptureOptions(options) {
  if (options.capture !== true) return options;
  // Captured Wrangler stdout is parsed by deployment guards. Keep pnpm's
  // dependency/status chatter deterministic without changing the operator's
  // shell or the environment inherited by non-captured commands.
  return {
    ...options,
    env: {
      ...options.env,
      CI: "true"
    }
  };
}

export function runWrangler(args, options = {}) {
  const pnpmArgs = wranglerPnpmArgs(args);
  try {
    return runPnpm(pnpmArgs, stableWranglerCaptureOptions(options));
  } finally {
    assertCloudflareCommandInputsUnchanged();
  }
}

export function probeWrangler(args, options = {}) {
  const pnpmArgs = wranglerPnpmArgs(args);
  try {
    return invokePnpm(
      pnpmArgs,
      stableWranglerCaptureOptions({ ...options, capture: true })
    );
  } finally {
    assertCloudflareCommandInputsUnchanged();
  }
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
  if ((config.queues?.producers ?? []).some((producer) => producer.binding === "NARRATIVE_QUEUE")) {
    names.add(`${config.name}-narrative-dlq`);
  }
  return [...names];
}

export function assertActiveWranglerConfig(environment = process.env) {
  const config = readWranglerConfig(activeWranglerConfigPath);
  const failures = [
    ...wranglerStructureFailures(config, activeWranglerConfigPath),
    ...wranglerEnvironmentFailures(config, environment)
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
