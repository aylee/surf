import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NARRATIVE_PROTOCOL_FINGERPRINT } from "@surf/narrative-contracts";
import {
  activateLaunchAgents,
  canRecoverHaltedRunner,
  canRecoverStoppedChildRunner,
  inspectRunnerTransitionInstallState,
  verifyCommittedRunnerDrainEvidence
} from "../scripts/manage-launch-agents.mjs";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function sha256(contents: Uint8Array | string) {
  return createHash("sha256").update(contents).digest("hex");
}

function recordValue(
  root: string,
  fingerprints: string | readonly string[] = NARRATIVE_PROTOCOL_FINGERPRINT,
  revision = "a".repeat(40)
) {
  const values = typeof fingerprints === "string" ? [fingerprints] : fingerprints;
  const transitionRoot = ["prior", "target"].includes(basename(root))
    ? dirname(root)
    : root;
  return {
    schemaVersion: 4 as const,
    activationId: `${revision}-${root.endsWith("prior") ? "r0" : "r1"}`,
    source: { revision, repositoryPath: join(root, "release") },
    runnerArtifact: { path: join(root, "runner.mjs"), sha256: "b".repeat(64) },
    acceptedProtocols: values.map((fingerprint) => ({
      family: "surf.narrative",
      version: 1,
      fingerprint
    })),
    runtime: { statusFile: join(root, "status.json") },
    executables: {
      node: { path: "/pinned/node" },
      runnerGuard: { path: "/pinned/run-verified-runner.mjs" }
    },
    launchAgents: {
      narrativeRunner: {
        path: join(
          transitionRoot,
          "home/Library/LaunchAgents/ai.alex.narrative-runner.plist"
        )
      },
      omlxServer: {
        path: join(
          transitionRoot,
          "home/Library/LaunchAgents/ai.alex.omlx-server.plist"
        )
      }
    }
  };
}

async function activationRecord(
  root: string,
  fingerprints?: string | readonly string[],
  revision?: string
): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, "activation-record.json");
  await writeFile(path, `${JSON.stringify(recordValue(root, fingerprints, revision))}\n`, {
    mode: 0o600
  });
  return path;
}

function heartbeat(
  record: ReturnType<typeof recordValue>,
  state = "halted",
  options: { pid?: number; updatedAt?: string } = {}
) {
  return {
    schemaVersion: 3 as const,
    pid: options.pid ?? 1234,
    activationId: record.activationId,
    runnerArtifactSha256: record.runnerArtifact.sha256,
    sourceRevision: record.source.revision,
    acceptedProtocolFingerprints: record.acceptedProtocols.map(
      ({ fingerprint }) => fingerprint
    ),
    state,
    inFlight: 0,
    updatedAt: options.updatedAt ?? new Date(NOW - 1_000).toISOString()
  };
}

function legacyRecordValue(
  root: string,
  target: ReturnType<typeof recordValue>
) {
  return {
    schemaVersion: 3 as const,
    releaseSha: "c".repeat(40),
    modelId: "legacy-model",
    statusFile: join(root, "status.json"),
    executables: target.executables,
    launchAgents: {
      narrativeRunner: {
        ...target.launchAgents.narrativeRunner,
        sha256: "d".repeat(64)
      },
      omlxServer: {
        ...target.launchAgents.omlxServer,
        sha256: "e".repeat(64)
      }
    }
  };
}

function legacyHeartbeat(
  record: ReturnType<typeof legacyRecordValue>,
  options: {
    pid?: number;
    state?: string;
    inFlight?: number;
    updatedAt?: string;
  } = {}
) {
  return {
    schemaVersion: 2,
    pid: options.pid ?? 5678,
    releaseSha: record.releaseSha,
    modelId: record.modelId,
    state: options.state ?? "stopped",
    inFlight: options.inFlight ?? 0,
    updatedAt: options.updatedAt ?? new Date(NOW - 1_000).toISOString()
  };
}

function loadedJob(
  root: string,
  record: ReturnType<typeof recordValue>,
  component: "narrativeRunner" | "omlxServer",
  pid = component === "narrativeRunner" ? 1234 : 2345
) {
  return [
    `path = ${record.launchAgents[component].path}`,
    "arguments = {",
    `\t${join(root, "activation-record.json")}`,
    "}",
    `pid = ${pid}`,
    ""
  ].join("\n");
}

function installationVerifier(
  targetRecordPath: string,
  priorRecordPath: string | null,
  installed: "target" | "prior" | "mixed" | "none"
) {
  return vi.fn(
    async (path: string, options: { requireInstalled: boolean }) => {
      if (!options.requireInstalled) return { status: "ok" };
      if (installed === "target" && path === targetRecordPath) return { status: "ok" };
      if (installed === "prior" && path === priorRecordPath) return { status: "ok" };
      throw new Error(installed === "mixed" ? "mixed installation" : "not installed");
    }
  );
}

function launchdHarness(
  targetRoot: string,
  target: ReturnType<typeof recordValue>,
  initial: Array<{
    root: string;
    record: ReturnType<typeof recordValue>;
    component: "narrativeRunner" | "omlxServer";
    pid?: number;
  }> = []
) {
  const labelFor = (component: "narrativeRunner" | "omlxServer") =>
    `gui/501/ai.alex.${component === "narrativeRunner" ? "narrative-runner" : "omlx-server"}`;
  const loaded = new Map(
    initial.map((value) => [
      labelFor(value.component),
      { ...value, pid: value.pid ?? (value.component === "narrativeRunner" ? 1234 : 2345) }
    ])
  );
  return {
    loaded,
    command: async (file: string, args: string[]) => {
      if (file === "/bin/launchctl" && args[0] === "print") {
        const value = loaded.get(String(args[1]));
        return value
          ? {
              status: 0,
              stdout: loadedJob(value.root, value.record, value.component, value.pid)
            }
          : { status: 1, stdout: "" };
      }
      if (file === "/bin/launchctl" && args[0] === "bootout") {
        loaded.delete(String(args[1]));
        return { status: 0, stdout: "" };
      }
      if (file === "/bin/launchctl" && args[0] === "bootstrap") {
        const component = String(args[2]) === target.launchAgents.narrativeRunner.path
          ? "narrativeRunner"
          : "omlxServer";
        loaded.set(labelFor(component), {
          root: targetRoot,
          record: target,
          component,
          pid: component === "narrativeRunner" ? 3456 : 4567
        });
      }
      return { status: 0, stdout: "" };
    }
  };
}

