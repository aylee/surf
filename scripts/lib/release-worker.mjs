import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  prebuiltWorkerVersionUploadArgs,
  workerTriggerSyncArgs,
  workerVersionActivationArgs
} from "./deploy-orchestration.mjs";
import {
  resolveActiveDeploymentId,
  resolveUploadedVersionId
} from "./deploy-url.mjs";
import {
  parseWorkerRuntime,
  resolveSoleActiveWorkerVersionId
} from "./worker-runtime.mjs";
import { waitForWorkerVersion } from "./worker-version.mjs";
import { workerVersionUploadFailure } from "./worker-release-errors.mjs";
import { smokeForecastInstance } from "./smoke-instance.mjs";
import { inspectRemoteForecastReadModels } from "./remote-ingest.mjs";
import {
  smokeStaticAssetsAcrossOrigins
} from "./static-assets-smoke.mjs";
import {
  assertClientOutputIdentity,
  captureClientOutputIdentity,
  workerBundleDigest
} from "./build-identity.mjs";
import { createReleaseStorage } from "./release-storage.mjs";

const HEALTH_IDENTITY_MAX_BYTES = 64 * 1024;
const WORKER_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELEASE_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const REQUIRED_SECRET_BINDINGS = Object.freeze([
  "GEMINI_API_KEY",
  "INGEST_TOKEN",
  "NARRATIVE_RESULT_TOKEN"
]);
// The cron-safe handoff may wait for the next hourly settle boundary before
// its bounded 1-minute affinity handoff and 10-minute publication proof.
// Keep the controller finite while leaving a small process-start margin.
export const RELEASE_GENERATION_TIMEOUT_MS = 75 * 60_000;
const WORKER_CANDIDATE_INVENTORY = Object.freeze([
  "README.md",
  "index.js",
  "index.js.map"
]);

