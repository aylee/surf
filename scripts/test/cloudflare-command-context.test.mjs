import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createCloudflareCommandContext } from "../lib/cloudflare-command-context.mjs";

function fixture(name, { productionOverlay = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `surf-command-context-${name}-`));
  const releaseRoot = join(root, "release");
  const configDirectory = join(root, "config");
  mkdirSync(join(releaseRoot, "apps/web/worker"), { recursive: true });
  mkdirSync(join(releaseRoot, "apps/web/dist/client"), { recursive: true });
  mkdirSync(join(releaseRoot, "packages/db/migrations"), { recursive: true });
  mkdirSync(join(releaseRoot, "apps/web/node_modules/wrangler"), { recursive: true });
  mkdirSync(configDirectory);
  writeFileSync(
    join(releaseRoot, "apps/web/node_modules/wrangler/config-schema.json"),
    "{}\n"
  );
  writeFileSync(join(releaseRoot, "apps/web/worker/index.ts"), "export default {};\n");
  writeFileSync(join(releaseRoot, "apps/web/dist/client/index.html"), "ok\n");
  const trackedConfig = {
    $schema: "node_modules/wrangler/config-schema.json",
    name,
    main: "worker/index.ts",
    compatibility_date: "2026-07-08",
    assets: { directory: "./dist/client", binding: "ASSETS" },
    limits: { cpu_ms: 2000 },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      ENVIRONMENT: "production",
      SURF_REGION: "norcal",
      SURF_USER_AGENT: "surf-test/1.0 (+https://example.test)",
      FORECAST_BRIEF_ENABLED: "false",
      NARRATIVE_ENABLED: "false",
      NARRATIVE_FALLBACK_MODEL: "gemini-3.6-flash",
      NARRATIVE_FALLBACK_DELAY_SECONDS: "600",
      NARRATIVE_FALLBACK_DAILY_CAP: "4",
      NARRATIVE_FALLBACK_ROLLING_31_DAY_CAP: "100"
    },
    durable_objects: { bindings: [{ name: "FORECAST_BRIEF_AGENT", class_name: "ForecastBriefAgent" }] },
    exports: { ForecastBriefAgent: { type: "durable-object", storage: "sqlite" } },
    d1_databases: [{ binding: "DB", database_name: name, database_id: "0".repeat(32), migrations_dir: "../../packages/db/migrations" }],
    r2_buckets: [{ binding: "RAW_ARTIFACTS", bucket_name: `${name}-raw-artifacts` }],
    queues: {
      producers: [
        { binding: "INGEST_QUEUE", queue: `${name}-ingest` },
        { binding: "NARRATIVE_QUEUE", queue: `${name}-narrative` },
        { binding: "NARRATIVE_FALLBACK_QUEUE", queue: `${name}-narrative-fallback` }
      ],
      consumers: [
        { queue: `${name}-ingest`, dead_letter_queue: `${name}-ingest-dlq`, max_batch_size: 1, max_batch_timeout: 30, max_concurrency: 1, max_retries: 3 },
        { queue: `${name}-narrative-fallback`, max_batch_size: 1, max_batch_timeout: 30, max_concurrency: 1, max_retries: 0 }
      ]
    },
    triggers: { crons: ["17 * * * *"] },
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true },
      traces: { enabled: true, head_sampling_rate: 1, persist: true }
    },
    cache: { enabled: true, cross_version_cache: false }
  };
  writeFileSync(
    join(releaseRoot, "apps/web/wrangler.jsonc"),
    `${JSON.stringify(trackedConfig)}\n`
  );
  const config = structuredClone(trackedConfig);
  const canonicalReleaseRoot = realpathSync(releaseRoot);
  config.$schema = join(
    canonicalReleaseRoot,
    "apps/web/node_modules/wrangler/config-schema.json"
  );
  config.main = join(canonicalReleaseRoot, "apps/web/worker/index.ts");
  config.assets.directory = join(canonicalReleaseRoot, "apps/web/dist/client");
  config.d1_databases[0].migrations_dir = join(canonicalReleaseRoot, "packages/db/migrations");
  if (productionOverlay) {
    config.vars.NARRATIVE_ENABLED = "true";
    config.observability.logs.destinations = [`${name}-logs`];
    config.observability.traces.destinations = [`${name}-traces`];
  }
  const configPath = join(configDirectory, "wrangler.jsonc");
  const contents = `${JSON.stringify(config)}\n`;
  writeFileSync(configPath, contents, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return {
    root,
    releaseRoot,
    configPath: realpathSync(configPath),
    configSha256: createHash("sha256").update(contents).digest("hex")
  };
}

