import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AmbiguousWorkerActivationError,
  createWorkerReleaseOperations,
  expectedWorkerBindingDescriptor,
  RELEASE_GENERATION_TIMEOUT_MS,
  readBoundedHealthIdentity,
  resolveOptionalWorkerSourceRevision,
  resolveWorkerSourceRevision,
  resolveTaggedWorkerVersion
} from "../lib/release-worker.mjs";
import { SURF_WORKER_VERSION_HEADER } from "../lib/worker-version.mjs";

const predecessor = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const deployment = "33333333-3333-4333-8333-333333333333";
const predecessorDeployment = "44444444-4444-4444-8444-444444444444";

const reconciliationSeedSql = `
insert into spots (id, name, region, lat, lon, timezone, shore_normal_deg, config_json, active) values
  ('spot-1', 'Spot One', 'norcal', 1.5, -2.5, 'UTC', 270, '{"safe":true}', 1)
on conflict(id) do update set
  name = excluded.name,
  region = excluded.region,
  lat = excluded.lat,
  lon = excluded.lon,
  timezone = excluded.timezone,
  shore_normal_deg = excluded.shore_normal_deg,
  config_json = excluded.config_json,
  active = excluded.active;

insert into sources (id, name, type, provider, external_id, url, format, parser_runtime, attribution, license_note, refresh_minutes, active, metadata_json) values
  ('source-1', 'Source One', 'wave', 'provider', null, 'https://example.test', 'json', 'worker', 'Public', null, 60, 1, '{"v":1}')
on conflict(id) do update set
  name = excluded.name,
  type = excluded.type,
  provider = excluded.provider,
  external_id = excluded.external_id,
  url = excluded.url,
  format = excluded.format,
  parser_runtime = excluded.parser_runtime,
  attribution = excluded.attribution,
  license_note = excluded.license_note,
  refresh_minutes = excluded.refresh_minutes,
  active = excluded.active,
  metadata_json = excluded.metadata_json;

update sources set active = 0 where id in ('retired-1');
`;

const reconciledSpot = {
  id: "spot-1",
  name: "Spot One",
  region: "norcal",
  lat: 1.5,
  lon: -2.5,
  timezone: "UTC",
  shore_normal_deg: 270,
  config_json: '{"safe":true}',
  active: 1
};
const reconciledSource = {
  id: "source-1",
  name: "Source One",
  type: "wave",
  provider: "provider",
  external_id: null,
  url: "https://example.test",
  format: "json",
  parser_runtime: "worker",
  attribution: "Public",
  license_note: null,
  refresh_minutes: 60,
  active: 1,
  metadata_json: '{"v":1}'
};

function deploymentStatus(versionId, deploymentId = deployment) {
  return JSON.stringify({
    id: deploymentId,
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }]
  });
}

function context(activeVersions, calls) {
  const config = {
    name: "surf-test",
    assets: { binding: "ASSETS" },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      SURF_SOURCE_REVISION: "a".repeat(40),
      SURF_WORKER_RUNTIME_DIGEST: "c".repeat(64),
      SURF_CLIENT_BUILD_DIGEST: "b".repeat(64)
    },
    d1_databases: [
      { binding: "DB", database_id: "database-id" }
    ],
    r2_buckets: [
      { binding: "RAW_ARTIFACTS", bucket_name: "surf-test-raw-artifacts" }
    ],
    queues: {
      producers: [{ binding: "INGEST_QUEUE", queue: "surf-ingest" }]
    },
    durable_objects: {
      bindings: [{ name: "FORECAST_BRIEF_AGENT", class_name: "ForecastBriefAgent" }]
    }
  };
  const resourceBindings = expectedWorkerBindingDescriptor(config).map((binding) => ({
    ...binding,
    ...(binding.type === "secret_text" ? { text: "redacted" } : {})
  }));
  return {
    workerName: "surf-test",
    releaseRoot: "/release",
    readConfig() {
      return config;
    },
    assertUnchanged() {},
    ensureQueues() {
      calls.push(["ensureQueues"]);
    },
    async inspectQueueConsumers() {
      calls.push(["inspectQueueConsumers"]);
      return {
        expected: [],
        actual: [],
        mismatches: [],
        staleConsumers: [],
        matches: true
      };
    },
    async removeStaleQueueConsumers() {
      calls.push(["removeStaleQueueConsumers"]);
      return { removed: 0 };
    },
    async inspectCronTriggers() {
      calls.push(["inspectCronTriggers"]);
      return {
        expected: ["17 * * * *"],
        actual: ["17 * * * *"],
        matches: true
      };
    },
    runPnpm(args, options) {
      calls.push(["pnpm", ...args, options]);
      return JSON.stringify({ ingestId: target });
    },
    runWrangler(args) {
      calls.push(["wrangler", ...args]);
      if (args[0] === "deployments") {
        const active = activeVersions.shift();
        return typeof active === "string"
          ? deploymentStatus(active)
          : deploymentStatus(active.versionId, active.deploymentId);
      }
      if (args[0] === "versions" && args[1] === "upload") {
        return `Worker Version ID: ${target}\n`;
      }
      if (args[0] === "versions" && args[1] === "list") {
        return JSON.stringify([]);
      }
      if (args[0] === "versions" && args[1] === "view") {
        return JSON.stringify({
          id: target,
          resources: {
            script_runtime: { usage_model: "standard", limits: { cpu_ms: 2000 } },
            bindings: resourceBindings
          }
        });
      }
      return "";
    }
  };
}

