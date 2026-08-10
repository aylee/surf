#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { installLaunchAgents } from "./install-launch-agents.mjs";
import { verifyLaunchActivation } from "./render-launch-agents.mjs";

const execFileAsync = promisify(execFile);
const RUNNER_LABEL = "ai.alex.narrative-runner";
const OMLX_LABEL = "ai.alex.omlx-server";
const COMMAND_TIMEOUT_MS = 10_000;
const RUNNER_DRAIN_TIMEOUT_MS = 960_000;
const OMLX_STOP_TIMEOUT_MS = 90_000;
const READINESS_TIMEOUT_MS = 120_000;

function remainingMs(deadline, now) {
  return Math.max(0, deadline - now());
}

async function defaultCommand(file, args, { timeoutMs }) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return { status: 0, stdout: result.stdout ?? "" };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ETIMEDOUT") {
      throw new Error("bounded service command timed out");
    }
    return {
      status: typeof error?.code === "number" ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : ""
    };
  }
}

async function defaultPortOpen(host, port, timeoutMs) {
  return await new Promise((resolveOpen) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function dependencies(overrides = {}) {
  return {
    command: overrides.command ?? defaultCommand,
    install: overrides.install ?? installLaunchAgents,
    verify: overrides.verify ?? verifyLaunchActivation,
    readFile: overrides.readFile ?? readFile,
    portOpen: overrides.portOpen ?? defaultPortOpen,
    now: overrides.now ?? Date.now,
    sleep:
      overrides.sleep ??
      ((milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))),
    uid: overrides.uid ?? process.getuid?.()
  };
}

async function labelLoaded(label, domain, deadline, deps) {
  const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, remainingMs(deadline, deps.now));
  if (timeoutMs <= 0) throw new Error(`timed out while checking ${label}`);
  const result = await deps.command(
    "/bin/launchctl",
    ["print", `${domain}/${label}`],
    { timeoutMs }
  );
  return result.status === 0;
}

async function assertLoadedJobPath(label, expectedPath, domain, deadline, deps) {
  const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, remainingMs(deadline, deps.now));
  if (timeoutMs <= 0) throw new Error(`timed out while attesting ${label}`);
  const result = await deps.command(
    "/bin/launchctl",
    ["print", `${domain}/${label}`],
    { timeoutMs }
  );
  const expectedLine = `path = ${expectedPath}`;
  if (
    result.status !== 0 ||
    !result.stdout.split("\n").some((line) => line.trim() === expectedLine)
  ) {
    throw new Error(`${label} is not loaded from the recorded persistent plist`);
  }
}

async function waitLabelUnloaded(label, domain, deadline, deps) {
  while (remainingMs(deadline, deps.now) > 0) {
    if (!(await labelLoaded(label, domain, deadline, deps))) return;
    await deps.sleep(Math.min(250, remainingMs(deadline, deps.now)));
  }
  throw new Error(`${label} did not unload inside the bounded stop window`);
}

async function bootout(label, domain, deadline, deps) {
  if (!(await labelLoaded(label, domain, deadline, deps))) return false;
  const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, remainingMs(deadline, deps.now));
  if (timeoutMs <= 0) throw new Error(`timed out before bootout of ${label}`);
  const result = await deps.command(
    "/bin/launchctl",
    ["bootout", `${domain}/${label}`],
    { timeoutMs }
  );
  if (result.status !== 0) throw new Error(`launchctl bootout failed for ${label}`);
  await waitLabelUnloaded(label, domain, deadline, deps);
  return true;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

async function waitPriorRunnerStopped(record, deadline, deps) {
  while (remainingMs(deadline, deps.now) > 0) {
    try {
      const heartbeat = JSON.parse(await deps.readFile(record.statusFile, "utf8"));
      if (
        heartbeat?.state === "stopped" &&
        Number.isInteger(heartbeat.pid) &&
        heartbeat.pid > 0 &&
        !pidAlive(heartbeat.pid)
      ) {
        return;
      }
    } catch {
      // A missing or partial heartbeat is not drain proof.
    }
    await deps.sleep(Math.min(250, remainingMs(deadline, deps.now)));
  }
  throw new Error("prior runner did not prove stopped heartbeat and dead PID");
}

async function waitPortClosed(deadline, deps) {
  while (remainingMs(deadline, deps.now) > 0) {
    const probeTimeoutMs = Math.min(500, remainingMs(deadline, deps.now));
    if (!(await deps.portOpen("127.0.0.1", 8000, probeTimeoutMs))) return;
    await deps.sleep(Math.min(250, remainingMs(deadline, deps.now)));
  }
  throw new Error("127.0.0.1:8000 remained open inside the bounded stop window");
}

async function verifiedRunnerCommand(record, command, deadline, deps) {
  const timeoutMs = Math.min(35_000, remainingMs(deadline, deps.now));
  if (timeoutMs <= 0) return false;
  const result = await deps.command(
    record.executables.node.path,
    [
      resolve(record.repositoryPath, "apps/narrative-runner/scripts/run-verified-runner.mjs"),
      "--record",
      record.activationRecordPath,
      "--command",
      command
    ],
    { timeoutMs }
  );
  return result.status === 0;
}

async function waitRunnerReady(record, command, deadline, deps) {
  while (remainingMs(deadline, deps.now) > 0) {
    if (await verifiedRunnerCommand(record, command, deadline, deps)) return;
    await deps.sleep(Math.min(3_000, remainingMs(deadline, deps.now)));
  }
  throw new Error(`runner ${command} did not become healthy inside 120 seconds`);
}