test("keeps two release command contexts isolated", () => {
  const left = fixture("left-surf");
  const right = fixture("right-surf");
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    return { status: 0, stdout: "{}", stderr: "" };
  };
  const logger = { info() {} };
  const leftContext = createCloudflareCommandContext({ ...left, spawn, logger, environment: {} });
  const rightContext = createCloudflareCommandContext({ ...right, spawn, logger, environment: {} });
  leftContext.runWrangler(["deployments", "status", "--json"], { capture: true });
  rightContext.runWrangler(["versions", "list"], { capture: true });
  assert.equal(calls[0].cwd, left.releaseRoot);
  assert.equal(calls[1].cwd, right.releaseRoot);
  assert.equal(calls[0].args.at(-1), left.configPath);
  assert.equal(calls[1].args.at(-1), right.configPath);
  assert.equal(calls[0].args.includes(right.configPath), false);
  assert.equal(calls[1].args.includes(left.configPath), false);
});

test("Queue probes accept a production overlay snapshot named wrangler.jsonc", () => {
  const instance = fixture("production-overlay-surf", {
    productionOverlay: true
  });
  const calls = [];
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {},
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0, stdout: "{}", stderr: "" };
    },
    logger: { info() {} }
  });

  const inspection = context.inspectQueues();

  assert.equal(instance.configPath.endsWith("/wrangler.jsonc"), true);
  assert.equal(context.readConfig().vars.NARRATIVE_ENABLED, "true");
  assert.deepEqual(inspection.missing, []);
  assert.equal(inspection.matches, true);
  assert.equal(calls.length, inspection.expected.length);
  assert.ok(
    calls.every(({ args }) =>
      args.some((argument) => argument === instance.configPath)
    )
  );
});

test("rechecks config and guard before spawning and after commands", () => {
  const instance = fixture("guarded-surf");
  let guardCalls = 0;
  let spawnCalls = 0;
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {},
    guard: () => {
      guardCalls += 1;
    },
    spawn: () => {
      spawnCalls += 1;
      return { status: 0, stdout: "", stderr: "" };
    },
    logger: { info() {} }
  });
  context.runWrangler(["whoami"]);
  assert.equal(spawnCalls, 1);
  assert.ok(guardCalls >= 4);

  writeFileSync(instance.configPath, `${readFileSync(instance.configPath, "utf8")} `);
  assert.throws(() => context.runWrangler(["whoami"]), /SHA-256 does not match/);
  assert.equal(spawnCalls, 1);
});

test("captured command failures expose only structured API codes", () => {
  const instance = fixture("failed-surf");
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {},
    spawn: () => ({
      status: 1,
      stdout: "secret-content [code: 100328]",
      stderr: ""
    }),
    logger: { info() {} }
  });
  let caught;
  try {
    context.runWrangler(["versions", "upload"], { capture: true });
  } catch (error) {
    caught = error;
  }
  assert.deepEqual(caught.cloudflareApiErrorCodes, [100328]);
  assert.doesNotMatch(caught.message, /secret-content/);
  assert.deepEqual(Object.keys(caught), []);
});