async function committedDrainFixture(priorSchemaVersion: 3 | 4 = 3) {
  const createdRoot = await mkdtemp(join(tmpdir(), "surf-committed-drain-"));
  const root = await realpath(createdRoot);
  const targetRoot = join(root, "target");
  const priorRoot = join(root, "prior");
  const targetRevision = "a".repeat(40);
  const priorRevision = "c".repeat(40);
  const targetRecordPath = await activationRecord(
    targetRoot,
    NARRATIVE_PROTOCOL_FINGERPRINT,
    targetRevision
  );
  const target = recordValue(
    targetRoot,
    NARRATIVE_PROTOCOL_FINGERPRINT,
    targetRevision
  );
  let prior: ReturnType<typeof recordValue> | ReturnType<typeof legacyRecordValue>;
  let priorRecordPath: string;
  if (priorSchemaVersion === 4) {
    priorRecordPath = await activationRecord(
      priorRoot,
      NARRATIVE_PROTOCOL_FINGERPRINT,
      priorRevision
    );
    prior = recordValue(priorRoot, NARRATIVE_PROTOCOL_FINGERPRINT, priorRevision);
  } else {
    await mkdir(priorRoot, { recursive: true });
    priorRecordPath = join(priorRoot, "activation-record.json");
    prior = legacyRecordValue(priorRoot, target);
    await writeFile(priorRecordPath, `${JSON.stringify(prior, null, 2)}\n`, {
      mode: 0o600
    });
  }
  const observedAt = new Date(NOW - 2_000).toISOString();
  const heartbeatUpdatedAt = new Date(NOW - 1_000).toISOString();
  const intent = {
    schemaVersion: 2,
    targetActivationId: target.activationId,
    targetReleaseSha: target.source.revision,
    priorActivationId: prior.schemaVersion === 4 ? prior.activationId : null,
    priorReleaseSha:
      prior.schemaVersion === 4 ? prior.source.revision : prior.releaseSha,
    priorPid: 4101,
    heartbeatPid: 4103,
    runnerLabelInitiallyLoaded: true,
    observedAt
  };
  const receipt = {
    schemaVersion: 2,
    priorActivationId: intent.priorActivationId,
    priorReleaseSha: intent.priorReleaseSha,
    priorPid: intent.priorPid,
    heartbeatPid: intent.heartbeatPid,
    outcome: "stopped",
    heartbeatUpdatedAt,
    observedAt: new Date(NOW).toISOString(),
    acceptedProtocolFingerprints:
      prior.schemaVersion === 4
        ? prior.acceptedProtocols.map(({ fingerprint }) => fingerprint).sort()
        : [],
    runnerLabelInitiallyLoaded: true,
    runnerLabelUnloaded: true,
    maxWaitMs: 960_000
  };
  const intentPath = join(targetRoot, "runner-drain-intent.json");
  const receiptPath = join(targetRoot, "runner-drain-receipt.json");
  const attemptDrainReceiptPath = join(root, "attempt-runner-drain.json");
  await Promise.all([
    writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 }),
    writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }),
    writeFile(
      attemptDrainReceiptPath,
      `${JSON.stringify(Object.fromEntries(Object.entries(receipt).reverse()))}\n`,
      { mode: 0o600 }
    )
  ]);
  return {
    root,
    target,
    prior,
    targetRecordPath,
    priorRecordPath,
    intentPath,
    receiptPath,
    attemptDrainReceiptPath,
    intent,
    receipt
  };
}

