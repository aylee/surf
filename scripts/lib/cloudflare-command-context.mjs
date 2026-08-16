import { spawnSync } from "node:child_process";
import {
  wranglerEnvironmentFailures,
  wranglerStructureFailures
} from "./validate-wrangler-config.mjs";
import { verifyWranglerConfigSnapshot } from "./wrangler-config-snapshot.mjs";
import { readBoundedResponseJson } from "./bounded-http-response.mjs";

export const RELEASE_COMMAND_TIMEOUT_MS = 45 * 60_000;
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const CRON_INSPECTION_TIMEOUT_MS = 15_000;
const CRON_INSPECTION_MAX_BYTES = 64 * 1024;
const QUEUE_CONSUMER_INSPECTION_MAX_BYTES = 128 * 1024;
const QUEUE_CONSUMER_INSPECTION_MAX_COUNT = 16;
const QUEUE_INSPECTION_MAX_BYTES = 2 * 1024 * 1024;
const QUEUE_INSPECTION_MAX_PAGES = 100;
const QUEUE_INSPECTION_MAX_QUEUES = 256;
const QUEUE_TOPOLOGY_OPERATION_TIMEOUT_MS = 30_000;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const RESOURCE_ID_PATTERN = /^[0-9a-f]{32}$/i;

function commandTimeout(options = {}) {
  if (options.timeoutPolicy === "unbounded") {
    if (options.timeoutMs !== undefined) {
      throw new Error("An unbounded release command cannot also set timeoutMs");
    }
    return undefined;
  }
  if (options.timeoutPolicy !== undefined && options.timeoutPolicy !== "finite") {
    throw new Error("Release command timeoutPolicy must be finite or unbounded");
  }
  const value = options.timeoutMs ?? RELEASE_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Release command timeout must be a positive integer in milliseconds");
  }
  return value;
}

function apiErrorCodes(output) {
  const codes = new Set();
  for (const match of String(output).matchAll(/\[code:\s*(\d+)\]/gi)) {
    codes.add(Number(match[1]));
  }
  return [...codes];
}

