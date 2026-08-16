import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  AmbiguousWorkerActivationError,
  assertWorkerVersionReleaseIdentity,
  buildWorkerCandidate,
  createWorkerReleaseOperations,
  expectedWorkerBindingDescriptor,
  RELEASE_GENERATION_TIMEOUT_MS,
  readBoundedHealthIdentity,
  resolveOptionalWorkerSourceRevision,
  resolveWorkerDurableObjectNamespaceIds,
  resolveWorkerSourceRevision,
  resolveTaggedWorkerVersion
} from "../lib/release-worker.mjs";
import { captureClientOutputIdentity } from "../lib/build-identity.mjs";
import { workerCandidateBuildArgs } from "../lib/deploy-orchestration.mjs";
import { SURF_WORKER_VERSION_HEADER } from "../lib/worker-version.mjs";

const predecessor = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const deployment = "33333333-3333-4333-8333-333333333333";
const predecessorDeployment = "44444444-4444-4444-8444-444444444444";

function temporaryRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const workerBundleRoot = temporaryRoot("surf-release-worker-bundle-");
const workerBundlePath = join(workerBundleRoot, "index.js");
const workerBundleContents = "export default { fetch() { return new Response('ok'); } };\n";
writeFileSync(workerBundlePath, workerBundleContents, { mode: 0o600 });
const workerRuntimeDigest = createHash("sha256")
  .update(workerBundleContents)
  .digest("hex");

function installClientOutput(releaseRoot, marker = "planned") {
  const clientDirectory = join(releaseRoot, "apps/web/dist/client");
  mkdirSync(join(clientDirectory, "assets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(clientDirectory, "index.html"), `<p>${marker}</p>\n`, {
    mode: 0o600
  });
  writeFileSync(join(clientDirectory, "assets/app.js"), `export default ${JSON.stringify(marker)};\n`, {
    mode: 0o600
  });
  return clientDirectory;
}

const workerClientDirectory = installClientOutput(workerBundleRoot);
const workerClientOutputIdentity = captureClientOutputIdentity(workerClientDirectory);
test.after(() => rmSync(workerBundleRoot, { recursive: true, force: true }));

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
      SURF_WORKER_RUNTIME_DIGEST: workerRuntimeDigest,
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
    ...(binding.type === "secret_text" ? { text: "redacted" } : {}),
    ...(binding.type === "durable_object_namespace"
      ? { namespace_id: "f".repeat(32) }
      : {})
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
          id: args[2],
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
  },
  {
    clientDirectory = workerClientDirectory,
    clientOutputIdentity = workerClientOutputIdentity
  } = {}
) {
  return createWorkerReleaseOperations({
    context: instance,
    predecessorWorkerVersionId: predecessor,
    workerSecretsFile: "/private/worker.json",
    customOrigin: "https://surf.example",
    workersDevOrigin: "https://surf.example.workers.dev",
    clientDirectory,
    sourceRevision: "a".repeat(40),
    clientBuildDigest: "b".repeat(64),
    clientOutputIdentity,
    workerBundlePath,
    workerRuntimeDigest,
    narrativeProtocolFingerprint: "d".repeat(64),
    releaseTag: "release-1",
    fetcher
  });
}

test("exported Worker version validator preserves exact release identity", () => {
  const instance = context([], []);
  const expectedBindings = expectedWorkerBindingDescriptor(instance.readConfig());
  const namespaceIds = resolveWorkerDurableObjectNamespaceIds(
    instance.runWrangler(["versions", "view", predecessor, "--json"]),
    predecessor,
    expectedBindings
  );
  const output = instance.runWrangler(["versions", "view", target, "--json"]);
  assert.doesNotThrow(() =>
    assertWorkerVersionReleaseIdentity(
      output,
      {
        versionId: target,
        sourceRevision: "a".repeat(40),
        workerRuntimeDigest,
        clientBuildDigest: "b".repeat(64)
      },
      expectedBindings,
      namespaceIds
    )
  );
});

