import { readFile, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NARRATIVE_PROTOCOL_FINGERPRINT } from "@surf/narrative-contracts";
import { buildRunnerArtifact } from "../scripts/build-runner.mjs";

describe("bundled runner artifact", () => {
  it("is deterministic and binds the accepted protocol", async () => {
    const root = join(import.meta.dirname, "..");
    const firstDir = await mkdtemp(join(tmpdir(), "surf-runner-build-a-"));
    const secondDir = await mkdtemp(join(tmpdir(), "surf-runner-build-b-"));
    const first = await buildRunnerArtifact({ root, outputDir: firstDir });
    const second = await buildRunnerArtifact({ root, outputDir: secondDir });

    expect(first.artifact).toEqual(second.artifact);
    expect(await readFile(first.artifactPath)).toEqual(await readFile(second.artifactPath));
    expect(first.acceptedProtocols).toEqual([
      expect.objectContaining({
        family: "surf.narrative",
        version: 1,
        fingerprint: NARRATIVE_PROTOCOL_FINGERPRINT
      })
    ]);
    expect((await stat(first.artifactPath)).mode & 0o777).toBe(0o500);
    expect((await stat(first.manifestPath)).mode & 0o777).toBe(0o400);
  });
});
