import { resolveActiveDeploymentId } from "./deploy-url.mjs";
import { isWorkerVersionId } from "./worker-version.mjs";
import { SUPPORTED_WORKER_CPU_LIMIT_MS } from "./validate-wrangler-config.mjs";

function parseJsonObject(output, label) {
  let value;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} must be exactly one JSON object.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

export function resolveSoleActiveWorkerVersionId(output) {
  const status = parseJsonObject(output, "Wrangler deployment status");
  const versionId = status.versions?.[0]?.version_id;
  if (!isWorkerVersionId(versionId)) {
    throw new Error("Active deployment did not identify a valid Worker version UUID.");
  }
  // Reuse the rollout parser so preflight also rejects split, partial, or
  // unsupported deployment strategies before any Queue or D1 mutation.
  resolveActiveDeploymentId(output, versionId);
  return versionId;
}

export function parseWorkerRuntime(
  output,
  { expectedVersionId, requireCpuLimit = false } = {}
) {
  const version = parseJsonObject(output, "Wrangler Worker version detail");
  if (!isWorkerVersionId(expectedVersionId)) {
    throw new Error("Expected Worker runtime version must be a UUID.");
  }
  if (version.id !== expectedVersionId) {
    throw new Error(
      `Worker runtime detail does not match the expected version; expected ${expectedVersionId}, received ${String(version.id ?? "missing")}.`
    );
  }
  const runtime = version.resources?.script_runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error("Worker version detail did not include script runtime metadata.");
  }
  if (runtime.usage_model !== "standard") {
    throw new Error(
      `Worker ${expectedVersionId} must use the Standard usage model; received ${String(runtime.usage_model ?? "missing")}.`
    );
  }
  const cpuMs = runtime.limits?.cpu_ms;
  if (requireCpuLimit && cpuMs !== SUPPORTED_WORKER_CPU_LIMIT_MS) {
    throw new Error(
      `Worker ${expectedVersionId} must publish limits.cpu_ms=${SUPPORTED_WORKER_CPU_LIMIT_MS}; received ${String(cpuMs ?? "missing")}.`
    );
  }
  return {
    workerVersion: expectedVersionId,
    usageModel: runtime.usage_model,
    cpuMs: cpuMs ?? null
  };
}