function assertWorkerCandidateInventory(outputDirectory) {
  if (realpathSync(outputDirectory) !== resolve(outputDirectory)) {
    throw new Error("Worker candidate output path must be canonical and contain no symlinks");
  }
  const rootStat = lstatSync(outputDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Worker candidate output must be a non-symlink directory");
  }
  const actual = readdirSync(outputDirectory).sort();
  if (
    actual.length !== WORKER_CANDIDATE_INVENTORY.length ||
    actual.some((name, index) => name !== WORKER_CANDIDATE_INVENTORY[index])
  ) {
    throw new Error(
      `Worker candidate output must contain exactly ${WORKER_CANDIDATE_INVENTORY.join(", ")}`
    );
  }
  for (const name of WORKER_CANDIDATE_INVENTORY) {
    const stat = lstatSync(resolve(outputDirectory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Worker candidate output ${name} must be a regular non-symlink file`);
    }
  }
}

function requiredString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`Worker binding ${label} is invalid`);
  }
  return value;
}

function bindingDescriptorEntry(value) {
  return Object.freeze(value);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} must contain exactly ${sortedExpectedKeys.join(", ")}`);
  }
}

export function expectedWorkerBindingDescriptor(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Pinned Worker config must be an object");
  }
  const bindings = [];
  const add = (value) => bindings.push(bindingDescriptorEntry(value));

  if (config.assets?.binding) {
    add({
      name: requiredString(config.assets.binding, "assets name"),
      type: "assets"
    });
  }
  if (config.version_metadata?.binding) {
    add({
      name: requiredString(
        config.version_metadata.binding,
        "version metadata name"
      ),
      type: "version_metadata"
    });
  }
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Worker plain-text binding ${name} is invalid`);
    }
    add({
      name: requiredString(name, "plain-text name"),
      type: "plain_text",
      text: String(value)
    });
  }
  for (const database of config.d1_databases ?? []) {
    add({
      name: requiredString(database?.binding, "D1 name"),
      type: "d1",
      database_id: requiredString(database?.database_id, "D1 database ID")
    });
  }
  for (const bucket of config.r2_buckets ?? []) {
    const binding = requiredString(bucket?.binding, "R2 name");
    // Wrangler's automatic provisioning derives an omitted bucket name from
    // the Worker and binding names; keep the post-upload proof independent.
    const bucketName =
      bucket?.bucket_name ??
      `${requiredString(config.name, "R2 Worker name")}-${binding
        .toLowerCase()
        .replaceAll("_", "-")}`;
    add({
      name: binding,
      type: "r2_bucket",
      bucket_name: requiredString(bucketName, "R2 bucket name")
    });
  }
  for (const producer of config.queues?.producers ?? []) {
    add({
      name: requiredString(producer?.binding, "Queue name"),
      type: "queue",
      queue_name: requiredString(producer?.queue, "Queue target")
    });
  }
  for (const durableObject of config.durable_objects?.bindings ?? []) {
    assertExactKeys(
      durableObject,
      ["name", "class_name"],
      "Pinned Worker Durable Object binding"
    );
    add({
      name: requiredString(durableObject?.name, "Durable Object name"),
      type: "durable_object_namespace",
      class_name: requiredString(
        durableObject?.class_name,
        "Durable Object class"
      )
    });
  }
  for (const name of REQUIRED_SECRET_BINDINGS) {
    add({ name, type: "secret_text" });
  }

  bindings.sort((left, right) => left.name.localeCompare(right.name));
  for (let index = 1; index < bindings.length; index += 1) {
    if (bindings[index - 1].name === bindings[index].name) {
      throw new Error(`Pinned Worker config contains duplicate binding ${bindings[index].name}`);
    }
  }
  return Object.freeze(bindings);
}

function assertVersionBindings(bindings, expectedBindings) {
  if (!Array.isArray(bindings) || bindings.length > 256) {
    throw new Error("Worker version bindings are invalid or unbounded");
  }
  const byName = new Map();
  for (const binding of bindings) {
    const name = requiredString(binding?.name, "version binding name");
    const type = requiredString(binding?.type, "version binding type");
    if (byName.has(name)) {
      throw new Error(`Worker version contains duplicate binding ${name}`);
    }
    byName.set(name, { ...binding, type });
  }
  const expectedNames = new Set(expectedBindings.map((binding) => binding.name));
  for (const [name, binding] of byName) {
    if (!expectedNames.has(name)) {
      throw new Error(
        `Worker version contains unexpected ${binding.type} binding ${name}`
      );
    }
  }
  for (const expected of expectedBindings) {
    const actual = byName.get(expected.name);
    if (!actual || actual.type !== expected.type) {
      throw new Error(`Worker version binding mismatch for ${expected.name}`);
    }
    if (expected.type === "durable_object_namespace") {
      assertExactKeys(
        actual,
        Object.keys(expected),
        `Worker version Durable Object binding ${expected.name}`
      );
    }
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) {
        throw new Error(`Worker version binding mismatch for ${expected.name}.${key}`);
      }
    }
  }
}

function cancelBody(response) {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  } catch {
    // Response cleanup must not replace the bounded verification result.
  }
}

export async function readBoundedHealthIdentity(response) {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    cancelBody(response);
    throw new Error("Release health identity must be application/json");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      cancelBody(response);
      throw new Error("Release health identity returned an invalid Content-Length");
    }
    if (declaredBytes > HEALTH_IDENTITY_MAX_BYTES) {
      cancelBody(response);
      throw new Error("Release health identity exceeded its bounded response size");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Release health identity returned no readable body");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Release health identity returned non-byte body data");
      }
      byteLength += value.byteLength;
      if (byteLength > HEALTH_IDENTITY_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Release health identity exceeded its bounded response size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

export function resolveTaggedWorkerVersion(output, releaseTag) {
  if (!RELEASE_TAG_PATTERN.test(releaseTag ?? "")) {
    throw new Error("Worker release tag is invalid");
  }
  let versions;
  try {
    versions = JSON.parse(output);
  } catch {
    throw new Error("Worker version list returned malformed JSON");
  }
  if (!Array.isArray(versions) || versions.length > 10) {
    throw new Error("Worker version list must contain at most ten versions");
  }
  const matches = versions.filter(
    (version) => version?.annotations?.["workers/tag"] === releaseTag
  );
  if (matches.length > 1) {
    throw new Error("Worker release tag resolves to multiple versions");
  }
  if (matches.length === 0) return null;
  if (!WORKER_VERSION_ID_PATTERN.test(matches[0]?.id ?? "")) {
    throw new Error("Tagged Worker version has an invalid ID");
  }
  return matches[0].id;
}

function assertVersionReleaseIdentity(output, expected, expectedBindings) {
  let version;
  try {
    version = JSON.parse(output);
  } catch {
    throw new Error("Worker version detail returned malformed JSON");
  }
  if (version?.id !== expected.versionId || !Array.isArray(version?.resources?.bindings)) {
    throw new Error("Worker version detail lacks exact release identity bindings");
  }
  assertVersionBindings(version.resources.bindings, expectedBindings);
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
      matches[0].type !== "plain_text" ||
      matches[0].text !== text
    ) {
      throw new Error(`Worker version release identity mismatch for ${name}`);
    }
  }
}

export function resolveOptionalWorkerSourceRevision(output, expectedVersionId) {
  let version;
  try {
    version = JSON.parse(output);
  } catch {
    throw new Error("Worker version detail returned malformed JSON");
  }
  if (
    version?.id !== expectedVersionId ||
    !Array.isArray(version?.resources?.bindings)
  ) {
    throw new Error("Worker version detail lacks exact release identity bindings");
  }
  const matches = version.resources.bindings.filter(
    (binding) => binding?.name === "SURF_SOURCE_REVISION"
  );
  if (matches.length === 0) return null;
  if (
    matches.length !== 1 ||
    matches[0].type !== "plain_text" ||
    !/^[0-9a-f]{40}$/.test(matches[0].text ?? "") ||
    matches[0].text === "0".repeat(40)
  ) {
    throw new Error("Worker version source revision binding is invalid");
  }
  return matches[0].text;
}

export function resolveWorkerSourceRevision(output, expectedVersionId) {
  const revision = resolveOptionalWorkerSourceRevision(output, expectedVersionId);
  if (revision === null) {
    throw new Error("Worker version source revision binding is invalid");
  }
  return revision;
}

export class AmbiguousWorkerActivationError extends Error {
  constructor(cause) {
    super(
      "Worker activation could not be reconciled to exactly the predecessor or target",
      { cause }
    );
    this.name = "AmbiguousWorkerActivationError";
  }
}

function inspectDeployment(context) {
  const output = context.runWrangler(["deployments", "status", "--json"], {
    capture: true,
    echo: false
  });
  const workerVersionId = resolveSoleActiveWorkerVersionId(output);
  const deploymentId = resolveActiveDeploymentId(output, workerVersionId);
  return Object.freeze({ workerVersionId, deploymentId });
}

export function createWorkerReleaseOperations({
  context,
  workerSecretsFile,
  customOrigin,
  workersDevOrigin,
  clientDirectory,
  sourceRevision,
  clientBuildDigest,
  clientOutputIdentity,
  workerBundlePath,
  workerRuntimeDigest,
  narrativeProtocolFingerprint,
  releaseTag,
  fetcher = fetch
}) {
  if (!RELEASE_TAG_PATTERN.test(releaseTag ?? "")) {
    throw new Error("Worker release tag is invalid");
  }
  const origins = Object.freeze([customOrigin, workersDevOrigin]);
  const seedPath = resolve(
    context.releaseRoot,
    "packages/db/seeds/0000_v1_norcal.sql"
  );
  const releaseStorage = createReleaseStorage({ commandContext: context });
  const expectedBindings = expectedWorkerBindingDescriptor(context.readConfig());
  const assertPlannedBuildOutputsUnchanged = () => {
    if (workerBundleDigest(workerBundlePath) !== workerRuntimeDigest) {
      throw new Error("Prebuilt Worker bundle differs from its planned runtime digest");
    }
    assertClientOutputIdentity(clientDirectory, clientOutputIdentity);
  };
  assertPlannedBuildOutputsUnchanged();
  const inspectActive = () => inspectDeployment(context);
  const inspectVersion = (versionId) => {
    const output = context.runWrangler(
      ["versions", "view", versionId, "--json"],
      { capture: true, echo: false }
    );
    const runtime = parseWorkerRuntime(output, {
      expectedVersionId: versionId,
      requireCpuLimit: true
    });
    assertVersionReleaseIdentity(output, {
      versionId,
      sourceRevision,
      workerRuntimeDigest,
      clientBuildDigest
    }, expectedBindings);
    return runtime;
  };
  const findTaggedUpload = () => {
    const output = context.runWrangler(["versions", "list", "--json"], {
      capture: true,
      echo: false
    });
    const versionId = resolveTaggedWorkerVersion(output, releaseTag);
    if (versionId !== null) inspectVersion(versionId);
    return versionId === null ? null : Object.freeze({ versionId });
  };
  const upload = () => {
    assertPlannedBuildOutputsUnchanged();
    let output;
    let commandError = null;
    try {
      output = context.runWrangler(
        [
          ...prebuiltWorkerVersionUploadArgs(workerBundlePath),
          "--tag",
          releaseTag,
          "--message",
          `surf release ${releaseTag}`,
          "--secrets-file",
          workerSecretsFile
        ],
        { capture: true, env: { CI: "true" } }
      );
    } catch (error) {
      commandError = workerVersionUploadFailure(error);
    }
    let integrityError = null;
    try {
      assertPlannedBuildOutputsUnchanged();
    } catch (error) {
      integrityError = error;
    }
    if (commandError && integrityError) {
      throw new AggregateError(
        [commandError, integrityError],
        "Worker upload failed while planned build outputs also changed"
      );
    }
    if (integrityError) throw integrityError;
    if (commandError) throw commandError;
    const versionId = resolveUploadedVersionId(output);
    inspectVersion(versionId);
    return Object.freeze({ versionId });
  };
  const activate = (versionId, predecessor) => {
    const before = inspectActive();
    if (
      before.workerVersionId !== predecessor.workerVersionId ||
      before.deploymentId !== predecessor.deploymentId
    ) {
      throw new Error("Active Worker predecessor changed before activation");
    }
    try {
      context.runWrangler(workerVersionActivationArgs(versionId), {
        env: { CI: "true" }
      });
    } catch (activationError) {
      try {
        const reconciled = inspectActive();
        if (reconciled.workerVersionId === versionId) return reconciled;
        if (
          reconciled.workerVersionId === predecessor.workerVersionId &&
          reconciled.deploymentId === predecessor.deploymentId
        ) {
          throw activationError;
        }
      } catch (reconciliationError) {
        throw new AmbiguousWorkerActivationError(
          new AggregateError([activationError, reconciliationError])
        );
      }
      throw new AmbiguousWorkerActivationError(activationError);
    }
    const after = inspectActive();
    if (after.workerVersionId !== versionId) {
      throw new AmbiguousWorkerActivationError();
    }
    return after;
  };
  const reconcileActivation = ({
    targetVersionId,
    targetDeploymentId = null,
    predecessorVersionId,
    predecessorDeploymentId
  }) => {
    const active = inspectActive();
    if (
      active.workerVersionId === targetVersionId &&
      (targetDeploymentId === null || active.deploymentId === targetDeploymentId)
    ) {
      return Object.freeze({ state: "target", ...active });
    }
    if (
      active.workerVersionId === predecessorVersionId &&
      active.deploymentId === predecessorDeploymentId
    ) {
      return Object.freeze({ state: "predecessor", ...active });
    }
    return Object.freeze({ state: "ambiguous", ...active });
  };
  const waitUntilServing = async (versionId) => {
    const results = await Promise.all(
      origins.map((baseUrl) =>
        waitForWorkerVersion({
          baseUrl,
          expectedVersionId: versionId,
          expectedWorkerName: context.workerName,
          fetcher
        })
      )
    );
    const active = inspectActive();
    if (active.workerVersionId !== versionId) {
      throw new Error("Target Worker stopped being sole-active during readiness");
    }
    return results;
  };
  const verifyLive = async (versionId, { requireForecastData = true } = {}) => {
    await Promise.all(
      origins.map((origin) =>
        smokeForecastInstance(origin, {
          label: `release smoke ${origin}`,
          requireForecastData,
          expectedVersionId: versionId,
          expectedWorkerName: context.workerName,
          fetcher
        })
      )
    );
    await smokeStaticAssetsAcrossOrigins(origins, {
      clientDirectory,
      sourceRevision,
      clientBuildDigest,
      fetcher
    });
    await Promise.all(
      origins.map(async (origin) => {
        const url = new URL("/api/health", origin);
        url.searchParams.set("surf-release", sourceRevision);
        const response = await fetcher(url, {
          method: "GET",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { Accept: "application/json", "Cache-Control": "no-store" }
        });
        if (!response.ok) {
          throw new Error(`Release health identity returned HTTP ${response.status}`);
        }
        const raw = await readBoundedHealthIdentity(response);
        let health;
        try {
          health = JSON.parse(raw);
        } catch {
          throw new Error("Release health identity was not JSON");
        }
        for (const [key, value] of Object.entries({
          sourceRevision,
          workerRuntimeDigest,
          clientBuildDigest,
          narrativeProtocolFingerprint
        })) {
          if (health?.[key] !== value) {
            throw new Error(`Release health identity mismatch for ${key}`);
          }
        }
      })
    );
    const active = inspectActive();
    if (active.workerVersionId !== versionId) {
      throw new Error("Target Worker stopped being sole-active after smoke");
    }
    return active;
  };
  const inspectGeneration = async (versionId, notBefore) => {
    if (
      !WORKER_VERSION_ID_PATTERN.test(versionId ?? "") ||
      typeof notBefore !== "string" ||
      new Date(notBefore).toISOString() !== notBefore
    ) {
      throw new Error("Release generation reconciliation identity is invalid");
    }
    context.assertUnchanged();
    try {
      const result = await inspectRemoteForecastReadModels({
        baseUrl: customOrigin,
        ingestId: versionId,
        requestedAt: notBefore,
        forecastGeneratedAt: notBefore,
        expectedVersionId: versionId,
        expectedWorkerName: context.workerName,
        fetcher
      });
      return result.status === "published"
        ? Object.freeze({ generationId: versionId })
        : null;
    } finally {
      context.assertUnchanged();
    }
  };
  return Object.freeze({
    inspectActive,
    inspectVersion,
    findTaggedUpload,
    upload,
    activate,
    reconcileActivation,
    waitUntilServing,
    verifyLive,
    inspectGeneration,
    ensureQueues: context.ensureQueues,
    inspectQueueConsumers() {
      if (typeof context.inspectQueueConsumers !== "function") {
        throw new Error("Release command context cannot inspect Queue consumers");
      }
      return context.inspectQueueConsumers();
    },
    inspectTriggers() {
      if (typeof context.inspectCronTriggers !== "function") {
        throw new Error("Release command context cannot inspect cron triggers");
      }
      return context.inspectCronTriggers();
    },
    async syncTriggers() {
      if (typeof context.removeStaleQueueConsumers !== "function") {
        throw new Error(
          "Release command context cannot reconcile stale Queue consumers"
        );
      }
      await context.removeStaleQueueConsumers();
      context.runWrangler(workerTriggerSyncArgs(), { env: { CI: "true" } });
    },
    migrate() {
      context.runWrangler(["d1", "migrations", "apply", "DB", "--remote"], {
        env: { CI: "true" }
      });
    },
    seed() {
      const before = releaseStorage.inspectSeedState({
        databaseName: "DB",
        seedPath
      });
      if (before.matches) {
        return Object.freeze({ ...before, disposition: "reconciled" });
      }
      context.assertUnchanged();
      try {
        context.runWrangler([
          "d1",
          "execute",
          "DB",
          "--remote",
          "--yes",
          "--file",
          seedPath
        ]);
      } finally {
        context.assertUnchanged();
      }
      const after = releaseStorage.inspectSeedState({
        databaseName: "DB",
        seedPath
      });
      if (
        !after.matches ||
        after.seedSha256 !== before.seedSha256 ||
        after.semanticSha256 !== before.semanticSha256
      ) {
        throw new Error(
          "D1 seed command completed without producing the exact immutable seed state"
        );
      }
      return Object.freeze({ ...after, disposition: "applied" });
    },
    generate(versionId, ingestToken) {
      context.assertUnchanged();
      let output;
      try {
        output = context.runPnpm(["ingest:remote"], {
          capture: true,
          timeoutPolicy: "finite",
          timeoutMs: RELEASE_GENERATION_TIMEOUT_MS,
          env: {
            SURF_BASE_URL: customOrigin,
            SURF_INGEST_TOKEN: ingestToken,
            SURF_EXPECTED_WORKER_VERSION: versionId,
            SURF_EXPECTED_WORKER_NAME: context.workerName
          }
        });
      } finally {
        context.assertUnchanged();
      }
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new Error("Remote generation command did not return one JSON receipt");
      }
      if (typeof parsed.ingestId !== "string" || parsed.ingestId.length === 0) {
        throw new Error("Remote generation receipt is missing ingestId");
      }
      return Object.freeze({ generationId: parsed.ingestId });
    }
  });
}

export function buildWorkerCandidate({
  context,
  outputDirectory,
  sourceRevision,
  clientBuildDigest
}) {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  context.runPnpm(["--filter", "@surf/web", "build"], {
    env: {
      SURF_RELEASE_SHA: sourceRevision,
      SURF_CLIENT_BUILD_DIGEST: clientBuildDigest
    }
  });
  context.runWrangler(
    ["deploy", "--dry-run", "--outdir", outputDirectory],
    { env: { CI: "true" } }
  );
  assertWorkerCandidateInventory(outputDirectory);
  const bundlePath = resolve(outputDirectory, "index.js");
  const clientDirectory = resolve(context.releaseRoot, "apps/web/dist/client");
  return Object.freeze({
    bundlePath,
    workerRuntimeDigest: workerBundleDigest(bundlePath),
    clientDirectory,
    clientOutputIdentity: captureClientOutputIdentity(clientDirectory)
  });
}
