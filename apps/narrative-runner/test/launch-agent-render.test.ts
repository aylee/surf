import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  renderLaunchAgents,
  verifyLaunchActivation
} from "../scripts/render-launch-agents.mjs";

const execFileAsync = promisify(execFile);

async function detachedRelease(root: string, name = "release") {
  const repositoryPath = join(root, name);
  const currentPackageRoot = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(join(repositoryPath, "apps/narrative-runner/scripts"), { recursive: true });
  await mkdir(join(repositoryPath, "apps/narrative-runner/examples"), { recursive: true });
  await mkdir(join(repositoryPath, "scripts/lib"), { recursive: true });
  await copyFile(
    join(currentPackageRoot, "scripts/render-launch-agents.mjs"),
    join(repositoryPath, "apps/narrative-runner/scripts/render-launch-agents.mjs")
  );
  await copyFile(
    join(currentPackageRoot, "scripts/supervise-omlx.sh"),
    join(repositoryPath, "apps/narrative-runner/scripts/supervise-omlx.sh")
  );
  await copyFile(
    join(currentPackageRoot, "scripts/run-verified-runner.mjs"),
    join(repositoryPath, "apps/narrative-runner/scripts/run-verified-runner.mjs")
  );
  await copyFile(
    join(currentPackageRoot, "scripts/install-launch-agents.mjs"),
    join(repositoryPath, "apps/narrative-runner/scripts/install-launch-agents.mjs")
  );
  await copyFile(
    join(currentPackageRoot, "../../scripts/lib/strict-env-file.mjs"),
    join(repositoryPath, "scripts/lib/strict-env-file.mjs")
  );
  await copyFile(
    join(currentPackageRoot, "examples/ai.alex.narrative-runner.plist.example"),
    join(repositoryPath, "apps/narrative-runner/examples/ai.alex.narrative-runner.plist.example")
  );
  await copyFile(
    join(currentPackageRoot, "examples/ai.alex.omlx-server.plist.example"),
    join(repositoryPath, "apps/narrative-runner/examples/ai.alex.omlx-server.plist.example")
  );
  await execFileAsync("git", ["init", "-q", repositoryPath]);
  await execFileAsync("git", ["-C", repositoryPath, "add", "."]);
  await execFileAsync("git", [
    "-C",
    repositoryPath,
    "-c",
    "user.name=Launch Test",
    "-c",
    "user.email=launch@test.invalid",
    "commit",
    "-qm",
    "release"
  ]);
  const { stdout } = await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
    encoding: "utf8"
  });
  const releaseSha = stdout.trim();
  await execFileAsync("git", ["-C", repositoryPath, "checkout", "--detach", "-q", releaseSha]);
  const releaseModule = await import(
    `${pathToFileURL(join(repositoryPath, "apps/narrative-runner/scripts/render-launch-agents.mjs")).href}?sha=${releaseSha}`
  );
  const installerModule = await import(
    `${pathToFileURL(join(repositoryPath, "apps/narrative-runner/scripts/install-launch-agents.mjs")).href}?sha=${releaseSha}`
  );
  return {
    repositoryPath,
    releaseSha,
    render: releaseModule.renderLaunchAgents as typeof renderLaunchAgents,
    verify: (recordPath: string) =>
      releaseModule.verifyLaunchActivation(recordPath, { requireInstalled: false }) as Promise<{
        status: "ok";
        releaseSha: string;
      }>,
    verifyInstalled: (recordPath: string) =>
      releaseModule.verifyLaunchActivation(recordPath, { requireInstalled: true }) as Promise<{
        status: "ok";
        releaseSha: string;
      }>,
    install: installerModule.installLaunchAgents as (
      recordPath: string,
      options: { environment: NodeJS.ProcessEnv; allowReplace?: boolean }
    ) => Promise<{ status: "ok"; releaseSha: string }>
  };
}

