import assert from "node:assert/strict";
import test from "node:test";
import {
  OPS_STATUS_WRANGLER_TIMEOUT_MS,
  READ_MODEL_STATUS_SQL,
  formatOpsStatus,
  parseDeploymentStatus,
  parseQueueConsumers,
  parseReadModelStatus,
  probeHealth,
  runOpsStatus
} from "../ops-status.mjs";
import { NORCAL_SPOTS } from "../../packages/forecast-core/src/spot-registry.ts";

const workerVersion = "11111111-2222-4333-8444-555555555555";
const otherVersion = "66666666-7777-4888-8999-000000000000";
const deploymentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const generatedAt = "2026-08-04T07:27:00.000Z";
const materializedAt = "2026-08-04T07:27:30.000Z";
const generationId = `sha256:${"a".repeat(64)}:ingest:cron-20260804T0717Z`;
const otherGenerationId = `sha256:${"b".repeat(64)}:ingest:cron-20260804T0617Z`;
const spotIds = NORCAL_SPOTS.map((spot) => spot.id);
const config = {
  name: "surf",
  vars: { SURF_REGION: "norcal" },
  queues: {
    consumers: [
      {
        queue: "surf-ingest",
        dead_letter_queue: "surf-ingest-dlq"
      }
    ]
  }
};

function healthResponse({
  version = workerVersion,
  status = 200,
  contentType = "application/json",
  body = {
    status: "ok",
    service: "surf",
    environment: "production",
    region: "norcal",
    generatedAt
  }
} = {}) {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    {
      status,
      headers: {
        "content-type": contentType,
        ...(version ? { "X-Surf-Worker-Version": version } : {})
      }
    }
  );
}

function deploymentStatus(overrides = {}) {
  return JSON.stringify({
    id: deploymentId,
    strategy: "percentage",
    versions: [{ version_id: workerVersion, percentage: 100 }],
    ...overrides
  });
}

function queueConsumer(overrides = {}) {
  return {
    consumer_id: "consumer-id",
    type: "worker",
    script: "surf",
    settings: {
      batch_size: 1,
      max_retries: 3,
      max_wait_time_ms: 30_000,
      max_concurrency: 1
    },
    dead_letter_queue: "surf-ingest-dlq",
    ...overrides
  };
}

function readModelRows() {
  return spotIds.flatMap((spotId) =>
    ["1h", "3h"].map((interval) => ({
      spot_id: spotId,
      interval,
      state: "ready",
      generation_id: generationId,
      generated_at: generatedAt,
      materialized_at: materializedAt,
      json_chars: interval === "1h" ? 300_000 : 120_000
    }))
  );
}

function d1Status(rows = readModelRows(), overrides = {}) {
  return JSON.stringify([
    {
      results: rows,
      success: true,
      meta: { served_by_primary: true },
      ...overrides
    }
  ]);
}

