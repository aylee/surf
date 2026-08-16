#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyLaunchActivation } from "./render-launch-agents.mjs";

// The runner plist is the commit marker: the bounded controller reaches it
// only after both services have drained and the target oMLX plist is installed.
const INSTALL_ORDER = Object.freeze(["omlxServer", "narrativeRunner"]);
const MAX_PLIST_BYTES = 1024 * 1024;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function readRecord(recordPath) {
  const canonicalRecordPath = resolve(recordPath);
  return {
    path: canonicalRecordPath,
    value: JSON.parse(await readFile(canonicalRecordPath, "utf8"))
  };
}

async function validateLaunchAgentDestinations(record, canonicalLaunchAgentsDir) {
  for (const name of INSTALL_ORDER) {
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
}

async function installedSnapshot(path) {
  let metadata;
  let canonical;
  let contents;
  try {
    [metadata, canonical, contents] = await Promise.all([
      lstat(path),
      realpath(path),
      readFile(path)
    ]);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error("persistent LaunchAgent destination is missing");
    }
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    canonical !== resolve(path) ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size !== contents.byteLength ||
    contents.byteLength > MAX_PLIST_BYTES
  ) {
    throw new Error(
      "persistent LaunchAgent destination must be a bounded canonical non-symlink mode-0600 regular file"
    );
  }
  return { contents, sha256: sha256(contents) };
}

async function writeAtomicPrivate(path, contents, acceptedExistingSha256) {
  try {
    const [metadata, canonical, existing] = await Promise.all([
      lstat(path),
      realpath(path),
      readFile(path)
    ]);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      canonical !== resolve(path) ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size !== existing.byteLength ||
      existing.byteLength > MAX_PLIST_BYTES
    ) {
      throw new Error(
        "persistent LaunchAgent destination must remain a bounded canonical non-symlink mode-0600 regular file"
      );
    }
    if (existing.equals(contents)) {
      return false;
    }
    const existingSha256 = sha256(existing);
    if (!acceptedExistingSha256.has(existingSha256)) {
      throw new Error(
        "persistent LaunchAgent bytes are not owned by the verified prior or target activation"
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
  return true;
}

export async function inspectInstalledLaunchAgents(
  { targetRecordPath, priorRecordPath },
  { environment = process.env } = {}
) {
  const targetRecord = await readRecord(targetRecordPath);
  const priorRecord = await readRecord(priorRecordPath);
  if (
    targetRecord.value.schemaVersion !== 4 ||
    ![3, 4].includes(priorRecord.value.schemaVersion)
  ) {
    throw new Error("mixed LaunchAgent recovery requires a v4 target and verified v3/v4 prior");
  }
  await verifyLaunchActivation(targetRecord.path, {
    requireInstalled: false,
    allowLegacyV3: false
  });
  await verifyLaunchActivation(priorRecord.path, {
    requireInstalled: false,
    allowLegacyV3: true
  });
  const launchAgentsDir = resolve(
    environment.HOME?.trim() || homedir(),
    "Library/LaunchAgents"
  );
  const canonicalLaunchAgentsDir = await realpath(launchAgentsDir);
  await validateLaunchAgentDestinations(targetRecord.value, canonicalLaunchAgentsDir);
  await validateLaunchAgentDestinations(priorRecord.value, canonicalLaunchAgentsDir);

  const launchAgents = {};
  for (const name of INSTALL_ORDER) {
    const target = targetRecord.value.launchAgents[name];
    const prior = priorRecord.value.launchAgents[name];
    if (target.path !== prior.path || target.sha256 === prior.sha256) {
      throw new Error(
        `prior and target ${name} records do not define distinct bytes at one persistent path`
      );
    }
    const installed = await installedSnapshot(target.path);
    if (installed.sha256 === target.sha256) launchAgents[name] = "target";
    else if (installed.sha256 === prior.sha256) launchAgents[name] = "prior";
    else {
      throw new Error(
        `installed ${name} bytes match neither the verified prior nor target activation`
      );
    }
  }
  return Object.freeze({
    status: "ok",
    launchAgents: Object.freeze(launchAgents)
  });
}

export async function installLaunchAgents(
  recordPath,
  {
    environment = process.env,
    allowReplace = false,
    allowLegacyV3 = false,
    priorRecordPath = null
  } = {},
  overrides = {}
) {
  const targetRecord = await readRecord(recordPath);
  const canonicalRecordPath = targetRecord.path;
  await verifyLaunchActivation(canonicalRecordPath, {
    requireInstalled: false,
    allowLegacyV3
  });
  const record = targetRecord.value;
  const launchAgentsDir = resolve(
    environment.HOME?.trim() || homedir(),
    "Library/LaunchAgents"
  );
  await mkdir(launchAgentsDir, { recursive: true });
  const canonicalLaunchAgentsDir = await realpath(launchAgentsDir);
  await validateLaunchAgentDestinations(record, canonicalLaunchAgentsDir);

  let prior = null;
  if (priorRecordPath !== null) {
    const priorRecord = await readRecord(priorRecordPath);
    await verifyLaunchActivation(priorRecord.path, {
      requireInstalled: false,
      allowLegacyV3: true
    });
    prior = priorRecord.value;
    await validateLaunchAgentDestinations(prior, canonicalLaunchAgentsDir);
  }
  if (allowReplace && prior === null) {
    throw new Error("bounded LaunchAgent replacement requires a verified prior record");
  }

  for (const name of INSTALL_ORDER) {
    const source = record.renderedLaunchAgents[name];
    const target = record.launchAgents[name];
    const contents = await readFile(source.path);
    if (sha256(contents) !== source.sha256) {
      throw new Error(`rendered ${name} differs from the activation record`);
    }
    const acceptedExistingSha256 = new Set([target.sha256]);
    if (allowReplace) {
      const priorTarget = prior?.launchAgents?.[name];
      if (!priorTarget || priorTarget.path !== target.path) {
        throw new Error(`verified prior record does not own the persistent ${name} path`);
      }
      acceptedExistingSha256.add(priorTarget.sha256);
    }
    const changed = await writeAtomicPrivate(
      target.path,
      contents,
      acceptedExistingSha256
    );
    if (changed && overrides.afterInstall) await overrides.afterInstall(name);
  }
  await verifyLaunchActivation(canonicalRecordPath, {
    requireInstalled: true,
    allowLegacyV3
  });
  return {
    status: "ok",
    releaseSha:
      record.schemaVersion === 4 ? record.source.revision : record.releaseSha,
    activationId: record.schemaVersion === 4 ? record.activationId : null,
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
