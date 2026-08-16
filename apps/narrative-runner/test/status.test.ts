import { describe, expect, it } from "vitest";
import { NARRATIVE_PROTOCOL_FINGERPRINT } from "@surf/narrative-contracts";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heartbeatMatchesConfig,
  heartbeatIsFresh,
  runnerStatusHealthy,
  statusFreshnessThresholdMs
} from "../src/cli";
import {
  FileStatusStore,
  MemoryStatusStore,
  readRunnerStatus,
  StatusTracker,
  type RunnerStatus,
  type StatusStore
} from "../src/status";
import { TestClock } from "./fakes";

function status(updatedAt: string, state: RunnerStatus["state"] = "idle"): RunnerStatus {
  return {
    schemaVersion: 3,
    runnerId: "runner-test",
    pid: process.pid,
    modelId: "local-model",
    activationId: `${"a".repeat(40)}-r1`,
    runnerArtifactSha256: "c".repeat(64),
    sourceRevision: "a".repeat(40),
    runtimeFingerprint: "b".repeat(64),
    acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT],
    state,
    startedAt: "2026-08-09T18:00:00.000Z",
    updatedAt,
    inFlight: 0,
    pulled: 0,
    acked: 0,
    retried: 0,
    terminal: 0,
    backlogCount: null,
    lastOutcome: null,
    lastErrorCode: null
  };
}

