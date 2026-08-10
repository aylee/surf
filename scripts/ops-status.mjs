#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  assertActiveWranglerConfig,
  probeWrangler
} from "./lib/cloudflare-commands.mjs";
import { resolveActiveDeploymentId } from "./lib/deploy-url.mjs";
import {
  isWorkerVersionId,
  responseWorkerVersion
} from "./lib/worker-version.mjs";

export const OPS_STATUS_REQUEST_TIMEOUT_MS = 10_000;
export const OPS_STATUS_WRANGLER_TIMEOUT_MS = 60_000;

// Keep this as one metadata-only SELECT. A single statement gives the status
// command one D1 snapshot and never retrieves forecast_json.
export const READ_MODEL_STATUS_SQL =
  "with intervals(interval) as (values ('1h'), ('3h')) select s.id as spot_id, i.interval, case when r.spot_id is null then 'missing' else 'ready' end as state, r.generation_id, r.generated_at, r.materialized_at, length(r.forecast_json) as json_chars from spots s cross join intervals i left join forecast_read_models r on r.spot_id=s.id and r.interval=i.interval where s.active=1 order by s.id,i.interval";

const FORECAST_GENERATION_PATTERN =
  /^sha256:[a-f0-9]{64}(?::ingest:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;

function parseJson(output, label) {
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

function canonicalTimestampMs(value) {
  if (typeof value !== "string") return Number.NaN;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) && new Date(timestampMs).toISOString() === value
    ? timestampMs
    : Number.NaN;
}

function resolveBaseUrl(env) {
  const configuredUrl = env.SURF_BASE_URL;
  if (!configuredUrl) {
    throw new Error(
      "ops:status requires SURF_BASE_URL in the shell or root .env."
    );
  }
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error(
      "SURF_BASE_URL must be a bare HTTPS origin without credentials, path, query, or fragment."
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SURF_BASE_URL must be a bare HTTPS origin without credentials, path, query, or fragment."
    );
  }
  return url.origin;
}

function cancelBody(response) {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  } catch {
    // Status/header evidence must never wait on response-body cleanup.
  }
}

