import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activateLaunchAgents } from "../scripts/manage-launch-agents.mjs";

async function activationRecord(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, "activation-record.json");
  await writeFile(
    path,
    `${JSON.stringify({
      releaseSha: "a".repeat(40),
      repositoryPath: join(root, "release"),
      statusFile: join(root, "status.json"),
      executables: { node: { path: "/pinned/node" } },
      launchAgents: {
        narrativeRunner: { path: join(root, "home/Library/LaunchAgents/ai.alex.narrative-runner.plist") },
        omlxServer: { path: join(root, "home/Library/LaunchAgents/ai.alex.omlx-server.plist") }
      }
    })}\n`
  );
  return path;
}

describe("bounded LaunchAgent activation", () => {
  it("is idempotent when the exact installed activation is already healthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-idempotent-"));
    const recordPath = await activationRecord(root);
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
            const plist = String(args[1]).endsWith("ai.alex.narrative-runner")
              ? join(root, "home/Library/LaunchAgents/ai.alex.narrative-runner.plist")
              : join(root, "home/Library/LaunchAgents/ai.alex.omlx-server.plist");
            return { status: 0, stdout: `path = ${plist}\n` };
          }
          return { status: 0, stdout: "" };
        }
      }
    );

    expect(result).toMatchObject({ status: "ok", changed: false });
    expect(install).not.toHaveBeenCalled();
    expect(commands.some((args) => args.includes("bootout"))).toBe(false);
    expect(verify).toHaveBeenCalledWith(recordPath, { requireInstalled: true });
  });

  it("requires an explicit rollback record before mutating a loaded service", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-prior-"));
    const recordPath = await activationRecord(root);
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
            if (args[0] === "print") return { status: 0, stdout: "" };
            mutations += 1;
            return { status: 0, stdout: "" };
          }
        }
      )
    ).rejects.toThrow(/priorRecordPath is required/);
    expect(mutations).toBe(0);
  });

  it("binds the prior rollback record to the currently loaded plist before bootout", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-loaded-path-"));
    const targetRecordPath = await activationRecord(join(root, "target"));
    const priorRecordPath = await activationRecord(join(root, "prior"));
    let mutations = 0;
    await expect(
      activateLaunchAgents(
        { recordPath: targetRecordPath, priorRecordPath },
        {
          uid: 501,
          verify: async (path: string, options: { requireInstalled: boolean }) => {
            if (path === targetRecordPath && options.requireInstalled) {
              throw new Error("target is not installed");
            }
            return { status: "ok" };
          },
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

  it("counts command/network time against the readiness wall-clock deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-manage-deadline-"));
    const recordPath = await activationRecord(root);
    let clock = 1_000;
    let runnerChecks = 0;
    await expect(
      activateLaunchAgents(
        { recordPath, environment: { HOME: join(root, "home") } },
        {
          uid: 501,
          now: () => clock,
          sleep: async (milliseconds: number) => {
            clock += milliseconds;
          },
          verify: async () => ({ status: "ok" }),
          install: async () => ({ status: "ok" }),
          portOpen: async () => false,
          command: async (file: string, args: string[], options: { timeoutMs: number }) => {
            if (file === "/bin/launchctl" && args[0] === "print") {
              return { status: 1, stdout: "" };
            }
            if (file === "/pinned/node") {
              runnerChecks += 1;
              expect(options.timeoutMs).toBeLessThanOrEqual(35_000);
              clock += 119_000;
              return { status: 1, stdout: "" };
            }
            return { status: 0, stdout: "" };
          }
        }
      )
    ).rejects.toThrow(/runner check did not become healthy inside 120 seconds/);
    expect(runnerChecks).toBe(1);
    expect(clock).toBe(121_000);
  });
});
