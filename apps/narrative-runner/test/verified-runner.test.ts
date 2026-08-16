import { EventEmitter } from "node:events";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runVerifiedRunner } from "../scripts/run-verified-runner.mjs";

async function activation(root: string, environmentLines: string[]) {
  const envPath = join(root, "runner.env");
  const recordPath = join(root, "activation-record.json");
  const releaseSha = "a".repeat(40);
  await writeFile(envPath, `${environmentLines.join("\n")}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);
  const record = {
    schemaVersion: 4,
    activationId: `${releaseSha}-r1`,
    source: { revision: releaseSha, repositoryPath: root },
    runnerArtifact: { path: join(root, "narrative-runner.mjs"), sha256: "b".repeat(64) },
    runtime: { environmentPath: envPath },
    executables: { node: { path: "/pinned/node" } },
    launchAgents: {
      narrativeRunner: { path: join(root, "home/Library/LaunchAgents/runner.plist") }
    }
  };
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { envPath, recordPath, releaseSha, record };
}

function successfulSpawn(invocation: Record<string, unknown>) {
  return (command: string, args: string[], options: any) => {
    Object.assign(invocation, { command, args, options });
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: (signal: string) => boolean;
    };
    child.killed = false;
    child.kill = () => true;
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
}

describe("verified runner launch guard", () => {
  it("launches the attested bundle with record-owned identity and no ambient overrides", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "surf-verified-runner-"))
    );
    const value = await activation(root, [
      `NARRATIVE_RUNNER_RELEASE_SHA=${"a".repeat(40)}`,
      "NARRATIVE_RUNNER_CF_QUEUE_NAME=attested-queue",
      'NARRATIVE_RUNNER_TARGET_MAP_JSON={"surf.analysis.v5":{"url":"https://surf.example/result","tokenEnv":"SURF_RESULT_TOKEN"}}',
      "SURF_RESULT_TOKEN=attested-result-token"
    ]);
    const verify = vi.fn(async () => ({ status: "ok" }));
    const invocation: Record<string, any> = {};
    process.env.NARRATIVE_RUNNER_CF_QUEUE_NAME = "ambient-wrong-queue";
    process.env.AMBIENT_ONLY_SECRET = "must-not-reach-child";
    try {
      await expect(
        runVerifiedRunner(
          ["--record", value.recordPath, "--command", "run"],
          { verify, spawn: successfulSpawn(invocation) as never }
        )
      ).resolves.toBe(0);
    } finally {
      delete process.env.NARRATIVE_RUNNER_CF_QUEUE_NAME;
      delete process.env.AMBIENT_ONLY_SECRET;
    }

    expect(verify).toHaveBeenCalledWith(value.recordPath, { requireInstalled: true });
    expect(invocation.command).toBe("/pinned/node");
    expect(invocation.args).toEqual([
      value.record.runnerArtifact.path,
      "run",
      "--expected-release-sha",
      value.releaseSha
    ]);
    expect(invocation.options.cwd).toBe(root);
    expect(invocation.options.env.NARRATIVE_RUNNER_CF_QUEUE_NAME).toBe("attested-queue");
    expect(invocation.options.env.NARRATIVE_RUNNER_ACTIVATION_ID).toBe(
      value.record.activationId
    );
    expect(invocation.options.env.NARRATIVE_RUNNER_ARTIFACT_SHA256).toBe(
      value.record.runnerArtifact.sha256
    );
    expect(invocation.options.env.AMBIENT_ONLY_SECRET).toBeUndefined();
  });

  it("does not spawn when activation verification fails", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "surf-verified-runner-drift-"))
    );
    const recordPath = join(root, "activation-record.json");
    await writeFile(recordPath, "{}\n", { mode: 0o600 });
    const spawn = vi.fn();
    await expect(
      runVerifiedRunner(
        ["--record", recordPath, "--command", "run"],
        { verify: async () => { throw new Error("drift"); }, spawn }
      )
    ).rejects.toThrow(/drift/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when the activation record changes across verification", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "surf-verified-runner-race-"))
    );
    const recordPath = join(root, "activation-record.json");
    await writeFile(recordPath, "{}\n", { mode: 0o600 });
    const spawn = vi.fn();
    await expect(
      runVerifiedRunner(
        ["--record", recordPath, "--command", "run"],
        {
          verify: async () => {
            await writeFile(recordPath, '{"changed":true}\n', { mode: 0o600 });
          },
          spawn: spawn as never
        }
      )
    ).rejects.toThrow(/changed during launch verification/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects legacy records instead of launching source through pnpm", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "surf-verified-runner-v3-"))
    );
    const recordPath = join(root, "activation-record.json");
    await writeFile(recordPath, `${JSON.stringify({ schemaVersion: 3 })}\n`, { mode: 0o600 });
    const spawn = vi.fn();
    await expect(
      runVerifiedRunner(
        ["--record", recordPath, "--command", "run"],
        { verify: async () => ({ status: "ok" }), spawn: spawn as never }
      )
    ).rejects.toThrow(/require an activation record v4 artifact/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects process-control variables from the attested dotenv", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "surf-verified-runner-process-env-"))
    );
    const value = await activation(root, [
      'NARRATIVE_RUNNER_TARGET_MAP_JSON={"surf.analysis.v5":{"url":"https://surf.example/result","tokenEnv":"SURF_RESULT_TOKEN"}}',
      "SURF_RESULT_TOKEN=result-token",
      "NODE_OPTIONS=--require=/tmp/untrusted.cjs"
    ]);
    const spawn = vi.fn();
    await expect(
      runVerifiedRunner(
        ["--record", value.recordPath, "--command", "run"],
        { verify: async () => ({ status: "ok" }), spawn: spawn as never }
      )
    ).rejects.toThrow(/unsupported runner environment setting NODE_OPTIONS/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