test("captured command failures map exact safe cron-wait diagnostics", () => {
  const cases = [
    [
      "remote ingest cron-safety wait ended before the required settle boundary; mutation did not begin",
      "cron_wait_ended_early",
      "stdout"
    ],
    [
      "remote ingest cron-safety wait did not reach a safe verification window; mutation did not begin",
      "cron_wait_not_safe",
      "stderr"
    ]
  ];

  for (const [diagnostic, code, stream] of cases) {
    const instance = fixture(`safe-diagnostic-${code}`);
    const context = createCloudflareCommandContext({
      ...instance,
      environment: {},
      spawn: () => ({
        status: 1,
        stdout: stream === "stdout" ? `Error: ${diagnostic}\n` : "",
        stderr: stream === "stderr" ? `Error: ${diagnostic}\n` : ""
      }),
      logger: { info() {} }
    });

    let caught;
    try {
      context.runPnpm(["ingest:remote"], { capture: true });
    } catch (error) {
      caught = error;
    }

    assert.equal(caught.releaseCommandDiagnosticCode, code);
    assert.equal(
      caught.message,
      `pnpm ingest:remote exited with status 1; diagnostic=${code}`
    );
    assert.deepEqual(Object.keys(caught), []);
  }
});

test("captured command failures suppress unknown output", () => {
  const instance = fixture("unknown-diagnostic-surf");
  const unknownOutput =
    "private provider detail: remote ingest failed outside the safe allowlist";
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {},
    spawn: () => ({ status: 1, stdout: unknownOutput, stderr: "" }),
    logger: { info() {} }
  });

  let caught;
  try {
    context.runPnpm(["ingest:remote"], { capture: true });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught.releaseCommandDiagnosticCode, undefined);
  assert.equal(caught.message, "pnpm ingest:remote exited with status 1");
  assert.doesNotMatch(caught.message, /private provider detail|safe allowlist/);
  assert.deepEqual(Object.keys(caught), []);
});

test("captured command diagnostics reject embedded and ambiguous messages", () => {
  const endedEarly =
    "remote ingest cron-safety wait ended before the required settle boundary; mutation did not begin";
  const notSafe =
    "remote ingest cron-safety wait did not reach a safe verification window; mutation did not begin";
  const cases = [
    `prefix Error: ${endedEarly}`,
    `Error: ${endedEarly} suffix`,
    `unrelated output embedded ${endedEarly} inside a longer line`,
    `Error: ${endedEarly}\nError: ${endedEarly}`,
    `Error: ${endedEarly}\r\nError: ${notSafe}`,
    `Error: ${endedEarly}\nError: unrelated adjacent failure`
  ];

  for (const [index, output] of cases.entries()) {
    const instance = fixture(`rejected-diagnostic-${index}`);
    const context = createCloudflareCommandContext({
      ...instance,
      environment: {},
      spawn: () => ({ status: 1, stdout: output, stderr: "" }),
      logger: { info() {} }
    });

    let caught;
    try {
      context.runPnpm(["ingest:remote"], { capture: true });
    } catch (error) {
      caught = error;
    }

    assert.equal(caught.releaseCommandDiagnosticCode, undefined);
    assert.equal(caught.message, "pnpm ingest:remote exited with status 1");
    assert.doesNotMatch(caught.message, /cron-safety|settle boundary/);
    assert.deepEqual(Object.keys(caught), []);
  }
});

test("safe captured diagnostics never expose adjacent secret output", () => {
  const instance = fixture("secret-diagnostic-surf");
  const secret = "super-secret-ingest-token-value";
  const diagnostic =
    "remote ingest cron-safety wait ended before the required settle boundary; mutation did not begin";
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {},
    spawn: () => ({
      status: 1,
      stdout: `${secret}\nError: ${diagnostic}\n`,
      stderr: `adjacent-${secret}`
    }),
    logger: { info() {} }
  });

  let caught;
  try {
    context.runPnpm(["ingest:remote"], { capture: true });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught.releaseCommandDiagnosticCode, "cron_wait_ended_early");
  assert.equal(
    caught.message,
    "pnpm ingest:remote exited with status 1; diagnostic=cron_wait_ended_early"
  );
  assert.doesNotMatch(caught.message, /super-secret|ingest-token-value/);
  assert.deepEqual(Object.keys(caught), []);
});

