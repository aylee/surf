import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../lib/cloudflare-commands.mjs";
import { stageWranglerConfigSnapshot } from "../lib/wrangler-config-snapshot.mjs";
import {
  wranglerEnvironmentFailures,
  wranglerStructureFailures
} from "../lib/validate-wrangler-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const configPath = resolve(root, "apps/web/wrangler.jsonc");
const canonical = readWranglerConfig(configPath);

function renameInstance(config, name) {
  config.name = name;
  config.d1_databases[0].database_name = name;
  config.queues.producers[0].queue = `${name}-ingest`;
  config.queues.producers[1].queue = `${name}-narrative`;
  config.queues.producers[2].queue = `${name}-narrative-fallback`;
  config.queues.consumers[0].queue = `${name}-ingest`;
  config.queues.consumers[0].dead_letter_queue = `${name}-ingest-dlq`;
  config.queues.consumers[1].queue = `${name}-narrative-fallback`;
}

test("Wrangler instance config follows the subcommand arguments", () => {
  const activationRoot = mkdtempSync(resolve(tmpdir(), "surf-wrangler-order-"));
  try {
    const sourcePath = resolve(activationRoot, "source/wrangler.jsonc");
    const outputPath = resolve(activationRoot, "activation/wrangler.jsonc");
    mkdirSync(resolve(activationRoot, "source"), { recursive: true });
    mkdirSync(resolve(activationRoot, "activation"), { recursive: true });
    writeFileSync(sourcePath, `${JSON.stringify(canonical, null, 2)}\n`, { mode: 0o600 });
    const pinned = stageWranglerConfigSnapshot({ sourcePath, outputPath, releaseRoot: root });
    const result = spawnSync(
      process.execPath,
      ["scripts/wrangler.mjs", "whoami", "--help"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SURF_WRANGLER_CONFIG: pinned.path,
          SURF_WRANGLER_CONFIG_SHA256: pinned.sha256,
          WRANGLER_LOG_PATH: resolve(tmpdir(), `surf-wrangler-order-${process.pid}.log`)
        }
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /wrangler whoami/);
    assert.doesNotMatch(output, /Unknown argument/);

    appendFileSync(pinned.path, " ");
    const drifted = spawnSync(
      process.execPath,
      ["scripts/wrangler.mjs", "deployments", "status", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SURF_WRANGLER_CONFIG: pinned.path,
          SURF_WRANGLER_CONFIG_SHA256: pinned.sha256
        }
      }
    );
    const driftOutput = `${drifted.stdout ?? ""}${drifted.stderr ?? ""}`;
    assert.notEqual(drifted.status, 0);
    assert.match(driftOutput, /SHA-256 does not match activation/);
    assert.doesNotMatch(driftOutput, /> pnpm|wrangler deployments/);
  } finally {
    rmSync(activationRoot, { recursive: true, force: true });
  }
});

test("canonical Wrangler configuration satisfies the supported instance contract", () => {
  assert.deepEqual(wranglerStructureFailures(canonical, configPath), []);
});

test("supported deployments pin a bounded Standard-plan CPU budget", () => {
  assert.deepEqual(canonical.limits, { cpu_ms: 2_000 });

  for (const cpuMs of [undefined, 50, 1_999, 2_001, 30_000, "2000"]) {
    const config = structuredClone(canonical);
    if (cpuMs === undefined) delete config.limits;
    else config.limits.cpu_ms = cpuMs;

    assert.deepEqual(wranglerStructureFailures(config, configPath), [
      "Worker CPU limit must be exactly 2000 ms; the supported deployment requires the Standard usage model."
    ]);
  }

  const instanceConfigPath = resolve(root, "apps/web/wrangler.instance.jsonc");
  const ignoredOverlay = structuredClone(canonical);
  ignoredOverlay.limits.cpu_ms = 50;
  assert.deepEqual(wranglerStructureFailures(ignoredOverlay, instanceConfigPath), [
    "Worker CPU limit must be exactly 2000 ms; the supported deployment requires the Standard usage model."
  ]);
});

test("instance Worker names remain addressable by exact version overrides", () => {
  for (const invalidName of ["Surf-Dev", "1surf", "surf_dev", "surf.dev"]) {
    const config = structuredClone(canonical);
    renameInstance(config, invalidName);
    assert.deepEqual(wranglerStructureFailures(config, configPath), [
      "Worker name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens so exact version overrides remain addressable."
    ]);
  }

  const validOverlay = structuredClone(canonical);
  renameInstance(validOverlay, "friends-surf2");
  assert.deepEqual(wranglerStructureFailures(validOverlay, configPath), []);
});

