import { describe, expect, it } from "vitest";
import {
  heartbeatMatchesConfig,
  heartbeatIsFresh,
  runnerStatusHealthy,
  statusFreshnessThresholdMs
} from "../src/cli";
import {
  MemoryStatusStore,
  StatusTracker,
  type RunnerStatus,
  type StatusStore
} from "../src/status";
import { TestClock } from "./fakes";

function status(updatedAt: string, state: RunnerStatus["state"] = "idle"): RunnerStatus {
  return {
    schemaVersion: 1,
    runnerId: "runner-test",
    pid: process.pid,
    modelId: "local-model",
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

describe("runner status health", () => {
  it("rejects a fresh heartbeat from a different runner or model", () => {
    const active = status("2026-08-09T18:00:00.000Z");
    expect(heartbeatMatchesConfig(active, {
      runnerId: "runner-test",
      omlx: { modelId: "local-model" }
    })).toBe(true);
    expect(heartbeatMatchesConfig({ ...active, runnerId: "retired-runner" }, {
      runnerId: "runner-test",
      omlx: { modelId: "local-model" }
    })).toBe(false);
    expect(heartbeatMatchesConfig({ ...active, modelId: "old-model" }, {
      runnerId: "runner-test",
      omlx: { modelId: "local-model" }
    })).toBe(false);
  });

  it("allows the configured maximum idle sleep plus an operator margin", () => {
    const config = {
      idleMaxMs: 600_000,
      pollIntervalMs: 5_000,
      heartbeatIntervalMs: 15_000,
      queueTimeoutMs: 30_000
    };
    expect(statusFreshnessThresholdMs(config)).toBe(640_000);
    expect(
      heartbeatIsFresh(
        status("2026-08-09T18:00:00.000Z"),
        config,
        Date.parse("2026-08-09T18:10:40.000Z")
      )
    ).toBe(true);
    expect(
      heartbeatIsFresh(
        status("2026-08-09T18:00:00.000Z"),
        config,
        Date.parse("2026-08-09T18:10:40.001Z")
      )
    ).toBe(false);
  });

  it("is healthy only while error-free idle or processing work is fresh", () => {
    const active = status("2026-08-09T18:00:00.000Z");
    expect(
      runnerStatusHealthy({
        modelReady: true,
        heartbeat: active,
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      })
    ).toBe(true);
    expect(
      runnerStatusHealthy({
        modelReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "processing"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      })
    ).toBe(true);
    for (const unhealthy of [
      { modelReady: false, heartbeat: active, heartbeatFresh: true, pidAlive: true, identityMatches: true },
      { modelReady: true, heartbeat: active, heartbeatFresh: false, pidAlive: true, identityMatches: true },
      { modelReady: true, heartbeat: active, heartbeatFresh: true, pidAlive: false, identityMatches: true },
      { modelReady: true, heartbeat: active, heartbeatFresh: true, pidAlive: true, identityMatches: false },
      {
        modelReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "stopped"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      },
      {
        modelReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "starting"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      },
      {
        modelReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "backing_off"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      },
      {
        modelReady: true,
        heartbeat: status("2026-08-09T18:00:00.000Z", "halted"),
        heartbeatFresh: true,
        pidAlive: true,
        identityMatches: true
      },
      {
        modelReady: true,
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
    const tracker = new StatusTracker("runner-test", "local-model", flaky, clock.now);
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
