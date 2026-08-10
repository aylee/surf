import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("oMLX LaunchAgent template", () => {
  const template = readFileSync(
    resolve(import.meta.dirname, "../examples/ai.alex.omlx-server.plist.example"),
    "utf8"
  );
  const supervisor = readFileSync(
    resolve(import.meta.dirname, "../scripts/supervise-omlx.sh"),
    "utf8"
  );

  it("stays loopback-only and secret-free", () => {
    expect(template).toContain("<string>127.0.0.1</string>");
    expect(template).toContain("<string>8000</string>");
    expect(template).toContain("<string>1</string>");
    expect(template).not.toMatch(/api[-_ ]?key|bearer|token/i);
  });

  it("keeps one long-running supervisor alive around the model-server child", () => {
    expect(template).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(template).toContain("__OMLX_SUPERVISOR_ABSOLUTE_PATH__");
    expect(template).toContain("<string>/bin/sh</string>");
    expect(template).toContain("<key>RunAtLoad</key>");
    expect(template).toContain("<key>ThrottleInterval</key>");
    expect(supervisor).toContain("while true");
    expect(supervisor).toContain("SURF_OMLX_RESTART_DELAY_SECONDS:-15");
    expect(supervisor).toMatch(/trap stop_child HUP INT TERM/);
  });

  it("uses only explicit render placeholders", () => {
    expect(
      [...new Set([...template.matchAll(/__[A-Z_]+__/g)].map(([value]) => value))].sort()
    ).toEqual([
        "__ACTIVATION_RECORD_ABSOLUTE_PATH__",
        "__ACTIVATION_VERIFIER_ABSOLUTE_PATH__",
        "__HOME_ABSOLUTE_PATH__",
        "__LOG_DIRECTORY_ABSOLUTE_PATH__",
        "__NODE_ABSOLUTE_PATH__",
        "__OMLX_ABSOLUTE_PATH__",
        "__OMLX_BIN_ABSOLUTE_DIRECTORY__",
        "__OMLX_DATA_ABSOLUTE_PATH__",
        "__OMLX_SUPERVISOR_ABSOLUTE_PATH__"
      ]);
  });

  it("restarts a crashed model-server child without replacing the supervisor", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "surf-omlx-supervisor-"));
    const countPath = resolve(directory, "runs");
    const verificationCountPath = resolve(directory, "verifications");
    const verifierPath = resolve(directory, "verifier.mjs");
    const fakeServerPath = resolve(directory, "fake-server.sh");
    await writeFile(
      verifierPath,
      'import { readFileSync, writeFileSync } from "node:fs"; const path=process.argv[3]; const count=Number((()=>{try{return readFileSync(path,"utf8")}catch{return "0"}})())+1; writeFileSync(path,String(count));\n',
      "utf8"
    );
    await writeFile(
      fakeServerPath,
      '#!/bin/sh\ncount=$(cat "$1" 2>/dev/null || echo 0)\ncount=$((count + 1))\necho "$count" > "$1"\nif [ "$count" -eq 1 ]; then exit 17; fi\nsleep 30\n',
      "utf8"
    );
    await chmod(fakeServerPath, 0o700);
    const child = spawn("/bin/sh", [
      resolve(import.meta.dirname, "../scripts/supervise-omlx.sh"),
      process.execPath,
      verifierPath,
      verificationCountPath,
      "--",
      fakeServerPath,
      countPath
    ], {
      env: { ...process.env, SURF_OMLX_RESTART_DELAY_SECONDS: "0.05" },
      stdio: "ignore"
    });
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const count = Number(await readFile(countPath, "utf8").catch(() => "0"));
        if (count >= 2) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(Number(await readFile(countPath, "utf8"))).toBeGreaterThanOrEqual(2);
      expect(Number(await readFile(verificationCountPath, "utf8"))).toBeGreaterThanOrEqual(2);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
  });

  it("fails closed before starting a child when activation verification fails", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "surf-omlx-supervisor-guard-"));
    const markerPath = resolve(directory, "child-started");
    const verifierPath = resolve(directory, "reject.mjs");
    const fakeServerPath = resolve(directory, "fake-server.sh");
    await writeFile(verifierPath, "process.exitCode = 1;\n", "utf8");
    await writeFile(
      fakeServerPath,
      `#!/bin/sh\necho started > ${JSON.stringify(markerPath)}\n`,
      "utf8"
    );
    await chmod(fakeServerPath, 0o700);
    const child = spawn("/bin/sh", [
      resolve(import.meta.dirname, "../scripts/supervise-omlx.sh"),
      process.execPath,
      verifierPath,
      resolve(directory, "activation-record.json"),
      "--",
      fakeServerPath
    ], { stdio: "ignore" });
    const exitCode = await new Promise<number | null>((resolveExit) =>
      child.once("exit", resolveExit)
    );
    expect(exitCode).toBe(78);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
