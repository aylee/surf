#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { loadRunnerConfig, redactedConfigSummary } from "./config";
import { RunnerFailure } from "./errors";
import { OpenAiCompatibleOmlxClient } from "./omlx-client";
import { createNarrativeRunner } from "./runner";
import { readRunnerStatus, type RunnerStatus } from "./status";

type Command = "run" | "once" | "check" | "status";

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function modelStatus(config: ReturnType<typeof loadRunnerConfig>): Promise<{
  ready: boolean;
  code: string | null;
}> {
  try {
    await new OpenAiCompatibleOmlxClient(config.omlx).preflight();
    return { ready: true, code: null };
  } catch (error) {
    return {
      ready: false,
      code: error instanceof RunnerFailure ? error.code : "omlx_preflight_failed"
    };
  }
}

export function statusFreshnessThresholdMs(
  config: Pick<
    ReturnType<typeof loadRunnerConfig>,
    | "idleMaxMs"
    | "pollIntervalMs"
    | "heartbeatIntervalMs"
    | "queueTimeoutMs"
  >
): number {
  return Math.max(
    config.idleMaxMs +
      config.queueTimeoutMs +
      Math.max(10_000, config.pollIntervalMs * 2),
    config.heartbeatIntervalMs * 3
  );
}

export function heartbeatIsFresh(
  heartbeat: RunnerStatus | null,
  config: Pick<
    ReturnType<typeof loadRunnerConfig>,
    | "idleMaxMs"
    | "pollIntervalMs"
    | "heartbeatIntervalMs"
    | "queueTimeoutMs"
  >,
  nowMs = Date.now()
): boolean {
  if (!heartbeat) return false;
  return Math.max(0, nowMs - Date.parse(heartbeat.updatedAt)) <=
    statusFreshnessThresholdMs(config);
}

export function heartbeatMatchesConfig(
  heartbeat: RunnerStatus | null,
  config: { runnerId: string; omlx: { modelId: string } }
): boolean {
  return Boolean(
    heartbeat &&
      heartbeat.runnerId === config.runnerId &&
      heartbeat.modelId === config.omlx.modelId
  );
}

export function localPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPERM"
    );
  }
}

export function runnerStatusHealthy(options: {
  modelReady: boolean;
  heartbeat: RunnerStatus | null;
  heartbeatFresh: boolean;
  pidAlive: boolean;
  identityMatches: boolean;
}): boolean {
  return Boolean(
    options.modelReady &&
      options.heartbeatFresh &&
      options.pidAlive &&
      options.identityMatches &&
      options.heartbeat !== null &&
      ["idle", "processing"].includes(options.heartbeat.state) &&
      options.heartbeat.lastErrorCode === null
  );
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] as Command | undefined;
  if (!command || !["run", "once", "check", "status"].includes(command) || argv.length !== 1) {
    process.stderr.write("Usage: narrative-runner <run|once|check|status>\n");
    return 2;
  }

  let config: ReturnType<typeof loadRunnerConfig>;
  try {
    config = loadRunnerConfig();
  } catch {
    process.stderr.write(`${JSON.stringify({ status: "error", code: "configuration_invalid" })}\n`);
    return 1;
  }

  if (command === "check") {
    const omlx = await modelStatus(config);
    write({ command, config: redactedConfigSummary(config), omlx });
    return omlx.ready ? 0 : 1;
  }

  if (command === "status") {
    let heartbeat;
    try {
      heartbeat = await readRunnerStatus(config.statusFile);
    } catch {
      process.stderr.write(`${JSON.stringify({ status: "error", code: "status_file_invalid" })}\n`);
      return 1;
    }
    const omlx = await modelStatus(config);
    const nowMs = Date.now();
    const ageMs = heartbeat ? Math.max(0, nowMs - Date.parse(heartbeat.updatedAt)) : null;
    const heartbeatFresh = heartbeatIsFresh(heartbeat, config, nowMs);
    const heartbeatActive = heartbeat !== null && heartbeat.state !== "stopped";
    const pidAlive = heartbeat !== null && localPidIsAlive(heartbeat.pid);
    const heartbeatIdentityMatches = heartbeatMatchesConfig(heartbeat, config);
    const healthy = runnerStatusHealthy({
      modelReady: omlx.ready,
      heartbeat,
      heartbeatFresh,
      pidAlive,
      identityMatches: heartbeatIdentityMatches
    });
    write({
      command,
      config: redactedConfigSummary(config),
      omlx,
      heartbeat,
      heartbeatAgeMs: ageMs,
      heartbeatFresh,
      heartbeatActive,
      heartbeatIdentityMatches,
      pidAlive,
      healthy
    });
    return healthy ? 0 : 1;
  }

  const runner = createNarrativeRunner(config);
  if (command === "once") {
    try {
      const outcomes = await runner.runOnce();
      write({
        command,
        pulled: outcomes.length,
        outcomes: outcomes.map(({ messageId, jobId, domain, action, code, disposition }) => ({
          messageId,
          jobId,
          domain,
          action,
          code,
          disposition
        }))
      });
      return outcomes.some(({ action }) => action !== "ack") ? 1 : 0;
    } catch (error) {
      const code = error instanceof RunnerFailure ? error.code : "runner_once_failed";
      process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
      return 1;
    }
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runner.run(controller.signal);
    return 0;
  } catch (error) {
    const code = error instanceof RunnerFailure ? error.code : "runner_failed";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
