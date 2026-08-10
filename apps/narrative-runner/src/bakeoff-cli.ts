#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBakeoffConfig } from "./bakeoff-config";
import {
  BakeoffInterruptedError,
  bakeoffPlanForDisplay,
  planBakeoff,
  runBakeoff
} from "./bakeoff";

function repositoryRoot(): string {
  return resolve(fileURLToPath(new URL("../../..", import.meta.url)));
}

function usage(): never {
  throw new Error(
    "Usage: bakeoff-cli.ts <plan|run> --config <path> [--max-calls <positive integer>] [--runner-isolation <stopped|dedicated-endpoint>]"
  );
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function allowedArguments(args: string[]): void {
  const allowed = new Set(["--config", "--max-calls", "--runner-isolation"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--") || !allowed.has(value)) usage();
    index += 1;
    if (index >= args.length) usage();
  }
}

let interruptionExitCode: number | null = null;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "--") rawArgs.shift();
  const [command, ...args] = rawArgs;
  if (command !== "plan" && command !== "run") usage();
  allowedArguments(args);
  const root = repositoryRoot();
  const configPath = option(args, "--config");
  if (!configPath) usage();
  const cwdConfigPath = resolve(process.cwd(), configPath);
  const resolvedConfigPath = existsSync(cwdConfigPath)
    ? cwdConfigPath
    : resolve(root, configPath);
  const config = await loadBakeoffConfig(resolvedConfigPath, {
    repositoryRoot: root
  });
  if (command === "plan") {
    const planned = await planBakeoff(config, root);
    process.stdout.write(
      `${JSON.stringify(
        bakeoffPlanForDisplay({ ...planned, config }),
        null,
        2
      )}\n`
    );
    return;
  }
  const rawMaxCalls = option(args, "--max-calls");
  if (!rawMaxCalls) usage();
  const maxCalls = Number(rawMaxCalls);
  const runnerIsolation = option(args, "--runner-isolation");
  if (runnerIsolation !== "stopped" && runnerIsolation !== "dedicated-endpoint") {
    usage();
  }
  const controller = new AbortController();
  const interrupt = (exitCode: number) => {
    interruptionExitCode ??= exitCode;
    controller.abort();
  };
  const onSigint = () => interrupt(130);
  const onSigterm = () => interrupt(143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let result: Awaited<ReturnType<typeof runBakeoff>>;
  try {
    result = await runBakeoff(config, {
      repositoryRoot: root,
      maxCalls,
      runnerIsolation,
      signal: controller.signal
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        runDirectory: result.runDirectory,
        actualCalls: result.summary.actualCalls,
        summary: resolve(result.runDirectory, "summary.json")
      },
      null,
      2
    )}\n`
  );
}

main().catch((error: unknown) => {
  if (error instanceof BakeoffInterruptedError || interruptionExitCode !== null) {
    process.stderr.write(
      "Analysis bakeoff interrupted at an inference boundary; the local manifest was updated.\n"
    );
    process.exitCode = interruptionExitCode ?? 130;
    return;
  }
  const message = error instanceof Error ? error.message : "Unknown bakeoff failure";
  process.stderr.write(`Analysis bakeoff failed: ${message}\n`);
  process.exitCode = 1;
});