test("cron trigger inspection proves exact remote topology without mutation", async () => {
  const instance = fixture("cron-inspection-surf");
  const requests = [];
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "release-test-token-that-is-never-logged"
    },
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { schedules: [{ cron: "17 * * * *" }] }
      });
    },
    spawn: () => {
      throw new Error("inspection must not spawn a mutating command");
    },
    logger: { info() {} }
  });

  assert.deepEqual(await context.inspectCronTriggers(), {
    expected: ["17 * * * *"],
    actual: ["17 * * * *"],
    matches: true
  });
  assert.equal(requests.length, 1);
  assert.match(
    requests[0].url,
    /\/accounts\/a{32}\/workers\/scripts\/cron-inspection-surf\/schedules$/
  );
  assert.equal(requests[0].init.method, "GET");
  assert.equal(
    requests[0].init.headers.Authorization,
    "Bearer release-test-token-that-is-never-logged"
  );
});

test("Queue identity inspection binds configured names to one Cloudflare account", async () => {
  const instance = fixture("queue-identity-surf");
  const accountId = "a".repeat(32);
  const requests = [];
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: "t".repeat(32)
    },
    fetcher: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              queue_name: "queue-identity-surf-ingest",
              queue_id: "1".repeat(32)
            },
            {
              queue_name: "queue-identity-surf-ingest-dlq",
              queue_id: "2".repeat(32)
            },
            {
              queue_name: "queue-identity-surf-narrative",
              queue_id: "3".repeat(32)
            },
            {
              queue_name: "queue-identity-surf-narrative-dlq",
              queue_id: "4".repeat(32)
            },
            {
              queue_name: "queue-identity-surf-narrative-fallback",
              queue_id: "5".repeat(32)
            }
          ],
          result_info: { page: 1, total_pages: 1 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
    spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    logger: { info() {} }
  });
  const receipt = await context.inspectQueueIdentities();
  assert.equal(receipt.accountId, accountId);
  assert.deepEqual(receipt.queues, {
    "queue-identity-surf-ingest": "1".repeat(32),
    "queue-identity-surf-ingest-dlq": "2".repeat(32),
    "queue-identity-surf-narrative": "3".repeat(32),
    "queue-identity-surf-narrative-dlq": "4".repeat(32),
    "queue-identity-surf-narrative-fallback": "5".repeat(32)
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, new RegExp(`/accounts/${accountId}/queues`));
  assert.equal(requests[0].options.method, "GET");
});

function queueApiFixture(name, consumerOverrides = {}) {
  const queueNames = [
    `${name}-ingest`,
    `${name}-ingest-dlq`,
    `${name}-narrative`,
    `${name}-narrative-dlq`,
    `${name}-narrative-fallback`
  ];
  const queues = queueNames.map((queueName, index) => ({
    queue_name: queueName,
    queue_id: String(index + 1).repeat(32),
    created_on: "2026-08-15T18:00:00.000000Z"
  }));
  const consumers = {
    ["1".repeat(32)]: [
      {
        consumer_id: "a".repeat(32),
        created_on: "2026-07-08T05:13:15.070235Z",
        type: "worker",
        script: name,
        queue_id: "1".repeat(32),
        queue_name: `${name}-ingest`,
        dead_letter_queue: `${name}-ingest-dlq`,
        settings: {
          batch_size: 1,
          max_retries: 3,
          max_wait_time_ms: 30_000,
          max_concurrency: 1,
          retry_delay: 0
        }
      }
    ],
    ["5".repeat(32)]: [
      {
        consumer_id: "b".repeat(32),
        created_on: "2026-08-10T23:43:22.880980Z",
        type: "worker",
        script_name: name,
        queue_id: "5".repeat(32),
        queue_name: `${name}-narrative-fallback`,
        settings: {
          batch_size: 1,
          max_retries: 0,
          max_wait_time_ms: 30_000,
          max_concurrency: 1
        }
      }
    ],
    ...consumerOverrides
  };
  return { queues, consumers };
}