test("upload uses an inactive version and validates runtime metadata", () => {
  const calls = [];
  const ops = operations(context([], calls));
  assert.deepEqual(ops.upload(), { versionId: target });
  assert.ok(calls.some((call) => call.includes("--secrets-file")));
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "wrangler" &&
        call[1] === "versions" &&
        call[2] === "upload" &&
        call.includes(workerBundlePath) &&
        call.includes("--no-bundle")
    )
  );
  const uploadCall = calls.find(
    (call) =>
      call[0] === "wrangler" &&
      call[1] === "versions" &&
      call[2] === "upload"
  );
  assert.equal(uploadCall.includes("--minify"), false);
  assert.ok(calls.some((call) => call.includes("--tag") && call.includes("release-1")));
  assert.deepEqual(
    calls
      .filter(
        (call) =>
          call[0] === "wrangler" &&
          call[1] === "versions" &&
          call[2] === "view"
      )
      .map((call) => call[3]),
    [predecessor, target]
  );
});

test("upload rejects a prebuilt Worker bundle changed after planning", () => {
  const changedRoot = temporaryRoot("surf-release-worker-changed-");
  try {
    const changedBundlePath = join(changedRoot, "index.js");
    writeFileSync(changedBundlePath, workerBundleContents, { mode: 0o600 });
    const calls = [];
    const ops = createWorkerReleaseOperations({
      context: context([], calls),
      predecessorWorkerVersionId: predecessor,
      workerSecretsFile: "/private/worker.json",
      customOrigin: "https://surf.example",
      workersDevOrigin: "https://surf.example.workers.dev",
      clientDirectory: workerClientDirectory,
      sourceRevision: "a".repeat(40),
      clientBuildDigest: "b".repeat(64),
      clientOutputIdentity: workerClientOutputIdentity,
      workerBundlePath: changedBundlePath,
      workerRuntimeDigest,
      narrativeProtocolFingerprint: "d".repeat(64),
      releaseTag: "release-1"
    });
    writeFileSync(changedBundlePath, `${workerBundleContents}// changed\n`, {
      mode: 0o600
    });
    assert.throws(
      () => ops.upload(),
      /differs from its planned runtime digest/
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(changedRoot, { recursive: true, force: true });
  }
});

test("upload rejects client output drift before making a Wrangler call", () => {
  const fixtureRoot = temporaryRoot("surf-release-client-drift-");
  try {
    const clientDirectory = installClientOutput(fixtureRoot);
    const clientOutputIdentity = captureClientOutputIdentity(clientDirectory);
    const calls = [];
    const ops = operations(context([], calls), undefined, {
      clientDirectory,
      clientOutputIdentity
    });
    writeFileSync(join(clientDirectory, "assets/app.js"), "export default 'changed';\n");
    assert.throws(
      () => ops.upload(),
      /Client build output differs from its planned identity/
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("upload detects client output drift during successful and failed Wrangler calls", () => {
  for (const outcome of ["response", "failure"]) {
    const fixtureRoot = temporaryRoot(`surf-release-client-${outcome}-drift-`);
    try {
      const clientDirectory = installClientOutput(fixtureRoot);
      const clientOutputIdentity = captureClientOutputIdentity(clientDirectory);
      const calls = [];
      const instance = context([], calls);
      const originalRunWrangler = instance.runWrangler;
      instance.runWrangler = (args) => {
        if (args[0] !== "versions" || args[1] !== "upload") {
          return originalRunWrangler(args);
        }
        calls.push(["wrangler", ...args]);
        writeFileSync(
          join(clientDirectory, "assets/app.js"),
          `export default ${JSON.stringify(outcome)};\n`
        );
        if (outcome === "failure") throw new Error("simulated upload failure");
        return `Worker Version ID: ${target}\n`;
      };
      const ops = operations(instance, undefined, {
        clientDirectory,
        clientOutputIdentity
      });
      let failure;
      try {
        ops.upload();
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      if (outcome === "failure") {
        assert.ok(failure instanceof AggregateError);
        assert.match(
          failure.message,
          /upload failed while planned build outputs also changed/
        );
        assert.equal(failure.errors.length, 2);
        assert.match(
          failure.errors[1].message,
          /Client build output differs from its planned identity/
        );
      } else {
        assert.match(
          failure.message,
          /Client build output differs from its planned identity/
        );
      }
      const uploadCalls = calls.filter(
        (call) =>
          call[0] === "wrangler" &&
          call[1] === "versions" &&
          call[2] === "upload"
      );
      assert.equal(uploadCalls.length, 1);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("candidate build accepts only Wrangler's exact single-module inventory", () => {
  const fixtureRoot = temporaryRoot("surf-release-candidate-");
  try {
    const outputDirectory = join(fixtureRoot, "output");
    const wranglerCalls = [];
    installClientOutput(fixtureRoot);
    const candidate = buildWorkerCandidate({
      context: {
        releaseRoot: fixtureRoot,
        runPnpm() {},
        runWrangler(args) {
          wranglerCalls.push(args);
          writeFileSync(join(outputDirectory, "README.md"), "Wrangler output\n");
          writeFileSync(join(outputDirectory, "index.js"), workerBundleContents);
          writeFileSync(join(outputDirectory, "index.js.map"), "{}\n");
        }
      },
      outputDirectory,
      sourceRevision: "a".repeat(40),
      clientBuildDigest: "b".repeat(64)
    });
    assert.equal(candidate.bundlePath, join(outputDirectory, "index.js"));
    assert.equal(candidate.workerRuntimeDigest, workerRuntimeDigest);
    assert.deepEqual(wranglerCalls, [workerCandidateBuildArgs(outputDirectory)]);
    assert.deepEqual(
      candidate.clientOutputIdentity,
      captureClientOutputIdentity(candidate.clientDirectory)
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("minified Worker candidate identity is stable across release roots", async () => {
  const fixtureRoot = temporaryRoot("surf-release-worker-roots-");
  try {
    const surfRoot = resolve(import.meta.dirname, "../..");
    const buildAt = (name) => {
      const releaseRoot = join(fixtureRoot, name);
      const sourceDirectory = join(releaseRoot, "src");
      const outputDirectory = join(releaseRoot, "output");
      const configPath = join(releaseRoot, "wrangler.jsonc");
      mkdirSync(sourceDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(outputDirectory, { mode: 0o700 });
      writeFileSync(
        join(sourceDirectory, "message.ts"),
        'export const message = "stable";\n',
        { mode: 0o600 }
      );
      writeFileSync(
        join(sourceDirectory, "index.ts"),
        [
          'import { message } from "./message";',
          "export class ForecastBriefAgent {",
          "  label() {",
          "    return message;",
          "  }",
          "}",
          "export default {",
          "  fetch() {",
          "    return new Response(message);",
          "  }",
          "};",
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            name: "surf-release-root-identity-test",
            main: "./src/index.ts",
            compatibility_date: "2026-07-08"
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
      const result = spawnSync(
        "pnpm",
        [
          "--filter",
          "@surf/web",
          "exec",
          "wrangler",
          ...workerCandidateBuildArgs(outputDirectory),
          "--config",
          configPath
        ],
        {
          cwd: surfRoot,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            CI: "true",
            CLOUDFLARE_ACCOUNT_ID: "",
            CLOUDFLARE_API_TOKEN: "",
            WRANGLER_LOG_PATH: join(releaseRoot, "wrangler.log"),
            WRANGLER_SEND_METRICS: "false"
          }
        }
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(result.error, undefined, output);
      assert.equal(result.status, 0, output);
      assert.deepEqual(readdirSync(outputDirectory).sort(), [
        "README.md",
        "index.js",
        "index.js.map"
      ]);
      return Object.freeze({
        releaseRoot,
        bundle: readFileSync(join(outputDirectory, "index.js"))
      });
    };

    const first = buildAt("first-release-root");
    const second = buildAt("second-release-root");
    assert.deepEqual(first.bundle, second.bundle);
    const bundleText = first.bundle.toString("utf8");
    assert.equal(bundleText.includes(first.releaseRoot), false);
    assert.equal(bundleText.includes(second.releaseRoot), false);
    const runtime = await import(
      `data:text/javascript;base64,${first.bundle.toString("base64")}`
    );
    assert.deepEqual(Object.keys(runtime).sort(), [
      "ForecastBriefAgent",
      "default"
    ]);
    assert.equal(new runtime.ForecastBriefAgent().label(), "stable");
    assert.equal(await runtime.default.fetch().text(), "stable");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("candidate build rejects extra and missing runtime output", () => {
  for (const variation of ["extra", "missing"]) {
    const fixtureRoot = temporaryRoot(`surf-release-candidate-${variation}-`);
    try {
      const outputDirectory = join(fixtureRoot, "output");
      installClientOutput(fixtureRoot);
      assert.throws(
        () =>
          buildWorkerCandidate({
            context: {
              releaseRoot: fixtureRoot,
              runPnpm() {},
              runWrangler() {
                writeFileSync(join(outputDirectory, "README.md"), "Wrangler output\n");
                writeFileSync(join(outputDirectory, "index.js"), workerBundleContents);
                if (variation !== "missing") {
                  writeFileSync(join(outputDirectory, "index.js.map"), "{}\n");
                }
                if (variation === "extra") {
                  writeFileSync(join(outputDirectory, "chunk.js"), "export {};\n");
                }
              }
            },
            outputDirectory,
            sourceRevision: "a".repeat(40),
            clientBuildDigest: "b".repeat(64)
          }),
        /must contain exactly README\.md, index\.js, index\.js\.map/
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("candidate build rejects a symlinked runtime output file", () => {
  const fixtureRoot = temporaryRoot("surf-release-candidate-link-");
  try {
    const outputDirectory = join(fixtureRoot, "output");
    installClientOutput(fixtureRoot);
    assert.throws(
      () =>
        buildWorkerCandidate({
          context: {
            releaseRoot: fixtureRoot,
            runPnpm() {},
            runWrangler() {
              writeFileSync(join(outputDirectory, "README.md"), "Wrangler output\n");
              writeFileSync(join(outputDirectory, "index.js"), workerBundleContents);
              symlinkSync("README.md", join(outputDirectory, "index.js.map"));
            }
          },
          outputDirectory,
          sourceRevision: "a".repeat(40),
          clientBuildDigest: "b".repeat(64)
        }),
      /index\.js\.map must be a regular non-symlink file/
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("candidate build rejects a symlinked output parent", () => {
  const fixtureRoot = temporaryRoot("surf-release-candidate-parent-link-");
  try {
    installClientOutput(fixtureRoot);
    mkdirSync(join(fixtureRoot, "canonical-output-parent"));
    symlinkSync(
      "canonical-output-parent",
      join(fixtureRoot, "aliased-output-parent")
    );
    const outputDirectory = join(fixtureRoot, "aliased-output-parent/output");
    assert.throws(
      () =>
        buildWorkerCandidate({
          context: {
            releaseRoot: fixtureRoot,
            runPnpm() {},
            runWrangler() {
              writeFileSync(join(outputDirectory, "README.md"), "Wrangler output\n");
              writeFileSync(join(outputDirectory, "index.js"), workerBundleContents);
              writeFileSync(join(outputDirectory, "index.js.map"), "{}\n");
            }
          },
          outputDirectory,
          sourceRevision: "a".repeat(40),
          clientBuildDigest: "b".repeat(64)
        }),
      /output path must be canonical and contain no symlinks/
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Wrangler no-bundle dry-run preserves the exact planned runtime module", () => {
  const fixtureRoot = temporaryRoot("surf-release-wrangler-upload-");
  try {
    const surfRoot = resolve(import.meta.dirname, "../..");
    const assetsDirectory = join(fixtureRoot, "assets");
    const outputDirectory = join(fixtureRoot, "output");
    const fixtureBundlePath = join(fixtureRoot, "index.js");
    const fixtureSourceMapPath = join(fixtureRoot, "index.js.map");
    const configPath = join(fixtureRoot, "wrangler.jsonc");
    mkdirSync(assetsDirectory, { mode: 0o700 });
    mkdirSync(outputDirectory, { mode: 0o700 });
    writeFileSync(join(assetsDirectory, "index.html"), "<!doctype html><p>surf</p>\n", {
      mode: 0o600
    });
    const productionLikeBundle = `${workerBundleContents}//# sourceMappingURL=index.js.map\n`;
    writeFileSync(fixtureBundlePath, productionLikeBundle, { mode: 0o600 });
    writeFileSync(
      fixtureSourceMapPath,
      `${JSON.stringify({
        version: 3,
        sources: ["worker/index.ts"],
        names: [],
        mappings: ""
      })}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          name: "surf-release-upload-test",
          main: fixtureBundlePath,
          compatibility_date: "2026-07-08",
          assets: {
            directory: assetsDirectory,
            binding: "ASSETS",
            run_worker_first: ["/api/*"]
          },
          vars: { RELEASE_CONFIG_SENTINEL: "retained" }
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "@surf/web",
        "exec",
        "wrangler",
        "versions",
        "upload",
        fixtureBundlePath,
        "--no-bundle",
        "--dry-run",
        "--outdir",
        outputDirectory,
        "--config",
        configPath
      ],
      {
        cwd: surfRoot,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CI: "true",
          CLOUDFLARE_ACCOUNT_ID: "",
          CLOUDFLARE_API_TOKEN: "",
          WRANGLER_LOG_PATH: join(fixtureRoot, "wrangler.log"),
          WRANGLER_SEND_METRICS: "false"
        }
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 0, output);
    assert.match(output, /env\.ASSETS\s+Assets/);
    assert.match(output, /env\.RELEASE_CONFIG_SENTINEL \("retained"\)/);
    assert.deepEqual(readdirSync(outputDirectory).sort(), [
      "README.md",
      "assets",
      "index.js"
    ]);
    assert.deepEqual(readdirSync(join(outputDirectory, "assets")).sort(), [
      "index.html"
    ]);
    assert.equal(
      readFileSync(join(outputDirectory, "assets/index.html"), "utf8"),
      "<!doctype html><p>surf</p>\n"
    );
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(outputDirectory, "index.js")))
        .digest("hex"),
      createHash("sha256").update(productionLikeBundle).digest("hex")
    );
    assert.deepEqual(
      readFileSync(join(outputDirectory, "index.js")),
      readFileSync(fixtureBundlePath)
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
    ["environment", "production"],
    ["dispatch_namespace", "tenant-dispatch"],
    ["future_capability", true]
  ]) {
    const uploaded = context([], []);
    const original = uploaded.runWrangler;
    uploaded.runWrangler = (args) => {
      const output = original(args);
      if (
        args[0] !== "versions" ||
        args[1] !== "view" ||
        args[2] !== target
      ) {
        return output;
      }
      const version = JSON.parse(output);
      version.resources.bindings.find(
        (binding) => binding.name === "FORECAST_BRIEF_AGENT"
      )[field] = value;
      return JSON.stringify(version);
    };
    assert.throws(
      () => operations(uploaded).upload(),
      /Worker version Durable Object binding FORECAST_BRIEF_AGENT must contain exactly class_name, name, namespace_id, type/
    );
  }

  for (const namespaceId of [
    null,
    "f".repeat(31),
    "g".repeat(32),
    "e".repeat(32)
  ]) {
    const uploaded = context([], []);
    const original = uploaded.runWrangler;
    uploaded.runWrangler = (args) => {
      const output = original(args);
      if (
        args[0] !== "versions" ||
        args[1] !== "view" ||
        args[2] !== target
      ) {
        return output;
      }
      const version = JSON.parse(output);
      const binding = version.resources.bindings.find(
        (candidate) => candidate.name === "FORECAST_BRIEF_AGENT"
      );
      if (namespaceId === null) delete binding.namespace_id;
      else binding.namespace_id = namespaceId;
      return JSON.stringify(version);
    };
    assert.throws(
      () => operations(uploaded).upload(),
      namespaceId === null
        ? /Worker version Durable Object binding FORECAST_BRIEF_AGENT must contain exactly class_name, name, namespace_id, type/
        : namespaceId === "e".repeat(32)
          ? /Worker version Durable Object namespace identity mismatch for FORECAST_BRIEF_AGENT/
          : /Worker version Durable Object binding FORECAST_BRIEF_AGENT\.namespace_id is invalid/
    );
  }
});

test("routine upload rejects a local Durable Object absent from the predecessor", () => {
  const calls = [];
  const instance = context([], calls);
  const original = instance.runWrangler;
  instance.runWrangler = (args) => {
    const output = original(args);
    if (
      args[0] !== "versions" ||
      args[1] !== "view" ||
      args[2] !== predecessor
    ) {
      return output;
    }
    const version = JSON.parse(output);
    version.resources.bindings = version.resources.bindings.filter(
      (binding) => binding.name !== "FORECAST_BRIEF_AGENT"
    );
    return JSON.stringify(version);
  };
  assert.throws(
    () => operations(instance).upload(),
    /Predecessor Worker version binding mismatch for FORECAST_BRIEF_AGENT/
  );
  assert.equal(
    calls.some(
      (call) =>
        call[0] === "wrangler" &&
        call[1] === "versions" &&
        call[2] === "upload"
    ),
    false
  );
});

test("predecessor Durable Object identity rejects cross-script capabilities", () => {
  for (const [field, value] of [
    ["script_name", "different-worker"],
    ["environment", "production"],
    ["dispatch_namespace", "tenant-dispatch"],
    ["future_capability", true]
  ]) {
    const calls = [];
    const instance = context([], calls);
    const original = instance.runWrangler;
    instance.runWrangler = (args) => {
      const output = original(args);
      if (
        args[0] !== "versions" ||
        args[1] !== "view" ||
        args[2] !== predecessor
      ) {
        return output;
      }
      const version = JSON.parse(output);
      version.resources.bindings.find(
        (binding) => binding.name === "FORECAST_BRIEF_AGENT"
      )[field] = value;
      return JSON.stringify(version);
    };
    assert.throws(
      () => operations(instance).upload(),
      /Predecessor Worker version Durable Object binding FORECAST_BRIEF_AGENT must contain exactly class_name, name, namespace_id, type/
    );
    assert.equal(
      calls.some(
        (call) =>
          call[0] === "wrangler" &&
          call[1] === "versions" &&
          call[2] === "upload"
      ),
      false
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
  const releaseRoot = temporaryRoot("surf-release-seed-");
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

test("generation reconciliation treats an intervening cron lineage as target-absent", async () => {
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
            generationId: `sha256:${"b".repeat(64)}:ingest:scheduled-ingest`,
            ingestId: "scheduled-ingest",
            generatedAt: "2026-08-15T20:17:00.000Z",
            materializedAt: "2026-08-15T20:18:00.000Z"
          }))
        },
        { headers }
      );
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const ops = operations(context([], calls), fetcher);
  assert.equal(await ops.inspectGeneration(target, notBefore), null);
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