function runnerEnvironment(releaseSha: string, statusFile: string): string {
  return [
    "NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS=900000",
    `NARRATIVE_RUNNER_RELEASE_SHA=${releaseSha}`,
    `NARRATIVE_RUNNER_STATUS_FILE=${statusFile}`,
    "NARRATIVE_RUNNER_OMLX_MODEL=local-model",
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}`,
    `NARRATIVE_RUNNER_STATUS_HMAC_KEY=${"h".repeat(64)}`,
    ""
  ].join("\n");
}

async function pinnedDeployInputs(root: string) {
  const wranglerConfigPath = join(root, "deploy/wrangler.instance.jsonc");
  const workerSecretsPath = join(root, "deploy/worker-secrets.json");
  await mkdir(join(root, "deploy"), { recursive: true });
  const wranglerContents = '{"name":"surf"}\n';
  await writeFile(wranglerConfigPath, wranglerContents, { mode: 0o600 });
  await writeFile(
    workerSecretsPath,
    `${JSON.stringify({
      GEMINI_API_KEY: "g".repeat(32),
      NARRATIVE_RESULT_TOKEN: "r".repeat(64)
    })}\n`,
    { mode: 0o600 }
  );
  return {
    wranglerConfigPath: await realpath(wranglerConfigPath),
    wranglerConfigSha256: createHash("sha256")
      .update(wranglerContents)
      .digest("hex"),
    workerSecretsPath: await realpath(workerSecretsPath)
  };
}

const deployInputPlaceholders = {
  wranglerConfigPath: "/Users/test/activations/wrangler.instance.jsonc",
  wranglerConfigSha256: "a".repeat(64),
  workerSecretsPath: "/Users/test/activations/worker-secrets.json"
};

async function pinnedModel(root: string, name = "omlx-data") {
  const omlxDataPath = join(root, name);
  const modelArtifactPath = join(omlxDataPath, "models/local-model");
  await mkdir(modelArtifactPath, { recursive: true });
  await writeFile(join(modelArtifactPath, "config.json"), '{"model":"local-model"}\n');
  await writeFile(join(modelArtifactPath, "weights.bin"), "weight-bytes\n");
  return { omlxDataPath, modelArtifactPath };
}

async function pinnedTools(root: string, name = "tools") {
  const bin = join(root, name, "bin");
  await mkdir(bin, { recursive: true });
  for (const tool of ["node", "pnpm", "omlx"]) {
    await writeFile(join(bin, tool), `#!/bin/sh\necho ${tool}\n`, { mode: 0o755 });
  }
  return {
    nodeBinPath: bin,
    pnpmPath: join(bin, "pnpm"),
    omlxPath: join(bin, "omlx")
  };
}

