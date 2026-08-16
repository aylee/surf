#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { link, open, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  inspectInstalledLaunchAgents,
  installLaunchAgents
} from "./install-launch-agents.mjs";
import { verifyLaunchActivation } from "./render-launch-agents.mjs";

const execFileAsync = promisify(execFile);
const RUNNER_LABEL = "ai.alex.narrative-runner";
const OMLX_LABEL = "ai.alex.omlx-server";
const COMMAND_TIMEOUT_MS = 10_000;
const RUNNER_DRAIN_TIMEOUT_MS = 960_000;
const OMLX_STOP_TIMEOUT_MS = 90_000;
const READINESS_TIMEOUT_MS = 120_000;
const HALTED_HEARTBEAT_MAX_AGE_MS = 300_000;
const MAX_PROTOCOL_FINGERPRINTS = 16;
const MAX_DRAIN_EVIDENCE_BYTES = 64 * 1024;
const DRAIN_INTENT_FILENAME = "runner-drain-intent.json";
const DRAIN_RECEIPT_FILENAME = "runner-drain-receipt.json";

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
    inspectInstalled: overrides.inspectInstalled ?? inspectInstalledLaunchAgents,
    verify: overrides.verify ?? verifyLaunchActivation,
    readFile: overrides.readFile ?? readFile,
    portOpen: overrides.portOpen ?? defaultPortOpen,
    pidAlive: overrides.pidAlive ?? pidAlive,
    afterDrainIntent: overrides.afterDrainIntent ?? null,
    afterDrainReceipt: overrides.afterDrainReceipt ?? null,
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

function launchctlValues(stdout) {
  return stdout.split("\n").map((line) => {
    const value = line.trim();
    const indexed = /^(?:\[[0-9]+\]|[0-9]+)\s*=\s*(.*)$/.exec(value);
    return indexed ? indexed[1].trim() : value;
  });
}

function distinctRecords(records) {
  return records.filter(
    (record, index) =>
      records.findIndex(
        (candidate) => candidate.activationRecordPath === record.activationRecordPath
      ) === index
  );
}

async function inspectLoadedJob(
  label,
  component,
  records,
  domain,
  deadline,
  deps
) {
  const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, remainingMs(deadline, deps.now));
  if (timeoutMs <= 0) throw new Error(`timed out while attesting ${label}`);
  const result = await deps.command(
    "/bin/launchctl",
    ["print", `${domain}/${label}`],
    { timeoutMs }
  );
  if (result.status !== 0) return Object.freeze({ loaded: false });
  const candidates = distinctRecords(records);
  const persistentPaths = new Set(
    candidates.map((record) => record.launchAgents?.[component]?.path)
  );
  if (
    persistentPaths.size !== 1 ||
    [...persistentPaths].some((path) => typeof path !== "string")
  ) {
    throw new Error(`${label} records disagree on the persistent plist path`);
  }
  const [expectedPath] = persistentPaths;
  const lines = launchctlValues(result.stdout);
  if (lines.filter((line) => line === `path = ${expectedPath}`).length !== 1) {
    throw new Error(`${label} is not loaded from the recorded persistent plist`);
  }
  const matchingRecords = candidates.filter(
    (record) =>
      lines.filter((line) => line === record.activationRecordPath).length === 1
  );
  const recordPathOccurrences = candidates.reduce(
    (count, record) =>
      count + lines.filter((line) => line === record.activationRecordPath).length,
    0
  );
  if (matchingRecords.length !== 1 || recordPathOccurrences !== 1) {
    throw new Error(`${label} does not expose exactly one verified activation record argument`);
  }
  const pids = lines
    .map((line) => /^pid = ([1-9][0-9]*)$/.exec(line)?.[1] ?? null)
    .filter((value) => value !== null)
    .map(Number)
    .filter(Number.isSafeInteger);
  if (pids.length !== 1) {
    throw new Error(`${label} does not expose exactly one positive loaded PID`);
  }
  return Object.freeze({ loaded: true, record: matchingRecords[0], pid: pids[0] });
}

async function waitLabelUnloaded(label, domain, deadline, deps) {
  while (remainingMs(deadline, deps.now) > 0) {
    if (!(await labelLoaded(label, domain, deadline, deps))) return;
    await deps.sleep(Math.min(250, remainingMs(deadline, deps.now)));
  }
  throw new Error(`${label} did not unload inside the bounded stop window`);
}