function queueApiFetcher({ queues, consumers, requests = [] }) {
  return async (url, options) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, options });
    if (parsed.pathname.endsWith("/queues")) {
      return Response.json({
        success: true,
        result: queues,
        result_info: { page: 1, total_pages: 1 }
      });
    }
    const match = parsed.pathname.match(/\/queues\/([0-9a-f]{32})\/consumers$/i);
    if (!match) throw new Error(`Unexpected Queue API URL: ${parsed.pathname}`);
    return Response.json({ success: true, result: consumers[match[1]] ?? [] });
  };
}

test("Queue preexistence attestation returns exact bounded read-only evidence", async () => {
  const name = "queue-preexistence-surf";
  const instance = fixture(name);
  const api = queueApiFixture(name);
  const requests = [];
  const token = "queue-attestation-token-that-is-never-returned";
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "7".repeat(32),
      CLOUDFLARE_API_TOKEN: token
    },
    fetcher: queueApiFetcher({ ...api, requests }),
    spawn: () => {
      throw new Error("Queue preexistence attestation must not spawn a command");
    },
    logger: { info() {} }
  });

  const result = await context.attestPreexistingQueues(
    "2026-08-15T19:00:00.000Z"
  );
  assert.deepEqual(
    result,
    {
      queues: api.queues.map((queue) => ({
        name: queue.queue_name,
        createdOn: queue.created_on
      }))
    }
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.queues), true);
  assert.ok(result.queues.every((queue) => Object.isFrozen(queue)));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.body, undefined);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(result), /[0-9a-f]{32}/i);
});

test("Queue preexistence attestation rejects missing Queue identity and time", async () => {
  const name = "queue-preexistence-missing-surf";
  const instance = fixture(name);
  const environment = {
    CLOUDFLARE_ACCOUNT_ID: "6".repeat(32),
    CLOUDFLARE_API_TOKEN: "t".repeat(32)
  };
  const createContext = (api) =>
    createCloudflareCommandContext({
      ...instance,
      environment,
      fetcher: queueApiFetcher(api),
      spawn: () => {
        throw new Error("Queue preexistence attestation must remain read-only");
      },
      logger: { info() {} }
    });

  const missingQueue = queueApiFixture(name);
  missingQueue.queues.pop();
  await assert.rejects(
    createContext(missingQueue).attestPreexistingQueues(
      "2026-08-15T19:00:00.000Z"
    ),
    /lacks a configured Queue/
  );

  const missingTimestamp = queueApiFixture(name);
  delete missingTimestamp.queues[0].created_on;
  await assert.rejects(
    createContext(missingTimestamp).attestPreexistingQueues(
      "2026-08-15T19:00:00.000Z"
    ),
    /created_on must be an exact ISO timestamp/
  );

  const duplicate = queueApiFixture(name);
  duplicate.queues.push({ ...duplicate.queues[0] });
  await assert.rejects(
    createContext(duplicate).attestPreexistingQueues(
      "2026-08-15T19:00:00.000Z"
    ),
    /duplicate name/
  );
});