function successWranglerProbe(calls, timeouts = []) {
  return async (args, options) => {
    calls.push(args);
    timeouts.push(options?.timeoutMs);
    if (args[0] === "deployments") {
      return { status: 0, stdout: deploymentStatus(), stderr: "" };
    }
    if (args[0] === "queues") {
      return {
        status: 0,
        stdout: JSON.stringify([queueConsumer()]),
        stderr: ""
      };
    }
    if (args[0] === "d1") {
      return { status: 0, stdout: d1Status(), stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
}

test("ops status performs exactly four locked read-only probes and prints compact evidence", async () => {
  const wranglerCalls = [];
  const wranglerTimeouts = [];
  const fetchCalls = [];
  const result = await runOpsStatus({
    env: {
      SURF_BASE_URL: "https://surf.example/",
      SURF_INGEST_TOKEN: "ingest-secret-must-not-render",
      CLOUDFLARE_API_TOKEN: "cloudflare-secret-must-not-render"
    },
    config,
    fetcher: async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      return healthResponse();
    },
    wranglerProbe: successWranglerProbe(wranglerCalls, wranglerTimeouts)
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].input, "https://surf.example/api/health");
  assert.equal(fetchCalls[0].init.method, "GET");
  assert.equal(fetchCalls[0].init.headers.Accept, "application/json");
  assert.deepEqual(wranglerCalls, [
    ["deployments", "status", "--json"],
    [
      "queues",
      "consumer",
      "worker",
      "list",
      "surf-ingest",
      "--json"
    ],
    [
      "d1",
      "execute",
      "DB",
      "--remote",
      "--json",
      "--command",
      READ_MODEL_STATUS_SQL
    ]
  ]);
  assert.deepEqual(wranglerTimeouts, [
    OPS_STATUS_WRANGLER_TIMEOUT_MS,
    OPS_STATUS_WRANGLER_TIMEOUT_MS,
    OPS_STATUS_WRANGLER_TIMEOUT_MS
  ]);
  assert.match(READ_MODEL_STATUS_SQL, /^with intervals\(interval\) as /);
  assert.doesNotMatch(
    READ_MODEL_STATUS_SQL,
    /\b(insert|update|delete|replace|drop|alter|create|pragma|vacuum)\b/i
  );
  assert.doesNotMatch(READ_MODEL_STATUS_SQL, /select\s+r\.forecast_json/i);

  assert.equal(result.health.workerVersion, workerVersion);
  assert.equal(result.deployment.workerVersion, workerVersion);
  assert.equal(result.queue.batchSize, 1);
  assert.equal(result.queue.maxConcurrency, 1);
  assert.equal(result.readModels.ready, spotIds.length * 2);
  const rendered = formatOpsStatus(result);
  const expectedReadModelCount = spotIds.length * 2;
  assert.match(
    rendered,
    new RegExp(
      `4/4 read-only probes; ${expectedReadModelCount}/${expectedReadModelCount} read models ready`
    )
  );
  assert.match(rendered, new RegExp(workerVersion));
  assert.match(rendered, /surf-ingest-dlq/);
  assert.doesNotMatch(rendered, /ingest-secret-must-not-render|cloudflare-secret-must-not-render/);
});

test("ops status rejects unsafe base URLs before any probe", async () => {
  for (const baseUrl of [
    undefined,
    "not a URL",
    "http://surf.example",
    "https://user:secret@surf.example",
    "https://surf.example/path",
    "https://surf.example?target=other"
  ]) {
    let fetches = 0;
    let subprocesses = 0;
    await assert.rejects(
      runOpsStatus({
        env: baseUrl ? { SURF_BASE_URL: baseUrl } : {},
        config,
        fetcher: async () => {
          fetches += 1;
          return healthResponse();
        },
        wranglerProbe: async () => {
          subprocesses += 1;
          return { status: 0, stdout: "{}", stderr: "" };
        }
      }),
      /requires SURF_BASE_URL|bare HTTPS origin/
    );
    assert.equal(fetches, 0);
    assert.equal(subprocesses, 0);
  }
});

test("health failure never waits for a stalled response-body cancellation", async () => {
  const response = new Response(
    new ReadableStream({
      start() {},
      cancel() {
        return new Promise(() => {});
      }
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "X-Surf-Worker-Version": workerVersion
      }
    }
  );
  await assert.rejects(
    probeHealth({
      baseUrl: "https://surf.example",
      expectedRegion: "norcal",
      fetcher: async () => response,
      requestTimeoutMs: 10
    }),
    /HTTP 503/
  );
});

test("health timeout remains active while the JSON body is consumed", async () => {
  const fetcher = async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        }
      }),
      {
        headers: {
          "content-type": "application/json",
          "X-Surf-Worker-Version": workerVersion
        }
      }
    );

  await assert.rejects(
    probeHealth({
      baseUrl: "https://surf.example",
      expectedRegion: "norcal",
      fetcher,
      requestTimeoutMs: 5
    }),
    /malformed JSON/
  );
});