function operations(
  instance,
  fetcher = async () => {
    throw new Error("not used");
  }
) {
  return createWorkerReleaseOperations({
    context: instance,
    workerSecretsFile: "/private/worker.json",
    customOrigin: "https://surf.example",
    workersDevOrigin: "https://surf.example.workers.dev",
    clientDirectory: "/release/apps/web/dist/client",
    sourceRevision: "a".repeat(40),
    clientBuildDigest: "b".repeat(64),
    workerRuntimeDigest: "c".repeat(64),
    narrativeProtocolFingerprint: "d".repeat(64),
    releaseTag: "release-1",
    fetcher
  });
}

test("upload uses an inactive version and validates runtime metadata", () => {
  const calls = [];
  const ops = operations(context([], calls));
  assert.deepEqual(ops.upload(), { versionId: target });
  assert.ok(calls.some((call) => call.includes("--secrets-file")));
  assert.ok(calls.some((call) => call.includes("--tag") && call.includes("release-1")));
  assert.ok(calls.some((call) => call[2] === "view"));
});

test("portable R2 bindings resolve to Wrangler's exact auto-provisioned name", () => {
  const calls = [];
  const instance = context([], calls);
  delete instance.readConfig().r2_buckets[0].bucket_name;

  assert.deepEqual(
    expectedWorkerBindingDescriptor(instance.readConfig()).find(
      (binding) => binding.name === "RAW_ARTIFACTS"
    ),
    {
      name: "RAW_ARTIFACTS",
      type: "r2_bucket",
      bucket_name: "surf-test-raw-artifacts"
    }
  );
  assert.deepEqual(operations(instance).upload(), { versionId: target });

  const drifted = context([], []);
  delete drifted.readConfig().r2_buckets[0].bucket_name;
  const original = drifted.runWrangler;
  drifted.runWrangler = (args) => {
    const output = original(args);
    if (args[0] !== "versions" || args[1] !== "view") return output;
    const version = JSON.parse(output);
    version.resources.bindings.find(
      (binding) => binding.name === "RAW_ARTIFACTS"
    ).bucket_name = "wrong-bucket";
    return JSON.stringify(version);
  };
  assert.throws(
    () => operations(drifted).upload(),
    /RAW_ARTIFACTS\.bucket_name/
  );
});

