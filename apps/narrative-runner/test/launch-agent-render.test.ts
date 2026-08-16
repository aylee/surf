import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
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
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NARRATIVE_PROTOCOL_DESCRIPTOR } from "@surf/narrative-contracts";
import {
  renderLaunchAgents,
  verifyLaunchActivation
} from "../scripts/render-launch-agents.mjs";

const execFileAsync = promisify(execFile);

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function detachedRelease(root: string, name = "release") {
  const repositoryPath = join(root, name);
  const currentPackageRoot = fileURLToPath(new URL("../", import.meta.url));
  for (const directory of [
    "apps/narrative-runner/scripts",
    "apps/narrative-runner/examples",
    "apps/narrative-runner/dist",
    "scripts/lib"
  ]) {
    await mkdir(join(repositoryPath, directory), { recursive: true });
  }
  for (const file of [
    "scripts/render-launch-agents.mjs",
    "scripts/supervise-omlx.sh",
    "scripts/run-verified-runner.mjs",
    "scripts/install-launch-agents.mjs",
    "examples/ai.alex.narrative-runner.plist.example",
    "examples/ai.alex.omlx-server.plist.example"
  ]) {
    await copyFile(
      join(currentPackageRoot, file),
      join(repositoryPath, "apps/narrative-runner", file)
    );
  }
  await copyFile(
    join(currentPackageRoot, "../../scripts/lib/strict-env-file.mjs"),
    join(repositoryPath, "scripts/lib/strict-env-file.mjs")
  );
  await copyFile(
    join(currentPackageRoot, "../../scripts/lib/verified-file-snapshot.mjs"),
    join(repositoryPath, "scripts/lib/verified-file-snapshot.mjs")
  );
  const runnerArtifactPath = join(
    repositoryPath,
    "apps/narrative-runner/dist/narrative-runner.mjs"
  );
  const artifactContents = "export const bundledRunner = true;\n";
  await writeFile(runnerArtifactPath, artifactContents, { mode: 0o500 });
  const runnerArtifactManifestPath = join(
    repositoryPath,
    "apps/narrative-runner/dist/narrative-runner.manifest.json"
  );
  await writeFile(
    runnerArtifactManifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifact: {
          sha256: sha256(artifactContents),
          bytes: Buffer.byteLength(artifactContents)
        },
        acceptedProtocols: [NARRATIVE_PROTOCOL_DESCRIPTOR]
      },
      null,
      2
    )}\n`,
    { mode: 0o400 }
  );
  await writeFile(join(repositoryPath, ".gitignore"), "dist/\n");
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
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repositoryPath, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  );
  const releaseSha = stdout.trim();
  await execFileAsync("git", [
    "-C",
    repositoryPath,
    "checkout",
    "--detach",
    "-q",
    releaseSha
  ]);
  const releaseModule = await import(
    `${pathToFileURL(
      join(repositoryPath, "apps/narrative-runner/scripts/render-launch-agents.mjs")
    ).href}?sha=${releaseSha}`
  );
  const installerModule = await import(
    `${pathToFileURL(
      join(repositoryPath, "apps/narrative-runner/scripts/install-launch-agents.mjs")
    ).href}?sha=${releaseSha}`
  );
  return {
    repositoryPath,
    releaseSha,
    runnerArtifactPath,
    runnerArtifactManifestPath,
    render: releaseModule.renderLaunchAgents as typeof renderLaunchAgents,
    verify: releaseModule.verifyLaunchActivation as typeof verifyLaunchActivation,
    install: installerModule.installLaunchAgents as (
      recordPath: string,
      options: {
        environment: NodeJS.ProcessEnv;
        allowReplace?: boolean;
        allowLegacyV3?: boolean;
        priorRecordPath?: string | null;
      },
      overrides?: { afterInstall?: (name: string) => Promise<void> | void }
    ) => Promise<Record<string, unknown>>,
    inspect: installerModule.inspectInstalledLaunchAgents as (
      records: { targetRecordPath: string; priorRecordPath: string },
      options: { environment: NodeJS.ProcessEnv }
    ) => Promise<{
      status: "ok";
      launchAgents: { narrativeRunner: "prior" | "target"; omlxServer: "prior" | "target" };
    }>
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

async function pinnedModel(root: string) {
  const omlxDataPath = join(root, "omlx-data");
  const modelArtifactPath = join(omlxDataPath, "models/local-model");
  await mkdir(modelArtifactPath, { recursive: true });
  await writeFile(join(modelArtifactPath, "config.json"), '{"model":"local-model"}\n');
  await writeFile(join(modelArtifactPath, "weights.bin"), "weight-bytes\n");
  return { omlxDataPath, modelArtifactPath };
}

async function pinnedTools(root: string) {
  const bin = join(root, "tools/bin");
  await mkdir(bin, { recursive: true });
  for (const tool of ["node", "omlx", "pnpm"]) {
    await writeFile(join(bin, tool), `#!/bin/sh\necho ${tool}\n`, { mode: 0o755 });
  }
  return {
    nodeBinPath: bin,
    omlxPath: join(bin, "omlx"),
    pnpmPath: join(bin, "pnpm")
  };
}