test("health probe fails closed on fetch, status, content, contract, and version defects", async (t) => {
  const cases = [
    {
      name: "fetch failure",
      fetcher: async () => {
        throw new TypeError("connection failed with private detail");
      },
      expected: /failed \(TypeError\)/
    },
    {
      name: "non-200 status",
      fetcher: async () => healthResponse({ status: 503 }),
      expected: /HTTP 503/
    },
    {
      name: "wrong content type",
      fetcher: async () => healthResponse({ contentType: "text/html" }),
      expected: /application\/json/
    },
    {
      name: "malformed JSON",
      fetcher: async () => healthResponse({ body: "{" }),
      expected: /malformed JSON/
    },
    {
      name: "wrong region",
      fetcher: async () => healthResponse({ body: {
        status: "ok",
        service: "surf",
        region: "socal",
        generatedAt
      } }),
      expected: /invalid Surf health contract/
    },
    {
      name: "parseable noncanonical timestamp",
      fetcher: async () => healthResponse({ body: {
        status: "ok",
        service: "surf",
        region: "norcal",
        generatedAt: "0"
      } }),
      expected: /invalid Surf health contract/
    },
    {
      name: "non-roundtripping timestamp",
      fetcher: async () => healthResponse({ body: {
        status: "ok",
        service: "surf",
        region: "norcal",
        generatedAt: "2026-08-04T07:27:00Z"
      } }),
      expected: /invalid Surf health contract/
    },
    {
      name: "impossible timestamp",
      fetcher: async () => healthResponse({ body: {
        status: "ok",
        service: "surf",
        region: "norcal",
        generatedAt: "2026-02-30T00:00:00.000Z"
      } }),
      expected: /invalid Surf health contract/
    },
    {
      name: "missing version",
      fetcher: async () => healthResponse({ version: null }),
      expected: /valid Worker version UUID/
    },
    {
      name: "malformed version",
      fetcher: async () => healthResponse({ version: "latest" }),
      expected: /valid Worker version UUID/
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        probeHealth({
          baseUrl: "https://surf.example",
          expectedRegion: "norcal",
          fetcher: fixture.fetcher
        }),
        fixture.expected
      );
    });
  }
});

test("deployment status rejects malformed, split, partial, and wrong-version traffic", () => {
  assert.throws(
    () => parseDeploymentStatus("not-json", workerVersion),
    /malformed JSON/
  );
  assert.throws(
    () =>
      parseDeploymentStatus(
        deploymentStatus({
          versions: [
            { version_id: workerVersion, percentage: 50 },
            { version_id: otherVersion, percentage: 50 }
          ]
        }),
        workerVersion
      ),
    /exactly one version/
  );
  assert.throws(
    () =>
      parseDeploymentStatus(
        deploymentStatus({
          versions: [{ version_id: workerVersion, percentage: 99 }]
        }),
        workerVersion
      ),
    /exactly 100%/
  );
  assert.throws(
    () =>
      parseDeploymentStatus(
        deploymentStatus({
          versions: [{ version_id: otherVersion, percentage: 100 }]
        }),
        workerVersion
      ),
    /does not match/
  );
});

test("queue status rejects malformed JSON, consumer drift, unbounded concurrency, and DLQ drift", () => {
  const expected = {
    workerName: "surf",
    queue: "surf-ingest",
    deadLetterQueue: "surf-ingest-dlq"
  };
  assert.throws(
    () => parseQueueConsumers("{", expected),
    /malformed JSON/
  );
  for (const consumers of [[], [queueConsumer(), queueConsumer()]]) {
    assert.throws(
      () => parseQueueConsumers(JSON.stringify(consumers), expected),
      /exactly one Worker consumer/
    );
  }
  for (const consumer of [
    queueConsumer({ script: "other-worker" }),
    queueConsumer({ settings: { batch_size: 10, max_concurrency: 1 } }),
    queueConsumer({ settings: { batch_size: 1 } }),
    queueConsumer({ settings: { batch_size: 1, max_concurrency: null } }),
    queueConsumer({ dead_letter_queue: "wrong-dlq" })
  ]) {
    assert.throws(
      () => parseQueueConsumers(JSON.stringify([consumer]), expected),
      /configured Worker|batch\/concurrency 1\/1|configured dead-letter queue/
    );
  }
});

