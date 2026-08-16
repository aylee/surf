import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverRunnerActivationFromInstalledPlist,
  verifyActiveRunnerCompatibility
} from "../lib/release-runner-compatibility.mjs";

const ACTIVATION_ID = "activation-20260815-a";
const PROTOCOL = "1".repeat(64);
const ARTIFACT = "2".repeat(64);
const SOURCE_REVISION = "3".repeat(40);
const RESULT_TOKEN = "result-token-" + "r".repeat(52);
const STATUS_HMAC_KEY = "status-key-" + "h".repeat(54);
const QUEUE_API_TOKEN = "queue-token-" + "q".repeat(52);
const GEMINI_TOKEN = "gemini-token-" + "g".repeat(51);
const NOW_ISO = "2026-08-15T20:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const CLOUDFLARE_ACCOUNT_ID = "a".repeat(32);
const QUEUE_ID = "b".repeat(32);
const RUNNER_WRAPPER_PID = 4101;
const OMLX_PID = 4102;
const RUNNER_HEARTBEAT_PID = 4103;
const PROCESS_STARTED_AT = "Sat Aug 15 19:00:00 2026";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function runnerEnvironmentValues(overrides = {}) {
  return {
    NARRATIVE_RUNNER_RELEASE_SHA: SOURCE_REVISION,
    NARRATIVE_RUNNER_STATUS_HMAC_KEY: STATUS_HMAC_KEY,
    NARRATIVE_RUNNER_CF_API_TOKEN: QUEUE_API_TOKEN,
    NARRATIVE_RUNNER_CF_ACCOUNT_ID: CLOUDFLARE_ACCOUNT_ID,
    NARRATIVE_RUNNER_CF_QUEUE_ID: QUEUE_ID,
    NARRATIVE_RUNNER_CF_QUEUE_NAME: "surf-narrative",
    NARRATIVE_RUNNER_CF_DLQ_NAME: "surf-narrative-dlq",
    NARRATIVE_RUNNER_TARGET_MAP_JSON: JSON.stringify({
      "surf.analysis.v5": {
        url: "https://surf.example/api/internal/narratives/results",
        tokenEnv: "SURF_NARRATIVE_RESULT_TOKEN"
      }
    }),
    NARRATIVE_RUNNER_STATUS_FILE: "/unused/record-owned-value",
    NARRATIVE_RUNNER_OMLX_MODEL: "model-test",
    SURF_NARRATIVE_RESULT_TOKEN: RESULT_TOKEN,
    ...overrides
  };
}