test("Queue preexistence attestation rejects malformed, equal, and newer times", async () => {
  const name = "queue-preexistence-time-surf";
  const instance = fixture(name);
  const cutoff = "2026-08-15T19:00:00.000Z";
  const createContext = (api, requests = []) =>
    createCloudflareCommandContext({
      ...instance,
      environment: {
        CLOUDFLARE_ACCOUNT_ID: "5".repeat(32),
        CLOUDFLARE_API_TOKEN: "t".repeat(32)
      },
      fetcher: queueApiFetcher({ ...api, requests }),
      spawn: () => {
        throw new Error("Queue preexistence attestation must remain read-only");
      },
      logger: { info() {} }
    });

  for (const [createdOn, pattern] of [
    ["not-a-timestamp", /created_on must be an exact ISO timestamp/],
    ["2026-08-15T19:00:00.000000Z", /was not created before the release cutoff/],
    ["2026-08-15T19:00:00.000001Z", /was not created before the release cutoff/]
  ]) {
    const api = queueApiFixture(name);
    api.queues[0].created_on = createdOn;
    await assert.rejects(
      createContext(api).attestPreexistingQueues(cutoff),
      pattern
    );
  }

  const preciselyOlder = queueApiFixture(name);
  for (const queue of preciselyOlder.queues) {
    queue.created_on = "2026-08-15T19:00:00.000499Z";
  }
  await assert.doesNotReject(
    createContext(preciselyOlder).attestPreexistingQueues(
      "2026-08-15T19:00:00.000500Z"
    )
  );

  const requests = [];
  await assert.rejects(
    createContext(queueApiFixture(name), requests).attestPreexistingQueues(
      "2026-08-15 19:00:00Z"
    ),
    /cutoff must be an exact ISO timestamp/
  );
  assert.equal(requests.length, 0);
});

test("Queue consumer inspection attests every account Queue and configured setting", async () => {
  const name = "queue-consumer-surf";
  const instance = fixture(name);
  const api = queueApiFixture(name);
  const requests = [];
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
      CLOUDFLARE_API_TOKEN: "t".repeat(32)
    },
    fetcher: queueApiFetcher({ ...api, requests }),
    spawn: () => {
      throw new Error("Queue consumer inspection must use the read-only API");
    },
    logger: { info() {} }
  });

  const result = await context.inspectQueueConsumers();
  assert.equal(result.matches, true);
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.staleConsumers, []);
  assert.equal(requests.length, 6);
  assert.ok(requests.slice(1).every(({ options }) => options.method === "GET"));
  assert.equal(
    new Set(requests.map(({ options }) => options.signal)).size,
    1,
    "one global deadline must bound inventory and every per-Queue read"
  );
  assert.deepEqual(
    result.expected.map(({ queue, deadLetterQueue, settings }) => ({
      queue,
      deadLetterQueue,
      settings
    })),
    [
      {
        queue: `${name}-ingest`,
        deadLetterQueue: `${name}-ingest-dlq`,
        settings: {
          batchSize: 1,
          maxRetries: 3,
          maxWaitTimeMs: 30_000,
          maxConcurrency: 1,
          retryDelay: 0
        }
      },
      {
        queue: `${name}-narrative-fallback`,
        deadLetterQueue: null,
        settings: {
          batchSize: 1,
          maxRetries: 0,
          maxWaitTimeMs: 30_000,
          maxConcurrency: 1,
          retryDelay: 0
        }
      }
    ]
  );
});

test("Queue consumer inspection rejects mismatched returned Queue identity", async () => {
  const name = "queue-consumer-identity-surf";
  const instance = fixture(name);
  for (const [field, value] of [
    ["queue_id", "2".repeat(32)],
    ["queue_name", `${name}-ingest-dlq`]
  ]) {
    const api = queueApiFixture(name);
    api.consumers["1".repeat(32)][0][field] = value;
    const context = createCloudflareCommandContext({
      ...instance,
      environment: {
        CLOUDFLARE_ACCOUNT_ID: "6".repeat(32),
        CLOUDFLARE_API_TOKEN: "t".repeat(32)
      },
      fetcher: queueApiFetcher(api),
      logger: { info() {} }
    });

    await assert.rejects(
      context.inspectQueueConsumers(),
      /returned an invalid Worker consumer/
    );
  }
});