async function waitPidDead(label, pid, deadline, deps) {
  while (remainingMs(deadline, deps.now) > 0) {
    if (!deps.pidAlive(pid)) return;
    await deps.sleep(Math.min(250, remainingMs(deadline, deps.now)));
  }
  throw new Error(`${label} PID ${pid} remained alive inside the bounded stop window`);
}

async function bootoutExactJob(
  snapshot,
  label,
  component,
  records,
  domain,
  deadline,
  deps
) {
  if (!snapshot.loaded) return false;
  const current = await inspectLoadedJob(
    label,
    component,
    records,
    domain,
    deadline,
    deps
  );
  if (!current.loaded) {
    await waitPidDead(label, snapshot.pid, deadline, deps);
    return true;
  }
  if (
    current.record.activationRecordPath !== snapshot.record.activationRecordPath ||
    current.pid !== snapshot.pid
  ) {
    throw new Error(`${label} identity changed before bounded bootout`);
  }
  const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, remainingMs(deadline, deps.now));
  if (timeoutMs <= 0) throw new Error(`timed out before bootout of ${label}`);
  const result = await deps.command(
    "/bin/launchctl",
    ["bootout", `${domain}/${label}`],
    { timeoutMs }
  );
  if (result.status !== 0) throw new Error(`launchctl bootout failed for ${label}`);
  await waitLabelUnloaded(label, domain, deadline, deps);
  await waitPidDead(label, snapshot.pid, deadline, deps);
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

function recordReleaseSha(record) {
  return record.schemaVersion === 4 ? record.source.revision : record.releaseSha;
}

function recordStatusFile(record) {
  return record.schemaVersion === 4 ? record.runtime.statusFile : record.statusFile;
}