test("D1 status rejects malformed output, failed statements, missing rows, duplicates, and invalid readiness", () => {
  assert.throws(() => parseReadModelStatus("["), /malformed JSON/);
  assert.throws(
    () => parseReadModelStatus(JSON.stringify([])),
    /exactly one statement result/
  );
  assert.throws(
    () => parseReadModelStatus(d1Status([], { success: false })),
    /did not complete successfully/
  );
  assert.throws(() => parseReadModelStatus(d1Status([])), /no active spot rows/);
  assert.throws(
    () => parseReadModelStatus(d1Status(readModelRows().slice(0, -1))),
    /complete 1h\/3h pairs for every active spot/
  );

  const duplicate = readModelRows();
  duplicate[1] = { ...duplicate[0] };
  assert.throws(
    () => parseReadModelStatus(d1Status(duplicate)),
    /duplicate key/
  );

  for (const change of [
    { state: "missing" },
    { generation_id: "not-a-canonical-generation" },
    { generated_at: "not-a-date" },
    { generated_at: "0" },
    { generated_at: "2026-08-04T07:27:00Z" },
    { generated_at: "2026-02-30T00:00:00.000Z" },
    { materialized_at: null },
    { materialized_at: "2026-02-30T00:00:00.000Z" },
    { materialized_at: "2026-08-04T07:26:59.999Z" },
    { json_chars: 0 },
    { json_chars: "100" }
  ]) {
    const rows = readModelRows();
    rows[0] = { ...rows[0], ...change };
    assert.throws(
      () => parseReadModelStatus(d1Status(rows)),
      /missing or invalid/
    );
  }

  const incompletePairs = readModelRows();
  incompletePairs[0] = { ...incompletePairs[0], spot_id: "seventh-spot" };
  assert.throws(
    () => parseReadModelStatus(d1Status(incompletePairs)),
    /complete 1h\/3h pairs for every active spot/
  );

  const splitGeneration = readModelRows();
  splitGeneration[1] = {
    ...splitGeneration[1],
    generation_id: otherGenerationId
  };
  assert.throws(
    () => parseReadModelStatus(d1Status(splitGeneration)),
    /split generation_id/
  );

  const splitGeneratedAt = readModelRows();
  splitGeneratedAt[1] = {
    ...splitGeneratedAt[1],
    generated_at: "2026-08-04T06:17:00.000Z"
  };
  assert.throws(
    () => parseReadModelStatus(d1Status(splitGeneratedAt)),
    /split generated_at/
  );
});

test("D1 status permits whole spot generations and materialization times to differ", () => {
  const rows = readModelRows();
  for (const index of [0, 1]) {
    rows[index] = {
      ...rows[index],
      generation_id: otherGenerationId,
      generated_at: "2026-08-04T06:17:00.000Z"
    };
  }
  rows[0] = {
    ...rows[0],
    materialized_at: "2026-08-04T07:27:29.000Z"
  };
  const result = parseReadModelStatus(d1Status(rows));
  assert.equal(result.ready, spotIds.length * 2);
  assert.equal(result.oldestGeneratedAt, "2026-08-04T06:17:00.000Z");
  assert.equal(result.newestGeneratedAt, generatedAt);
});

test("ops status rejects subprocess failures without leaking stderr or running later probes", async () => {
  const calls = [];
  let caught;
  try {
    await runOpsStatus({
      env: { SURF_BASE_URL: "https://surf.example" },
      config,
      fetcher: async () => healthResponse(),
      wranglerProbe: async (args) => {
        calls.push(args);
        return {
          status: 1,
          stdout: "",
          stderr: "Authorization: Bearer test-secret-must-not-escape"
        };
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.match(caught?.message ?? "", /Deployment status subprocess exited with status 1/);
  assert.doesNotMatch(caught?.message ?? "", /test-secret|Authorization|Bearer/);
  assert.equal(calls.length, 1);
});

test("ops status converts thrown subprocess errors to bounded diagnostics", async () => {
  await assert.rejects(
    runOpsStatus({
      env: { SURF_BASE_URL: "https://surf.example" },
      config,
      fetcher: async () => healthResponse(),
      wranglerProbe: async () => {
        throw new Error("private child-process output");
      }
    }),
    (error) => {
      assert.match(error.message, /subprocess failed \(Error\)/);
      assert.doesNotMatch(error.message, /private child-process output/);
      return true;
    }
  );
});
