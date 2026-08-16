import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  openSync,
  realpathSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BUILD_DIGEST_PATTERN,
  SOURCE_REVISION_PATTERN,
  clientBuildDigest,
  gitSourceRevision,
  workerBundleDigest
} from "./build-identity.mjs";
import { stageWranglerConfigSnapshot } from "./wrangler-config-snapshot.mjs";

const ZERO_SOURCE_REVISION = "0".repeat(40);
const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gitStatus(root) {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    }
  ).trim();
}

function fsyncBootstrapSnapshot(path) {
  if (
    !Number.isInteger(fsConstants.O_NOFOLLOW) ||
    !Number.isInteger(fsConstants.O_DIRECTORY)
  ) {
    throw new Error(
      "This runtime cannot durably pin the bootstrap identity snapshot"
    );
  }
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || (metadata.mode & 0o7777) !== 0o600) {
      throw new Error(
        "Bootstrap identity snapshot must remain a mode-0600 regular file"
      );
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directoryDescriptor = openSync(
    dirname(path),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY
  );
  try {
    if (!fstatSync(directoryDescriptor).isDirectory()) {
      throw new Error("Bootstrap identity snapshot parent must be a directory");
    }
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

export function resolveExactBootstrapSourceIdentity(root) {
  const canonicalRoot = realpathSync(root);
  const sourceRevision = gitSourceRevision(canonicalRoot);
  if (
    !SOURCE_REVISION_PATTERN.test(sourceRevision) ||
    sourceRevision === ZERO_SOURCE_REVISION
  ) {
    throw new Error(
      "Bootstrap source revision must be one exact nonzero Git commit"
    );
  }
  if (gitStatus(canonicalRoot) !== "") {
    throw new Error(
      "Cloudflare bootstrap requires a clean Git worktree so the deployed source lineage is exact"
    );
  }
  const clientDigest = clientBuildDigest(canonicalRoot);

  const assertUnchanged = () => {
    if (
      gitSourceRevision(canonicalRoot) !== sourceRevision ||
      gitStatus(canonicalRoot) !== "" ||
      clientBuildDigest(canonicalRoot) !== clientDigest
    ) {
      throw new Error(
        "Bootstrap source inputs changed after build identity was pinned"
      );
    }
  };

  return Object.freeze({
    sourceRevision,
    clientBuildDigest: clientDigest,
    assertUnchanged
  });
}

export function stageExactBootstrapWranglerConfig({
  sourcePath,
  releaseRoot,
  sourceRevision,
  clientBuildDigest: clientDigest,
  workerBundlePath
}) {
  if (
    !SOURCE_REVISION_PATTERN.test(sourceRevision ?? "") ||
    sourceRevision === ZERO_SOURCE_REVISION
  ) {
    throw new Error(
      "Bootstrap source revision must be one exact nonzero Git commit"
    );
  }
  if (!BUILD_DIGEST_PATTERN.test(clientDigest ?? "")) {
    throw new Error("Bootstrap client build digest must be an exact SHA-256");
  }
  const runtimeDigest = workerBundleDigest(workerBundlePath);
  const outputDirectory = realpathSync(dirname(sourcePath));
  const outputPath = resolve(
    outputDirectory,
    [
      ".surf-bootstrap",
      sourceRevision.slice(0, 12),
      clientDigest.slice(0, 12),
      runtimeDigest.slice(0, 12),
      "wrangler.jsonc"
    ].join("-")
  );
  const staged = stageWranglerConfigSnapshot({
    sourcePath,
    outputPath,
    releaseRoot,
    releaseIdentity: {
      sourceRevision,
      workerRuntimeDigest: runtimeDigest,
      clientBuildDigest: clientDigest
    }
  });
  fsyncBootstrapSnapshot(staged.path);
  return Object.freeze({
    ...staged,
    sourceRevision,
    clientBuildDigest: clientDigest,
    workerRuntimeDigest: runtimeDigest
  });
}

export function assertBootstrapWorkerDigest(path, expectedDigest) {
  if (
    !BUILD_DIGEST_PATTERN.test(expectedDigest ?? "") ||
    workerBundleDigest(path) !== expectedDigest
  ) {
    throw new Error(
      "Worker runtime digest changed after bootstrap release identity was pinned"
    );
  }
}

export function assertDeployedBootstrapReleaseIdentity(output, expected) {
  if (
    !expected ||
    typeof expected !== "object" ||
    !WORKER_VERSION_ID_PATTERN.test(expected.versionId ?? "") ||
    !SOURCE_REVISION_PATTERN.test(expected.sourceRevision ?? "") ||
    expected.sourceRevision === ZERO_SOURCE_REVISION ||
    !BUILD_DIGEST_PATTERN.test(expected.workerRuntimeDigest ?? "") ||
    !BUILD_DIGEST_PATTERN.test(expected.clientBuildDigest ?? "")
  ) {
    throw new Error("Expected bootstrap release identity is invalid");
  }
  let version;
  try {
    version = JSON.parse(output);
  } catch {
    throw new Error("Bootstrap Worker version detail returned malformed JSON");
  }
  if (
    version?.id !== expected.versionId ||
    !Array.isArray(version?.resources?.bindings)
  ) {
    throw new Error(
      "Bootstrap Worker version detail lacks release identity bindings"
    );
  }
  for (const [name, text] of Object.entries({
    SURF_SOURCE_REVISION: expected.sourceRevision,
    SURF_WORKER_RUNTIME_DIGEST: expected.workerRuntimeDigest,
    SURF_CLIENT_BUILD_DIGEST: expected.clientBuildDigest
  })) {
    const matches = version.resources.bindings.filter(
      (binding) => binding?.name === name
    );
    if (
      matches.length !== 1 ||
      matches[0]?.type !== "plain_text" ||
      matches[0]?.text !== text
    ) {
      throw new Error(`Bootstrap Worker release identity mismatch for ${name}`);
    }
  }
  return Object.freeze({
    versionId: expected.versionId,
    sourceRevision: expected.sourceRevision,
    workerRuntimeDigest: expected.workerRuntimeDigest,
    clientBuildDigest: expected.clientBuildDigest
  });
}