describe("bounded LaunchAgent activation", () => {
  it("attests an exact committed v4 drain against its installed target and prior record", async () => {
    const fixture = await committedDrainFixture(3);
    if (fixture.prior.schemaVersion !== 3) throw new Error("expected legacy prior");
    const verify = vi.fn(async () => ({ status: "ok" }));
    const evidence = await verifyCommittedRunnerDrainEvidence(
      {
        targetRecordPath: fixture.targetRecordPath,
        priorRecordPath: fixture.priorRecordPath,
        attemptDrainReceiptPath: fixture.attemptDrainReceiptPath
      },
      { verify, now: () => NOW }
    );

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      targetActivationId: fixture.target.activationId,
      targetReleaseSha: fixture.target.source.revision,
      priorActivationId: null,
      priorReleaseSha: fixture.prior.releaseSha,
      drainIntent: fixture.intent,
      drainReceipt: fixture.receipt
    });
    expect(evidence.targetRecordSha256).toBe(
      sha256(await readFile(fixture.targetRecordPath))
    );
    expect(evidence.priorRecordSha256).toBe(
      sha256(await readFile(fixture.priorRecordPath))
    );
    expect(evidence.drainIntentSha256).toBe(sha256(await readFile(fixture.intentPath)));
    expect(evidence.drainReceiptSha256).toBe(
      sha256(await readFile(fixture.receiptPath))
    );
    expect(evidence.attemptDrainReceiptSha256).toBe(
      sha256(await readFile(fixture.attemptDrainReceiptPath))
    );
    expect(evidence.semanticReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.attemptDrainReceiptSha256).not.toBe(
      evidence.drainReceiptSha256
    );
    expect(verify.mock.calls).toEqual([
      [fixture.targetRecordPath, { requireInstalled: true, allowLegacyV3: false }],
      [fixture.targetRecordPath, { requireInstalled: true, allowLegacyV3: false }],
      [fixture.priorRecordPath, { requireInstalled: false, allowLegacyV3: true }],
      [fixture.priorRecordPath, { requireInstalled: false, allowLegacyV3: true }]
    ]);
  });

  it("accepts a committed v4 prior and an absent attempt receipt without weakening identity", async () => {
    const fixture = await committedDrainFixture(4);
    if (fixture.prior.schemaVersion !== 4) throw new Error("expected v4 prior");
    const evidence = await verifyCommittedRunnerDrainEvidence(
      {
        targetRecordPath: fixture.targetRecordPath,
        priorRecordPath: fixture.priorRecordPath
      },
      { verify: async () => ({ status: "ok" }), now: () => NOW }
    );

    expect(evidence.priorActivationId).toBe(fixture.prior.activationId);
    expect(evidence.priorReleaseSha).toBe(fixture.prior.source.revision);
    expect(evidence.priorRecordSha256).toBe(
      sha256(await readFile(fixture.priorRecordPath))
    );
    expect(evidence.attemptDrainReceiptSha256).toBeNull();
  });

  it("rejects an attempt receipt that is valid for the transition but differs semantically", async () => {
    const fixture = await committedDrainFixture(3);
    await writeFile(
      fixture.attemptDrainReceiptPath,
      `${JSON.stringify({
        ...fixture.receipt,
        heartbeatUpdatedAt: new Date(NOW - 500).toISOString()
      })}\n`,
      { mode: 0o600 }
    );

    await expect(
      verifyCommittedRunnerDrainEvidence(
        {
          targetRecordPath: fixture.targetRecordPath,
          priorRecordPath: fixture.priorRecordPath,
          attemptDrainReceiptPath: fixture.attemptDrainReceiptPath
        },
        { verify: async () => ({ status: "ok" }), now: () => NOW }
      )
    ).rejects.toThrow(/differs from the committed manager receipt/);
  });

  it("attests fully prior, oMLX-first mixed, and fully target transition installs", async () => {
    const cases = [
      {
        name: "prior",
        installed: "prior" as const,
        inspected: null,
        expected: {
          narrativeRunner: "prior",
          omlxServer: "prior",
          targetCommitted: false,
          validPrecommit: true
        }
      },
      {
        name: "oMLX-first mixed",
        installed: "mixed" as const,
        inspected: { narrativeRunner: "prior", omlxServer: "target" },
        expected: {
          narrativeRunner: "prior",
          omlxServer: "target",
          targetCommitted: false,
          validPrecommit: true
        }
      },
      {
        name: "target",
        installed: "target" as const,
        inspected: null,
        expected: {
          narrativeRunner: "target",
          omlxServer: "target",
          targetCommitted: true,
          validPrecommit: false
        }
      }
    ];
    for (const testCase of cases) {
      const fixture = await committedDrainFixture(4);
      if (fixture.prior.schemaVersion !== 4) throw new Error("expected v4 prior");
      const inspectInstalled = vi.fn(async () => ({
        status: "ok",
        launchAgents: testCase.inspected
      }));
      const state = await inspectRunnerTransitionInstallState(
        {
          targetRecordPath: fixture.targetRecordPath,
          priorRecordPath: fixture.priorRecordPath
        },
        {
          verify: installationVerifier(
            fixture.targetRecordPath,
            fixture.priorRecordPath,
            testCase.installed
          ),
          inspectInstalled
        }
      );

      expect(state).toMatchObject({
        schemaVersion: 1,
        targetActivationId: fixture.target.activationId,
        targetReleaseSha: fixture.target.source.revision,
        priorActivationId: fixture.prior.activationId,
        priorReleaseSha: fixture.prior.source.revision,
        ...testCase.expected
      });
      expect(state.targetRecordSha256).toBe(
        sha256(await readFile(fixture.targetRecordPath))
      );
      expect(state.priorRecordSha256).toBe(
        sha256(await readFile(fixture.priorRecordPath))
      );
      expect(inspectInstalled).toHaveBeenCalledTimes(
        testCase.installed === "mixed" ? 2 : 0
      );
    }
  });

  it("rejects runner-first mixed transition installation state", async () => {
    const fixture = await committedDrainFixture(4);
    await expect(
      inspectRunnerTransitionInstallState(
        {
          targetRecordPath: fixture.targetRecordPath,
          priorRecordPath: fixture.priorRecordPath
        },
        {
          verify: installationVerifier(
            fixture.targetRecordPath,
            fixture.priorRecordPath,
            "mixed"
          ),
          inspectInstalled: async () => ({
            status: "ok",
            launchAgents: { narrativeRunner: "target", omlxServer: "prior" }
          })
        }
      )
    ).rejects.toThrow(/oMLX-first, runner-last commit order/);
  });

  it("rejects activation-record drift during transition installation inspection", async () => {
    const fixture = await committedDrainFixture(4);
    let inspections = 0;
    await expect(
      inspectRunnerTransitionInstallState(
        {
          targetRecordPath: fixture.targetRecordPath,
          priorRecordPath: fixture.priorRecordPath
        },
        {
          verify: installationVerifier(
            fixture.targetRecordPath,
            fixture.priorRecordPath,
            "mixed"
          ),
          inspectInstalled: async () => {
            inspections += 1;
            if (inspections === 1) {
              await writeFile(
                fixture.targetRecordPath,
                `${JSON.stringify({
                  ...fixture.target,
                  source: {
                    ...fixture.target.source,
                    revision: "d".repeat(40)
                  }
                })}\n`,
                { mode: 0o600 }
              );
            }
            return {
              status: "ok",
              launchAgents: { narrativeRunner: "prior", omlxServer: "target" }
            };
          }
        }
      )
    ).rejects.toThrow(/activation records changed during installation inspection/);
  });

  it("rejects plist-state drift during transition installation inspection", async () => {
    const fixture = await committedDrainFixture(4);
    let inspections = 0;
    await expect(
      inspectRunnerTransitionInstallState(
        {
          targetRecordPath: fixture.targetRecordPath,
          priorRecordPath: fixture.priorRecordPath
        },
        {
          verify: installationVerifier(
            fixture.targetRecordPath,
            fixture.priorRecordPath,
            "mixed"
          ),
          inspectInstalled: async () => {
            inspections += 1;
            return {
              status: "ok",
              launchAgents:
                inspections === 1
                  ? { narrativeRunner: "prior", omlxServer: "target" }
                  : { narrativeRunner: "prior", omlxServer: "prior" }
            };
          }
        }
      )
    ).rejects.toThrow(/installation changed during inspection/);
  });

  it("is idempotent when the exact installed v4 activation is healthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-idempotent-"));
    const recordPath = await activationRecord(root);
    const record = recordValue(root);
    const commands: string[][] = [];
    const install = vi.fn();
    const verify = vi.fn(async () => ({ status: "ok" }));
    const result = await activateLaunchAgents(
      { recordPath },
      {
        uid: 501,
        verify,
        install,
        command: async (file: string, args: string[]) => {
          commands.push([file, ...args]);
          if (file === "/bin/launchctl" && args[0] === "print") {
            const component = String(args[1]).endsWith("ai.alex.narrative-runner")
              ? "narrativeRunner"
              : "omlxServer";
            return { status: 0, stdout: loadedJob(root, record, component) };
          }
          return { status: 0, stdout: "" };
        }
      }
    );

    expect(result).toMatchObject({
      status: "ok",
      activationId: record.activationId,
      changed: false,
      drainReceipt: null
    });
    expect(install).not.toHaveBeenCalled();
    expect(commands.some((args) => args.includes("bootout"))).toBe(false);
    expect(verify).toHaveBeenCalledWith(recordPath, {
      requireInstalled: true,
      allowLegacyV3: false
    });
  });

  it("requires an explicit prior record before mutating a loaded service", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-prior-"));
    const recordPath = await activationRecord(root);
    const record = recordValue(root);
    let mutations = 0;
    await expect(
      activateLaunchAgents(
        { recordPath },
        {
          uid: 501,
          verify: async (_path: string, options: { requireInstalled: boolean }) => {
            if (options.requireInstalled) throw new Error("different activation");
            return { status: "ok" };
          },
          command: async (_file: string, args: string[]) => {
            if (args[0] === "print") {
              const component = String(args[1]).endsWith("ai.alex.narrative-runner")
                ? "narrativeRunner"
                : "omlxServer";
              return { status: 0, stdout: loadedJob(root, record, component) };
            }
            mutations += 1;
            return { status: 0, stdout: "" };
          }
        }
      )
    ).rejects.toThrow(/priorRecordPath is required/);
    expect(mutations).toBe(0);
  });

  it("binds the prior record to loaded plist paths before bootout", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-loaded-path-"));
    const targetRecordPath = await activationRecord(join(root, "target"));
    const priorRecordPath = await activationRecord(join(root, "prior"));
    let mutations = 0;
    await expect(
      activateLaunchAgents(
        { recordPath: targetRecordPath, priorRecordPath },
        {
          uid: 501,
          verify: async () => ({ status: "ok" }),
          command: async (_file: string, args: string[]) => {
            if (args[0] === "print") {
              return { status: 0, stdout: "path = /unrecorded/job.plist\n" };
            }
            mutations += 1;
            return { status: 0, stdout: "" };
          }
        }
      )
    ).rejects.toThrow(/not loaded from the recorded persistent plist/);
    expect(mutations).toBe(0);
  });

  it("counts command time against the readiness deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-deadline-"));
    const recordPath = await activationRecord(root);
    const target = recordValue(root);
    const launchd = launchdHarness(root, target);
    let clock = 1_000;
    let runnerChecks = 0;
    await expect(
      activateLaunchAgents(
        { recordPath, environment: { HOME: join(root, "home") } },
        {
          uid: 501,
          now: () => clock,
          sleep: async (milliseconds: number) => { clock += milliseconds; },
          verify: installationVerifier(recordPath, null, "none"),
          install: async () => ({ status: "ok" }),
          portOpen: async () => false,
          command: async (file: string, args: string[], options: { timeoutMs: number }) => {
            if (file === "/pinned/node") {
              runnerChecks += 1;
              expect(options.timeoutMs).toBeLessThanOrEqual(35_000);
              clock += 119_000;
              return { status: 1, stdout: "" };
            }
            return launchd.command(file, args);
          }
        }
      )
    ).rejects.toThrow(/runner check did not become healthy inside 120 seconds/);
    expect(runnerChecks).toBe(1);
  });

  it("allows halted recovery only for fresh, PID-bound, exact protocol-set evidence", () => {
    const secondFingerprint = "c".repeat(64);
    const prior = recordValue("/tmp/prior", [
      NARRATIVE_PROTOCOL_FINGERPRINT,
      secondFingerprint
    ]);
    const target = recordValue("/tmp/target", [
      secondFingerprint,
      NARRATIVE_PROTOCOL_FINGERPRINT
    ]);
    const stopped = heartbeat(prior);
    const drainIntent = {
      schemaVersion: 1,
      targetActivationId: target.activationId,
      targetReleaseSha: target.source.revision,
      priorActivationId: prior.activationId,
      priorReleaseSha: prior.source.revision,
      priorPid: 1234,
      runnerLabelInitiallyLoaded: false,
      observedAt: new Date(NOW).toISOString()
    };
    expect(
      canRecoverHaltedRunner({
        priorRecord: prior,
        targetRecord: target,
        heartbeat: stopped,
        labelUnloaded: true,
        drainIntent,
        priorPidAlive: false,
        heartbeatPidAlive: false,
        nowMs: NOW
      })
    ).toBe(true);
    for (const overrides of [
      { labelUnloaded: false },
      { priorPidAlive: true },
      { heartbeatPidAlive: true },
      { drainIntent: { ...drainIntent, priorPid: 9876 } },
      { heartbeat: { ...stopped, inFlight: 1 } },
      { heartbeat: { ...stopped, state: "backing_off" } },
      {
        heartbeat: {
          ...stopped,
          updatedAt: new Date(NOW - 300_001).toISOString()
        }
      },
      {
        heartbeat: {
          ...stopped,
          updatedAt: new Date(NOW + 1).toISOString()
        }
      },
      {
        targetRecord: recordValue("/tmp/target", [
          NARRATIVE_PROTOCOL_FINGERPRINT,
          "f".repeat(64)
        ])
      },
      {
        targetRecord: recordValue("/tmp/target", [
          NARRATIVE_PROTOCOL_FINGERPRINT,
          secondFingerprint,
          "f".repeat(64)
        ])
      },
      {
        heartbeat: {
          ...stopped,
          acceptedProtocolFingerprints: [
            NARRATIVE_PROTOCOL_FINGERPRINT,
            NARRATIVE_PROTOCOL_FINGERPRINT
          ]
        }
      },
      { priorRecord: { ...prior, schemaVersion: 3 } }
    ]) {
      expect(
        canRecoverHaltedRunner({
          priorRecord: prior,
          targetRecord: target,
          heartbeat: stopped,
          labelUnloaded: true,
          drainIntent,
          priorPidAlive: false,
          heartbeatPidAlive: false,
          nowMs: NOW,
          ...overrides
        })
      ).toBe(false);
    }

    const childHeartbeat = heartbeat(prior, "halted", {
      pid: 5678,
      updatedAt: new Date(NOW - 1_000).toISOString()
    });
    const childIntent = {
      ...drainIntent,
      schemaVersion: 2,
      heartbeatPid: 5678,
      runnerLabelInitiallyLoaded: true,
      observedAt: new Date(NOW - 2_000).toISOString()
    };
    expect(
      canRecoverHaltedRunner({
        priorRecord: prior,
        targetRecord: target,
        heartbeat: childHeartbeat,
        labelUnloaded: true,
        drainIntent: childIntent,
        priorPidAlive: false,
        heartbeatPidAlive: false,
        nowMs: NOW
      })
    ).toBe(true);
    expect(
      canRecoverHaltedRunner({
        priorRecord: prior,
        targetRecord: target,
        heartbeat: childHeartbeat,
        labelUnloaded: true,
        drainIntent,
        priorPidAlive: false,
        heartbeatPidAlive: false,
        nowMs: NOW
      })
    ).toBe(false);
    expect(
      canRecoverHaltedRunner({
        priorRecord: prior,
        targetRecord: target,
        heartbeat: {
          ...childHeartbeat,
          updatedAt: new Date(NOW - 2_001).toISOString()
        },
        labelUnloaded: true,
        drainIntent: childIntent,
        priorPidAlive: false,
        heartbeatPidAlive: false,
        nowMs: NOW
      })
    ).toBe(false);
  });

  it("allows a distinct stopped child PID only from an exact transition-bounded v2 binding", () => {
    const target = recordValue("/tmp/target");
    const prior = legacyRecordValue("/tmp/prior", target);
    const stopped = legacyHeartbeat(prior, {
      updatedAt: new Date(NOW - 1_000).toISOString()
    });
    const drainIntent = {
      schemaVersion: 2,
      targetActivationId: target.activationId,
      targetReleaseSha: target.source.revision,
      priorActivationId: null,
      priorReleaseSha: prior.releaseSha,
      priorPid: 1234,
      heartbeatPid: 5678,
      runnerLabelInitiallyLoaded: true,
      observedAt: new Date(NOW - 2_000).toISOString()
    };
    const valid = {
      priorRecord: prior,
      targetRecord: target,
      heartbeat: stopped,
      labelUnloaded: true,
      drainIntent,
      priorPidAlive: false,
      heartbeatPidAlive: false,
      nowMs: NOW
    };

    expect(canRecoverStoppedChildRunner(valid)).toBe(true);
    expect(
      canRecoverStoppedChildRunner({
        ...valid,
        drainIntent: {
          ...drainIntent,
          observedAt: new Date(NOW - 1_000_000).toISOString()
        },
        heartbeat: legacyHeartbeat(prior, {
          updatedAt: new Date(NOW - 999_000).toISOString()
        })
      })
    ).toBe(true);
    for (const overrides of [
      { labelUnloaded: false },
      {
        drainIntent: { ...drainIntent, runnerLabelInitiallyLoaded: false }
      },
      { priorPidAlive: true },
      { heartbeatPidAlive: true },
      { drainIntent: { ...drainIntent, priorPid: 5678 } },
      { heartbeat: legacyHeartbeat(prior, { state: "halted" }) },
      { heartbeat: legacyHeartbeat(prior, { inFlight: 1 }) },
      {
        heartbeat: legacyHeartbeat(prior, {
          updatedAt: new Date(NOW - 2_001).toISOString()
        })
      },
      {
        drainIntent: {
          ...drainIntent,
          observedAt: new Date(NOW - 1_000_000).toISOString()
        },
        heartbeat: legacyHeartbeat(prior, {
          updatedAt: new Date(NOW - 39_999).toISOString()
        })
      },
      {
        heartbeat: legacyHeartbeat(prior, {
          updatedAt: new Date(NOW + 1).toISOString()
        })
      },
      {
        heartbeat: { ...stopped, releaseSha: "d".repeat(40) }
      },
      {
        heartbeat: { ...stopped, modelId: "different-model" }
      },
      {
        priorRecord: recordValue("/tmp/prior-v4"),
        heartbeat: heartbeat(recordValue("/tmp/prior-v4"), "stopped", {
          pid: 5678
        })
      },
      { targetRecord: { ...target, schemaVersion: 3 } }
    ]) {
      expect(canRecoverStoppedChildRunner({ ...valid, ...overrides })).toBe(false);
    }

    expect(
      canRecoverStoppedChildRunner({
        ...valid,
        drainIntent,
        heartbeat: { ...stopped, pid: 6789 }
      })
    ).toBe(false);
    expect(
      canRecoverStoppedChildRunner({
        ...valid,
        drainIntent,
        heartbeat: legacyHeartbeat(prior, {
          updatedAt: new Date(NOW - 300_001).toISOString()
        })
      })
    ).toBe(false);

    const priorV4 = recordValue("/tmp/prior-v4");
    const v4Stopped = heartbeat(priorV4, "stopped", { pid: 5678 });
    const v4Intent = {
      ...drainIntent,
      priorActivationId: priorV4.activationId,
      priorReleaseSha: priorV4.source.revision
    };
    expect(
      canRecoverStoppedChildRunner({
        ...valid,
        priorRecord: priorV4,
        heartbeat: v4Stopped,
        drainIntent: v4Intent
      })
    ).toBe(true);
    const v4Unbound = { ...v4Intent, schemaVersion: 1 } as Record<string, unknown>;
    delete v4Unbound.heartbeatPid;
    expect(
      canRecoverStoppedChildRunner({
        ...valid,
        priorRecord: priorV4,
        heartbeat: v4Stopped,
        drainIntent: v4Unbound
      })
    ).toBe(false);
    const unboundV1 = { ...drainIntent, schemaVersion: 1 } as Record<string, unknown>;
    delete unboundV1.heartbeatPid;
    expect(
      canRecoverStoppedChildRunner({ ...valid, drainIntent: unboundV1 })
    ).toBe(false);
  });

  it("uses the halted exception only after bootout proves the label unloaded", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-halted-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const priorRecordPath = await activationRecord(priorRoot);
    const target = recordValue(targetRoot);
    const prior = recordValue(priorRoot);
    await writeFile(
      prior.runtime.statusFile,
      `${JSON.stringify(heartbeat(prior, "halted", { pid: 5678 }))}\n`
    );
    const launchd = launchdHarness(targetRoot, target, [
      { root: priorRoot, record: prior, component: "narrativeRunner" },
      { root: priorRoot, record: prior, component: "omlxServer" }
    ]);
    const result = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      {
        uid: 501,
        now: () => NOW,
        verify: installationVerifier(targetRecordPath, priorRecordPath, "prior"),
        install: async () => ({ status: "ok" }),
        pidAlive: () => false,
        portOpen: async () => false,
        sleep: async () => undefined,
        afterDrainIntent: async () => {
          await writeFile(
            prior.runtime.statusFile,
            `${JSON.stringify(
              heartbeat(prior, "halted", {
                pid: 5678,
                updatedAt: new Date(NOW).toISOString()
              })
            )}\n`
          );
        },
        command: launchd.command
      }
    );
    expect(result).toMatchObject({
      status: "ok",
      changed: true,
      drainReceipt: {
        schemaVersion: 2,
        priorActivationId: prior.activationId,
        priorReleaseSha: prior.source.revision,
        priorPid: 1234,
        heartbeatPid: 5678,
        outcome: "compatible-halted",
        heartbeatUpdatedAt: new Date(NOW).toISOString(),
        observedAt: new Date(NOW).toISOString(),
        acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT],
        runnerLabelInitiallyLoaded: true,
        runnerLabelUnloaded: true,
        maxWaitMs: 960_000
      }
    });
    expect(target.acceptedProtocols[0]!.fingerprint).toBe(
      prior.acceptedProtocols[0]!.fingerprint
    );
  });

  it("proves and receipts a stopped prior runner even when labels were already unloaded", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-unloaded-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const priorRecordPath = await activationRecord(priorRoot);
    const target = recordValue(targetRoot);
    const prior = recordValue(priorRoot);
    await writeFile(
      prior.runtime.statusFile,
      `${JSON.stringify(heartbeat(prior, "stopped"))}\n`
    );
    const launchd = launchdHarness(targetRoot, target);
    const install = vi.fn(async () => ({ status: "ok" }));
    const result = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      {
        uid: 501,
        now: () => NOW,
        verify: installationVerifier(targetRecordPath, priorRecordPath, "prior"),
        install,
        pidAlive: () => false,
        portOpen: async () => false,
        command: launchd.command
      }
    );

    expect(install).toHaveBeenCalledOnce();
    expect(result.drainReceipt).toMatchObject({
      schemaVersion: 1,
      priorActivationId: prior.activationId,
      priorPid: 1234,
      outcome: "stopped",
      runnerLabelInitiallyLoaded: false,
      runnerLabelUnloaded: true
    });
  });

  it("resumes from the immutable loaded-PID intent after interruption before bootout", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-intent-crash-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const priorRecordPath = await activationRecord(priorRoot);
    const target = recordValue(targetRoot);
    const prior = recordValue(priorRoot);
    await writeFile(
      prior.runtime.statusFile,
      `${JSON.stringify(heartbeat(prior, "stopped"))}\n`
    );
    const launchd = launchdHarness(targetRoot, target, [
      { root: priorRoot, record: prior, component: "narrativeRunner" },
      { root: priorRoot, record: prior, component: "omlxServer" }
    ]);
    const common = {
      uid: 501,
      now: () => NOW,
      verify: installationVerifier(targetRecordPath, priorRecordPath, "prior"),
      install: async () => ({ status: "ok" }),
      pidAlive: () => false,
      portOpen: async () => false,
      sleep: async () => undefined,
      command: launchd.command
    };

    await expect(
      activateLaunchAgents(
        { recordPath: targetRecordPath, priorRecordPath },
        {
          ...common,
          afterDrainIntent: async () => {
            throw new Error("injected after intent");
          }
        }
      )
    ).rejects.toThrow(/injected after intent/);
    expect(launchd.loaded.has("gui/501/ai.alex.narrative-runner")).toBe(true);

    const resumed = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      common
    );
    expect(resumed.drainReceipt).toMatchObject({
      priorPid: 1234,
      outcome: "stopped",
      runnerLabelInitiallyLoaded: true
    });
  });

  it("resumes from the immutable drain receipt without re-deriving the prior PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-receipt-crash-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const priorRecordPath = await activationRecord(priorRoot);
    const target = recordValue(targetRoot);
    const prior = recordValue(priorRoot);
    await writeFile(
      prior.runtime.statusFile,
      `${JSON.stringify(heartbeat(prior, "stopped"))}\n`
    );
    const launchd = launchdHarness(targetRoot, target, [
      { root: priorRoot, record: prior, component: "narrativeRunner" },
      { root: priorRoot, record: prior, component: "omlxServer" }
    ]);
    const common = {
      uid: 501,
      now: () => NOW,
      verify: installationVerifier(targetRecordPath, priorRecordPath, "prior"),
      install: async () => ({ status: "ok" }),
      pidAlive: () => false,
      portOpen: async () => false,
      sleep: async () => undefined,
      command: launchd.command
    };

    await expect(
      activateLaunchAgents(
        { recordPath: targetRecordPath, priorRecordPath },
        {
          ...common,
          afterDrainReceipt: async () => {
            throw new Error("injected after receipt");
          }
        }
      )
    ).rejects.toThrow(/injected after receipt/);
    await writeFile(prior.runtime.statusFile, "stale and intentionally unreadable\n");

    const resumed = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      common
    );
    expect(resumed.drainReceipt).toMatchObject({ priorPid: 1234, outcome: "stopped" });
  });

  it("completes an oMLX-first mixed install only after the prior runner is proven dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-mixed-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const priorRecordPath = await activationRecord(priorRoot);
    const target = recordValue(targetRoot);
    const prior = recordValue(priorRoot);
    await writeFile(
      prior.runtime.statusFile,
      `${JSON.stringify(heartbeat(prior, "stopped"))}\n`
    );
    const launchd = launchdHarness(targetRoot, target);
    const install = vi.fn(async () => ({ status: "ok" }));
    const inspectInstalled = vi.fn(async () => ({
      status: "ok",
      launchAgents: { narrativeRunner: "prior", omlxServer: "target" }
    }));

    const result = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      {
        uid: 501,
        now: () => NOW,
        verify: installationVerifier(targetRecordPath, priorRecordPath, "mixed"),
        inspectInstalled,
        install,
        pidAlive: () => false,
        portOpen: async () => false,
        command: launchd.command
      }
    );

    expect(result).toMatchObject({
      status: "ok",
      changed: true,
      drainReceipt: { priorActivationId: prior.activationId, outcome: "stopped" }
    });
    expect(inspectInstalled).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(targetRecordPath, {
      environment: process.env,
      allowReplace: true,
      allowLegacyV3: false,
      priorRecordPath
    });
  });

  it("recovers the committed target using the pre-commit drain receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-commit-crash-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const priorRecordPath = await activationRecord(priorRoot);
    const target = recordValue(targetRoot);
    const prior = recordValue(priorRoot);
    await writeFile(
      prior.runtime.statusFile,
      `${JSON.stringify(heartbeat(prior, "stopped"))}\n`
    );
    const launchd = launchdHarness(targetRoot, target);
    let installed: "prior" | "target" = "prior";
    const verify = vi.fn(async (path: string, options: { requireInstalled: boolean }) => {
      if (!options.requireInstalled) return { status: "ok" };
      if (installed === "prior" && path === priorRecordPath) return { status: "ok" };
      if (installed === "target" && path === targetRecordPath) return { status: "ok" };
      throw new Error("not installed");
    });
    const install = vi.fn(async () => {
      installed = "target";
      throw new Error("injected after plist commit");
    });
    const common = {
      uid: 501,
      now: () => NOW,
      verify,
      install,
      pidAlive: () => false,
      portOpen: async () => false,
      command: launchd.command
    };

    await expect(
      activateLaunchAgents({ recordPath: targetRecordPath, priorRecordPath }, common)
    ).rejects.toThrow(/injected after plist commit/);
    await writeFile(prior.runtime.statusFile, "stale and intentionally unreadable\n");

    const resumed = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      { ...common, install: vi.fn() }
    );
    expect(resumed.drainReceipt).toMatchObject({ priorPid: 1234, outcome: "stopped" });
  });

  it("receipts both dead PIDs when a loaded v3 wrapper stops through its child", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-v3-child-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const target = recordValue(targetRoot);
    await mkdir(priorRoot, { recursive: true });
    const priorRecordPath = join(priorRoot, "activation-record.json");
    const legacy = legacyRecordValue(priorRoot, target);
    await writeFile(priorRecordPath, `${JSON.stringify(legacy)}\n`);
    await writeFile(
      legacy.statusFile,
      `${JSON.stringify(legacyHeartbeat(legacy))}\n`
    );
    const launchd = launchdHarness(targetRoot, target, [
      {
        root: priorRoot,
        record: legacy as unknown as ReturnType<typeof recordValue>,
        component: "narrativeRunner",
        pid: 1234
      },
      {
        root: priorRoot,
        record: legacy as unknown as ReturnType<typeof recordValue>,
        component: "omlxServer"
      }
    ]);
    const pidAlive = vi.fn(() => false);

    const result = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      {
        uid: 501,
        now: () => NOW,
        verify: installationVerifier(targetRecordPath, priorRecordPath, "prior"),
        install: async () => ({ status: "ok" }),
        pidAlive,
        portOpen: async () => false,
        sleep: async () => undefined,
        afterDrainIntent: async () => {
          await writeFile(
            legacy.statusFile,
            `${JSON.stringify(
              legacyHeartbeat(legacy, {
                updatedAt: new Date(NOW).toISOString()
              })
            )}\n`
          );
        },
        command: launchd.command
      }
    );

    expect(result.drainReceipt).toMatchObject({
      schemaVersion: 2,
      priorActivationId: null,
      priorReleaseSha: legacy.releaseSha,
      priorPid: 1234,
      heartbeatPid: 5678,
      outcome: "stopped",
      runnerLabelInitiallyLoaded: true,
      runnerLabelUnloaded: true
    });
    expect(pidAlive).toHaveBeenCalledWith(1234);
    expect(pidAlive).toHaveBeenCalledWith(5678);

  });

  it("resumes a prebound v2 stopped child after the intent window has elapsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-v2-resume-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const target = recordValue(targetRoot);
    await mkdir(priorRoot, { recursive: true });
    const priorRecordPath = join(priorRoot, "activation-record.json");
    const legacy = legacyRecordValue(priorRoot, target);
    await writeFile(priorRecordPath, `${JSON.stringify(legacy)}\n`);
    await writeFile(
      legacy.statusFile,
      `${JSON.stringify(legacyHeartbeat(legacy))}\n`
    );
    const launchd = launchdHarness(targetRoot, target, [
      {
        root: priorRoot,
        record: legacy as unknown as ReturnType<typeof recordValue>,
        component: "narrativeRunner",
        pid: 1234
      },
      {
        root: priorRoot,
        record: legacy as unknown as ReturnType<typeof recordValue>,
        component: "omlxServer"
      }
    ]);
    let clock = NOW;
    const common = {
      uid: 501,
      now: () => clock,
      verify: installationVerifier(targetRecordPath, priorRecordPath, "prior"),
      install: async () => ({ status: "ok" }),
      pidAlive: () => false,
      portOpen: async () => false,
      sleep: async () => undefined,
      command: launchd.command
    };

    await expect(
      activateLaunchAgents(
        { recordPath: targetRecordPath, priorRecordPath },
        {
          ...common,
          afterDrainIntent: async () => {
            await writeFile(
              legacy.statusFile,
              `${JSON.stringify(
                legacyHeartbeat(legacy, {
                  updatedAt: new Date(NOW).toISOString()
                })
              )}\n`
            );
            throw new Error("injected after v2 intent");
          }
        }
      )
    ).rejects.toThrow(/injected after v2 intent/);

    launchd.loaded.delete("gui/501/ai.alex.narrative-runner");
    clock = NOW + 960_001;
    const resumed = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      common
    );

    expect(resumed.drainReceipt).toMatchObject({
      schemaVersion: 2,
      priorPid: 1234,
      heartbeatPid: 5678,
      outcome: "stopped",
      heartbeatUpdatedAt: new Date(NOW).toISOString(),
      observedAt: new Date(clock).toISOString()
    });
  });

  it("recovers a v3-prior to v4-target oMLX-first mixed installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-v3-mixed-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const target = recordValue(targetRoot);
    await mkdir(priorRoot, { recursive: true });
    const priorRecordPath = join(priorRoot, "activation-record.json");
    const legacy = legacyRecordValue(priorRoot, target);
    await writeFile(priorRecordPath, `${JSON.stringify(legacy)}\n`);
    await writeFile(
      legacy.statusFile,
      `${JSON.stringify(legacyHeartbeat(legacy, { pid: 1234 }))}\n`
    );
    const launchd = launchdHarness(targetRoot, target);
    const install = vi.fn(async () => ({ status: "ok" }));
    const result = await activateLaunchAgents(
      { recordPath: targetRecordPath, priorRecordPath },
      {
        uid: 501,
        now: () => NOW,
        verify: installationVerifier(targetRecordPath, priorRecordPath, "mixed"),
        inspectInstalled: async () => ({
          status: "ok",
          launchAgents: { narrativeRunner: "prior", omlxServer: "target" }
        }),
        install,
        pidAlive: () => false,
        portOpen: async () => false,
        command: launchd.command
      }
    );
    expect(result.drainReceipt).toMatchObject({
      priorActivationId: null,
      priorReleaseSha: legacy.releaseSha,
      priorPid: 1234,
      outcome: "stopped",
      acceptedProtocolFingerprints: []
    });
  });

  it("rejects a runner-first mixed install as an invalid commit state", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-invalid-mixed-"));
    const targetRecordPath = await activationRecord(join(root, "target"));
    const priorRecordPath = await activationRecord(join(root, "prior"));
    const install = vi.fn();
    let mutations = 0;

    await expect(
      activateLaunchAgents(
        { recordPath: targetRecordPath, priorRecordPath },
        {
          uid: 501,
          verify: installationVerifier(targetRecordPath, priorRecordPath, "mixed"),
          inspectInstalled: async () => ({
            status: "ok",
            launchAgents: { narrativeRunner: "target", omlxServer: "prior" }
          }),
          install,
          command: async (_file: string, args: string[]) => {
            if (args[0] !== "print") mutations += 1;
            return { status: args[0] === "print" ? 1 : 0, stdout: "" };
          }
        }
      )
    ).rejects.toThrow(/violates the oMLX-first, runner-last commit order/);
    expect(install).not.toHaveBeenCalled();
    expect(mutations).toBe(0);
  });

  it("resumes after both target plists were installed without repeating installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-after-install-"));
    const recordPath = await activationRecord(root);
    const target = recordValue(root);
    const launchd = launchdHarness(root, target);
    const install = vi.fn();

    const result = await activateLaunchAgents(
      { recordPath, priorRecordPath: recordPath },
      {
        uid: 501,
        verify: installationVerifier(recordPath, recordPath, "target"),
        install,
        command: launchd.command
      }
    );

    expect(result).toMatchObject({ status: "ok", changed: true, drainReceipt: null });
    expect(install).not.toHaveBeenCalled();
    expect(launchd.loaded.has("gui/501/ai.alex.omlx-server")).toBe(true);
    expect(launchd.loaded.has("gui/501/ai.alex.narrative-runner")).toBe(true);
  });

  it("resumes after target oMLX bootstrap without restarting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-after-omlx-"));
    const recordPath = await activationRecord(root);
    const target = recordValue(root);
    const launchd = launchdHarness(root, target, [
      { root, record: target, component: "omlxServer" }
    ]);
    const bootstraps: string[] = [];

    const result = await activateLaunchAgents(
      { recordPath, priorRecordPath: recordPath },
      {
        uid: 501,
        verify: installationVerifier(recordPath, recordPath, "target"),
        command: async (file: string, args: string[]) => {
          if (file === "/bin/launchctl" && args[0] === "bootstrap") {
            bootstraps.push(String(args[2]));
          }
          return launchd.command(file, args);
        }
      }
    );

    expect(result).toMatchObject({ status: "ok", changed: true });
    expect(bootstraps).toEqual([target.launchAgents.narrativeRunner.path]);
  });

  it("waits through target startup when resuming before runner readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-before-ready-"));
    const recordPath = await activationRecord(root);
    const target = recordValue(root);
    const launchd = launchdHarness(root, target, [
      { root, record: target, component: "omlxServer" },
      { root, record: target, component: "narrativeRunner" }
    ]);
    let clock = NOW;
    let statusAttempts = 0;
    let launchMutations = 0;

    const result = await activateLaunchAgents(
      { recordPath, priorRecordPath: recordPath },
      {
        uid: 501,
        now: () => clock,
        sleep: async (milliseconds: number) => { clock += milliseconds; },
        verify: installationVerifier(recordPath, recordPath, "target"),
        command: async (file: string, args: string[]) => {
          if (file === "/pinned/node" && args.includes("status")) {
            statusAttempts += 1;
            return { status: statusAttempts < 3 ? 1 : 0, stdout: "" };
          }
          if (
            file === "/bin/launchctl" &&
            ["bootout", "bootstrap", "kickstart"].includes(String(args[0]))
          ) {
            launchMutations += 1;
          }
          return launchd.command(file, args);
        }
      }
    );

    expect(result).toMatchObject({ status: "ok", changed: false });
    expect(statusAttempts).toBe(3);
    expect(launchMutations).toBe(0);
  });

  it("fails closed on an unknown loaded activation record or PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-unknown-loaded-"));
    const recordPath = await activationRecord(root);
    const target = recordValue(root);
    let mutations = 0;

    for (const invalidLine of ["/unknown/activation-record.json", "pid = unknown"]) {
      await expect(
        activateLaunchAgents(
          { recordPath },
          {
            uid: 501,
            verify: installationVerifier(recordPath, null, "target"),
            command: async (_file: string, args: string[]) => {
              if (args[0] !== "print") {
                mutations += 1;
                return { status: 0, stdout: "" };
              }
              if (!String(args[1]).endsWith("ai.alex.narrative-runner")) {
                return { status: 1, stdout: "" };
              }
              const identity = invalidLine.startsWith("pid")
                ? join(root, "activation-record.json")
                : invalidLine;
              const pid = invalidLine.startsWith("pid") ? invalidLine : "pid = 1234";
              return {
                status: 0,
                stdout: [
                  `path = ${target.launchAgents.narrativeRunner.path}`,
                  identity,
                  pid,
                  ""
                ].join("\n")
              };
            }
          }
        )
      ).rejects.toThrow(/verified activation record argument|positive loaded PID/);
    }
    expect(mutations).toBe(0);
  });

  it("does not boot out a label whose attested PID changes before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-pid-race-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const priorRecordPath = await activationRecord(priorRoot);
    const prior = recordValue(priorRoot);
    let runnerPrints = 0;
    let bootouts = 0;

    await expect(
      activateLaunchAgents(
        { recordPath: targetRecordPath, priorRecordPath },
        {
          uid: 501,
          verify: installationVerifier(targetRecordPath, priorRecordPath, "prior"),
          command: async (file: string, args: string[]) => {
            if (file === "/bin/launchctl" && args[0] === "print") {
              if (!String(args[1]).endsWith("ai.alex.narrative-runner")) {
                return { status: 1, stdout: "" };
              }
              runnerPrints += 1;
              return {
                status: 0,
                stdout: loadedJob(
                  priorRoot,
                  prior,
                  "narrativeRunner",
                  runnerPrints === 1 ? 1234 : 9999
                )
              };
            }
            if (args[0] === "bootout") bootouts += 1;
            return { status: 0, stdout: "" };
          }
        }
      )
    ).rejects.toThrow(/identity changed before bounded bootout/);
    expect(bootouts).toBe(0);
  });

  it("does not replace an already-unloaded prior runner until its recorded PID is dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-live-prior-"));
    const targetRoot = join(root, "target");
    const priorRoot = join(root, "prior");
    const targetRecordPath = await activationRecord(targetRoot);
    const priorRecordPath = await activationRecord(priorRoot);
    const target = recordValue(targetRoot);
    const prior = recordValue(priorRoot);
    await writeFile(
      prior.runtime.statusFile,
      `${JSON.stringify(heartbeat(prior, "stopped"))}\n`
    );
    const launchd = launchdHarness(targetRoot, target);
    const install = vi.fn();
    let clock = NOW;

    await expect(
      activateLaunchAgents(
        { recordPath: targetRecordPath, priorRecordPath },
        {
          uid: 501,
          now: () => clock,
          sleep: async () => { clock += 1_000_000; },
          verify: installationVerifier(targetRecordPath, priorRecordPath, "prior"),
          install,
          pidAlive: () => true,
          command: launchd.command
        }
      )
    ).rejects.toThrow(/matching stopped heartbeat and dead PID/);
    expect(install).not.toHaveBeenCalled();
  });

  it("blocks legacy v3 as an activation target but permits explicit rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-v3-"));
    const recordPath = join(root, "activation-record.json");
    const legacy = {
      schemaVersion: 3,
      releaseSha: "a".repeat(40),
      statusFile: join(root, "status.json"),
      executables: {
        node: { path: "/pinned/node" },
        runnerGuard: { path: "/pinned/run-verified-runner.mjs" }
      },
      launchAgents: {
        narrativeRunner: { path: join(root, "runner.plist") },
        omlxServer: { path: join(root, "omlx.plist") }
      }
    };
    await writeFile(recordPath, `${JSON.stringify(legacy)}\n`);
    await expect(
      activateLaunchAgents(
        { recordPath },
        { uid: 501, verify: async () => ({ status: "ok" }) }
      )
    ).rejects.toThrow(/targets only for explicit rollback/);

    const verify = installationVerifier(recordPath, null, "none");
    const install = vi.fn(async () => ({ status: "ok" }));
    const launchd = launchdHarness(
      root,
      legacy as unknown as ReturnType<typeof recordValue>
    );
    await expect(
      activateLaunchAgents(
        { recordPath, transitionMode: "rollback" },
        {
          uid: 501,
          verify,
          install,
          portOpen: async () => false,
          command: launchd.command
        }
      )
    ).resolves.toMatchObject({
      status: "ok",
      releaseSha: legacy.releaseSha,
      activationId: null,
      changed: true
    });
    expect(verify).toHaveBeenCalledWith(recordPath, {
      requireInstalled: false,
      allowLegacyV3: true
    });
    expect(install).toHaveBeenCalledWith(recordPath, {
      environment: process.env,
      allowReplace: false,
      allowLegacyV3: true,
      priorRecordPath: null
    });
  });

  it("restarts an unloaded installed v3 runner beside its exact loaded oMLX", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-v3-restart-"));
    const recordPath = join(root, "activation-record.json");
    const legacy = legacyRecordValue(root, recordValue(root));
    await writeFile(recordPath, `${JSON.stringify(legacy)}\n`);
    const launchd = launchdHarness(
      root,
      legacy as unknown as ReturnType<typeof recordValue>,
      [
        {
          root,
          record: legacy as unknown as ReturnType<typeof recordValue>,
          component: "omlxServer"
        }
      ]
    );
    const commands: Array<[string, string[]]> = [];
    const install = vi.fn();

    const result = await activateLaunchAgents(
      {
        recordPath,
        priorRecordPath: recordPath,
        transitionMode: "rollback"
      },
      {
        uid: 501,
        verify: installationVerifier(recordPath, recordPath, "target"),
        install,
        command: async (file: string, args: string[]) => {
          commands.push([file, args]);
          return await launchd.command(file, args);
        }
      }
    );

    expect(result).toMatchObject({
      status: "ok",
      releaseSha: legacy.releaseSha,
      activationId: null,
      changed: true,
      drainReceipt: null
    });
    expect(install).not.toHaveBeenCalled();
    expect(commands.some(([, args]) => args[0] === "bootout")).toBe(false);
    expect(
      commands.some(
        ([file, args]) =>
          file === "/bin/launchctl" &&
          args[0] === "bootstrap" &&
          args[2] === legacy.launchAgents.narrativeRunner.path
      )
    ).toBe(true);
    expect(
      commands
        .filter(([file]) => file === legacy.executables.node.path)
        .map(([, args]) => args.at(-1))
    ).toEqual(["check", "status"]);
    expect(launchd.loaded.has("gui/501/ai.alex.omlx-server")).toBe(true);
    expect(launchd.loaded.has("gui/501/ai.alex.narrative-runner")).toBe(true);
  });
});
