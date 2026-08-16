#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { NARRATIVE_PROTOCOL_DESCRIPTOR } from "@surf/narrative-contracts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function writeAtomic(path, contents, mode) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function buildRunnerArtifact({
  root = packageRoot,
  outputDir = resolve(root, "dist")
} = {}) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "bundle",
    legalComments: "none",
    charset: "utf8",
    sourcemap: false,
    minify: false,
    treeShaking: true,
    write: false,
    outfile: "narrative-runner.mjs"
  });
  if (result.outputFiles?.length !== 1) {
    throw new Error("runner bundle must produce exactly one artifact");
  }
  const contents = result.outputFiles[0].contents;
  const artifact = {
    sha256: sha256(contents),
    bytes: contents.byteLength
  };
  const manifest = {
    schemaVersion: 1,
    artifact,
    acceptedProtocols: [NARRATIVE_PROTOCOL_DESCRIPTOR]
  };
  const artifactPath = resolve(outputDir, "narrative-runner.mjs");
  const manifestPath = resolve(outputDir, "narrative-runner.manifest.json");
  await mkdir(outputDir, { recursive: true });
  await writeAtomic(artifactPath, contents, 0o500);
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o400);
  return {
    artifactPath,
    manifestPath,
    artifact,
    acceptedProtocols: manifest.acceptedProtocols
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildRunnerArtifact();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