describe("LaunchAgent renderer", () => {
  it("renders secret-free, mode-0600 local service files", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-"));
    const outputDir = join(root, "agents");
    const logDir = join(root, "logs");
    const runnerEnvPath = join(root, "narrative-runner.env");
    const launchAgentsDir = join(root, "home/Library/LaunchAgents");
    const release = await detachedRelease(root);
    const tools = await pinnedTools(root);
    const model = await pinnedModel(root);
    const deployInputs = await pinnedDeployInputs(root);
    await writeFile(runnerEnvPath, runnerEnvironment(release.releaseSha, join(root, "state/status.json")), {
      mode: 0o600
    });
    const options = {
      outputDir,
      repositoryPath: release.repositoryPath,
      releaseSha: release.releaseSha,
      runnerEnvPath,
      launchAgentsDir,
      runnerExitTimeoutSeconds: 930,
      ...tools,
      ...model,
      ...deployInputs,
      logDir,
      environment: {
        HOME: join(root, "home"),
        SURF_NARRATIVE_RUNNER_ENV_FILE: runnerEnvPath
      }
    };
    const written = await release.render(options);

    expect(written).toHaveLength(3);
    for (const path of written) {
      const contents = await readFile(path, "utf8");
      expect(contents).not.toMatch(/__[A-Z_]+__/);
      expect(contents).not.toMatch(/api[-_ ]?key|bearer|token/i);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect((await stat(logDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(written[0]!, "utf8")).toMatch(
      /<key>ExitTimeOut<\/key>\s*<integer>930<\/integer>/
    );
    expect(await readFile(written[0]!, "utf8")).toContain(
      `<string>${written[2]}</string>\n    <string>--command</string>\n    <string>run</string>`
    );
    expect(await readFile(written[1]!, "utf8")).toContain(
      `<string>${written[2]}</string>\n    <string>--</string>`
    );
    expect(await readFile(written[1]!, "utf8")).toMatch(
      /<key>ExitTimeOut<\/key>\s*<integer>60<\/integer>/
    );
    expect(JSON.parse(await readFile(written[2]!, "utf8"))).toMatchObject({
      schemaVersion: 3,
      releaseSha: release.releaseSha,
      modelId: "local-model",
      wranglerConfig: {
        path: deployInputs.wranglerConfigPath,
        sha256: deployInputs.wranglerConfigSha256
      },
      workerSecrets: {
        path: deployInputs.workerSecretsPath,
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
      },
      modelArtifact: {
        path: expect.stringMatching(/\/omlx-data\/models\/local-model$/),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        fileCount: 2
      },
      executables: {
        node: { path: expect.stringMatching(/\/tools\/bin\/node$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        pnpm: { path: expect.stringMatching(/\/tools\/bin\/pnpm$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        omlx: { path: expect.stringMatching(/\/tools\/bin\/omlx$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        runnerGuard: { path: expect.stringMatching(/\/run-verified-runner\.mjs$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }
      },
      launchAgents: {
        narrativeRunner: { path: expect.stringMatching(/\/Library\/LaunchAgents\/ai\.alex\.narrative-runner\.plist$/) },
        omlxServer: { path: expect.stringMatching(/\/Library\/LaunchAgents\/ai\.alex\.omlx-server\.plist$/) }
      }
    });
    await expect(release.render(options)).resolves.toEqual(written);
    await expect(
      release.render({ ...options, runnerExitTimeoutSeconds: 931 })
    ).rejects.toThrow(/existing LaunchAgent artifact differs/);
    await expect(release.verify(written[2]!)).resolves.toMatchObject({
      status: "ok",
      releaseSha: release.releaseSha
    });
    await expect(
      verifyLaunchActivation(written[2]!, { requireInstalled: false })
    ).resolves.toMatchObject({
      status: "ok",
      releaseSha: release.releaseSha
    });
    await expect(
      release.install(written[2]!, { environment: options.environment })
    ).resolves.toMatchObject({ status: "ok", releaseSha: release.releaseSha });
    await expect(release.verifyInstalled(written[2]!)).resolves.toMatchObject({
      status: "ok",
      releaseSha: release.releaseSha
    });
    for (const name of ["ai.alex.narrative-runner.plist", "ai.alex.omlx-server.plist"]) {
      expect((await stat(join(launchAgentsDir, name))).mode & 0o777).toBe(0o600);
    }
    await writeFile(
      join(launchAgentsDir, "ai.alex.narrative-runner.plist"),
      "drifted\n",
      { mode: 0o600 }
    );
    await expect(release.verifyInstalled(written[2]!)).rejects.toThrow(
      /installed narrativeRunner SHA-256 differs/
    );
    await expect(
      release.install(written[2]!, { environment: options.environment })
    ).rejects.toThrow(/use the bounded activation controller/);
    await release.install(written[2]!, {
      environment: options.environment,
      allowReplace: true
    });
    await chmod(
      join(launchAgentsDir, "ai.alex.narrative-runner.plist"),
      0o644
    );
    await expect(release.verifyInstalled(written[2]!)).rejects.toThrow(
      /installed narrativeRunner must remain/
    );
    await chmod(
      join(launchAgentsDir, "ai.alex.narrative-runner.plist"),
      0o600
    );
    const workerSecretsContents = await readFile(
      deployInputs.workerSecretsPath,
      "utf8"
    );
    await writeFile(
      deployInputs.workerSecretsPath,
      `${JSON.stringify({
        GEMINI_API_KEY: "x".repeat(32),
        NARRATIVE_RESULT_TOKEN: "r".repeat(64)
      })}\n`,
      { mode: 0o600 }
    );
    await expect(release.verify(written[2]!)).rejects.toThrow(
      /worker secrets differ/
    );
    await writeFile(deployInputs.workerSecretsPath, workerSecretsContents, {
      mode: 0o600
    });
    const wranglerContents = await readFile(deployInputs.wranglerConfigPath, "utf8");
    await writeFile(deployInputs.wranglerConfigPath, `${wranglerContents} `, {
      mode: 0o600
    });
    await expect(release.verify(written[2]!)).rejects.toThrow(
      /wranglerConfigPath SHA-256 differs/
    );
    await writeFile(deployInputs.wranglerConfigPath, wranglerContents, {
      mode: 0o600
    });
    await writeFile(join(model.modelArtifactPath, "weights.bin"), "mutated\n");
    await expect(release.verify(written[2]!)).rejects.toThrow(
      /model artifact differs/
    );
    await writeFile(join(model.modelArtifactPath, "weights.bin"), "weight-bytes\n");
    await writeFile(tools.pnpmPath, "#!/bin/sh\necho changed\n", { mode: 0o755 });
    await expect(release.verify(written[2]!)).rejects.toThrow(
      /pnpm SHA-256 differs/
    );
  });

  it("XML-escapes operational paths and emits valid macOS plists", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-escaped-"));
    const runnerEnvPath = join(root, "A&B-runner.env");
    const release = await detachedRelease(root, "A&B-surf");
    const tools = await pinnedTools(root, "A&B-tools");
    const model = await pinnedModel(root, "A&B-omlx");
    const deployInputs = await pinnedDeployInputs(root);
    await writeFile(runnerEnvPath, runnerEnvironment(release.releaseSha, join(root, "state/status.json")), {
      mode: 0o600
    });
    const written = await release.render({
      outputDir: join(root, "agents"),
      repositoryPath: release.repositoryPath,
      releaseSha: release.releaseSha,
      runnerEnvPath,
      runnerExitTimeoutSeconds: 930,
      ...tools,
      ...model,
      ...deployInputs,
      logDir: join(root, "A&B-logs"),
      environment: {
        SURF_NARRATIVE_RUNNER_ENV_FILE: runnerEnvPath
      }
    });

    for (const path of written.slice(0, 2)) {
      const contents = await readFile(path, "utf8");
      expect(contents).toContain("A&amp;B");
      expect(contents).not.toContain("A&B");
      if (process.platform === "darwin") {
        await expect(
          execFileAsync("/usr/bin/plutil", ["-lint", path])
        ).resolves.toBeDefined();
      }
    }
  });


  it("rejects relative operational paths", async () => {
    await expect(
      renderLaunchAgents({
        outputDir: "agents",
        repositoryPath: "/opt/surf",
        releaseSha: "a".repeat(40),
        runnerEnvPath: "/Users/test/.config/surf/narrative-runner.env",
        runnerExitTimeoutSeconds: 930,
        pnpmPath: "/opt/homebrew/bin/pnpm",
        nodeBinPath: "/opt/homebrew/bin",
        omlxPath: "/opt/homebrew/bin/omlx",
        omlxDataPath: "/Users/test/.omlx",
        modelArtifactPath: "/Users/test/.omlx/models/local-model",
        ...deployInputPlaceholders,
        logDir: "/tmp/logs",
        environment: {
          SURF_NARRATIVE_RUNNER_ENV_FILE: "/Users/test/.config/surf/narrative-runner.env"
        }
      })
    ).rejects.toThrow(/outputDir must be an absolute path/);
  });

  it("rejects a service environment path different from deploy validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-env-mismatch-"));
    await expect(
      renderLaunchAgents({
        outputDir: join(root, "agents"),
        repositoryPath: "/opt/surf",
        releaseSha: "a".repeat(40),
        runnerEnvPath: "/Users/test/.config/surf/service.env",
        runnerExitTimeoutSeconds: 930,
        pnpmPath: "/opt/homebrew/bin/pnpm",
        nodeBinPath: "/opt/homebrew/bin",
        omlxPath: "/opt/homebrew/bin/omlx",
        omlxDataPath: "/Users/test/.omlx",
        modelArtifactPath: "/Users/test/.omlx/models/local-model",
        ...deployInputPlaceholders,
        logDir: join(root, "logs"),
        environment: {
          SURF_NARRATIVE_RUNNER_ENV_FILE: "/Users/test/.config/surf/validated.env"
        }
      })
    ).rejects.toThrow(/must exactly match SURF_NARRATIVE_RUNNER_ENV_FILE/);
  });

  it("rejects an unbounded or too-short runner exit timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-exit-timeout-"));
    await expect(
      renderLaunchAgents({
        outputDir: join(root, "agents"),
        repositoryPath: "/opt/surf",
        releaseSha: "a".repeat(40),
        runnerEnvPath: "/Users/test/.config/surf/runner.env",
        runnerExitTimeoutSeconds: 0,
        pnpmPath: "/opt/homebrew/bin/pnpm",
        nodeBinPath: "/opt/homebrew/bin",
        omlxPath: "/opt/homebrew/bin/omlx",
        omlxDataPath: "/Users/test/.omlx",
        modelArtifactPath: "/Users/test/.omlx/models/local-model",
        ...deployInputPlaceholders,
        logDir: join(root, "logs"),
        environment: {
          SURF_NARRATIVE_RUNNER_ENV_FILE: "/Users/test/.config/surf/runner.env"
        }
      })
    ).rejects.toThrow(/runnerExitTimeoutSeconds must be an integer from 30/);
  });

  it("derives the minimum exit timeout from the validated runner lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-lease-timeout-"));
    const runnerEnvPath = join(root, "runner.env");
    const release = await detachedRelease(root);
    const tools = await pinnedTools(root);
    const model = await pinnedModel(root);
    const deployInputs = await pinnedDeployInputs(root);
    await writeFile(runnerEnvPath, runnerEnvironment(release.releaseSha, join(root, "state/status.json")), {
      mode: 0o600
    });
    const base = {
      outputDir: join(root, "agents"),
      repositoryPath: release.repositoryPath,
      releaseSha: release.releaseSha,
      runnerEnvPath,
      ...tools,
      ...model,
      ...deployInputs,
      logDir: join(root, "logs"),
      environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: runnerEnvPath }
    };
    await expect(
      release.render({ ...base, runnerExitTimeoutSeconds: 929 })
    ).rejects.toThrow(/must be at least 930/);
    await expect(
      release.render({
        ...base,
        outputDir: join(root, "agents-930"),
        runnerExitTimeoutSeconds: 930
      })
    ).resolves.toHaveLength(3);
  });

  it("requires the exact strict deploy-validated runner environment before rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-strict-env-"));
    const release = await detachedRelease(root);
    const tools = await pinnedTools(root);
    const runnerEnvPath = join(root, "runner.env");
    const base = {
      outputDir: join(root, "agents"),
      repositoryPath: release.repositoryPath,
      releaseSha: release.releaseSha,
      runnerEnvPath,
      runnerExitTimeoutSeconds: 930,
      ...tools,
      omlxDataPath: "/Users/test/.omlx",
      modelArtifactPath: "/Users/test/.omlx/models/local-model",
      ...deployInputPlaceholders,
      logDir: join(root, "logs"),
      environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: runnerEnvPath }
    };

    await writeFile(
      runnerEnvPath,
      runnerEnvironment(release.releaseSha, join(root, "state/status.json")),
      { mode: 0o600 }
    );
    await chmod(runnerEnvPath, 0o640);
    await expect(release.render(base)).rejects.toThrow(/mode 0600/);

    await chmod(runnerEnvPath, 0o600);
    const runnerEnvAlias = join(root, "runner-current.env");
    await symlink(runnerEnvPath, runnerEnvAlias);
    await expect(
      release.render({
        ...base,
        runnerEnvPath: runnerEnvAlias,
        environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: runnerEnvAlias }
      })
    ).rejects.toThrow(/non-symlink regular file/);

    await writeFile(
      runnerEnvPath,
      `${runnerEnvironment(release.releaseSha, join(root, "state/status.json"))}NARRATIVE_RUNNER_RELEASE_SHA=${release.releaseSha}\n`,
      { mode: 0o600 }
    );
    await expect(release.render(base)).rejects.toThrow(
      /duplicate NARRATIVE_RUNNER_RELEASE_SHA/
    );

    await writeFile(
      runnerEnvPath,
      `${runnerEnvironment(release.releaseSha, join(root, "state/status.json"))}BROKEN VALUE\n`,
      { mode: 0o600 }
    );
    await expect(release.render(base)).rejects.toThrow(/line 7 is malformed/);

  });

  it("keeps environment, state, logs, and rendered artifacts outside the immutable release", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-containment-"));
    const release = await detachedRelease(root);
    const externalEnv = join(root, "external/runner.env");
    await mkdir(join(root, "external"), { recursive: true });
    await writeFile(
      externalEnv,
      runnerEnvironment(release.releaseSha, join(root, "state/status.json")),
      { mode: 0o600 }
    );
    const base = {
      outputDir: join(root, "agents"),
      repositoryPath: release.repositoryPath,
      releaseSha: release.releaseSha,
      runnerEnvPath: externalEnv,
      runnerExitTimeoutSeconds: 930,
      pnpmPath: "/opt/homebrew/bin/pnpm",
      nodeBinPath: "/opt/homebrew/bin",
      omlxPath: "/opt/homebrew/bin/omlx",
      omlxDataPath: "/Users/test/.omlx",
      modelArtifactPath: "/Users/test/.omlx/models/local-model",
      ...deployInputPlaceholders,
      logDir: join(root, "logs"),
      environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: externalEnv }
    };

    await expect(
      release.render({ ...base, outputDir: join(release.repositoryPath, "agents") })
    ).rejects.toThrow(/outputDir must be outside/);
    await expect(
      release.render({ ...base, logDir: join(release.repositoryPath, "logs") })
    ).rejects.toThrow(/logDir must be outside/);

    const stateInsideEnv = join(root, "external/state-inside.env");
    await writeFile(
      stateInsideEnv,
      runnerEnvironment(release.releaseSha, join(release.repositoryPath, "status.json")),
      { mode: 0o600 }
    );
    await expect(
      release.render({
        ...base,
        runnerEnvPath: stateInsideEnv,
        environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: stateInsideEnv }
      })
    ).rejects.toThrow(/statusFile must be outside/);

    const envInside = join(release.repositoryPath, "ignored-runner.env");
    await writeFile(join(release.repositoryPath, ".git/info/exclude"), "ignored-runner.env\n");
    await writeFile(
      envInside,
      runnerEnvironment(release.releaseSha, join(root, "state/status.json")),
      { mode: 0o600 }
    );
    await expect(
      release.render({
        ...base,
        runnerEnvPath: envInside,
        environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: envInside }
      })
    ).rejects.toThrow(/runnerEnvPath must be outside/);
  });

  it("rejects mutable executable aliases instead of pinning them into rollback plists", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-alias-"));
    const release = await detachedRelease(root);
    const tools = await pinnedTools(root);
    const runnerEnvPath = join(root, "runner.env");
    await writeFile(
      runnerEnvPath,
      runnerEnvironment(release.releaseSha, join(root, "state/status.json")),
      { mode: 0o600 }
    );
    const omlxAlias = join(root, "omlx-current");
    await symlink(tools.omlxPath, omlxAlias);
    await expect(
      release.render({
        outputDir: join(root, "agents"),
        repositoryPath: release.repositoryPath,
        releaseSha: release.releaseSha,
        runnerEnvPath,
        runnerExitTimeoutSeconds: 930,
        pnpmPath: tools.pnpmPath,
        nodeBinPath: tools.nodeBinPath,
        omlxPath: omlxAlias,
        omlxDataPath: "/Users/test/.omlx",
        modelArtifactPath: "/Users/test/.omlx/models/local-model",
        ...deployInputPlaceholders,
        logDir: join(root, "logs"),
        environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: runnerEnvPath }
      })
    ).rejects.toThrow(/omlxPath must be the canonical realpath/);
  });

  it("rejects a branch checkout, wrong SHA, or dirty release worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launchagents-release-boundary-"));
    const release = await detachedRelease(root);
    const runnerEnvPath = join(root, "runner.env");
    await writeFile(runnerEnvPath, runnerEnvironment(release.releaseSha, join(root, "state/status.json")), {
      mode: 0o600
    });
    const base = {
      outputDir: join(root, "agents"),
      repositoryPath: release.repositoryPath,
      releaseSha: release.releaseSha,
      runnerEnvPath,
      runnerExitTimeoutSeconds: 930,
      pnpmPath: "/opt/homebrew/bin/pnpm",
      nodeBinPath: "/opt/homebrew/bin",
      omlxPath: "/opt/homebrew/bin/omlx",
      omlxDataPath: "/Users/test/.omlx",
      modelArtifactPath: "/Users/test/.omlx/models/local-model",
      ...deployInputPlaceholders,
      logDir: join(root, "logs"),
      environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: runnerEnvPath }
    };

    await expect(renderLaunchAgents(base)).rejects.toThrow(
      /renderer must execute from the same release/
    );

    await expect(
      release.render({ ...base, releaseSha: "f".repeat(40) })
    ).rejects.toThrow(/runnerEnvPath NARRATIVE_RUNNER_RELEASE_SHA must equal releaseSha/);
    const wrongShaEnv = join(root, "wrong-sha.env");
    await writeFile(
      wrongShaEnv,
      runnerEnvironment("f".repeat(40), join(root, "state/status.json")),
      { mode: 0o600 }
    );
    await expect(
      release.render({
        ...base,
        releaseSha: "f".repeat(40),
        runnerEnvPath: wrongShaEnv,
        environment: { SURF_NARRATIVE_RUNNER_ENV_FILE: wrongShaEnv }
      })
    ).rejects.toThrow(/HEAD must exactly match releaseSha/);

    await execFileAsync("git", ["-C", release.repositoryPath, "switch", "-c", "mutable-branch"]);
    await expect(release.render(base)).rejects.toThrow(/must be a detached release worktree/);

    await execFileAsync("git", ["-C", release.repositoryPath, "checkout", "--detach", "-q", release.releaseSha]);
    await writeFile(join(release.repositoryPath, "untracked.txt"), "dirty\n");
    await expect(release.render(base)).rejects.toThrow(/release worktree must be clean/);
  });
});