test("uploaded versions must preserve exact stateful and secret binding identity", () => {
  const calls = [];
  const instance = context([], calls);
  const original = instance.runWrangler;
  instance.runWrangler = (args) => {
    const output = original(args);
    if (args[0] !== "versions" || args[1] !== "view") return output;
    const version = JSON.parse(output);
    version.resources.bindings = version.resources.bindings.filter(
      (binding) => binding.name !== "INGEST_TOKEN"
    );
    return JSON.stringify(version);
  };
  assert.throws(() => operations(instance).upload(), /INGEST_TOKEN/);

  const misbound = context([], []);
  const misboundOriginal = misbound.runWrangler;
  misbound.runWrangler = (args) => {
    const output = misboundOriginal(args);
    if (args[0] !== "versions" || args[1] !== "view") return output;
    const version = JSON.parse(output);
    version.resources.bindings.find((binding) => binding.name === "DB").database_id =
      "wrong-database";
    return JSON.stringify(version);
  };
  assert.throws(() => operations(misbound).upload(), /DB\.database_id/);

  const mistypedSecret = context([], []);
  const mistypedSecretOriginal = mistypedSecret.runWrangler;
  mistypedSecret.runWrangler = (args) => {
    const output = mistypedSecretOriginal(args);
    if (args[0] !== "versions" || args[1] !== "view") return output;
    const version = JSON.parse(output);
    version.resources.bindings.find((binding) => binding.name === "INGEST_TOKEN").type =
      "plain_text";
    return JSON.stringify(version);
  };
  assert.throws(() => operations(mistypedSecret).upload(), /INGEST_TOKEN/);
});

test("Durable Object bindings reject cross-script config and uploaded capabilities", () => {
  for (const unexpected of [
    { script_name: "different-worker" },
    { environment: "production" },
    { future_capability: true }
  ]) {
    const configured = context([], []);
    Object.assign(
      configured.readConfig().durable_objects.bindings[0],
      unexpected
    );
    assert.throws(
      () => operations(configured),
      /Pinned Worker Durable Object binding must contain exactly class_name, name/
    );
  }

  for (const [field, value] of [
    ["script_name", "different-worker"],
    ["environment", "production"]
  ]) {
    const uploaded = context([], []);
    const original = uploaded.runWrangler;
    uploaded.runWrangler = (args) => {
      const output = original(args);
      if (args[0] !== "versions" || args[1] !== "view") return output;
      const version = JSON.parse(output);
      version.resources.bindings.find(
        (binding) => binding.name === "FORECAST_BRIEF_AGENT"
      )[field] = value;
      return JSON.stringify(version);
    };
    assert.throws(
      () => operations(uploaded).upload(),
      /Worker version Durable Object binding FORECAST_BRIEF_AGENT must contain exactly class_name, name, type/
    );
  }
});

test("uploaded versions reject every unexpected binding capability", () => {
  for (const type of [
    "service",
    "kv_namespace",
    "browser",
    "ai",
    "analytics_engine",
    "hyperdrive",
    "vectorize",
    "workflow",
    "future_capability"
  ]) {
    const instance = context([], []);
    const original = instance.runWrangler;
    instance.runWrangler = (args) => {
      const output = original(args);
      if (args[0] !== "versions" || args[1] !== "view") return output;
      const version = JSON.parse(output);
      version.resources.bindings.push({
        name: `UNEXPECTED_${type.toUpperCase()}`,
        type
      });
      return JSON.stringify(version);
    };
    assert.throws(
      () => operations(instance).upload(),
      new RegExp(`unexpected ${type} binding`)
    );
  }
});

test("active Worker source revision is read from one exact version binding", () => {
  const sourceRevision = "a".repeat(40);
  const output = JSON.stringify({
    id: target,
    resources: {
      bindings: [
        { name: "SURF_SOURCE_REVISION", type: "plain_text", text: sourceRevision }
      ]
    }
  });
  assert.equal(resolveWorkerSourceRevision(output, target), sourceRevision);
  assert.equal(
    resolveOptionalWorkerSourceRevision(
      JSON.stringify({ id: target, resources: { bindings: [] } }),
      target
    ),
    null
  );
  assert.throws(
    () =>
      resolveWorkerSourceRevision(
        JSON.stringify({ id: target, resources: { bindings: [] } }),
        target
      ),
    /source revision binding/
  );
  assert.throws(
    () =>
      resolveOptionalWorkerSourceRevision(
        JSON.stringify({
          id: target,
          resources: {
            bindings: [
              {
                name: "SURF_SOURCE_REVISION",
                type: "plain_text",
                text: "0".repeat(40)
              }
            ]
          }
        }),
        target
      ),
    /source revision binding/
  );
});