describe("runner status persistence", () => {
  it("atomically replaces a private heartbeat and leaves no temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-runner-status-"));
    try {
      const directory = join(root, "state");
      const path = join(directory, "status.json");
      const store = new FileStatusStore(path);
      const first = status("2026-08-09T18:00:00.000Z");
      const second = {
        ...first,
        state: "processing" as const,
        inFlight: 1,
        updatedAt: "2026-08-09T18:00:01.000Z"
      };

      await store.write(first);
      await store.write(second);
      await expect(
        store.write({ ...second, lastOutcome: "x".repeat(64 * 1024) })
      ).rejects.toThrow("Runner status exceeds its bounded file size");

      await expect(readRunnerStatus(path)).resolves.toEqual(second);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(["status.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects status-file and status-directory symlinks without touching their targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-runner-status-symlink-"));
    try {
      const directory = join(root, "state");
      const path = join(directory, "status.json");
      const target = join(root, "target.json");
      await mkdir(directory, { mode: 0o700 });
      await writeFile(target, "preserve\n", { mode: 0o600 });
      await symlink(target, path);

      await expect(
        new FileStatusStore(path).write(status("2026-08-09T18:00:00.000Z"))
      ).rejects.toThrow(/mode-0600 regular file/);
      await expect(readRunnerStatus(path)).rejects.toThrow("Runner status file is invalid");
      await expect(readFile(target, "utf8")).resolves.toBe("preserve\n");

      const safeDirectory = join(root, "safe-state");
      const safePath = join(safeDirectory, "status.json");
      await mkdir(safeDirectory, { mode: 0o700 });
      await symlink(target, `${safePath}.tmp-${process.pid}`);
      const heartbeat = status("2026-08-09T18:00:00.000Z");
      await new FileStatusStore(safePath).write(heartbeat);
      await expect(readRunnerStatus(safePath)).resolves.toEqual(heartbeat);
      await expect(readFile(target, "utf8")).resolves.toBe("preserve\n");

      const realDirectory = join(root, "real-state");
      const linkedDirectory = join(root, "linked-state");
      await mkdir(realDirectory, { mode: 0o700 });
      await symlink(realDirectory, linkedDirectory);
      const linkedPath = join(linkedDirectory, "status.json");
      await expect(
        new FileStatusStore(linkedPath).write(status("2026-08-09T18:00:00.000Z"))
      ).rejects.toThrow("Runner status directory is unsafe");
      await expect(readRunnerStatus(linkedPath)).rejects.toThrow(
        "Runner status file is invalid"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runner status health", () => {
  it("rejects a fresh heartbeat from a different runner, model, release, or effective environment", () => {
    const active = status("2026-08-09T18:00:00.000Z");
    expect(heartbeatMatchesConfig(active, {
      runnerId: "runner-test",
      activationId: `${"a".repeat(40)}-r1`,
      artifactSha256: "c".repeat(64),
      acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT],
      releaseSha: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      omlx: { modelId: "local-model" }
    })).toBe(true);
    expect(heartbeatMatchesConfig({ ...active, runnerId: "retired-runner" }, {
      runnerId: "runner-test",
      activationId: `${"a".repeat(40)}-r1`,
      artifactSha256: "c".repeat(64),
      acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT],
      releaseSha: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      omlx: { modelId: "local-model" }
    })).toBe(false);
    expect(heartbeatMatchesConfig({ ...active, modelId: "old-model" }, {
      runnerId: "runner-test",
      activationId: `${"a".repeat(40)}-r1`,
      artifactSha256: "c".repeat(64),
      acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT],
      releaseSha: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      omlx: { modelId: "local-model" }
    })).toBe(false);
    expect(heartbeatMatchesConfig({ ...active, sourceRevision: "c".repeat(40) }, {
      runnerId: "runner-test",
      activationId: `${"a".repeat(40)}-r1`,
      artifactSha256: "c".repeat(64),
      acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT],
      releaseSha: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      omlx: { modelId: "local-model" }
    })).toBe(false);
    expect(heartbeatMatchesConfig({ ...active, runtimeFingerprint: "d".repeat(64) }, {
      runnerId: "runner-test",
      activationId: `${"a".repeat(40)}-r1`,
      artifactSha256: "c".repeat(64),
      acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT],
      releaseSha: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      omlx: { modelId: "local-model" }
    })).toBe(false);
    const expected = {
      runnerId: "runner-test",
      activationId: `${"a".repeat(40)}-r1`,
      artifactSha256: "c".repeat(64),
      acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT],
      releaseSha: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      omlx: { modelId: "local-model" }
    };
    expect(
      heartbeatMatchesConfig({ ...active, activationId: "different-r1" }, expected)
    ).toBe(false);
    expect(
      heartbeatMatchesConfig(
        { ...active, runnerArtifactSha256: "e".repeat(64) },
        expected
      )
    ).toBe(false);
    expect(
      heartbeatMatchesConfig(
        { ...active, acceptedProtocolFingerprints: ["f".repeat(64)] },
        expected
      )
    ).toBe(false);
  });

  it("allows the default idle sleep, runner preflight, pull, and operator margin", () => {
    const config = {
      idleMaxMs: 120_000,
      pollIntervalMs: 5_000,
      heartbeatIntervalMs: 15_000,
      queueTimeoutMs: 30_000,
      omlx: { timeoutMs: 600_000 }
    };
    expect(statusFreshnessThresholdMs(config)).toBe(190_000);
    expect(
      heartbeatIsFresh(
        status("2026-08-09T18:00:00.000Z"),
        config,
        Date.parse("2026-08-09T18:03:10.000Z")
      )
    ).toBe(true);
    expect(
      heartbeatIsFresh(
        status("2026-08-09T18:00:00.000Z"),
        config,
        Date.parse("2026-08-09T18:03:10.001Z")
      )
    ).toBe(false);
  });

  it("is healthy only while error-free idle or processing work is fresh", () => {
    const active = status("2026-08-09T18:00:00.000Z");
    expect(
      runnerStatusHealthy({
        modelReady: true,
        queueReady: true,
        heartbeat: active,
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      })
    ).toBe(true);
    expect(
      runnerStatusHealthy({
        modelReady: true,
        queueReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "processing"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      })
    ).toBe(true);
    for (const unhealthy of [
      { modelReady: false, queueReady: true, heartbeat: active, heartbeatFresh: true, pidAlive: true, identityMatches: true },
      { modelReady: true, queueReady: false, heartbeat: active, heartbeatFresh: true, pidAlive: true, identityMatches: true },
      { modelReady: true, queueReady: true, heartbeat: active, heartbeatFresh: false, pidAlive: true, identityMatches: true },
      { modelReady: true, queueReady: true, heartbeat: active, heartbeatFresh: true, pidAlive: false, identityMatches: true },
      { modelReady: true, queueReady: true, heartbeat: active, heartbeatFresh: true, pidAlive: true, identityMatches: false },
      {
        modelReady: true,
        queueReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "stopped"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      },
      {
        modelReady: true,
        queueReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "starting"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      },
      {
        modelReady: true,
        queueReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "backing_off"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      },
      {
        modelReady: true,
        queueReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "halted"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      },
      {
        modelReady: true,
        queueReady: true,
        heartbeat: { ...active, lastErrorCode: "active_circuit" },
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      }
    ]) {
      expect(runnerStatusHealthy(unhealthy)).toBe(false);
    }
  });

  it("recovers the serialized write chain after one status-store failure", async () => {
    const clock = new TestClock();
    const durable = new MemoryStatusStore();
    let writes = 0;
    const flaky: StatusStore = {
      async write(value) {
        writes += 1;
        if (writes === 1) throw new Error("disk temporarily unavailable");
        await durable.write(value);
      }
    };
    const tracker = new StatusTracker(
      {
        runnerId: "runner-test",
        modelId: "local-model",
        activationId: `${"a".repeat(40)}-r1`,
        runnerArtifactSha256: "c".repeat(64),
        sourceRevision: "a".repeat(40),
        runtimeFingerprint: "b".repeat(64),
        acceptedProtocolFingerprints: [NARRATIVE_PROTOCOL_FINGERPRINT]
      },
      flaky,
      clock.now
    );
    await expect(tracker.update({ state: "idle" })).rejects.toThrow(
      "disk temporarily unavailable"
    );
    clock.advance(1_000);
    await expect(tracker.update({ state: "processing", inFlight: 1 })).resolves.toBeUndefined();
    expect(durable.writes).toEqual([
      expect.objectContaining({ state: "processing", inFlight: 1 })
    ]);
  });
});