const ISO_UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function exactIsoTimestampNanoseconds(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  const match = value.match(ISO_UTC_TIMESTAMP_PATTERN);
  if (!match) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  const wholeSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const milliseconds = Date.parse(`${wholeSecond}.000Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== `${wholeSecond}.000Z`
  ) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  const fractionalNanoseconds = BigInt(
    (match[7] ?? "").padEnd(9, "0") || "0"
  );
  return BigInt(milliseconds) * 1_000_000n + fractionalNanoseconds;
}

export function configuredReleaseQueueNames(config) {
  const names = new Set();
  for (const producer of config.queues?.producers ?? []) {
    if (producer.queue) names.add(producer.queue);
  }
  for (const consumer of config.queues?.consumers ?? []) {
    if (consumer.queue) names.add(consumer.queue);
    if (consumer.dead_letter_queue) names.add(consumer.dead_letter_queue);
  }
  if (
    (config.queues?.producers ?? []).some(
      (producer) => producer.binding === "NARRATIVE_QUEUE"
    )
  ) {
    names.add(`${config.name}-narrative-dlq`);
  }
  return [...names].sort();
}

function configuredQueueConsumerDescriptors(config) {
  const workerName = config.name;
  return (config.queues?.consumers ?? [])
    .map((consumer) =>
      Object.freeze({
        queue: consumer.queue,
        workerName,
        environmentName: "",
        deadLetterQueue: consumer.dead_letter_queue ?? null,
        settings: Object.freeze({
          batchSize: consumer.max_batch_size ?? 10,
          maxRetries: consumer.max_retries ?? 3,
          maxWaitTimeMs: (consumer.max_batch_timeout ?? 5) * 1_000,
          maxConcurrency: consumer.max_concurrency ?? null,
          retryDelay: consumer.retry_delay ?? 0
        })
      })
    )
    .sort((left, right) => left.queue.localeCompare(right.queue));
}

function normalizedRemoteWorkerConsumer(consumer, queue) {
  if (!consumer || typeof consumer !== "object" || Array.isArray(consumer)) {
    return null;
  }
  if (
    consumer.type !== "worker" ||
    !consumer.settings ||
    typeof consumer.settings !== "object" ||
    Array.isArray(consumer.settings)
  ) {
    return null;
  }
  const allowedConsumerKeys = new Set([
    "consumer_id",
    "created_on",
    "dead_letter_queue",
    "environment",
    "environment_name",
    "queue_id",
    "queue_name",
    "script",
    "script_name",
    "service",
    "settings",
    "type"
  ]);
  const allowedSettingKeys = new Set([
    "batch_size",
    "max_concurrency",
    "max_retries",
    "max_wait_time_ms",
    "retry_delay"
  ]);
  if (
    Object.keys(consumer).some((key) => !allowedConsumerKeys.has(key)) ||
    Object.keys(consumer.settings).some((key) => !allowedSettingKeys.has(key))
  ) {
    return null;
  }
  if (
    (consumer.queue_id !== undefined && consumer.queue_id !== queue.id) ||
    (consumer.queue_name !== undefined && consumer.queue_name !== queue.name)
  ) {
    return null;
  }
  const names = [consumer.script, consumer.service, consumer.script_name].filter(
    (value) => value !== undefined
  );
  if (
    names.length === 0 ||
    names.some(
      (value) =>
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 256 ||
        /[\x00-\x1f\x7f]/.test(value)
    ) ||
    new Set(names).size !== 1
  ) {
    return null;
  }
  const environments = [
    consumer.environment,
    consumer.environment_name
  ].filter((value) => value !== undefined);
  if (
    environments.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 256 ||
        /[\x00-\x1f\x7f]/.test(value)
    ) ||
    new Set(environments).size > 1
  ) {
    return null;
  }
  const normalizedSettings = {
    batchSize: consumer.settings.batch_size ?? 10,
    maxRetries: consumer.settings.max_retries ?? 3,
    maxWaitTimeMs: consumer.settings.max_wait_time_ms ?? 5_000,
    maxConcurrency: consumer.settings.max_concurrency ?? null,
    retryDelay: consumer.settings.retry_delay ?? 0
  };
  const numeric = [
    normalizedSettings.batchSize,
    normalizedSettings.maxRetries,
    normalizedSettings.maxWaitTimeMs,
    normalizedSettings.retryDelay
  ];
  if (
    numeric.some((value) => !Number.isInteger(value) || value < 0) ||
    (normalizedSettings.maxConcurrency !== null &&
      (!Number.isInteger(normalizedSettings.maxConcurrency) ||
        normalizedSettings.maxConcurrency < 1))
  ) {
    return null;
  }
  const deadLetterQueue = consumer.dead_letter_queue;
  if (
    deadLetterQueue !== undefined &&
    deadLetterQueue !== null &&
    (typeof deadLetterQueue !== "string" ||
      deadLetterQueue.length > 256 ||
      /[\x00-\x1f\x7f]/.test(deadLetterQueue))
  ) {
    return null;
  }
  return Object.freeze({
    consumerId: RESOURCE_ID_PATTERN.test(consumer.consumer_id ?? "")
      ? consumer.consumer_id
      : null,
    workerName: names[0],
    environmentName: environments[0] ?? "",
    deadLetterQueue:
      deadLetterQueue === undefined ||
      deadLetterQueue === null ||
      deadLetterQueue === ""
        ? null
        : deadLetterQueue,
    settings: Object.freeze({
      ...normalizedSettings
    })
  });
}

function sameQueueConsumer(left, right) {
  return (
    left !== null &&
    left.workerName === right.workerName &&
    left.environmentName === right.environmentName &&
    left.deadLetterQueue === right.deadLetterQueue &&
    left.settings.batchSize === right.settings.batchSize &&
    left.settings.maxRetries === right.settings.maxRetries &&
    left.settings.maxWaitTimeMs === right.settings.maxWaitTimeMs &&
    left.settings.maxConcurrency === right.settings.maxConcurrency &&
    left.settings.retryDelay === right.settings.retryDelay
  );
}

export function createCloudflareCommandContext({
  releaseRoot,
  configPath,
  configSha256,
  environment = process.env,
  guard = () => undefined,
  spawn = spawnSync,
  fetcher = fetch,
  logger = console
}) {
  if (
    typeof guard !== "function" ||
    typeof spawn !== "function" ||
    typeof fetcher !== "function"
  ) {
    throw new Error(
      "Cloudflare command context requires callable guard, spawn, and fetch"
    );
  }
  const pinned = verifyWranglerConfigSnapshot({
    path: configPath,
    releaseRoot,
    expectedSha256: configSha256
  });
  const baseEnvironment = Object.freeze({ ...environment });

  const assertUnchanged = () => {
    guard();
    verifyWranglerConfigSnapshot({
      path: pinned.path,
      releaseRoot,
      expectedSha256: pinned.sha256
    });
    guard();
  };

  const readConfig = () => {
    assertUnchanged();
    return structuredClone(pinned.config);
  };

  const assertConfig = (commandEnvironment = baseEnvironment) => {
    const config = readConfig();
    const failures = [
      ...wranglerStructureFailures(config, pinned.path),
      ...wranglerEnvironmentFailures(config, commandEnvironment)
    ];
    if (failures.length > 0) {
      throw new Error(
        `Pinned Wrangler configuration is unsafe:\n${failures
          .map((failure) => `- ${failure}`)
          .join("\n")}`
      );
    }
    return config;
  };

  const invokePnpm = (args, options = {}) => {
    const timeoutMs = commandTimeout(options);
    const capture = options.capture ?? false;
    const result = spawn("pnpm", args, {
      cwd: releaseRoot,
      encoding: "utf8",
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      env: {
        ...baseEnvironment,
        WRANGLER_SEND_METRICS: "false",
        ...options.env
      },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        const error = new Error(
          `Release subprocess exceeded its ${timeoutMs}ms timeout; captured output was suppressed`
        );
        error.name = "TimeoutError";
        throw error;
      }
      throw result.error;
    }
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0) {
      const error = new Error(
        `pnpm ${args.join(" ")} exited with status ${result.status ?? "unknown"}`
      );
      Object.defineProperty(error, "cloudflareApiErrorCodes", {
        value: apiErrorCodes(output),
        enumerable: false
      });
      throw error;
    }
    if (capture && options.echo === true && output) process.stdout.write(output);
    return output;
  };

  const runPnpm = (args, options = {}) => {
    logger.info?.({ event: "release_command", command: "pnpm", args });
    return invokePnpm(args, options);
  };

  const wranglerArgs = (args) => [
    "--filter",
    "@surf/web",
    "exec",
    "wrangler",
    ...args,
    "--config",
    pinned.path
  ];

  const runWrangler = (args, options = {}) => {
    assertUnchanged();
    try {
      return runPnpm(wranglerArgs(args), {
        ...options,
        ...(options.capture
          ? { env: { ...options.env, CI: "true" } }
          : {})
      });
    } finally {
      assertUnchanged();
    }
  };

  const probeWrangler = (args, options = {}) => {
    assertUnchanged();
    try {
      const timeoutMs = commandTimeout(options);
      return spawn("pnpm", wranglerArgs(args), {
        cwd: releaseRoot,
        encoding: "utf8",
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
        env: {
          ...baseEnvironment,
          WRANGLER_SEND_METRICS: "false",
          CI: "true",
          ...options.env
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } finally {
      assertUnchanged();
    }
  };

  const inspectQueues = () => {
    const config = assertConfig();
    const queueNames = configuredReleaseQueueNames(config);
    if (queueNames.length === 0) {
      throw new Error("Pinned Wrangler config does not define any Queues");
    }
    const missing = [];
    for (const queueName of queueNames) {
      const result = probeWrangler(["queues", "info", queueName]);
      if (result.error) throw result.error;
      if (result.status === 0) continue;
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (!output.includes(`Queue "${queueName}" does not exist`)) {
        throw new Error(`Could not inspect Queue ${queueName}`);
      }
      missing.push(queueName);
    }
    return Object.freeze({
      expected: Object.freeze(queueNames),
      missing: Object.freeze(missing),
      matches: missing.length === 0
    });
  };

  const ensureQueues = () => {
    const before = inspectQueues();
    for (const queueName of before.missing) {
      runWrangler(["queues", "create", queueName]);
    }
    const after = inspectQueues();
    if (!after.matches) {
      throw new Error("Configured Queues still differ after reconciliation");
    }
    return after;
  };

  const queueApiCredentials = (label) => {
    const accountId = baseEnvironment.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = baseEnvironment.CLOUDFLARE_API_TOKEN;
    if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) {
      throw new Error(`${label} requires an exact Cloudflare account ID`);
    }
    if (
      typeof apiToken !== "string" ||
      apiToken.length < 20 ||
      apiToken.length > 512 ||
      apiToken !== apiToken.trim() ||
      /[\x00-\x1f\x7f]/.test(apiToken)
    ) {
      throw new Error(`${label} requires a bounded Cloudflare API token`);
    }
    return { accountId, apiToken };
  };

  const inspectQueueInventory = async (
    signal = AbortSignal.timeout(QUEUE_TOPOLOGY_OPERATION_TIMEOUT_MS)
  ) => {
    const { accountId, apiToken } = queueApiCredentials(
      "Queue inventory inspection"
    );
    const queues = new Map();
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page += 1) {
      if (page > QUEUE_INSPECTION_MAX_PAGES) {
        throw new Error("Cloudflare Queue inventory inspection exceeded its page bound");
      }
      const endpoint = new URL(
        `/client/v4/accounts/${encodeURIComponent(accountId)}/queues`,
        CLOUDFLARE_API_ORIGIN
      );
      endpoint.searchParams.set("page", String(page));
      endpoint.searchParams.set("per_page", "100");
      assertUnchanged();
      let response;
      let payload;
      try {
        response = await fetcher(endpoint, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiToken}`
          }
        });
        payload = await readBoundedResponseJson(response, {
          maxBytes: QUEUE_INSPECTION_MAX_BYTES,
          label: "Cloudflare Queue inventory inspection"
        });
      } finally {
        assertUnchanged();
      }
      if (!response.ok || payload?.success !== true || !Array.isArray(payload.result)) {
        throw new Error(
          `Cloudflare Queue inventory inspection failed with HTTP ${response.status}`
        );
      }
      const pageInfo = payload.result_info;
      if (
        !Number.isInteger(pageInfo?.page) ||
        pageInfo.page !== page ||
        !Number.isInteger(pageInfo?.total_pages) ||
        pageInfo.total_pages < 1 ||
        pageInfo.total_pages > QUEUE_INSPECTION_MAX_PAGES ||
        payload.result.length > 100
      ) {
        throw new Error("Cloudflare Queue inventory pagination is invalid");
      }
      totalPages = pageInfo.total_pages;
      for (const queue of payload.result) {
        if (
          typeof queue?.queue_name !== "string" ||
          queue.queue_name.length < 1 ||
          queue.queue_name.length > 256 ||
          !RESOURCE_ID_PATTERN.test(queue.queue_id ?? "")
        ) {
          throw new Error("Cloudflare Queue inventory contains an invalid identity");
        }
        if (queues.has(queue.queue_name)) {
          throw new Error("Cloudflare Queue inventory contains a duplicate name");
        }
        queues.set(
          queue.queue_name,
          Object.freeze({
            name: queue.queue_name,
            id: queue.queue_id,
            createdOn: queue.created_on
          })
        );
        if (queues.size > QUEUE_INSPECTION_MAX_QUEUES) {
          throw new Error("Cloudflare Queue inventory exceeded its queue bound");
        }
      }
    }
    return Object.freeze({
      accountId,
      apiToken,
      queues: Object.freeze(
        [...queues.values()].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      )
    });
  };

  const inspectExactQueueConsumers = async ({
    accountId,
    apiToken,
    queue,
    signal
  }) => {
    const endpoint = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(
        queue.id
      )}/consumers`,
      CLOUDFLARE_API_ORIGIN
    );
    assertUnchanged();
    let response;
    let payload;
    try {
      response = await fetcher(endpoint, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`
        }
      });
      payload = await readBoundedResponseJson(response, {
        maxBytes: QUEUE_CONSUMER_INSPECTION_MAX_BYTES,
        label: `Cloudflare Queue consumer inspection for ${queue.name}`
      });
    } finally {
      assertUnchanged();
    }
    if (!response.ok || payload?.success !== true || !Array.isArray(payload.result)) {
      throw new Error(
        `Cloudflare Queue consumer inspection failed with HTTP ${response.status}`
      );
    }
    if (payload.result.length > QUEUE_CONSUMER_INSPECTION_MAX_COUNT) {
      throw new Error("Cloudflare Queue consumer inspection exceeded its consumer bound");
    }
    const workers = [];
    for (const consumer of payload.result) {
      if (!consumer || typeof consumer !== "object" || Array.isArray(consumer)) {
        throw new Error("Cloudflare Queue consumer inspection returned an invalid consumer");
      }
      if (consumer.type === "http_pull") continue;
      if (consumer.type !== "worker") {
        throw new Error("Cloudflare Queue consumer inspection returned an unknown type");
      }
      const normalized = normalizedRemoteWorkerConsumer(consumer, queue);
      if (normalized === null || normalized.consumerId === null) {
        throw new Error(
          "Cloudflare Queue consumer inspection returned an invalid Worker consumer"
        );
      }
      workers.push(normalized);
    }
    return Object.freeze({
      consumerCount: payload.result.length,
      workers: Object.freeze(workers)
    });
  };

  const inspectQueueIdentities = async () => {
    const config = assertConfig();
    const expectedNames = configuredReleaseQueueNames(config);
    const inventory = await inspectQueueInventory(
      AbortSignal.timeout(QUEUE_TOPOLOGY_OPERATION_TIMEOUT_MS)
    );
    const identities = new Map(
      inventory.queues.map((queue) => [queue.name, queue.id])
    );
    const missing = expectedNames.filter((name) => !identities.has(name));
    if (missing.length > 0) {
      throw new Error("Cloudflare Queue identity response lacks a configured Queue");
    }
    return Object.freeze({
      accountId: inventory.accountId,
      queues: Object.freeze(
        Object.fromEntries(
          expectedNames.map((name) => [name, identities.get(name)])
        )
      )
    });
  };

  const attestPreexistingQueues = async (createdBefore) => {
    const cutoffNanoseconds = exactIsoTimestampNanoseconds(
      createdBefore,
      "Queue preexistence cutoff"
    );
    const config = assertConfig();
    const expectedNames = configuredReleaseQueueNames(config);
    if (expectedNames.length === 0) {
      throw new Error("Pinned Wrangler config does not define any Queues");
    }
    const inventory = await inspectQueueInventory(
      AbortSignal.timeout(QUEUE_TOPOLOGY_OPERATION_TIMEOUT_MS)
    );
    const byName = new Map(
      inventory.queues.map((queue) => [queue.name, queue])
    );
    const evidence = expectedNames.map((name) => {
      const queue = byName.get(name);
      if (!queue) {
        throw new Error(
          "Cloudflare Queue preexistence attestation lacks a configured Queue"
        );
      }
      const createdNanoseconds = exactIsoTimestampNanoseconds(
        queue.createdOn,
        `Cloudflare Queue ${name} created_on`
      );
      if (createdNanoseconds >= cutoffNanoseconds) {
        throw new Error(
          `Cloudflare Queue ${name} was not created before the release cutoff`
        );
      }
      return Object.freeze({ name, createdOn: queue.createdOn });
    });
    return Object.freeze({ queues: Object.freeze(evidence) });
  };

  const inspectQueueConsumersWithSignal = async (signal) => {
    const config = assertConfig();
    const expected = configuredQueueConsumerDescriptors(config);
    if (expected.length === 0) {
      throw new Error("Pinned Wrangler config does not define Queue consumers");
    }
    const expectedByQueue = new Map(
      expected.map((descriptor) => [descriptor.queue, descriptor])
    );
    const inventory = await inspectQueueInventory(signal);
    const actual = [];
    const mismatches = new Set();
    const staleConsumers = [];
    const seenExpected = new Set();
    // Inspect every Queue in the account, not only target-declared Queues.
    // Wrangler updates configured consumers but does not remove a consumer
    // whose Queue disappeared from the target config.
    for (const queue of inventory.queues) {
      const inspected = await inspectExactQueueConsumers({
        accountId: inventory.accountId,
        apiToken: inventory.apiToken,
        queue,
        signal
      });
      const descriptor = expectedByQueue.get(queue.name);
      if (descriptor) {
        seenExpected.add(queue.name);
        const normalized =
          inspected.consumerCount === 1 && inspected.workers.length === 1
            ? inspected.workers[0]
            : null;
        const matches = sameQueueConsumer(normalized, descriptor);
        actual.push(
          Object.freeze({
            queue: queue.name,
            consumerCount: inspected.consumerCount,
            consumer: normalized,
            matches
          })
        );
        if (!matches) mismatches.add(queue.name);
        continue;
      }
      for (const consumer of inspected.workers) {
        if (
          consumer.workerName === config.name &&
          consumer.environmentName === ""
        ) {
          const stale = Object.freeze({
            queue: queue.name,
            queueId: queue.id,
            consumerId: consumer.consumerId,
            workerName: consumer.workerName,
            environmentName: consumer.environmentName
          });
          staleConsumers.push(stale);
          mismatches.add(queue.name);
          actual.push(
            Object.freeze({
              queue: queue.name,
              consumerCount: inspected.consumerCount,
              consumer,
              matches: false
            })
          );
        }
      }
    }
    for (const descriptor of expected) {
      if (seenExpected.has(descriptor.queue)) continue;
      mismatches.add(descriptor.queue);
      actual.push(
        Object.freeze({
          queue: descriptor.queue,
          consumerCount: 0,
          consumer: null,
          matches: false
        })
      );
    }
    actual.sort((left, right) => left.queue.localeCompare(right.queue));
    staleConsumers.sort((left, right) =>
      left.queue === right.queue
        ? left.consumerId.localeCompare(right.consumerId)
        : left.queue.localeCompare(right.queue)
    );
    const mismatchList = [...mismatches].sort();
    return Object.freeze({
      expected: Object.freeze(expected),
      actual: Object.freeze(actual),
      mismatches: Object.freeze(mismatchList),
      staleConsumers: Object.freeze(staleConsumers),
      matches: mismatchList.length === 0
    });
  };

  const inspectQueueConsumers = () =>
    inspectQueueConsumersWithSignal(
      AbortSignal.timeout(QUEUE_TOPOLOGY_OPERATION_TIMEOUT_MS)
    );

  const removeStaleQueueConsumers = async () => {
    const signal = AbortSignal.timeout(QUEUE_TOPOLOGY_OPERATION_TIMEOUT_MS);
    const inspection = await inspectQueueConsumersWithSignal(signal);
    if (inspection.staleConsumers.length === 0) {
      return Object.freeze({ removed: 0 });
    }
    const { accountId, apiToken } = queueApiCredentials(
      "Queue consumer reconciliation"
    );
    for (const stale of inspection.staleConsumers) {
      // Re-read the exact Queue immediately before deletion. A consumer that
      // changed Worker/environment identity is external drift, not ours to
      // remove.
      const latest = await inspectExactQueueConsumers({
        accountId,
        apiToken,
        queue: { name: stale.queue, id: stale.queueId },
        signal
      });
      const stillExact = latest.workers.some(
        (consumer) =>
          consumer.consumerId === stale.consumerId &&
          consumer.workerName === stale.workerName &&
          consumer.environmentName === stale.environmentName
      );
      if (!stillExact) {
        throw new Error(
          "Stale Queue consumer identity changed before exact deletion"
        );
      }
      const endpoint = new URL(
        `/client/v4/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(
          stale.queueId
        )}/consumers/${encodeURIComponent(stale.consumerId)}`,
        CLOUDFLARE_API_ORIGIN
      );
      assertUnchanged();
      let response;
      let payload;
      try {
        response = await fetcher(endpoint, {
          method: "DELETE",
          redirect: "error",
          cache: "no-store",
          signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiToken}`
          }
        });
        payload = await readBoundedResponseJson(response, {
          maxBytes: CRON_INSPECTION_MAX_BYTES,
          label: `Cloudflare stale Queue consumer removal for ${stale.queue}`
        });
      } finally {
        assertUnchanged();
      }
      if (!response.ok || payload?.success !== true) {
        throw new Error(
          `Cloudflare stale Queue consumer removal failed with HTTP ${response.status}`
        );
      }
    }
    const after = await inspectQueueConsumersWithSignal(signal);
    if (after.staleConsumers.length > 0) {
      throw new Error(
        "Stale Queue consumers remain after exact deletion reconciliation"
      );
    }
    return Object.freeze({ removed: inspection.staleConsumers.length });
  };

  const inspectCronTriggers = async () => {
    const config = readConfig();
    const expected = [...(config.triggers?.crons ?? [])].sort();
    if (
      expected.length > 32 ||
      expected.some(
        (cron) =>
          typeof cron !== "string" ||
          cron.length < 1 ||
          cron.length > 256 ||
          /[\x00-\x1f\x7f]/.test(cron)
      )
    ) {
      throw new Error("Pinned Wrangler cron trigger configuration is invalid");
    }
    const accountId = baseEnvironment.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = baseEnvironment.CLOUDFLARE_API_TOKEN;
    if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) {
      throw new Error("Cron trigger inspection requires an exact Cloudflare account ID");
    }
    if (
      typeof apiToken !== "string" ||
      apiToken.length < 20 ||
      apiToken.length > 512 ||
      apiToken !== apiToken.trim() ||
      /[\x00-\x1f\x7f]/.test(apiToken)
    ) {
      throw new Error("Cron trigger inspection requires a bounded Cloudflare API token");
    }
    const endpoint = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(
        pinned.config.name
      )}/schedules`,
      CLOUDFLARE_API_ORIGIN
    );
    assertUnchanged();
    try {
      const response = await fetcher(endpoint, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(CRON_INSPECTION_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`
        }
      });
      const payload = await readBoundedResponseJson(response, {
        maxBytes: CRON_INSPECTION_MAX_BYTES,
        label: "Cloudflare cron trigger inspection"
      });
      if (!response.ok || payload?.success !== true) {
        throw new Error(
          `Cloudflare cron trigger inspection failed with HTTP ${response.status}`
        );
      }
      const schedules = payload?.result?.schedules;
      if (!Array.isArray(schedules) || schedules.length > 32) {
        throw new Error("Cloudflare cron trigger inspection returned invalid schedules");
      }
      const actual = schedules.map((schedule) => {
        const cron = schedule?.cron;
        if (
          typeof cron !== "string" ||
          cron.length < 1 ||
          cron.length > 256 ||
          /[\x00-\x1f\x7f]/.test(cron)
        ) {
          throw new Error(
            "Cloudflare cron trigger inspection returned an invalid schedule"
          );
        }
        return cron;
      });
      actual.sort();
      if (new Set(actual).size !== actual.length) {
        throw new Error(
          "Cloudflare cron trigger inspection returned duplicate schedules"
        );
      }
      return Object.freeze({
        expected: Object.freeze(expected),
        actual: Object.freeze(actual),
        matches:
          expected.length === actual.length &&
          expected.every((cron, index) => cron === actual[index])
      });
    } finally {
      assertUnchanged();
    }
  };

  return Object.freeze({
    releaseRoot,
    configPath: pinned.path,
    configSha256: pinned.sha256,
    workerName: pinned.config.name,
    assertUnchanged,
    readConfig,
    assertConfig,
    runPnpm,
    runWrangler,
    probeWrangler,
    inspectQueues,
    inspectQueueIdentities,
    attestPreexistingQueues,
    inspectQueueConsumers,
    removeStaleQueueConsumers,
    ensureQueues,
    inspectCronTriggers
  });
}