test("a tagged inactive upload can be reconciled after interruption", () => {
  assert.equal(
    resolveTaggedWorkerVersion(
      JSON.stringify([
        {
          id: target,
          annotations: { "workers/tag": "release-1" }
        }
      ]),
      "release-1"
    ),
    target
  );
  assert.equal(resolveTaggedWorkerVersion("[]", "release-1"), null);
  assert.throws(
    () =>
      resolveTaggedWorkerVersion(
        JSON.stringify([
          { id: target, annotations: { "workers/tag": "release-1" } },
          { id: predecessor, annotations: { "workers/tag": "release-1" } }
        ]),
        "release-1"
      ),
    /multiple versions/
  );
});

test("activation rechecks predecessor and proves exact sole-active target", () => {
  const calls = [];
  const ops = operations(
    context(
      [
        { versionId: predecessor, deploymentId: predecessorDeployment },
        { versionId: target, deploymentId: deployment }
      ],
      calls
    )
  );
  assert.equal(
    ops.activate(target, {
      workerVersionId: predecessor,
      deploymentId: predecessorDeployment
    }).workerVersionId,
    target
  );
  assert.ok(calls.some((call) => call[2] === "deploy" && call.includes(`${target}@100%`)));
});

test("activation ambiguity fails closed", () => {
  const calls = [];
  const other = "44444444-4444-4444-8444-444444444444";
  const instance = context(
    [
      { versionId: predecessor, deploymentId: predecessorDeployment },
      { versionId: other, deploymentId: deployment }
    ],
    calls
  );
  const original = instance.runWrangler;
  instance.runWrangler = (args) => {
    if (args[0] === "versions" && args[1] === "deploy") {
      throw new Error("command failed");
    }
    return original(args);
  };
  const ops = operations(instance);
  assert.throws(
    () =>
      ops.activate(target, {
        workerVersionId: predecessor,
        deploymentId: predecessorDeployment
      }),
    AmbiguousWorkerActivationError
  );
});

test("activation rejects a same-version predecessor with a different deployment", () => {
  const calls = [];
  const ops = operations(
    context(
      [
        { versionId: predecessor, deploymentId: deployment }
      ],
      calls
    )
  );
  assert.throws(
    () =>
      ops.activate(target, {
        workerVersionId: predecessor,
        deploymentId: predecessorDeployment
      }),
    /predecessor changed/
  );
  assert.equal(
    calls.some((call) => call[2] === "deploy"),
    false
  );
});

test("assets-only surface exposes no implicit stateful mutation", () => {
  const calls = [];
  const ops = operations(context([], calls));
  assert.equal(calls.length, 0);
  assert.equal(typeof ops.upload, "function");
  assert.equal(typeof ops.activate, "function");
  assert.equal(typeof ops.verifyLive, "function");
});

test("trigger inspection is read-only and delegates to the pinned command context", async () => {
  const calls = [];
  const ops = operations(context([], calls));
  assert.deepEqual(await ops.inspectTriggers(), {
    expected: ["17 * * * *"],
    actual: ["17 * * * *"],
    matches: true
  });
  assert.deepEqual(calls, [["inspectCronTriggers"]]);
});

test("Queue consumer inspection is read-only and delegates to the pinned command context", async () => {
  const calls = [];
  const ops = operations(context([], calls));
  assert.deepEqual(await ops.inspectQueueConsumers(), {
    expected: [],
    actual: [],
    mismatches: [],
    staleConsumers: [],
    matches: true
  });
  assert.deepEqual(calls, [["inspectQueueConsumers"]]);
});

test("trigger synchronization removes exact stale consumers before Wrangler reconciliation", async () => {
  const calls = [];
  const ops = operations(context([], calls));
  await ops.syncTriggers();
  assert.deepEqual(calls, [
    ["removeStaleQueueConsumers"],
    ["wrangler", "triggers", "deploy"]
  ]);
});