export async function probeHealth({
  baseUrl,
  expectedRegion,
  fetcher = globalThis.fetch,
  requestTimeoutMs = OPS_STATUS_REQUEST_TIMEOUT_MS
}) {
  if (typeof fetcher !== "function" || !(requestTimeoutMs > 0)) {
    throw new Error("HTTPS health probe requires fetch and a positive timeout.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    response = await fetcher(
      `${baseUrl}/api/health`,
      {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    clearTimeout(timeout);
    const kind = error instanceof Error ? error.name : "UnknownError";
    throw new Error(`HTTPS health probe failed (${kind}).`);
  }

  try {
    if (response.status !== 200) {
      cancelBody(response);
      throw new Error(`HTTPS health probe returned HTTP ${response.status}; expected 200.`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
    if (contentType !== "application/json") {
      cancelBody(response);
      throw new Error("HTTPS health probe did not return application/json.");
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("HTTPS health probe returned malformed JSON.");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      payload.status !== "ok" ||
      payload.service !== "surf" ||
      payload.region !== expectedRegion ||
      !Number.isFinite(canonicalTimestampMs(payload.generatedAt))
    ) {
      throw new Error("HTTPS health probe returned an invalid Surf health contract.");
    }

    const workerVersion = responseWorkerVersion(response);
    if (!isWorkerVersionId(workerVersion)) {
      throw new Error("HTTPS health probe did not identify a valid Worker version UUID.");
    }
    return {
      status: "PASS",
      service: payload.service,
      region: payload.region,
      workerVersion,
      generatedAt: payload.generatedAt
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseDeploymentStatus(output, expectedVersionId) {
  const value = parseJson(output, "Deployment status probe");
  const deploymentId = resolveActiveDeploymentId(output, expectedVersionId);
  return {
    status: "PASS",
    deploymentId,
    workerVersion: value.versions[0].version_id,
    percentage: value.versions[0].percentage
  };
}

export function parseQueueConsumers(output, expected) {
  const value = parseJson(output, "Queue consumer probe");
  if (!Array.isArray(value)) {
    throw new Error("Queue consumer probe must return one JSON array.");
  }
  if (value.length !== 1) {
    throw new Error(
      `Ingest queue must have exactly one Worker consumer; found ${value.length}.`
    );
  }
  const [consumer] = value;
  if (!consumer || typeof consumer !== "object" || Array.isArray(consumer)) {
    throw new Error("Ingest queue consumer must be a JSON object.");
  }
  const script = consumer.script ?? consumer.service;
  if (consumer.type !== "worker" || script !== expected.workerName) {
    throw new Error("Ingest queue is not consumed by the configured Worker.");
  }
  if (
    !consumer.settings ||
    typeof consumer.settings !== "object" ||
    Array.isArray(consumer.settings)
  ) {
    throw new Error("Ingest queue consumer settings are missing or invalid.");
  }
  const batchSize = consumer.settings.batch_size;
  const maxConcurrency = consumer.settings.max_concurrency;
  if (batchSize !== 1 || maxConcurrency !== 1) {
    throw new Error(
      `Ingest queue must be serialized at batch/concurrency 1/1; received ${String(batchSize)}/${String(maxConcurrency)}.`
    );
  }
  if (consumer.dead_letter_queue !== expected.deadLetterQueue) {
    throw new Error("Ingest queue does not use the configured dead-letter queue.");
  }
  return {
    status: "PASS",
    queue: expected.queue,
    consumer: script,
    batchSize,
    maxConcurrency,
    deadLetterQueue: consumer.dead_letter_queue
  };
}

export function parseReadModelStatus(output) {
  const value = parseJson(output, "D1 read-model probe");
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("D1 read-model probe must return exactly one statement result.");
  }
  const [statement] = value;
  if (
    !statement ||
    typeof statement !== "object" ||
    Array.isArray(statement) ||
    statement.success !== true ||
    !Array.isArray(statement.results)
  ) {
    throw new Error("D1 read-model SELECT did not complete successfully.");
  }

  const rows = statement.results;
  if (rows.length === 0) {
    throw new Error("D1 read-model SELECT returned no active spot rows.");
  }
  const keys = new Set();
  const intervalsBySpot = new Map();
  const generatedTimes = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("D1 read-model rows must be JSON objects.");
    }
    if (
      typeof row.spot_id !== "string" ||
      row.spot_id.length === 0 ||
      !["1h", "3h"].includes(row.interval)
    ) {
      throw new Error("D1 read-model SELECT returned an invalid spot/interval key.");
    }
    const key = `${row.spot_id}:${row.interval}`;
    if (keys.has(key)) {
      throw new Error(`D1 read-model SELECT returned duplicate key ${key}.`);
    }
    keys.add(key);

    const generatedAtMs = canonicalTimestampMs(row.generated_at);
    const materializedAtMs = canonicalTimestampMs(row.materialized_at);
    if (
      row.state !== "ready" ||
      typeof row.generation_id !== "string" ||
      !FORECAST_GENERATION_PATTERN.test(row.generation_id) ||
      !Number.isFinite(generatedAtMs) ||
      !Number.isFinite(materializedAtMs) ||
      materializedAtMs < generatedAtMs ||
      !Number.isInteger(row.json_chars) ||
      row.json_chars <= 0
    ) {
      throw new Error(`Read model ${key} is missing or invalid.`);
    }

    const pair = intervalsBySpot.get(row.spot_id) ?? {
      intervals: new Set(),
      generationId: row.generation_id,
      generatedAt: row.generated_at
    };
    if (pair.generationId !== row.generation_id) {
      throw new Error(`Read-model spot pair ${row.spot_id} has split generation_id.`);
    }
    if (pair.generatedAt !== row.generated_at) {
      throw new Error(`Read-model spot pair ${row.spot_id} has split generated_at.`);
    }
    pair.intervals.add(row.interval);
    intervalsBySpot.set(row.spot_id, pair);
    generatedTimes.push(row.generated_at);
  }
  if (
    intervalsBySpot.size === 0 ||
    [...intervalsBySpot.values()].some(
      ({ intervals }) =>
        intervals.size !== 2 || !intervals.has("1h") || !intervals.has("3h")
    )
  ) {
    throw new Error("D1 read-model SELECT did not return complete 1h/3h pairs for every active spot.");
  }

  const expected = intervalsBySpot.size * 2;
  generatedTimes.sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    status: "PASS",
    ready: rows.length,
    expected,
    spots: intervalsBySpot.size,
    oldestGeneratedAt: generatedTimes[0],
    newestGeneratedAt: generatedTimes.at(-1)
  };
}

async function runProbe(probe, args, label) {
  let result;
  try {
    result = await probe(args, { timeoutMs: OPS_STATUS_WRANGLER_TIMEOUT_MS });
  } catch (error) {
    const kind = error instanceof Error ? error.name : "UnknownError";
    throw new Error(`${label} subprocess failed (${kind}).`);
  }
  if (!result || typeof result !== "object" || result.status !== 0) {
    const status = result?.status ?? "unknown";
    throw new Error(`${label} subprocess exited with status ${String(status)}.`);
  }
  if (typeof result.stdout !== "string") {
    throw new Error(`${label} subprocess returned no JSON output.`);
  }
  return result.stdout;
}

function generatedRange(readModels) {
  return readModels.oldestGeneratedAt === readModels.newestGeneratedAt
    ? readModels.oldestGeneratedAt
    : `${readModels.oldestGeneratedAt} → ${readModels.newestGeneratedAt}`;
}

export function formatOpsStatus(result) {
  const rows = [
    [
      "HTTPS health",
      result.health.status,
      `${result.health.service}/${result.health.region} · Worker ${result.health.workerVersion}`
    ],
    [
      "Deployment",
      result.deployment.status,
      `${result.deployment.percentage}% → Worker ${result.deployment.workerVersion} · deployment ${result.deployment.deploymentId}`
    ],
    [
      "Queue",
      result.queue.status,
      `${result.queue.queue} · 1 consumer · batch/concurrency ${result.queue.batchSize}/${result.queue.maxConcurrency} · DLQ ${result.queue.deadLetterQueue}`
    ],
    [
      "Read models",
      result.readModels.status,
      `${result.readModels.ready}/${result.readModels.expected} ready · ${result.readModels.spots} spots · generated ${generatedRange(result.readModels)}`
    ]
  ];
  const headers = ["Check", "Status", "Evidence"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );
  const line = (row) =>
    row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [
    line(headers),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
    "",
    `ops:status PASS — 4/4 read-only probes; ${result.readModels.ready}/${result.readModels.expected} read models ready.`
  ].join("\n");
}

export async function runOpsStatus({
  env = process.env,
  config,
  fetcher = globalThis.fetch,
  wranglerProbe = probeWrangler,
  requestTimeoutMs = OPS_STATUS_REQUEST_TIMEOUT_MS
} = {}) {
  const activeConfig = config ?? assertActiveWranglerConfig();
  const baseUrl = resolveBaseUrl(env);
  const workerName = activeConfig.name;
  const queueConfig = activeConfig.queues.consumers[0];
  const queue = queueConfig.queue;
  const deadLetterQueue = queueConfig.dead_letter_queue;

  const health = await probeHealth({
    baseUrl,
    expectedRegion: activeConfig.vars.SURF_REGION,
    fetcher,
    requestTimeoutMs
  });
  const deploymentOutput = await runProbe(
    wranglerProbe,
    ["deployments", "status", "--json"],
    "Deployment status"
  );
  const deployment = parseDeploymentStatus(
    deploymentOutput,
    health.workerVersion
  );
  const queueOutput = await runProbe(
    wranglerProbe,
    ["queues", "consumer", "worker", "list", queue, "--json"],
    "Queue consumer"
  );
  const queueStatus = parseQueueConsumers(queueOutput, {
    workerName,
    queue,
    deadLetterQueue
  });
  const readModelOutput = await runProbe(
    wranglerProbe,
    [
      "d1",
      "execute",
      "DB",
      "--remote",
      "--json",
      "--command",
      READ_MODEL_STATUS_SQL
    ],
    "D1 read-model"
  );
  const readModels = parseReadModelStatus(readModelOutput);

  return {
    baseUrl,
    workerName,
    health,
    deployment,
    queue: queueStatus,
    readModels
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runOpsStatus();
    console.log(formatOpsStatus(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure.";
    console.error(`ops:status FAIL — ${message}`);
    process.exitCode = 1;
  }
}
