#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertSupportedRunnerEnvironment,
  readStrictDotenvFile
} from "../../../scripts/lib/strict-env-file.mjs";
import { verifyLaunchActivation } from "./render-launch-agents.mjs";

function parseArgs(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--record" ||
    argv[2] !== "--command" ||
    !["run", "once", "check", "status"].includes(argv[3])
  ) {
    throw new Error(
      "usage: run-verified-runner.mjs --record <activation-record> --command <run|once|check|status>"
    );
  }
  return { recordPath: resolve(argv[1]), command: argv[3] };
}

function sanitizedEnvironment(values, record) {
  assertSupportedRunnerEnvironment(values);
  const environment = {
    HOME: dirname(dirname(dirname(record.launchAgents.narrativeRunner.path))),
    LANG: "en_US.UTF-8",
    PATH: `${dirname(record.executables.node.path)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: "/tmp"
  };
  for (const [name, value] of Object.entries(values)) {
    environment[name] = value;
  }
  environment.NARRATIVE_RUNNER_ACTIVATION_ID = record.activationId;
  environment.NARRATIVE_RUNNER_ARTIFACT_SHA256 = record.runnerArtifact.sha256;
  return environment;
}

export async function runVerifiedRunner(argv, dependencies = {}) {
  const { recordPath, command } = parseArgs(argv);
  const verify = dependencies.verify ?? verifyLaunchActivation;
  const spawnChild = dependencies.spawn ?? spawn;
  const recordBeforeVerification = await readFile(recordPath, "utf8");
  await verify(recordPath, { requireInstalled: true });
  const recordAfterVerification = await readFile(recordPath, "utf8");
  if (recordAfterVerification !== recordBeforeVerification) {
    throw new Error("activation record changed during launch verification");
  }
  const record = JSON.parse(recordAfterVerification);
  if (record.schemaVersion !== 4) {
    throw new Error("verified runner launches require an activation record v4 artifact");
  }
  const runnerEnvironment = readStrictDotenvFile(
    record.runtime.environmentPath,
    "Narrative runner environment file"
  );
  const child = spawnChild(
    record.executables.node.path,
    [
      record.runnerArtifact.path,
      command,
      "--expected-release-sha",
      record.source.revision
    ],
    {
      cwd: record.source.repositoryPath,
      env: sanitizedEnvironment(runnerEnvironment, record),
      stdio: "inherit"
    }
  );

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);
  process.once("SIGHUP", forward);
  const exit = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  process.removeListener("SIGTERM", forward);
  process.removeListener("SIGINT", forward);
  process.removeListener("SIGHUP", forward);
  if (exit.signal) return 128 + (exit.signal === "SIGTERM" ? 15 : 1);
  return exit.code ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runVerifiedRunner(process.argv.slice(2));
  } catch {
    // Activation failures are intentionally secret-free. Detailed verifier
    // errors belong in an operator-held manual verify invocation.
    process.stderr.write("runner activation verification failed\n");
    process.exitCode = 78;
  }
}
