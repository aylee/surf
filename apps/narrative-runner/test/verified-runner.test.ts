import { EventEmitter } from "node:events";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runVerifiedRunner } from "../scripts/run-verified-runner.mjs";

describe("verified runner launch guard", () => {
  it("verifies the installed activation before spawn and excludes ambient overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-verified-runner-"));
    const envPath = join(root, "runner.env");
    const recordPath = join(root, "activation-record.json");
    const releaseSha = "a".repeat(40);
    await writeFile(
      envPath,
      [
        `NARRATIVE_RUNNER_RELEASE_SHA=${releaseSha}`,
        "NARRATIVE_RUNNER_CF_QUEUE_NAME=attested-queue",
        'NARRATIVE_RUNNER_TARGET_MAP_JSON={"surf.analysis.v5":{"url":"https://surf.example/result","tokenEnv":"SURF_RESULT_TOKEN"}}',
        "SURF_RESULT_TOKEN=attested-result-token",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await chmod(envPath, 0o600);
    await writeFile(
      recordPath,
      `${JSON.stringify({
        releaseSha,
        repositoryPath: root,
        runnerEnvPath: envPath,
        executables: {
          node: { path: process.execPath },
          pnpm: { path: "/pinned/pnpm" }
        },
        launchAgents: {
          narrativeRunner: { path: join(root, "home/Library/LaunchAgents/runner.plist") }
        }
      })}\n`,
      { mode: 0o600 }
    );

    const verify = vi.fn(async () => ({ status: "ok" }));
    let invocation: { command?: string; args?: string[]; options?: any } = {};
    const spawn = vi.fn((command: string, args: string[], options: any) => {
      invocation = { command, args, options };
      const child = new EventEmitter() as EventEmitter & {
        killed: boolean;
        kill: (signal: string) => boolean;
      };
      child.killed = false;
      child.kill = () => true;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    process.env.NARRATIVE_RUNNER_CF_QUEUE_NAME = "ambient-wrong-queue";
    process.env.AMBIENT_ONLY_SECRET = "must-not-reach-child";
    try {
      await expect(
        runVerifiedRunner(
          ["--record", recordPath, "--command", "run"],
          { verify, spawn: spawn as never }
        )
      ).resolves.toBe(0);
    } finally {
      delete process.env.NARRATIVE_RUNNER_CF_QUEUE_NAME;
      delete process.env.AMBIENT_ONLY_SECRET;
    }

    expect(verify).toHaveBeenCalledWith(recordPath, { requireInstalled: true });
    expect(invocation.command).toBe("/pinned/pnpm");
    expect(invocation.args).toContain(releaseSha);
    expect(invocation.options.env.NARRATIVE_RUNNER_CF_QUEUE_NAME).toBe("attested-queue");
    expect(invocation.options.env.AMBIENT_ONLY_SECRET).toBeUndefined();
  });

  it("does not spawn when activation verification fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-verified-runner-drift-"));
    const recordPath = join(root, "activation-record.json");
    await writeFile(recordPath, "{}\n", { mode: 0o600 });
    const spawn = vi.fn();
    await expect(
      runVerifiedRunner(
        ["--record", recordPath, "--command", "run"],
        {
          verify: async () => {
            throw new Error("drift");
          },
          spawn
        }
      )
    ).rejects.toThrow(/drift/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when the activation record changes across verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-verified-runner-record-race-"));
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

  it("rejects process-control variables even when they appear in the attested dotenv", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-verified-runner-process-env-"));
    const envPath = join(root, "runner.env");
    const recordPath = join(root, "activation-record.json");
    await writeFile(
      envPath,
      [
        'NARRATIVE_RUNNER_TARGET_MAP_JSON={"surf.analysis.v5":{"url":"https://surf.example/result","tokenEnv":"SURF_RESULT_TOKEN"}}',
        "SURF_RESULT_TOKEN=result-token",
        "NODE_OPTIONS=--require=/tmp/untrusted.cjs",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await writeFile(
      recordPath,
      `${JSON.stringify({
        runnerEnvPath: envPath,
        executables: { pnpm: { path: "/pinned/pnpm" }, node: { path: "/pinned/node" } },
        launchAgents: { narrativeRunner: { path: join(root, "home/Library/LaunchAgents/runner.plist") } }
      })}\n`,
      { mode: 0o600 }
    );
    const spawn = vi.fn();
    await expect(
      runVerifiedRunner(
        ["--record", recordPath, "--command", "run"],
        { verify: async () => ({ status: "ok" }), spawn: spawn as never }
      )
    ).rejects.toThrow(/unsupported runner environment setting NODE_OPTIONS/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not let an extra target-map entry bless a process-control variable", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-verified-runner-target-env-"));
    const envPath = join(root, "runner.env");
    const recordPath = join(root, "activation-record.json");
    await writeFile(
      envPath,
      [
        `NARRATIVE_RUNNER_TARGET_MAP_JSON=${JSON.stringify({
          "surf.analysis.v5": {
            url: "https://surf.example/result",
            tokenEnv: "SURF_RESULT_TOKEN"
          },
          "future.analysis.v1": {
            url: "https://future.example/result",
            tokenEnv: "NODE_OPTIONS"
          }
        })}`,
        "SURF_RESULT_TOKEN=result-token",
        "NODE_OPTIONS=--require=/tmp/untrusted.cjs",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await writeFile(
      recordPath,
      `${JSON.stringify({
        runnerEnvPath: envPath,
        executables: { pnpm: { path: "/pinned/pnpm" }, node: { path: "/pinned/node" } },
        launchAgents: { narrativeRunner: { path: join(root, "home/Library/LaunchAgents/runner.plist") } }
      })}\n`,
      { mode: 0o600 }
    );
    const spawn = vi.fn();
    await expect(
      runVerifiedRunner(
        ["--record", recordPath, "--command", "run"],
        { verify: async () => ({ status: "ok" }), spawn: spawn as never }
      )
    ).rejects.toThrow(/unsupported runner target token environment NODE_OPTIONS/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