function recordProtocols(record) {
  return record.schemaVersion === 4 && Array.isArray(record.acceptedProtocols)
    ? record.acceptedProtocols.map(({ fingerprint }) => fingerprint)
    : [];
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function exactTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} timestamp is invalid`);
  }
}

function drainEvidencePaths(target) {
  const root = dirname(target.activationRecordPath);
  return Object.freeze({
    intent: resolve(root, DRAIN_INTENT_FILENAME),
    receipt: resolve(root, DRAIN_RECEIPT_FILENAME)
  });
}

async function readPrivateJson(path, label) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size < 2n ||
      before.size > BigInt(MAX_DRAIN_EVIDENCE_BYTES)
    ) {
      throw new Error(`${label} must be a bounded mode-0600 regular file`);
    }
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(contents.byteLength) !== before.size
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    try {
      return JSON.parse(contents.toString("utf8"));
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  } finally {
    await handle.close();
  }
}

async function writeImmutablePrivateJson(path, value, label) {
  const contents = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (contents.byteLength > MAX_DRAIN_EVIDENCE_BYTES) {
    throw new Error(`${label} exceeds its bounded size`);
  }
  const existing = await readPrivateJson(path, label);
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error(`${label} already contains different immutable evidence`);
    }
    return;
  }
  const temporary = resolve(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, path);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        throw error;
      }
      const raced = await readPrivateJson(path, label);
      if (JSON.stringify(raced) !== JSON.stringify(value)) {
        throw new Error(`${label} already contains different immutable evidence`);
      }
    }
    const directory = await open(dirname(path), fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

function createDrainIntent(target, prior, priorPid, labelInitiallyLoaded, nowMs) {
  if (!Number.isSafeInteger(priorPid) || priorPid < 1) {
    throw new Error("prior activation is missing its attested runner PID");
  }
  return Object.freeze({
    schemaVersion: 1,
    targetActivationId: target.activationId,
    targetReleaseSha: recordReleaseSha(target),
    priorActivationId: prior.schemaVersion === 4 ? prior.activationId : null,
    priorReleaseSha: recordReleaseSha(prior),
    priorPid,
    runnerLabelInitiallyLoaded: labelInitiallyLoaded,
    observedAt: new Date(nowMs).toISOString()
  });
}

function validateDrainIntent(value, target, prior) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "targetActivationId",
      "targetReleaseSha",
      "priorActivationId",
      "priorReleaseSha",
      "priorPid",
      "runnerLabelInitiallyLoaded",
      "observedAt"
    ],
    "Runner drain intent"
  );
  if (
    value.schemaVersion !== 1 ||
    value.targetActivationId !== target.activationId ||
    value.targetReleaseSha !== recordReleaseSha(target) ||
    value.priorActivationId !==
      (prior.schemaVersion === 4 ? prior.activationId : null) ||
    value.priorReleaseSha !== recordReleaseSha(prior) ||
    !Number.isSafeInteger(value.priorPid) ||
    value.priorPid < 1 ||
    typeof value.runnerLabelInitiallyLoaded !== "boolean"
  ) {
    throw new Error("Runner drain intent does not match the exact transition");
  }
  exactTimestamp(value.observedAt, "Runner drain intent");
  return Object.freeze({ ...value });
}

function validateDrainReceipt(value, intent, prior) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "priorActivationId",
      "priorReleaseSha",
      "priorPid",
      "outcome",
      "heartbeatUpdatedAt",
      "observedAt",
      "acceptedProtocolFingerprints",
      "runnerLabelInitiallyLoaded",
      "runnerLabelUnloaded",
      "maxWaitMs"
    ],
    "Runner drain receipt"
  );
  const expectedProtocols =
    prior.schemaVersion === 4 ? [...recordProtocols(prior)].sort() : [];
  if (
    value.schemaVersion !== 1 ||
    value.priorActivationId !== intent.priorActivationId ||
    value.priorReleaseSha !== intent.priorReleaseSha ||
    value.priorPid !== intent.priorPid ||
    !["stopped", "compatible-halted"].includes(value.outcome) ||
    JSON.stringify(value.acceptedProtocolFingerprints) !==
      JSON.stringify(expectedProtocols) ||
    value.runnerLabelInitiallyLoaded !== intent.runnerLabelInitiallyLoaded ||
    value.runnerLabelUnloaded !== true ||
    value.maxWaitMs !== RUNNER_DRAIN_TIMEOUT_MS
  ) {
    throw new Error("Runner drain receipt does not match its immutable intent");
  }
  exactTimestamp(value.heartbeatUpdatedAt, "Runner drain receipt heartbeat");
  exactTimestamp(value.observedAt, "Runner drain receipt observation");
  return Object.freeze({
    ...value,
    acceptedProtocolFingerprints: Object.freeze([
      ...value.acceptedProtocolFingerprints
    ])
  });
}

async function readDrainEvidence(target, prior) {
  const paths = drainEvidencePaths(target);
  const intentValue = await readPrivateJson(paths.intent, "Runner drain intent");
  const receiptValue = await readPrivateJson(paths.receipt, "Runner drain receipt");
  if (receiptValue !== null && intentValue === null) {
    throw new Error("Runner drain receipt exists without its immutable intent");
  }
  const intent =
    intentValue === null ? null : validateDrainIntent(intentValue, target, prior);
  const receipt =
    receiptValue === null
      ? null
      : validateDrainReceipt(receiptValue, intent, prior);
  return Object.freeze({ paths, intent, receipt });
}

function boundedProtocolSet(values) {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > MAX_PROTOCOL_FINGERPRINTS ||
    values.some((value) => typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) ||
    new Set(values).size !== values.length
  ) {
    return null;
  }
  return new Set(values);
}

function exactProtocolSet(left, right) {
  const leftSet = boundedProtocolSet(left);
  const rightSet = boundedProtocolSet(right);
  return Boolean(
    leftSet &&
      rightSet &&
      leftSet.size === rightSet.size &&
      [...leftSet].every((fingerprint) => rightSet.has(fingerprint))
  );
}

function heartbeatMatchesV4Record(heartbeat, record) {
  return Boolean(
    record.schemaVersion === 4 &&
      heartbeat?.schemaVersion === 3 &&
      heartbeat.activationId === record.activationId &&
      heartbeat.runnerArtifactSha256 === record.runnerArtifact.sha256 &&
      heartbeat.sourceRevision === record.source.revision &&
      exactProtocolSet(
        heartbeat.acceptedProtocolFingerprints,
        recordProtocols(record)
      )
  );
}

function heartbeatMatchesLegacyRecord(heartbeat, record) {
  return Boolean(
    record.schemaVersion === 3 &&
      heartbeat?.schemaVersion === 2 &&
      heartbeat.releaseSha === record.releaseSha &&
      heartbeat.modelId === record.modelId
  );
}

function heartbeatTimestamp(heartbeat) {
  if (typeof heartbeat?.updatedAt !== "string" || heartbeat.updatedAt.length > 40) {
    return null;
  }
  const timestamp = Date.parse(heartbeat.updatedAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === heartbeat.updatedAt
    ? timestamp
    : null;
}

function heartbeatIsFresh(heartbeat, nowMs) {
  const timestamp = heartbeatTimestamp(heartbeat);
  return Boolean(
    Number.isFinite(nowMs) &&
      timestamp !== null &&
      timestamp <= nowMs &&
      nowMs - timestamp <= HALTED_HEARTBEAT_MAX_AGE_MS
  );
}

function heartbeatMatchesRecord(heartbeat, record) {
  return record.schemaVersion === 4
    ? heartbeatMatchesV4Record(heartbeat, record)
    : heartbeatMatchesLegacyRecord(heartbeat, record);
}

export function canRecoverHaltedRunner({
  priorRecord,
  targetRecord,
  heartbeat,
  labelUnloaded,
  priorPid,
  pidAlive: heartbeatPidAlive,
  nowMs
}) {
  if (
    !labelUnloaded ||
    heartbeatPidAlive ||
    !Number.isSafeInteger(priorPid) ||
    priorPid < 1 ||
    priorRecord?.schemaVersion !== 4 ||
    targetRecord?.schemaVersion !== 4 ||
    heartbeat?.state !== "halted" ||
    heartbeat.inFlight !== 0 ||
    heartbeat.pid !== priorPid ||
    !heartbeatIsFresh(heartbeat, nowMs) ||
    !heartbeatMatchesV4Record(heartbeat, priorRecord)
  ) {
    return false;
  }
  return exactProtocolSet(recordProtocols(priorRecord), recordProtocols(targetRecord));
}

async function readPriorRunnerHeartbeat(record, deps) {
  let heartbeat;
  try {
    heartbeat = JSON.parse(await deps.readFile(recordStatusFile(record), "utf8"));
  } catch {
    throw new Error("prior runner heartbeat is required to bind its PID before replacement");
  }
  if (
    !Number.isSafeInteger(heartbeat?.pid) ||
    heartbeat.pid < 1 ||
    !heartbeatMatchesRecord(heartbeat, record)
  ) {
    throw new Error("prior runner heartbeat does not match the verified activation record");
  }
  return heartbeat;
}

function drainReceipt(record, heartbeat, labelInitiallyLoaded, nowMs) {
  const heartbeatUpdatedAt = heartbeatTimestamp(heartbeat);
  if (heartbeatUpdatedAt === null) {
    throw new Error("prior runner drain heartbeat timestamp is invalid");
  }
  const protocolFingerprints =
    record.schemaVersion === 4 ? [...recordProtocols(record)].sort() : [];
  if (
    record.schemaVersion === 4 &&
    boundedProtocolSet(protocolFingerprints) === null
  ) {
    throw new Error("prior runner drain protocol evidence is not bounded");
  }
  return Object.freeze({
    schemaVersion: 1,
    priorActivationId: record.schemaVersion === 4 ? record.activationId : null,
    priorReleaseSha: recordReleaseSha(record),
    priorPid: heartbeat.pid,
    outcome: heartbeat.state === "halted" ? "compatible-halted" : "stopped",
    heartbeatUpdatedAt: heartbeat.updatedAt,
    observedAt: new Date(nowMs).toISOString(),
    acceptedProtocolFingerprints: Object.freeze(protocolFingerprints),
    runnerLabelInitiallyLoaded: labelInitiallyLoaded,
    runnerLabelUnloaded: true,
    maxWaitMs: RUNNER_DRAIN_TIMEOUT_MS
  });
}

async function waitPriorRunnerStopped(
  record,
  target,
  priorPid,
  labelInitiallyLoaded,
  deadline,
  deps
) {
  while (remainingMs(deadline, deps.now) > 0) {
    try {
      const heartbeat = JSON.parse(await deps.readFile(recordStatusFile(record), "utf8"));
      const heartbeatPidAlive =
        heartbeat?.pid === priorPid
          ? deps.pidAlive(priorPid)
          : true;
      if (
        heartbeat?.state === "stopped" &&
        heartbeat.inFlight === 0 &&
        heartbeat.pid === priorPid &&
        !heartbeatPidAlive &&
        heartbeatIsFresh(heartbeat, deps.now()) &&
        heartbeatMatchesRecord(heartbeat, record)
      ) {
        return drainReceipt(record, heartbeat, labelInitiallyLoaded, deps.now());
      }
      if (heartbeat?.state === "halted" && heartbeat.pid !== priorPid) {
        throw new Error(
          "halted runner recovery rejected a heartbeat PID that differs from the attested loaded PID"
        );
      }
      if (heartbeat?.state === "halted" && !heartbeatPidAlive) {
        if (
          canRecoverHaltedRunner({
            priorRecord: record,
            targetRecord: target,
            heartbeat,
            labelUnloaded: true,
            priorPid,
            pidAlive: heartbeatPidAlive,
            nowMs: deps.now()
          })
        ) {
          return drainReceipt(record, heartbeat, labelInitiallyLoaded, deps.now());
        }
        throw new Error(
          "halted runner recovery requires fresh matching v4 evidence, exact protocol-set equality, zero in-flight work, an unloaded label, and the attested dead PID"
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("halted runner recovery")) {
        throw error;
      }
      // A missing or partial heartbeat is not drain proof.
    }
    await deps.sleep(Math.min(250, remainingMs(deadline, deps.now)));
  }
  throw new Error("prior runner did not prove a matching stopped heartbeat and dead PID");
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
      record.executables.runnerGuard.path,
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

function sameActivation(left, right) {
  return Boolean(
    left &&
      right &&
      left.activationRecordPath === right.activationRecordPath
  );
}

async function verifiesInstalled(recordPath, allowLegacyV3, deps) {
  try {
    await deps.verify(recordPath, { requireInstalled: true, allowLegacyV3 });
    return true;
  } catch {
    return false;
  }
}

async function installationState({ target, prior, environment, allowLegacyTarget }, deps) {
  if (
    await verifiesInstalled(
      target.activationRecordPath,
      allowLegacyTarget,
      deps
    )
  ) {
    return Object.freeze({ narrativeRunner: "target", omlxServer: "target" });
  }
  if (!prior) return null;
  if (
    !sameActivation(target, prior) &&
    (await verifiesInstalled(prior.activationRecordPath, true, deps))
  ) {
    return Object.freeze({ narrativeRunner: "prior", omlxServer: "prior" });
  }
  if (
    sameActivation(target, prior) ||
    target.schemaVersion !== 4 ||
    ![3, 4].includes(prior.schemaVersion)
  ) {
    throw new Error(
      "installed LaunchAgents do not exactly match the verified target or prior activation"
    );
  }
  const inspected = await deps.inspectInstalled(
    {
      targetRecordPath: target.activationRecordPath,
      priorRecordPath: prior.activationRecordPath
    },
    { environment }
  );
  const state = inspected?.launchAgents;
  if (
    !state ||
    !["prior", "target"].includes(state.narrativeRunner) ||
    !["prior", "target"].includes(state.omlxServer)
  ) {
    throw new Error("LaunchAgent installation inspection returned an invalid state");
  }
  return Object.freeze({
    narrativeRunner: state.narrativeRunner,
    omlxServer: state.omlxServer
  });
}

async function attestTargetBootstrap(label, component, target, domain, deps) {
  const loaded = await inspectLoadedJob(
    label,
    component,
    [target],
    domain,
    deps.now() + COMMAND_TIMEOUT_MS,
    deps
  );
  if (!loaded.loaded || !sameActivation(loaded.record, target)) {
    throw new Error(`${label} did not load the exact target activation`);
  }
  return loaded;
}

async function startOrCheckTarget({ target, runner, omlx, domain }, deps) {
  let changed = false;
  if (!omlx.loaded) {
    await bootstrap(OMLX_LABEL, target.launchAgents.omlxServer.path, domain, deps);
    omlx = await attestTargetBootstrap(OMLX_LABEL, "omlxServer", target, domain, deps);
    changed = true;
  } else if (!sameActivation(omlx.record, target)) {
    throw new Error("cannot start the target while a non-target oMLX label remains loaded");
  }
  await waitRunnerReady(target, "check", deps.now() + READINESS_TIMEOUT_MS, deps);

  if (!runner.loaded) {
    await bootstrap(
      RUNNER_LABEL,
      target.launchAgents.narrativeRunner.path,
      domain,
      deps
    );
    runner = await attestTargetBootstrap(
      RUNNER_LABEL,
      "narrativeRunner",
      target,
      domain,
      deps
    );
    changed = true;
  } else if (!sameActivation(runner.record, target)) {
    throw new Error("cannot wait for target readiness while a non-target runner remains loaded");
  }
  await waitRunnerReady(target, "status", deps.now() + READINESS_TIMEOUT_MS, deps);
  return changed;
}

export async function activateLaunchAgents(
  {
    recordPath,
    priorRecordPath = null,
    environment = process.env,
    transitionMode = "activate"
  },
  overrides = {}
) {
  const deps = dependencies(overrides);
  if (!Number.isInteger(deps.uid) || deps.uid < 0) {
    throw new Error("a numeric per-user UID is required for LaunchAgent activation");
  }
  const domain = `gui/${deps.uid}`;
  const allowLegacyTarget = transitionMode === "rollback";
  await deps.verify(recordPath, {
    requireInstalled: false,
    allowLegacyV3: allowLegacyTarget
  });
  const target = await readActivationRecord(recordPath, deps);
  if (target.schemaVersion === 3 && !allowLegacyTarget) {
    throw new Error("legacy v3 activation records are targets only for explicit rollback");
  }

  let prior = null;
  if (priorRecordPath) {
    await deps.verify(priorRecordPath, {
      requireInstalled: false,
      allowLegacyV3: true
    });
    prior = await readActivationRecord(priorRecordPath, deps);
  }

  const records = distinctRecords([target, ...(prior ? [prior] : [])]);
  const attestationDeadline = deps.now() + COMMAND_TIMEOUT_MS;
  let runner = await inspectLoadedJob(
    RUNNER_LABEL,
    "narrativeRunner",
    records,
    domain,
    attestationDeadline,
    deps
  );
  let omlx = await inspectLoadedJob(
    OMLX_LABEL,
    "omlxServer",
    records,
    domain,
    attestationDeadline,
    deps
  );
  const installed = await installationState(
    { target, prior, environment, allowLegacyTarget },
    deps
  );

  if (installed === null) {
    if (runner.loaded || omlx.loaded) {
      throw new Error("priorRecordPath is required before replacing a loaded activation");
    }
    const modelDeadline = deps.now() + OMLX_STOP_TIMEOUT_MS;
    await waitPortClosed(modelDeadline, deps);
    await deps.install(recordPath, {
      environment,
      allowReplace: false,
      allowLegacyV3: allowLegacyTarget,
      priorRecordPath: null
    });
    await startOrCheckTarget({ target, runner, omlx, domain }, deps);
    return {
      status: "ok",
      releaseSha: recordReleaseSha(target),
      activationId: target.activationId ?? null,
      changed: true,
      drainReceipt: null
    };
  }

  const targetCommitted =
    installed.narrativeRunner === "target" && installed.omlxServer === "target";
  // The only resumable pre-commit state has the target oMLX plist and prior
  // runner plist. A target runner plist proves the bounded installer reached
  // its final commit write after the prior drain.
  const validPrecommit =
    installed.narrativeRunner === "prior" &&
    ["prior", "target"].includes(installed.omlxServer);
  if (!targetCommitted && !validPrecommit) {
    throw new Error(
      "mixed LaunchAgent state violates the oMLX-first, runner-last commit order"
    );
  }
  if (validPrecommit && runner.loaded && !sameActivation(runner.record, prior)) {
    throw new Error("pre-commit runner label is not the exact verified prior activation");
  }
  if (
    targetCommitted &&
    runner.loaded &&
    sameActivation(runner.record, target) &&
    omlx.loaded &&
    !sameActivation(omlx.record, target)
  ) {
    throw new Error("target runner is loaded beside a non-target oMLX activation");
  }

  const priorIsDistinct = prior && !sameActivation(prior, target);
  const persistedDrain = priorIsDistinct
    ? await readDrainEvidence(target, prior)
    : null;
  let receipt = persistedDrain?.receipt ?? null;
  if (targetCommitted && priorIsDistinct && receipt === null) {
    throw new Error(
      "target runner commit lacks the durable prior drain receipt"
    );
  }
  const priorRunnerLoaded =
    priorIsDistinct && runner.loaded && sameActivation(runner.record, prior);
  const requiresPriorDrain = Boolean(
    priorIsDistinct && receipt === null && (validPrecommit || priorRunnerLoaded)
  );
  if (requiresPriorDrain) {
    let intent = persistedDrain.intent;
    if (intent === null) {
      if (priorRunnerLoaded) {
        intent = createDrainIntent(target, prior, runner.pid, true, deps.now());
      } else {
        const heartbeat = await readPriorRunnerHeartbeat(prior, deps);
        const heartbeatPidAlive = deps.pidAlive(heartbeat.pid);
        const stoppedSafe = Boolean(
          heartbeat.state === "stopped" &&
            heartbeat.inFlight === 0 &&
            !heartbeatPidAlive &&
            heartbeatIsFresh(heartbeat, deps.now())
        );
        const haltedSafe = canRecoverHaltedRunner({
          priorRecord: prior,
          targetRecord: target,
          heartbeat,
          labelUnloaded: true,
          priorPid: heartbeat.pid,
          pidAlive: heartbeatPidAlive,
          nowMs: deps.now()
        });
        if (!stoppedSafe && !haltedSafe) {
          throw new Error(
            "already-unloaded prior runner lacks a fresh matching stopped heartbeat and dead PID or compatible-halted evidence"
          );
        }
        intent = createDrainIntent(
          target,
          prior,
          heartbeat.pid,
          false,
          deps.now()
        );
      }
      await writeImmutablePrivateJson(
        persistedDrain.paths.intent,
        intent,
        "Runner drain intent"
      );
      if (deps.afterDrainIntent) await deps.afterDrainIntent(intent);
    } else if (
      priorRunnerLoaded &&
      (!intent.runnerLabelInitiallyLoaded || intent.priorPid !== runner.pid)
    ) {
      throw new Error(
        "loaded prior runner differs from the durable pre-bootout intent"
      );
    }
    const priorPid = intent.priorPid;
    const runnerDeadline = deps.now() + RUNNER_DRAIN_TIMEOUT_MS;
    if (priorRunnerLoaded) {
      await bootoutExactJob(
        runner,
        RUNNER_LABEL,
        "narrativeRunner",
        records,
        domain,
        runnerDeadline,
        deps
      );
      runner = Object.freeze({ loaded: false });
    }
    await waitLabelUnloaded(RUNNER_LABEL, domain, runnerDeadline, deps);
    if (!Number.isSafeInteger(priorPid) || priorPid < 1) {
      throw new Error("prior activation is missing its attested runner PID");
    }
    receipt = await waitPriorRunnerStopped(
      prior,
      target,
      priorPid,
      priorRunnerLoaded,
      runnerDeadline,
      deps
    );
    await writeImmutablePrivateJson(
      persistedDrain.paths.receipt,
      receipt,
      "Runner drain receipt"
    );
    if (deps.afterDrainReceipt) await deps.afterDrainReceipt(receipt);
  }

  let changed = false;
  const mustStopOmlx =
    validPrecommit ||
    priorRunnerLoaded ||
    (omlx.loaded && !sameActivation(omlx.record, target));
  if (mustStopOmlx) {
    const modelDeadline = deps.now() + OMLX_STOP_TIMEOUT_MS;
    await bootoutExactJob(
      omlx,
      OMLX_LABEL,
      "omlxServer",
      records,
      domain,
      modelDeadline,
      deps
    );
    await waitPortClosed(modelDeadline, deps);
    omlx = Object.freeze({ loaded: false });
    changed = true;
  }

  if (validPrecommit) {
    if (runner.loaded || omlx.loaded) {
      throw new Error("mixed LaunchAgents may be completed only after both labels unload");
    }
    await deps.install(recordPath, {
      environment,
      allowReplace: true,
      allowLegacyV3: allowLegacyTarget,
      priorRecordPath: prior.activationRecordPath
    });
    changed = true;
  }

  changed =
    (await startOrCheckTarget({ target, runner, omlx, domain }, deps)) || changed;
  return {
    status: "ok",
    releaseSha: recordReleaseSha(target),
    activationId: target.activationId ?? null,
    changed,
    drainReceipt: receipt
  };
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
    priorRecordPath: values["--prior-record"] ?? null,
    transitionMode: command
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