test("seed resumes a lost-after-commit execution by exact read-only reconciliation", () => {
  const releaseRoot = mkdtempSync(join(tmpdir(), "surf-release-seed-"));
  try {
    const seedDirectory = join(releaseRoot, "packages/db/seeds");
    mkdirSync(seedDirectory, { recursive: true });
    const seedPath = join(seedDirectory, "0000_v1_norcal.sql");
    writeFileSync(seedPath, reconciliationSeedSql, { mode: 0o600 });
    const calls = [];
    const instance = context([], calls);
    instance.releaseRoot = releaseRoot;
    const originalRunWrangler = instance.runWrangler;
    let remoteApplied = false;
    let seedMutations = 0;
    instance.runWrangler = (args) => {
      if (args[0] !== "d1" || args[1] !== "execute") {
        return originalRunWrangler(args);
      }
      calls.push(["wrangler", ...args]);
      if (args.includes("--file")) {
        assert.equal(args.at(-1), seedPath);
        seedMutations += 1;
        remoteApplied = true;
        throw new Error("simulated transport loss after D1 commit");
      }
      const sql = args.at(-1);
      assert.match(sql, /^select /);
      let results = [];
      if (remoteApplied) {
        if (sql.includes(" from spots ")) results = [reconciledSpot];
        else if (sql.startsWith("select id, active from sources")) {
          results = [{ id: "retired-1", active: 0 }];
        } else {
          results = [reconciledSource];
        }
      }
      return JSON.stringify([{ success: true, results }]);
    };

    const ops = operations(instance);
    assert.throws(() => ops.seed(), /simulated transport loss after D1 commit/);
    assert.equal(seedMutations, 1);

    const resumed = ops.seed();
    assert.equal(resumed.disposition, "reconciled");
    assert.equal(resumed.matches, true);
    assert.match(resumed.seedSha256, /^[0-9a-f]{64}$/);
    assert.match(resumed.semanticSha256, /^[0-9a-f]{64}$/);
    assert.equal(seedMutations, 1, "resume must not execute the seed twice");
    for (const call of calls.filter(
      (entry) => entry[1] === "d1" && entry.includes("--command")
    )) {
      assert.match(call.at(-1), /^select /);
      assert.equal(
        /\b(?:insert|update|delete|alter|drop)\b/i.test(call.at(-1)),
        false
      );
    }
  } finally {
    rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("remote generation has a finite ceiling covering cron deferral", () => {
  const calls = [];
  const ops = operations(context([], calls));
  assert.deepEqual(ops.generate(target, "ingest-token"), {
    generationId: target
  });
  const call = calls.find((entry) => entry[0] === "pnpm");
  const options = call.at(-1);
  assert.equal(options.timeoutPolicy, "finite");
  assert.equal(options.timeoutMs, RELEASE_GENERATION_TIMEOUT_MS);
  assert.ok(RELEASE_GENERATION_TIMEOUT_MS > 70 * 60_000);
  assert.ok(RELEASE_GENERATION_TIMEOUT_MS < 90 * 60_000);
});

test("generation reconciliation proves an existing target lineage without enqueueing", async () => {
  const calls = [];
  const notBefore = "2026-08-15T20:00:00.000Z";
  const fetcher = async (input) => {
    const url = new URL(String(input));
    const headers = { [SURF_WORKER_VERSION_HEADER]: target };
    if (url.pathname === "/api/spots") {
      return Response.json(
        { spots: [{ id: "obsf-north", timezone: "America/Los_Angeles" }] },
        { headers }
      );
    }
    if (url.pathname === "/api/forecast-readiness") {
      return Response.json(
        {
          forecastReadModels: ["3h", "1h"].map((interval) => ({
            spotId: "obsf-north",
            interval,
            generationId: `sha256:${"a".repeat(64)}:ingest:${target}`,
            ingestId: target,
            generatedAt: notBefore,
            materializedAt: "2026-08-15T20:01:00.000Z"
          }))
        },
        { headers }
      );
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const ops = operations(context([], calls), fetcher);
  assert.deepEqual(await ops.inspectGeneration(target, notBefore), {
    generationId: target
  });
  assert.equal(calls.length, 0);
});

test("health identity reads a bounded JSON stream", async () => {
  const response = new Response('{"status":"ok"}', {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
  assert.equal(await readBoundedHealthIdentity(response), '{"status":"ok"}');
});

test("health identity rejects oversized, non-JSON, and dishonest bodies", async () => {
  await assert.rejects(
    readBoundedHealthIdentity(
      new Response("not json", { headers: { "content-type": "text/plain" } })
    ),
    /must be application\/json/
  );
  await assert.rejects(
    readBoundedHealthIdentity(
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(64 * 1024 + 1)
        }
      })
    ),
    /bounded response size/
  );
  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  });
  await assert.rejects(
    readBoundedHealthIdentity(
      new Response(oversizedStream, {
        headers: { "content-type": "application/json" }
      })
    ),
    /bounded response size/
  );
});