async function readActivationRecord(recordPath, deps) {
  const record = JSON.parse(await deps.readFile(recordPath, "utf8"));
  return { ...record, activationRecordPath: resolve(recordPath) };
}

async function bootstrap(label, plistPath, domain, deps) {
  for (const [command, args] of [
    ["bootstrap", [domain, plistPath]],
    ["kickstart", [`${domain}/${label}`]]
  ]) {
    const result = await deps.command("/bin/launchctl", [command, ...args], {
      timeoutMs: COMMAND_TIMEOUT_MS
    });
    if (result.status !== 0) throw new Error(`launchctl ${command} failed for ${label}`);
  }
}

export async function activateLaunchAgents(
  { recordPath, priorRecordPath = null, environment = process.env },
  overrides = {}
) {
  const deps = dependencies(overrides);
  if (!Number.isInteger(deps.uid) || deps.uid < 0) {
    throw new Error("a numeric per-user UID is required for LaunchAgent activation");
  }
  const domain = `gui/${deps.uid}`;
  await deps.verify(recordPath, { requireInstalled: false });
  const target = await readActivationRecord(recordPath, deps);

  const runnerLoaded = await labelLoaded(
    RUNNER_LABEL,
    domain,
    deps.now() + COMMAND_TIMEOUT_MS,
    deps
  );
  const omlxLoaded = await labelLoaded(
    OMLX_LABEL,
    domain,
    deps.now() + COMMAND_TIMEOUT_MS,
    deps
  );
  if (runnerLoaded && omlxLoaded) {
    try {
      await deps.verify(recordPath, { requireInstalled: true });
      const attestationDeadline = deps.now() + COMMAND_TIMEOUT_MS;
      await assertLoadedJobPath(
        RUNNER_LABEL,
        target.launchAgents.narrativeRunner.path,
        domain,
        attestationDeadline,
        deps
      );
      await assertLoadedJobPath(
        OMLX_LABEL,
        target.launchAgents.omlxServer.path,
        domain,
        attestationDeadline,
        deps
      );
      const readinessDeadline = deps.now() + READINESS_TIMEOUT_MS;
      await waitRunnerReady(target, "status", readinessDeadline, deps);
      return { status: "ok", releaseSha: target.releaseSha, changed: false };
    } catch {
      // A different or unhealthy loaded activation must take the bounded
      // replacement path with an explicit rollback record.
    }
  }
  if ((runnerLoaded || omlxLoaded) && !priorRecordPath) {
    throw new Error("priorRecordPath is required before replacing a loaded activation");
  }

  let prior = null;
  if (priorRecordPath) {
    await deps.verify(priorRecordPath, { requireInstalled: true });
    prior = await readActivationRecord(priorRecordPath, deps);
    const attestationDeadline = deps.now() + COMMAND_TIMEOUT_MS;
    if (runnerLoaded) {
      await assertLoadedJobPath(
        RUNNER_LABEL,
        prior.launchAgents.narrativeRunner.path,
        domain,
        attestationDeadline,
        deps
      );
    }
    if (omlxLoaded) {
      await assertLoadedJobPath(
        OMLX_LABEL,
        prior.launchAgents.omlxServer.path,
        domain,
        attestationDeadline,
        deps
      );
    }
  }

  const runnerDeadline = deps.now() + RUNNER_DRAIN_TIMEOUT_MS;
  const stoppedRunner = await bootout(RUNNER_LABEL, domain, runnerDeadline, deps);
  if (stoppedRunner) {
    if (!prior) throw new Error("prior activation is required to prove runner drain");
    await waitPriorRunnerStopped(prior, runnerDeadline, deps);
  }
  const modelDeadline = deps.now() + OMLX_STOP_TIMEOUT_MS;
  await bootout(OMLX_LABEL, domain, modelDeadline, deps);
  await waitPortClosed(modelDeadline, deps);

  await deps.install(recordPath, { environment, allowReplace: true });
  await bootstrap(OMLX_LABEL, target.launchAgents.omlxServer.path, domain, deps);
  await waitRunnerReady(target, "check", deps.now() + READINESS_TIMEOUT_MS, deps);
  await bootstrap(RUNNER_LABEL, target.launchAgents.narrativeRunner.path, domain, deps);
  await waitRunnerReady(target, "status", deps.now() + READINESS_TIMEOUT_MS, deps);
  return { status: "ok", releaseSha: target.releaseSha, changed: true };
}

function parseCli(argv) {
  const command = argv[0];
  if (!["activate", "rollback"].includes(command)) {
    throw new Error(
      "usage: manage-launch-agents.mjs <activate|rollback> --record <activation-record> [--prior-record <activation-record>]"
    );
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--record", "--prior-record"].includes(flag)) {
      throw new Error("invalid LaunchAgent management argument");
    }
    values[flag] = value;
  }
  if (!values["--record"]) throw new Error("--record is required");
  if (command === "rollback" && !values["--prior-record"]) {
    throw new Error("rollback requires --prior-record for the currently loaded activation");
  }
  return {
    recordPath: values["--record"],
    priorRecordPath: values["--prior-record"] ?? null
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await activateLaunchAgents(parseCli(process.argv.slice(2)))));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "LaunchAgent activation failed"}\n`
    );
    process.exitCode = 1;
  }
}