test("Queue consumer inspection reports setting and exact environment drift", async () => {
  const name = "queue-consumer-drift-surf";
  const instance = fixture(name);
  const api = queueApiFixture(name);
  api.consumers["1".repeat(32)][0].settings.max_wait_time_ms = 29_000;
  api.consumers["5".repeat(32)][0].environment_name = "staging";
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "d".repeat(32),
      CLOUDFLARE_API_TOKEN: "t".repeat(32)
    },
    fetcher: queueApiFetcher(api),
    logger: { info() {} }
  });
  const result = await context.inspectQueueConsumers();
  assert.equal(result.matches, false);
  assert.deepEqual(result.mismatches, [
    `${name}-ingest`,
    `${name}-narrative-fallback`
  ]);
});

test("Queue consumer inspection detects and exactly removes stale target consumers", async () => {
  const name = "queue-consumer-stale-surf";
  const instance = fixture(name);
  const api = queueApiFixture(name);
  const staleQueueId = "6".repeat(32);
  const stagingQueueId = "7".repeat(32);
  const staleConsumerId = "c".repeat(32);
  api.queues.push(
    { queue_name: `${name}-removed`, queue_id: staleQueueId },
    { queue_name: `${name}-staging`, queue_id: stagingQueueId }
  );
  api.consumers[staleQueueId] = [
    {
      consumer_id: staleConsumerId,
      type: "worker",
      script: name,
      environment_name: "",
      settings: {}
    }
  ];
  api.consumers[stagingQueueId] = [
    {
      consumer_id: "d".repeat(32),
      type: "worker",
      service: name,
      environment: "staging",
      settings: {}
    }
  ];
  const requests = [];
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, options });
    const deleteMatch = parsed.pathname.match(
      /\/queues\/([0-9a-f]{32})\/consumers\/([0-9a-f]{32})$/i
    );
    if (deleteMatch) {
      assert.equal(options.method, "DELETE");
      assert.equal(deleteMatch[1], staleQueueId);
      assert.equal(deleteMatch[2], staleConsumerId);
      api.consumers[staleQueueId] = [];
      return Response.json({ success: true, result: {} });
    }
    return queueApiFetcher(api)(url, options);
  };
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "e".repeat(32),
      CLOUDFLARE_API_TOKEN: "t".repeat(32)
    },
    fetcher,
    logger: { info() {} }
  });

  const before = await context.inspectQueueConsumers();
  assert.equal(before.matches, false);
  assert.deepEqual(before.mismatches, [`${name}-removed`]);
  assert.deepEqual(before.staleConsumers, [
    {
      queue: `${name}-removed`,
      queueId: staleQueueId,
      consumerId: staleConsumerId,
      workerName: name,
      environmentName: ""
    }
  ]);
  assert.deepEqual(await context.removeStaleQueueConsumers(), { removed: 1 });
  assert.equal((await context.inspectQueueConsumers()).matches, true);
  assert.equal(
    requests.filter(({ options }) => options.method === "DELETE").length,
    1
  );
});

