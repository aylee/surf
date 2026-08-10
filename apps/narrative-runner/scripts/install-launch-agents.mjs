#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyLaunchActivation } from "./render-launch-agents.mjs";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function writeAtomicPrivate(path, contents, allowReplace) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("persistent LaunchAgent destination must be a non-symlink regular file");
    }
    const existing = await readFile(path);
    if (existing.equals(contents)) {
      await chmod(path, 0o600);
      return;
    }
    if (!allowReplace) {
      throw new Error(
        "a different persistent LaunchAgent is installed; use the bounded activation controller"
      );
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }

  const temporary = resolve(
    dirname(path),
    `.${basename(path)}.install-${process.pid}-${Date.now()}`
  );
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  await chmod(path, 0o600);
}

export async function installLaunchAgents(
  recordPath,
  { environment = process.env, allowReplace = false } = {}
) {
  const canonicalRecordPath = resolve(recordPath);
  await verifyLaunchActivation(canonicalRecordPath, { requireInstalled: false });
  const record = JSON.parse(await readFile(canonicalRecordPath, "utf8"));
  const launchAgentsDir = resolve(
    environment.HOME?.trim() || homedir(),
    "Library/LaunchAgents"
  );
  await mkdir(launchAgentsDir, { recursive: true });
  const canonicalLaunchAgentsDir = await realpath(launchAgentsDir);
  for (const name of ["narrativeRunner", "omlxServer"]) {
    const source = record.renderedLaunchAgents?.[name];
    const target = record.launchAgents?.[name];
    if (
      !source ||
      !target ||
      dirname(target.path) !== canonicalLaunchAgentsDir ||
      basename(source.path) !== basename(target.path) ||
      source.sha256 !== target.sha256
    ) {
      throw new Error("activation record does not target the current user's LaunchAgents directory");
    }
  }

  for (const name of ["narrativeRunner", "omlxServer"]) {
    const source = record.renderedLaunchAgents[name];
    const target = record.launchAgents[name];
    const contents = await readFile(source.path);
    if (sha256(contents) !== source.sha256) {
      throw new Error(`rendered ${name} differs from the activation record`);
    }
    await writeAtomicPrivate(target.path, contents, allowReplace);
  }
  await verifyLaunchActivation(canonicalRecordPath, { requireInstalled: true });
  return {
    status: "ok",
    releaseSha: record.releaseSha,
    activationRecord: canonicalRecordPath,
    launchAgents: {
      narrativeRunner: record.launchAgents.narrativeRunner.path,
      omlxServer: record.launchAgents.omlxServer.path
    }
  };
}

function parseCli(argv) {
  if (argv.length !== 2 || !["--installRecord", "--verifyInstalledRecord"].includes(argv[0])) {
    throw new Error(
      "usage: install-launch-agents.mjs <--installRecord|--verifyInstalledRecord> <activation-record>"
    );
  }
  return { command: argv[0], recordPath: argv[1] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { command, recordPath } = parseCli(process.argv.slice(2));
    const result =
      command === "--installRecord"
        ? await installLaunchAgents(recordPath)
        : await verifyLaunchActivation(recordPath, { requireInstalled: true });
    console.log(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "LaunchAgent installation failed"}\n`
    );
    process.exitCode = 1;
  }
}