test("CI cannot silently deploy under a different Worker name", () => {
  assert.deepEqual(
    wranglerEnvironmentFailures(canonical, {
      WRANGLER_CI_OVERRIDE_NAME: "different-surf"
    }),
    [
      "WRANGLER_CI_OVERRIDE_NAME (different-surf) must match the active config Worker name (surf) so exact version overrides target the deployed Worker."
    ]
  );
  assert.deepEqual(
    wranglerEnvironmentFailures(canonical, {
      WRANGLER_CI_OVERRIDE_NAME: "surf"
    }),
    []
  );
  assert.deepEqual(
    wranglerEnvironmentFailures(canonical, {
      CLOUDFLARE_ENV: "reviewtest"
    }),
    [
      "CLOUDFLARE_ENV must be unset; the supported deploy path selects instances with SURF_WRANGLER_CONFIG and rejects ambient Wrangler environment suffixes."
    ]
  );
});

test("instance validation rejects namespace, region, and contact drift", () => {
  const config = structuredClone(canonical);
  config.d1_databases[0].database_name = "someone-elses-database";
  config.r2_buckets[0].bucket_name = "shared-raw-data";
  config.vars.SURF_REGION = "socal";
  config.vars.SURF_USER_AGENT = "surf";

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "D1 database_name must match the Worker name.",
    "Manual RAW_ARTIFACTS bucket_name must be surf-raw-artifacts.",
    "SURF_REGION must remain norcal until another runtime catalog is implemented.",
    "SURF_USER_AGENT must identify the instance with an operator contact."
  ]);
});

test("instance validation keeps the legacy Agent dormant and protects its secret boundary", () => {
  const config = structuredClone(canonical);
  config.durable_objects.bindings[0].class_name = "WrongAgent";
  config.exports.ForecastBriefAgent.storage = "kv";
  config.vars.FORECAST_BRIEF_ENABLED = "true";
  config.vars.GEMINI_API_KEY = "must-not-be-tracked";

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "FORECAST_BRIEF_AGENT must bind exactly once to ForecastBriefAgent.",
    "ForecastBriefAgent must be declared as a live SQLite durable-object export.",
    "FORECAST_BRIEF_ENABLED must remain false; ForecastBriefAgent is dormant rollback compatibility, not the active Analysis path.",
    "GEMINI_API_KEY must be a Wrangler secret, never a tracked Worker var."
  ]);
});

test("instance validation permits only the exact local Durable Object binding", () => {
  for (const unexpected of [
    { script_name: "different-worker" },
    { environment: "production" },
    { future_capability: true }
  ]) {
    const config = structuredClone(canonical);
    Object.assign(config.durable_objects.bindings[0], unexpected);
    assert.deepEqual(wranglerStructureFailures(config, configPath), [
      "FORECAST_BRIEF_AGENT must be a local binding with exactly name and class_name; script_name and environment are not allowed."
    ]);
  }

  const config = structuredClone(canonical);
  config.durable_objects.bindings.push({
    name: "UNEXPECTED_AGENT",
    class_name: "ForecastBriefAgent"
  });
  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "FORECAST_BRIEF_AGENT must bind exactly once to ForecastBriefAgent."
  ]);
});

test("instance validation protects the outbound narrative pull boundary", () => {
  const config = structuredClone(canonical);
  config.queues.producers[1].queue = "wrong-narrative";
  config.queues.consumers.push({ queue: "surf-narrative" });
  config.vars.NARRATIVE_ENABLED = "true";
  config.vars.NARRATIVE_RESULT_TOKEN = "must-not-be-tracked";

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "NARRATIVE_QUEUE must produce to surf-narrative.",
    "Queue consumer must read surf-ingest and dead-letter to surf-ingest-dlq.",
    "The narrative queue must use an out-of-band HTTP pull consumer, not a Worker consumer.",
    "The tracked config must keep NARRATIVE_ENABLED=false; activation belongs in the ignored instance overlay.",
    "NARRATIVE_RESULT_TOKEN must be a Wrangler secret, never a tracked Worker var."
  ]);
});

test("observability validation requires persisted full-sample logs and automatic traces", () => {
  const config = structuredClone(canonical);
  config.observability.logs.head_sampling_rate = 0.5;
  config.observability.logs.invocation_logs = false;
  config.observability.logs.persist = false;
  config.observability.traces.enabled = false;
  config.observability.traces.head_sampling_rate = 0.25;
  config.observability.traces.persist = false;

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "Worker observability logs must be enabled, persisted, invocation-complete, and sampled at 100%.",
    "Worker automatic traces must be enabled, persisted, and sampled at 100%."
  ]);
});

test("observability validation requires the top-level enablement switch", () => {
  for (const enabled of [false, undefined]) {
    const config = structuredClone(canonical);
    if (enabled === undefined) delete config.observability.enabled;
    else config.observability.enabled = enabled;

    assert.deepEqual(wranglerStructureFailures(config, configPath), [
      "Worker observability must be enabled at the top level."
    ]);
  }
});