test("stale Queue removal resumes safely after partial deletion and response loss", async () => {
  const name = "queue-consumer-resume-surf";
  const instance = fixture(name);
  const api = queueApiFixture(name);
  const stale = [
    { queueId: "6".repeat(32), consumerId: "c".repeat(32), suffix: "old-a" },
    { queueId: "7".repeat(32), consumerId: "d".repeat(32), suffix: "old-b" }
  ];
  for (const entry of stale) {
    api.queues.push({
      queue_name: `${name}-${entry.suffix}`,
      queue_id: entry.queueId
    });
    api.consumers[entry.queueId] = [
      {
        consumer_id: entry.consumerId,
        type: "worker",
        script: name,
        environment_name: "",
        settings: {}
      }
    ];
  }
  const deletes = [];
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    const match = parsed.pathname.match(
      /\/queues\/([0-9a-f]{32})\/consumers\/([0-9a-f]{32})$/i
    );
    if (!match) return queueApiFetcher(api)(url, options);
    deletes.push({ queueId: match[1], consumerId: match[2] });
    api.consumers[match[1]] = [];
    if (match[1] === stale[1].queueId) {
      throw new TypeError("simulated response loss after delete commit");
    }
    return Response.json({ success: true, result: {} });
  };
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "9".repeat(32),
      CLOUDFLARE_API_TOKEN: "t".repeat(32)
    },
    fetcher,
    logger: { info() {} }
  });

  await assert.rejects(
    context.removeStaleQueueConsumers(),
    /simulated response loss/
  );
  assert.deepEqual(await context.removeStaleQueueConsumers(), { removed: 0 });
  assert.deepEqual(deletes, stale.map(({ queueId, consumerId }) => ({
    queueId,
    consumerId
  })));
});

test("stale Queue removal fails closed when a successful DELETE is not observable", async () => {
  const name = "queue-consumer-readback-surf";
  const instance = fixture(name);
  const api = queueApiFixture(name);
  const queueId = "6".repeat(32);
  api.queues.push({ queue_name: `${name}-old`, queue_id: queueId });
  api.consumers[queueId] = [
    {
      consumer_id: "c".repeat(32),
      type: "worker",
      script: name,
      environment_name: "",
      settings: {}
    }
  ];
  const context = createCloudflareCommandContext({
    ...instance,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "8".repeat(32),
      CLOUDFLARE_API_TOKEN: "t".repeat(32)
    },
    fetcher: async (url, options) => {
      const parsed = new URL(url);
      if (/\/consumers\/[0-9a-f]{32}$/i.test(parsed.pathname)) {
        return Response.json({ success: true, result: {} });
      }
      return queueApiFetcher(api)(url, options);
    },
    logger: { info() {} }
  });

  await assert.rejects(
    context.removeStaleQueueConsumers(),
    /remain after exact deletion reconciliation/
  );
});

test("Queue consumer inspection rejects malformed and oversized API output", async () => {
  const name = "queue-consumer-invalid-surf";
  const instance = fixture(name);
  const api = queueApiFixture(name);
  for (const response of [
    () => new Response("not json"),
    () =>
      new Response("x", {
        headers: { "content-length": String(129 * 1024) }
      })
  ]) {
    let calls = 0;
    const context = createCloudflareCommandContext({
      ...instance,
      environment: {
        CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
        CLOUDFLARE_API_TOKEN: "t".repeat(32)
      },
      fetcher: async (url, options) => {
        calls += 1;
        return calls === 1
          ? queueApiFetcher(api)(url, options)
          : response();
      },
      logger: { info() {} }
    });
    await assert.rejects(
      context.inspectQueueConsumers(),
      /malformed JSON|exceeded its 131072-byte limit/
    );
  }
});

test("cron trigger inspection distinguishes drift and rejects unbounded responses", async () => {
  const instance = fixture("cron-drift-surf");
  const environment = {
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    CLOUDFLARE_API_TOKEN: "release-test-token-that-is-never-logged"
  };
  const drifted = createCloudflareCommandContext({
    ...instance,
    environment,
    fetcher: async () =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { schedules: [{ cron: "18 * * * *" }] }
      }),
    logger: { info() {} }
  });
  assert.deepEqual(await drifted.inspectCronTriggers(), {
    expected: ["17 * * * *"],
    actual: ["18 * * * *"],
    matches: false
  });

  const oversized = createCloudflareCommandContext({
    ...instance,
    environment,
    fetcher: async () =>
      new Response("x", {
        headers: { "content-length": String(65 * 1024) }
      }),
    logger: { info() {} }
  });
  await assert.rejects(
    oversized.inspectCronTriggers(),
    /exceeded its 65536-byte limit/
  );
});