function runnerEnvironment(overrides = {}) {
  const values = runnerEnvironmentValues(overrides);
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

function environmentFingerprint(values = runnerEnvironmentValues()) {
  const canonical = Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
  );
  return createHmac("sha256", values.NARRATIVE_RUNNER_STATUS_HMAC_KEY)
    .update("surf-runner-env-v1")
    .update("\u0000")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function status(overrides = {}) {
  return {
    schemaVersion: 3,
    runnerId: "runner-test",
    pid: RUNNER_HEARTBEAT_PID,
    modelId: "model-test",
    activationId: ACTIVATION_ID,
    runnerArtifactSha256: ARTIFACT,
    sourceRevision: SOURCE_REVISION,
    runtimeFingerprint: environmentFingerprint(),
    acceptedProtocolFingerprints: [PROTOCOL],
    state: "idle",
    startedAt: "2026-08-15T19:00:00.000Z",
    updatedAt: NOW_ISO,
    inFlight: 0,
    pulled: 10,
    acked: 10,
    retried: 0,
    terminal: 0,
    backlogCount: 0,
    lastOutcome: "idle",
    lastErrorCode: null,
    ...overrides
  };
}

function plist(recordPath, { records = [recordPath], command = "run" } = {}) {
  const strings = [
    "/usr/bin/env",
    "-i",
    "HOME=/tmp/a&amp;b",
    "/usr/bin/node",
    "/service/run-verified-runner.mjs",
    ...records.flatMap((value) => ["--record", value]),
    "--command",
    command
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>ai.alex.narrative-runner</string>
<key>ProgramArguments</key><array>
${strings.map((value) => `<string>${value}</string>`).join("\n")}
</array></dict></plist>\n`;
}

async function fixture() {
  const createdRoot = await mkdtemp(join(tmpdir(), "surf-runner-compat-"));
  const root = await realpath(createdRoot);
  const serviceRoot = join(root, "service");
  const activationDirectory = join(serviceRoot, "launch-agents", ACTIVATION_ID);
  await mkdir(activationDirectory, { recursive: true });
  const recordPath = join(activationDirectory, "activation-record.json");
  const environmentPath = join(root, "runner.env");
  const statusPath = join(root, "status.json");
  const installedDirectory = join(root, "Library", "LaunchAgents");
  await mkdir(installedDirectory, { recursive: true });
  const runnerPlistPath = join(installedDirectory, "ai.alex.narrative-runner.plist");
  const omlxPlistPath = join(installedDirectory, "ai.alex.omlx-server.plist");
  const runnerPlistContents = plist(recordPath);
  const omlxPlistContents = "<plist><dict><key>Label</key><string>ai.alex.omlx-server</string></dict></plist>\n";
  await Promise.all([
    writeFile(environmentPath, runnerEnvironment(), { mode: 0o600 }),
    writeFile(statusPath, `${JSON.stringify(status())}\n`, { mode: 0o600 }),
    writeFile(runnerPlistPath, runnerPlistContents, { mode: 0o600 }),
    writeFile(omlxPlistPath, omlxPlistContents, { mode: 0o600 })
  ]);
  const record = {
    schemaVersion: 4,
    activationId: ACTIVATION_ID,
    source: { revision: SOURCE_REVISION, repositoryPath: join(root, "release") },
    runnerArtifact: { sha256: ARTIFACT },
    acceptedProtocols: [
      { family: "surf.narrative", version: 1, fingerprint: PROTOCOL }
    ],
    runtime: {
      environmentPath,
      environmentFingerprint: environmentFingerprint(),
      statusFile: statusPath
    },
    model: { id: "model-test" },
    launchAgents: {
      narrativeRunner: {
        path: runnerPlistPath,
        sha256: sha256(runnerPlistContents)
      },
      omlxServer: {
        path: omlxPlistPath,
        sha256: sha256(omlxPlistContents)
      }
    },
    executables: {
      node: { path: "/usr/bin/node" },
      runnerGuard: { path: "/service/run-verified-runner.mjs" }
    }
  };
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return {
    root,
    serviceRoot,
    recordPath,
    environmentPath,
    statusPath,
    runnerPlistPath,
    omlxPlistPath,
    record,
    async writeRecord(change = {}) {
      const next = { ...record, ...change };
      await writeFile(recordPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      return next;
    },
    async writeStatus(change = {}) {
      await writeFile(statusPath, `${JSON.stringify(status(change))}\n`, { mode: 0o600 });
    },
    async writeEnvironment(change = {}) {
      await writeFile(environmentPath, runnerEnvironment(change), { mode: 0o600 });
    }
  };
}

function verificationOptions(value, overrides = {}) {
  return {
    serviceRoot: value.serviceRoot,
    activationId: ACTIVATION_ID,
    expectedProtocolFingerprint: PROTOCOL,
    expectedCloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
    expectedQueueId: QUEUE_ID,
    expectedQueueName: "surf-narrative",
    expectedDeadLetterQueueName: "surf-narrative-dlq",
    expectedCallbackOrigin: "https://surf.example",
    expectedResultTargetId: "surf.analysis.v5",
    workerResultToken: RESULT_TOKEN,
    workerGeminiToken: GEMINI_TOKEN,
    ...overrides
  };
}

function verificationDependencies(value, overrides = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      uid: 501,
      now: () => NOW_MS,
      pidAlive: () => true,
      verifyActivation: async (recordPath, options) => {
        calls.push({ type: "verify", recordPath, options });
        return {
          status: "ok",
          schemaVersion: 4,
          transitionOnly: false,
          activationId: ACTIVATION_ID,
          releaseSha: SOURCE_REVISION,
          runnerArtifactSha256: ARTIFACT,
          modelId: "model-test",
          acceptedProtocols: [
            { family: "surf.narrative", version: 1, fingerprint: PROTOCOL }
          ]
        };
      },
      command: async (file, args) => {
        if (file === value.record.executables.node.path) {
          calls.push({ type: "health-check", file, args });
          return { status: 0, stdout: "" };
        }
        if (file === "/bin/ps") {
          const pid = Number(args.at(-1));
          const parentPid = pid === RUNNER_HEARTBEAT_PID ? RUNNER_WRAPPER_PID : 1;
          calls.push({ type: "ps", pid, parentPid });
          return {
            status: 0,
            stdout: `${pid} ${parentPid} ${PROCESS_STARTED_AT}\n`
          };
        }
        const label = args[1].endsWith("/ai.alex.narrative-runner")
          ? "runner"
          : "omlx";
        const path = label === "runner" ? value.runnerPlistPath : value.omlxPlistPath;
        const pid = label === "runner" ? RUNNER_WRAPPER_PID : OMLX_PID;
        calls.push({ type: "launchctl", label, path, pid });
        return { status: 0, stdout: `path = ${path}\nstate = running\npid = ${pid}\n` };
      },
      ...overrides
    }
  };
}

test("trusted-id verification returns a bounded secret-free v4 compatibility receipt", async () => {
  const value = await fixture();
  const { calls, dependencies } = verificationDependencies(value);
  const receipt = await verifyActiveRunnerCompatibility(
    verificationOptions(value),
    dependencies
  );

  assert.deepEqual(receipt, {
    schemaVersion: 1,
    activationId: ACTIVATION_ID,
    runnerArtifactSha256: ARTIFACT,
    sourceRevision: SOURCE_REVISION,
    acceptedProtocolFingerprints: [PROTOCOL],
    runtimeFingerprint: environmentFingerprint(),
    resultTargetId: "surf.analysis.v5",
    bindingHmacs: {
      queue: receipt.bindingHmacs.queue,
      cloudflareAccount: receipt.bindingHmacs.cloudflareAccount,
      queueId: receipt.bindingHmacs.queueId,
      deadLetterQueue: receipt.bindingHmacs.deadLetterQueue,
      callback: receipt.bindingHmacs.callback,
      resultToken: receipt.bindingHmacs.resultToken
    }
  });
  for (const fingerprint of Object.values(receipt.bindingHmacs)) {
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
  }
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(RESULT_TOKEN), false);
  assert.equal(serialized.includes(STATUS_HMAC_KEY), false);
  assert.equal(serialized.includes("https://surf.example"), false);
  assert.equal(serialized.includes("surf-narrative-dlq"), false);
  assert.deepEqual(calls[0], {
    type: "verify",
    recordPath: value.recordPath,
    options: { requireInstalled: true, allowLegacyV3: false }
  });
  assert.equal(calls.filter(({ type }) => type === "launchctl").length, 4);
  assert.equal(calls.filter(({ type }) => type === "ps").length, 4);
  assert.deepEqual(
    calls.find(({ type }) => type === "health-check")?.args,
    [
      value.record.executables.runnerGuard.path,
      "--record",
      value.recordPath,
      "--command",
      "check"
    ]
  );
});

test("normal verification cannot discover or traverse an untrusted activation", async () => {
  const value = await fixture();
  const { dependencies } = verificationDependencies(value);
  await assert.rejects(
    verifyActiveRunnerCompatibility(
      verificationOptions(value, { activationId: "../outside" }),
      dependencies
    ),
    /trusted active runner activationId/
  );
  await assert.rejects(
    verifyActiveRunnerCompatibility(
      verificationOptions(value, { activationId: "different-activation" }),
      dependencies
    ),
    /activation record/
  );
});

test("normal verification rejects legacy or incompatible activation verifier results", async () => {
  const value = await fixture();
  const incompatible = verificationDependencies(value, {
    verifyActivation: async () => ({
      status: "ok",
      schemaVersion: 3,
      transitionOnly: true,
      activationId: ACTIVATION_ID,
      releaseSha: SOURCE_REVISION,
      runnerArtifactSha256: ARTIFACT,
      modelId: "model-test",
      acceptedProtocols: [
        { family: "surf.narrative", version: 1, fingerprint: PROTOCOL }
      ]
    })
  });
  await assert.rejects(
    verifyActiveRunnerCompatibility(verificationOptions(value), incompatible.dependencies),
    /did not attest v4 identity/
  );

  const missingProtocol = "9".repeat(64);
  await assert.rejects(
    verifyActiveRunnerCompatibility(
      verificationOptions(value, { expectedProtocolFingerprint: missingProtocol }),
      verificationDependencies(value).dependencies
    ),
    /does not accept the expected narrative protocol/
  );
});

test("installed and loaded plist identity is exact and process-bound", async (t) => {
  await t.test("installed content hash", async () => {
    const value = await fixture();
    await writeFile(value.runnerPlistPath, `${await readFile(value.runnerPlistPath, "utf8")} `, {
      mode: 0o600
    });
    await assert.rejects(
      verifyActiveRunnerCompatibility(
        verificationOptions(value),
        verificationDependencies(value).dependencies
      ),
      /differs from the active runner activation record/
    );
  });

  await t.test("loaded persistent path", async () => {
    const value = await fixture();
    const { dependencies } = verificationDependencies(value, {
      command: async (_file, args) => {
        const runner = args[1].endsWith("/ai.alex.narrative-runner");
        const path = runner ? `${value.runnerPlistPath}.other` : value.omlxPlistPath;
        return {
          status: 0,
          stdout: `path = ${path}\nstate = running\npid = ${runner ? RUNNER_WRAPPER_PID : OMLX_PID}\n`
        };
      }
    });
    await assert.rejects(
      verifyActiveRunnerCompatibility(verificationOptions(value), dependencies),
      /not loaded from the exact recorded persistent plist/
    );
  });

  await t.test("loaded wrapper directly owns the heartbeat child", async () => {
    const value = await fixture();
    await value.writeStatus({ pid: 9999 });
    await assert.rejects(
      verifyActiveRunnerCompatibility(
        verificationOptions(value),
        verificationDependencies(value).dependencies
      ),
      /not a direct child/
    );
  });

  await t.test("wrapper and heartbeat PIDs must be distinct", async () => {
    const value = await fixture();
    await value.writeStatus({ pid: RUNNER_WRAPPER_PID });
    await assert.rejects(
      verifyActiveRunnerCompatibility(
        verificationOptions(value),
        verificationDependencies(value).dependencies
      ),
      /not distinct/
    );
  });

  for (const [name, stdout, message] of [
    ["malformed ps", "not-a-process\n", /process attestation is malformed/],
    [
      "ambiguous ps",
      `${RUNNER_HEARTBEAT_PID} ${RUNNER_WRAPPER_PID} ${PROCESS_STARTED_AT}\n${RUNNER_HEARTBEAT_PID} ${RUNNER_WRAPPER_PID} ${PROCESS_STARTED_AT}\n`,
      /process attestation is ambiguous/
    ]
  ]) {
    await t.test(name, async () => {
      const value = await fixture();
      const base = verificationDependencies(value);
      const command = base.dependencies.command;
      await assert.rejects(
        verifyActiveRunnerCompatibility(verificationOptions(value), {
          ...base.dependencies,
          command: async (file, args, options) =>
            file === "/bin/ps" && Number(args.at(-1)) === RUNNER_HEARTBEAT_PID
              ? { status: 0, stdout }
              : command(file, args, options)
        }),
        message
      );
    });
  }

  await t.test("heartbeat child must remain directly parented to the wrapper", async () => {
    const value = await fixture();
    const base = verificationDependencies(value);
    const command = base.dependencies.command;
    let heartbeatInspections = 0;
    await assert.rejects(
      verifyActiveRunnerCompatibility(verificationOptions(value), {
        ...base.dependencies,
        command: async (file, args, options) => {
          if (file === "/bin/ps" && Number(args.at(-1)) === RUNNER_HEARTBEAT_PID) {
            heartbeatInspections += 1;
            return {
              status: 0,
              stdout: `${RUNNER_HEARTBEAT_PID} ${heartbeatInspections === 1 ? RUNNER_WRAPPER_PID : 1} ${PROCESS_STARTED_AT}\n`
            };
          }
          return command(file, args, options);
        }
      }),
      /not a direct child/
    );
  });

  await t.test("wrapper PID reuse is rejected by stable process start identity", async () => {
    const value = await fixture();
    const base = verificationDependencies(value);
    const command = base.dependencies.command;
    let wrapperInspections = 0;
    await assert.rejects(
      verifyActiveRunnerCompatibility(verificationOptions(value), {
        ...base.dependencies,
        command: async (file, args, options) => {
          if (file === "/bin/ps" && Number(args.at(-1)) === RUNNER_WRAPPER_PID) {
            wrapperInspections += 1;
            return {
              status: 0,
              stdout: `${RUNNER_WRAPPER_PID} 1 ${wrapperInspections === 1 ? PROCESS_STARTED_AT : "Sat Aug 15 19:00:01 2026"}\n`
            };
          }
          return command(file, args, options);
        }
      }),
      /process identity changed/
    );
  });

  await t.test("launchd wrapper restart is rejected after the live check", async () => {
    const value = await fixture();
    const base = verificationDependencies(value);
    const command = base.dependencies.command;
    let runnerPrints = 0;
    await assert.rejects(
      verifyActiveRunnerCompatibility(verificationOptions(value), {
        ...base.dependencies,
        command: async (file, args, options) => {
          if (
            file === "/bin/launchctl" &&
            args[1].endsWith("/ai.alex.narrative-runner")
          ) {
            runnerPrints += 1;
            const pid = runnerPrints === 1 ? RUNNER_WRAPPER_PID : 4999;
            return {
              status: 0,
              stdout: `path = ${value.runnerPlistPath}\nstate = running\npid = ${pid}\n`
            };
          }
          return command(file, args, options);
        }
      }),
      /process identity changed during preflight/
    );
  });

  await t.test("both loaded PIDs remain alive", async () => {
    const value = await fixture();
    const { dependencies } = verificationDependencies(value, {
      pidAlive: (pid) => pid !== OMLX_PID
    });
    await assert.rejects(
      verifyActiveRunnerCompatibility(verificationOptions(value), dependencies),
      /process identity is not alive/
    );
  });

  await t.test("heartbeat child must remain alive", async () => {
    const value = await fixture();
    const { dependencies } = verificationDependencies(value, {
      pidAlive: (pid) => pid !== RUNNER_HEARTBEAT_PID
    });
    await assert.rejects(
      verifyActiveRunnerCompatibility(verificationOptions(value), dependencies),
      /heartbeat child process is not alive/
    );
  });
});

test("fresh healthy status v3 must exactly match record identity", async (t) => {
  const cases = [
    ["stale", { updatedAt: "2026-08-15T19:59:00.000Z" }, { maxStatusAgeMs: 1_000 }, /stale/],
    ["future", { updatedAt: "2026-08-15T20:01:00.000Z" }, {}, /future-dated/],
    ["halted", { state: "halted" }, {}, /not healthy/],
    ["errored", { lastErrorCode: "callback_failed" }, {}, /not healthy/],
    ["artifact", { runnerArtifactSha256: "8".repeat(64) }, {}, /identity differs/],
    ["source", { sourceRevision: "8".repeat(40) }, {}, /identity differs/],
    ["runtime-invalid", { runtimeFingerprint: "bad" }, {}, /runtime fingerprint is invalid/],
    ["runtime-mismatch", { runtimeFingerprint: "8".repeat(64) }, {}, /identity differs/],
    ["protocol", { acceptedProtocolFingerprints: ["8".repeat(64)] }, {}, /identity differs/]
  ];
  for (const [name, statusChange, optionChange, message] of cases) {
    await t.test(name, async () => {
      const value = await fixture();
      await value.writeStatus(statusChange);
      await assert.rejects(
        verifyActiveRunnerCompatibility(
          verificationOptions(value, optionChange),
          verificationDependencies(value).dependencies
        ),
        message
      );
    });
  }

  await t.test("unknown status fields fail closed", async () => {
    const value = await fixture();
    await value.writeStatus({ untrusted: true });
    await assert.rejects(
      verifyActiveRunnerCompatibility(
        verificationOptions(value),
        verificationDependencies(value).dependencies
      ),
      /schema is invalid/
    );
  });
});

test("live Queue and model preflight is required after heartbeat attestation", async () => {
  const value = await fixture();
  const base = verificationDependencies(value);
  const command = base.dependencies.command;
  await assert.rejects(
    verifyActiveRunnerCompatibility(verificationOptions(value), {
      ...base.dependencies,
      command: async (file, args, options) =>
        file === value.record.executables.node.path
          ? { status: 1, stdout: "secret-free failure" }
          : command(file, args, options)
    }),
    /live Queue and model preflight failed/
  );
});

test("account, Queue, DLQ, result target, callback, and result token must match exactly", async (t) => {
  const cases = [
    [
      "Cloudflare account",
      { NARRATIVE_RUNNER_CF_ACCOUNT_ID: "c".repeat(32) },
      /Cloudflare account binding is incompatible/
    ],
    [
      "Queue ID",
      { NARRATIVE_RUNNER_CF_QUEUE_ID: "d".repeat(32) },
      /Queue ID binding is incompatible/
    ],
    [
      "queue",
      { NARRATIVE_RUNNER_CF_QUEUE_NAME: "other-queue" },
      /Queue binding is incompatible/
    ],
    [
      "dead-letter queue",
      { NARRATIVE_RUNNER_CF_DLQ_NAME: "other-dlq" },
      /dead-letter Queue binding is incompatible/
    ],
    [
      "callback",
      {
        NARRATIVE_RUNNER_TARGET_MAP_JSON: JSON.stringify({
          "surf.analysis.v5": {
            url: "https://other.example/api/internal/narratives/results",
            tokenEnv: "SURF_NARRATIVE_RESULT_TOKEN"
          }
        })
      },
      /callback is incompatible/
    ],
    [
      "result target",
      {
        NARRATIVE_RUNNER_TARGET_MAP_JSON: JSON.stringify({
          "other.analysis.v1": {
            url: "https://surf.example/api/internal/narratives/results",
            tokenEnv: "SURF_NARRATIVE_RESULT_TOKEN"
          }
        })
      },
      /result target is incompatible/
    ],
    [
      "token",
      { SURF_NARRATIVE_RESULT_TOKEN: "different-token-" + "x".repeat(52) },
      /result token is incompatible/
    ]
  ];
  for (const [name, environmentChange, message] of cases) {
    await t.test(name, async () => {
      const value = await fixture();
      await value.writeEnvironment(environmentChange);
      await assert.rejects(
        verifyActiveRunnerCompatibility(
          verificationOptions(value),
          verificationDependencies(value).dependencies
        ),
        message
      );
    });
  }
});

test("Queue, status, result, and Gemini secret roles remain distinct", async () => {
  const value = await fixture();
  await assert.rejects(
    verifyActiveRunnerCompatibility(
      verificationOptions(value, { workerGeminiToken: RESULT_TOKEN }),
      verificationDependencies(value).dependencies
    ),
    /secret roles must be distinct/
  );
});

test("environment drift during verification fails closed without exposing secrets", async () => {
  const value = await fixture();
  let aliveChecks = 0;
  const { dependencies } = verificationDependencies(value, {
    pidAlive: (pid) => {
      aliveChecks += 1;
      if (aliveChecks === 3) {
        writeFileSync(
          value.environmentPath,
          runnerEnvironment({ NARRATIVE_RUNNER_CF_QUEUE_NAME: "drifted-queue" }),
          { mode: 0o600 }
        );
      }
      return pid > 0;
    }
  });
  let error;
  try {
    await verifyActiveRunnerCompatibility(verificationOptions(value), dependencies);
  } catch (candidate) {
    error = candidate;
  }
  assert.ok(error instanceof Error);
  assert.match(
    error.message,
    /environment changed|Queue binding is incompatible|environment must be a bounded/
  );
  assert.equal(error.message.includes(RESULT_TOKEN), false);
  assert.equal(error.message.includes(STATUS_HMAC_KEY), false);
});

test("adoption/recovery discovery reads one exact installed --record argument", async () => {
  const value = await fixture();
  assert.deepEqual(
    await discoverRunnerActivationFromInstalledPlist({
      serviceRoot: value.serviceRoot,
      installedPlistPath: value.runnerPlistPath
    }),
    {
      activationId: ACTIVATION_ID,
      recordPath: value.recordPath,
      recordSchemaVersion: 4,
      transitionOnly: false,
      legacyCoupledSourceRevision: null
    }
  );
});

test("legacy v3 discovery is explicit transition evidence and never compatibility", async () => {
  const value = await fixture();
  const legacy = {
    schemaVersion: 3,
    releaseSha: SOURCE_REVISION,
    repositoryPath: join(value.root, "release"),
    runnerEnvPath: value.environmentPath,
    statusFile: value.statusPath,
    runnerEnvironmentFingerprint: environmentFingerprint(),
    modelId: "model-test",
    launchAgents: {
      narrativeRunner: value.record.launchAgents.narrativeRunner
    }
  };
  await writeFile(value.recordPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

  await assert.rejects(
    discoverRunnerActivationFromInstalledPlist({
      serviceRoot: value.serviceRoot,
      installedPlistPath: value.runnerPlistPath
    }),
    /requires explicit allowLegacyV3 transition mode/
  );
  const evidence = await discoverRunnerActivationFromInstalledPlist({
    serviceRoot: value.serviceRoot,
    installedPlistPath: value.runnerPlistPath,
    allowLegacyV3: true
  });
  assert.deepEqual(evidence, {
    activationId: ACTIVATION_ID,
    recordPath: value.recordPath,
    recordSchemaVersion: 3,
    transitionOnly: true,
    legacyCoupledSourceRevision: SOURCE_REVISION
  });
  assert.equal("acceptedProtocolFingerprints" in evidence, false);
  assert.equal("runtimeFingerprint" in evidence, false);

  await assert.rejects(
    verifyActiveRunnerCompatibility(
      verificationOptions(value),
      verificationDependencies(value).dependencies
    ),
    /activation record v4 schema is invalid/
  );
});

test("legacy v3 transition discovery still requires exact installed plist ownership", async () => {
  const value = await fixture();
  const legacy = {
    schemaVersion: 3,
    releaseSha: SOURCE_REVISION,
    repositoryPath: join(value.root, "release"),
    runnerEnvPath: value.environmentPath,
    statusFile: value.statusPath,
    runnerEnvironmentFingerprint: environmentFingerprint(),
    modelId: "model-test",
    launchAgents: {
      narrativeRunner: {
        ...value.record.launchAgents.narrativeRunner,
        sha256: "f".repeat(64)
      }
    }
  };
  await writeFile(value.recordPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    discoverRunnerActivationFromInstalledPlist({
      serviceRoot: value.serviceRoot,
      installedPlistPath: value.runnerPlistPath,
      allowLegacyV3: true
    }),
    /does not own the installed runner plist/
  );
});

test("adoption/recovery discovery rejects ambiguous or unsafe installed plist arguments", async (t) => {
  await t.test("duplicate --record", async () => {
    const value = await fixture();
    await writeFile(
      value.runnerPlistPath,
      plist(value.recordPath, { records: [value.recordPath, value.recordPath] }),
      { mode: 0o600 }
    );
    await assert.rejects(
      discoverRunnerActivationFromInstalledPlist({
        serviceRoot: value.serviceRoot,
        installedPlistPath: value.runnerPlistPath
      }),
      /one exact --record argument/
    );
  });

  await t.test("--record= lookalike", async () => {
    const value = await fixture();
    const contents = plist(value.recordPath).replace(
      `<string>--record</string>\n<string>${value.recordPath}</string>`,
      `<string>--record=${value.recordPath}</string>`
    );
    await writeFile(value.runnerPlistPath, contents, { mode: 0o600 });
    await assert.rejects(
      discoverRunnerActivationFromInstalledPlist({
        serviceRoot: value.serviceRoot,
        installedPlistPath: value.runnerPlistPath
      }),
      /one exact --record argument/
    );
  });

  await t.test("record outside service activation store", async () => {
    const value = await fixture();
    await writeFile(value.runnerPlistPath, plist(join(value.root, "outside.json")), {
      mode: 0o600
    });
    await assert.rejects(
      discoverRunnerActivationFromInstalledPlist({
        serviceRoot: value.serviceRoot,
        installedPlistPath: value.runnerPlistPath
      }),
      /outside the activation store/
    );
  });

  await t.test("non-run command", async () => {
    const value = await fixture();
    await writeFile(value.runnerPlistPath, plist(value.recordPath, { command: "status" }), {
      mode: 0o600
    });
    await assert.rejects(
      discoverRunnerActivationFromInstalledPlist({
        serviceRoot: value.serviceRoot,
        installedPlistPath: value.runnerPlistPath
      }),
      /exact --command run/
    );
  });

  await t.test("symlinked installed plist", async () => {
    const value = await fixture();
    const alias = join(value.root, "runner.plist.alias");
    await symlink(value.runnerPlistPath, alias);
    await assert.rejects(
      discoverRunnerActivationFromInstalledPlist({
        serviceRoot: value.serviceRoot,
        installedPlistPath: alias
      }),
      /canonical non-symlink/
    );
  });

  await t.test("non-private installed plist", async () => {
    const value = await fixture();
    await chmod(value.runnerPlistPath, 0o644);
    await assert.rejects(
      discoverRunnerActivationFromInstalledPlist({
        serviceRoot: value.serviceRoot,
        installedPlistPath: value.runnerPlistPath
      }),
      /mode-0600/
    );
  });
});