test("only the exact tracked config path applies template-only production guards", () => {
  const config = structuredClone(canonical);
  config.vars.NARRATIVE_ENABLED = "true";
  config.observability.logs.destinations = ["surf-logfire-logs"];
  config.observability.traces.destinations = ["surf-logfire-traces"];

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "The tracked config must keep NARRATIVE_ENABLED=false; activation belongs in the ignored instance overlay.",
    "The tracked Wrangler config must remain destination-neutral; account-scoped telemetry destination names belong only in the ignored instance overlay."
  ]);

  config.$schema = resolve(root, "apps/web", canonical.$schema);
  config.main = resolve(root, "apps/web", canonical.main);
  config.d1_databases[0].migrations_dir = resolve(
    root,
    "apps/web",
    canonical.d1_databases[0].migrations_dir
  );
  assert.deepEqual(
    wranglerStructureFailures(
      config,
      resolve(root, ".release-state/attempts/release-1/wrangler.jsonc")
    ),
    []
  );
});

test("instance validation preserves serialized ingest generations", () => {
  const config = structuredClone(canonical);
  config.queues.consumers[0].max_batch_size = 10;
  delete config.queues.consumers[0].max_concurrency;

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "Ingest queue consumption must be serialized one message at a time."
  ]);
});

test("instance validation preserves the at-most-once paid fallback topology", () => {
  const config = structuredClone(canonical);
  config.queues.producers[2].queue = "wrong-fallback";
  config.queues.consumers[1].max_retries = 2;
  config.queues.consumers[1].dead_letter_queue = "surf-narrative-fallback-dlq";

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "NARRATIVE_FALLBACK_QUEUE must produce to surf-narrative-fallback.",
    "Narrative fallback consumption must be serialized with max_retries=0 and no DLQ; D1 owns paid-call idempotency."
  ]);
});

test("tracked fallback defaults remain reviewable and bounded", () => {
  const config = structuredClone(canonical);
  config.vars.NARRATIVE_FALLBACK_MODEL = "gemini-expensive";
  config.vars.NARRATIVE_FALLBACK_DAILY_CAP = "20";

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "NARRATIVE_FALLBACK_MODEL must remain gemini-3.6-flash in the tracked canonical config.",
    "NARRATIVE_FALLBACK_DAILY_CAP must remain 4 in the tracked canonical config."
  ]);
});

test("instance validation locks the cron schedule used by deploy safety", () => {
  for (const crons of [undefined, [], ["18 * * * *"], ["17 * * * *", "47 * * * *"]]) {
    const config = structuredClone(canonical);
    if (crons === undefined) delete config.triggers;
    else config.triggers.crons = crons;

    assert.deepEqual(wranglerStructureFailures(config, configPath), [
      "Scheduled ingest must use exactly 17 * * * * so deploy cron-safety remains valid."
    ]);
  }
});

test("instance validation preserves version-scoped Worker response caching", () => {
  const config = structuredClone(canonical);
  config.cache.cross_version_cache = true;

  assert.deepEqual(wranglerStructureFailures(config, configPath), [
    "Worker response caching must be enabled with version-scoped cache keys."
  ]);
});

test("instance validation requires the exact Worker version metadata binding", () => {
  const missing = structuredClone(canonical);
  delete missing.version_metadata;
  const renamed = structuredClone(canonical);
  renamed.version_metadata.binding = "WORKER_VERSION";
  const extended = structuredClone(canonical);
  extended.version_metadata.extra = true;

  for (const config of [missing, renamed, extended]) {
    assert.deepEqual(wranglerStructureFailures(config, configPath), [
      "Worker version metadata must bind exactly as CF_VERSION_METADATA."
    ]);
  }
});

test("an ignored instance config cannot reactivate the dormant brief Agent", () => {
  const config = structuredClone(canonical);
  config.vars.FORECAST_BRIEF_ENABLED = "true";
  const instanceConfigPath = resolve(root, "apps/web/wrangler.instance.jsonc");

  assert.deepEqual(wranglerStructureFailures(config, instanceConfigPath), [
    "FORECAST_BRIEF_ENABLED must remain false; ForecastBriefAgent is dormant rollback compatibility, not the active Analysis path."
  ]);
});

test("an ignored instance config may enable narrative production after operator setup", () => {
  const config = structuredClone(canonical);
  config.vars.NARRATIVE_ENABLED = "true";
  const instanceConfigPath = resolve(root, "apps/web/wrangler.instance.jsonc");

  assert.deepEqual(wranglerStructureFailures(config, instanceConfigPath), []);
});