async function fixture(root: string) {
  root = await realpath(root);
  const release = await detachedRelease(root);
  const tools = await pinnedTools(root);
  const model = await pinnedModel(root);
  const runnerEnvPath = join(root, "runner.env");
  const statusFile = join(root, "state/status.json");
  await writeFile(
    runnerEnvPath,
    runnerEnvironment(release.releaseSha, statusFile),
    { mode: 0o600 }
  );
  const outputDir = join(root, "activation-r1");
  const launchAgentsDir = join(root, "home/Library/LaunchAgents");
  return {
    release,
    tools,
    model,
    runnerEnvPath,
    statusFile,
    outputDir,
    launchAgentsDir,
    options: {
      outputDir,
      repositoryPath: release.repositoryPath,
      releaseSha: release.releaseSha,
      runnerEnvPath,
      runnerArtifactPath: release.runnerArtifactPath,
      runnerArtifactManifestPath: release.runnerArtifactManifestPath,
      launchAgentsDir,
      runnerExitTimeoutSeconds: 930,
      nodeBinPath: tools.nodeBinPath,
      omlxPath: tools.omlxPath,
      ...model,
      logDir: join(root, "logs"),
      environment: { HOME: join(root, "home") }
    }
  };
}

describe("LaunchAgent activation records", () => {
  it("renders and verifies a runner-owned v4 activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-v4-"));
    const value = await fixture(root);
    const written = await value.release.render(value.options);
    const record = JSON.parse(await readFile(written[2]!, "utf8"));

    expect(written).toHaveLength(3);
    expect(record).toMatchObject({
      schemaVersion: 4,
      activationId: "activation-r1",
      source: {
        revision: value.release.releaseSha,
        repositoryPath: value.release.repositoryPath
      },
      runnerArtifact: {
        path: value.release.runnerArtifactPath,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        bytes: expect.any(Number),
        manifest: {
          path: value.release.runnerArtifactManifestPath,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
        }
      },
      acceptedProtocols: [
        expect.objectContaining({
          family: "surf.narrative",
          version: 1,
          fingerprint: NARRATIVE_PROTOCOL_DESCRIPTOR.fingerprint
        })
      ],
      runtime: {
        environmentPath: value.runnerEnvPath,
        environmentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        statusFile: value.statusFile
      },
      model: {
        id: "local-model",
        artifact: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), fileCount: 2 }
      },
      executables: {
        node: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        omlx: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        runnerGuard: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }
      }
    });
    expect(record).not.toHaveProperty("wranglerConfig");
    expect(record).not.toHaveProperty("workerSecrets");
    expect(record.executables).not.toHaveProperty("pnpm");
    for (const path of written) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).not.toMatch(/__[A-Z_]+__/);
    }
    await expect(
      value.release.verify(written[2]!, { requireInstalled: false })
    ).resolves.toMatchObject({
      status: "ok",
      schemaVersion: 4,
      activationId: "activation-r1",
      releaseSha: value.release.releaseSha,
      runnerArtifactSha256: record.runnerArtifact.sha256
    });
    await expect(
      value.release.install(written[2]!, {
        environment: value.options.environment
      })
    ).resolves.toMatchObject({ status: "ok", activationId: "activation-r1" });
    await expect(
      value.release.verify(written[2]!, { requireInstalled: true })
    ).resolves.toMatchObject({ status: "ok" });
  });

  it.each([
    ["omlxServer", { omlxServer: "target", narrativeRunner: "prior" }],
    ["narrativeRunner", { omlxServer: "target", narrativeRunner: "target" }]
  ] as const)(
    "resumes exact replacement after a crash following the %s plist rename",
    async (failedAfter, expectedState) => {
      const root = await mkdtemp(join(tmpdir(), `surf-launch-install-${failedAfter}-`));
      const value = await fixture(root);
      const prior = await value.release.render({
        ...value.options,
        outputDir: join(dirname(value.outputDir), "activation-r0")
      });
      const target = await value.release.render(value.options);
      await value.release.install(prior[2]!, {
        environment: value.options.environment
      });

      await expect(
        value.release.install(
          target[2]!,
          {
            environment: value.options.environment,
            allowReplace: true,
            priorRecordPath: prior[2]!
          },
          {
            afterInstall(name) {
              if (name === failedAfter) throw new Error(`injected crash after ${name}`);
            }
          }
        )
      ).rejects.toThrow(`injected crash after ${failedAfter}`);
      await expect(
        value.release.inspect(
          { targetRecordPath: target[2]!, priorRecordPath: prior[2]! },
          { environment: value.options.environment }
        )
      ).resolves.toMatchObject({ launchAgents: expectedState });

      await expect(
        value.release.install(target[2]!, {
          environment: value.options.environment,
          allowReplace: true,
          priorRecordPath: prior[2]!
        })
      ).resolves.toMatchObject({ status: "ok", activationId: "activation-r1" });
      await expect(
        value.release.verify(target[2]!, { requireInstalled: true })
      ).resolves.toMatchObject({ status: "ok", activationId: "activation-r1" });
    }
  );

  it("refuses to inspect or replace persistent plist bytes owned by neither record", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-install-unknown-"));
    const value = await fixture(root);
    const prior = await value.release.render({
      ...value.options,
      outputDir: join(dirname(value.outputDir), "activation-r0")
    });
    const target = await value.release.render(value.options);
    await value.release.install(prior[2]!, {
      environment: value.options.environment
    });
    await writeFile(
      join(value.launchAgentsDir, "ai.alex.omlx-server.plist"),
      "unknown plist bytes\n",
      { mode: 0o600 }
    );

    await expect(
      value.release.inspect(
        { targetRecordPath: target[2]!, priorRecordPath: prior[2]! },
        { environment: value.options.environment }
      )
    ).rejects.toThrow(/match neither the verified prior nor target/);
    await expect(
      value.release.install(target[2]!, {
        environment: value.options.environment,
        allowReplace: true,
        priorRecordPath: prior[2]!
      })
    ).rejects.toThrow(/not owned by the verified prior or target/);
  });

  it("fails closed on runner, runtime, model, tool, and installed-plist drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-drift-"));
    const value = await fixture(root);
    const written = await value.release.render(value.options);
    await value.release.install(written[2]!, { environment: value.options.environment });

    await chmod(value.release.runnerArtifactPath, 0o700);
    await writeFile(value.release.runnerArtifactPath, "mutated\n", { mode: 0o500 });
    await expect(
      value.release.verify(written[2]!, { requireInstalled: false })
    ).rejects.toThrow(/runner artifact SHA-256 differs/);
    await writeFile(value.release.runnerArtifactPath, "export const bundledRunner = true;\n", {
      mode: 0o500
    });
    await chmod(value.release.runnerArtifactPath, 0o500);

    await writeFile(
      value.runnerEnvPath,
      `${await readFile(value.runnerEnvPath, "utf8")}NARRATIVE_RUNNER_POLL_INTERVAL_MS=6000\n`,
      { mode: 0o600 }
    );
    await expect(
      value.release.verify(written[2]!, { requireInstalled: false })
    ).rejects.toThrow(/runner environment differs/);
    await writeFile(
      value.runnerEnvPath,
      runnerEnvironment(value.release.releaseSha, value.statusFile),
      { mode: 0o600 }
    );

    await writeFile(join(value.model.modelArtifactPath, "weights.bin"), "mutated\n");
    await expect(
      value.release.verify(written[2]!, { requireInstalled: false })
    ).rejects.toThrow(/model artifact differs/);
    await writeFile(join(value.model.modelArtifactPath, "weights.bin"), "weight-bytes\n");

    await writeFile(join(value.tools.nodeBinPath, "node"), "#!/bin/sh\necho changed\n", {
      mode: 0o755
    });
    await expect(
      value.release.verify(written[2]!, { requireInstalled: false })
    ).rejects.toThrow(/node SHA-256 differs/);
    await writeFile(join(value.tools.nodeBinPath, "node"), "#!/bin/sh\necho node\n", {
      mode: 0o755
    });

    await writeFile(
      join(value.launchAgentsDir, "ai.alex.narrative-runner.plist"),
      "drifted\n",
      { mode: 0o600 }
    );
    await expect(
      value.release.verify(written[2]!, { requireInstalled: true })
    ).rejects.toThrow(/installed narrativeRunner SHA-256 differs/);
  });

  it("keeps source, identity, paths, lease timeout, and executables immutable", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-boundaries-"));
    const value = await fixture(root);
    await expect(
      value.release.render({ ...value.options, runnerExitTimeoutSeconds: 929 })
    ).rejects.toThrow(/must be at least 930/);
    await expect(
      value.release.render({ ...value.options, outputDir: join(root, "bad activation") })
    ).rejects.toThrow(/stable activation identifier/);
    await expect(
      renderLaunchAgents(value.options)
    ).rejects.toThrow(/renderer must execute from the same release/);

    const envInside = join(value.release.repositoryPath, "runner.env");
    await writeFile(
      join(value.release.repositoryPath, ".git/info/exclude"),
      "runner.env\napps/narrative-runner/dist/runner-alias.mjs\n"
    );
    await writeFile(envInside, runnerEnvironment(value.release.releaseSha, value.statusFile), {
      mode: 0o600
    });
    await expect(
      value.release.render({
        ...value.options,
        runnerEnvPath: envInside,
        outputDir: join(root, "activation-env-inside")
      })
    ).rejects.toThrow(/runnerEnvPath must be outside/);

    const artifactAlias = join(
      value.release.repositoryPath,
      "apps/narrative-runner/dist/runner-alias.mjs"
    );
    await symlink(value.release.runnerArtifactPath, artifactAlias);
    await expect(
      value.release.render({
        ...value.options,
        outputDir: join(root, "activation-artifact-alias"),
        runnerArtifactPath: artifactAlias
      })
    ).rejects.toThrow(/runnerArtifactPath must be a canonical non-symlink file/);

    const omlxAlias = join(root, "omlx-current");
    await symlink(value.tools.omlxPath, omlxAlias);
    await expect(
      value.release.render({
        ...value.options,
        outputDir: join(root, "activation-alias"),
        omlxPath: omlxAlias
      })
    ).rejects.toThrow(/omlxPath must be the canonical realpath/);

    await execFileAsync("git", [
      "-C",
      value.release.repositoryPath,
      "switch",
      "-c",
      "mutable"
    ]);
    await expect(value.release.render(value.options)).rejects.toThrow(/detached release/);
  });

  it("accepts v3 records only behind the explicit rollback-transition gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "surf-launch-v3-"));
    const value = await fixture(root);
    const written = await value.release.render(value.options);
    const v4 = JSON.parse(await readFile(written[2]!, "utf8"));
    const wranglerConfigPath = join(root, "legacy/wrangler.jsonc");
    const workerSecretsPath = join(root, "legacy/worker-secrets.json");
    await mkdir(dirname(wranglerConfigPath), { recursive: true });
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
    const environmentValues = Object.fromEntries(
      (await readFile(value.runnerEnvPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
    );
    const environmentFingerprint = createHmac(
      "sha256",
      environmentValues.NARRATIVE_RUNNER_STATUS_HMAC_KEY
    )
      .update("surf-runner-env-v1")
      .update("\u0000")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(environmentValues).sort(([left], [right]) =>
              left.localeCompare(right)
            )
          )
        )
      )
      .digest("hex");
    const legacyPath = join(root, "legacy/activation-record.json");
    const legacy = {
      schemaVersion: 3,
      releaseSha: value.release.releaseSha,
      repositoryPath: value.release.repositoryPath,
      runnerEnvPath: value.runnerEnvPath,
      statusFile: value.statusFile,
      modelId: "local-model",
      runnerEnvironmentFingerprint: environmentFingerprint,
      wranglerConfig: { path: await realpath(wranglerConfigPath), sha256: sha256(wranglerContents) },
      workerSecrets: {
        path: await realpath(workerSecretsPath),
        fingerprint: createHmac(
          "sha256",
          environmentValues.NARRATIVE_RUNNER_STATUS_HMAC_KEY
        )
          .update("surf-worker-secrets-v1")
          .update("\u0000")
          .update(
            JSON.stringify({
              GEMINI_API_KEY: "g".repeat(32),
              NARRATIVE_RESULT_TOKEN: "r".repeat(64)
            })
          )
          .digest("hex")
      },
      modelArtifact: v4.model.artifact,
      renderedLaunchAgents: v4.renderedLaunchAgents,
      launchAgents: v4.launchAgents,
      executables: {
        ...v4.executables,
        pnpm: {
          path: await realpath(value.tools.pnpmPath),
          sha256: sha256(await readFile(value.tools.pnpmPath))
        }
      }
    };
    await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    await expect(
      value.release.verify(legacyPath, { requireInstalled: false })
    ).rejects.toThrow(/only for explicit rollback transition/);
    await expect(
      value.release.verify(legacyPath, {
        requireInstalled: false,
        allowLegacyV3: true
      })
    ).resolves.toMatchObject({
      status: "ok",
      schemaVersion: 3,
      transitionOnly: true,
      acceptedProtocols: []
    });
  });
});
