import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  assertNarrativeSetupDisabled,
  resolveNarrativeDeploySecrets
} from "../lib/deploy-secrets.mjs";

const surfResultUrl = "https://surf.example/api/internal/narratives/results";
let currentReleaseSha = null;

function targetMapLine(options = {}) {
  const targetId = options.targetId ?? "surf.analysis.v5";
  const tokenEnv = options.tokenEnv ?? "SURF_NARRATIVE_RESULT_TOKEN";
  const url = options.url ?? surfResultUrl;
  const releaseSha = options.releaseSha ?? currentReleaseSha ?? "a".repeat(40);
  return `NARRATIVE_RUNNER_CF_DLQ_NAME=surf-narrative-dlq\nNARRATIVE_RUNNER_RELEASE_SHA=${releaseSha}\nNARRATIVE_RUNNER_STATUS_HMAC_KEY=${"h".repeat(64)}\nNARRATIVE_RUNNER_TARGET_MAP_JSON=${JSON.stringify({
    [targetId]: { url, tokenEnv }
  })}\n`;
}

function deployEnvironment(candidate) {
  return {
    SURF_BASE_URL: "https://surf.example",
    SURF_WORKER_SECRETS_FILE: candidate.worker,
    SURF_NARRATIVE_RUNNER_ENV_FILE: candidate.runner,
    SURF_WORKER_SECRETS_SNAPSHOT: candidate.workerSnapshot
  };
}

function enabledConfig(queue = "surf-narrative") {
  return {
    name: "surf",
    vars: { NARRATIVE_ENABLED: "true" },
    queues: {
      producers: [{ binding: "NARRATIVE_QUEUE", queue }]
    }
  };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "surf-deploy-secrets-")));
  const worker = join(root, "worker.env");
  const runner = join(root, "runner.env");
  const workerSnapshot = join(tmpdir(), `surf-worker-secrets-${basename(root)}.json`);
  const resultToken = "r".repeat(64);
  writeFileSync(join(root, ".gitignore"), "worker.env\nrunner.env\nrunner.json\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", ".gitignore"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Deploy Test",
    "-c",
    "user.email=deploy@test.invalid",
    "commit",
    "-qm",
    "release"
  ]);
  const releaseSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  execFileSync("git", ["-C", root, "checkout", "--detach", "-q", releaseSha]);
  currentReleaseSha = releaseSha;
  writeFileSync(
    worker,
    `NARRATIVE_RESULT_TOKEN=${resultToken}\nGEMINI_API_KEY=${"g".repeat(32)}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${resultToken}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  return { root, worker, runner, workerSnapshot, releaseSha };
}

test("disabled narrative deploys do not require a secret file", () => {
  assert.equal(
    resolveNarrativeDeploySecrets({
      config: { vars: { NARRATIVE_ENABLED: "false" } },
      environment: {},
      root: "/unused"
    }),
    null
  );
});

test("initial setup rejects narrative activation before staged deployment", () => {
  assert.throws(
    () => assertNarrativeSetupDisabled("setup", enabledConfig()),
    /Initial setup requires NARRATIVE_ENABLED=false/
  );
  assert.doesNotThrow(() =>
    assertNarrativeSetupDisabled("setup", {
      vars: { NARRATIVE_ENABLED: "false" }
    })
  );
  assert.doesNotThrow(() =>
    assertNarrativeSetupDisabled("deploy", enabledConfig())
  );
});

test("enabled deploys validate the production target and one shared result token", () => {
  const candidate = fixture();
  const resolved = resolveNarrativeDeploySecrets({
      config: enabledConfig(),
      environment: deployEnvironment(candidate),
      root: candidate.root
    });
  assert.equal(resolved.workerSecretsFile, realpathSync(candidate.workerSnapshot));
  assert.match(resolved.receipt.workerSecretsFingerprint, /^[0-9a-f]{64}$/);
  assert.match(resolved.receipt.runnerEnvFingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(resolved.assertUnchanged);
  const pinnedContents = readFileSync(resolved.workerSecretsFile, "utf8");
  writeFileSync(
    candidate.worker,
    `NARRATIVE_RESULT_TOKEN=${"x".repeat(64)}\nGEMINI_API_KEY=${"y".repeat(32)}\n`,
    { mode: 0o600 }
  );
  assert.doesNotThrow(resolved.assertUnchanged);
  assert.equal(readFileSync(resolved.workerSecretsFile, "utf8"), pinnedContents);
});

test("enabled deploys refuse Worker snapshot or runner environment drift", () => {
  const workerDrift = fixture();
  const workerResolved = resolveNarrativeDeploySecrets({
    config: enabledConfig(),
    environment: deployEnvironment(workerDrift),
    root: workerDrift.root
  });
  const changedWorkerSecrets = JSON.parse(
    readFileSync(workerResolved.workerSecretsFile, "utf8")
  );
  changedWorkerSecrets.GEMINI_API_KEY = "x".repeat(32);
  writeFileSync(
    workerResolved.workerSecretsFile,
    `${JSON.stringify(changedWorkerSecrets, null, 2)}\n`,
    { mode: 0o600 }
  );
  assert.throws(workerResolved.assertUnchanged, /deploy input changed/);

  const runnerDrift = fixture();
  const runnerResolved = resolveNarrativeDeploySecrets({
    config: enabledConfig(),
    environment: deployEnvironment(runnerDrift),
    root: runnerDrift.root
  });
  writeFileSync(
    runnerDrift.runner,
    readFileSync(runnerDrift.runner, "utf8").replace(
      "NARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative",
      "NARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative-drift"
    ),
    { mode: 0o600 }
  );
  assert.throws(runnerResolved.assertUnchanged, /deploy input changed/);
});

test("legacy setup retains Worker/runner SHA equality", () => {
  const mismatch = fixture();
  writeFileSync(
    mismatch.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine({ releaseSha: "f".repeat(40) })}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(mismatch),
        root: mismatch.root
      }),
    /Legacy setup requires/
  );

  const branch = fixture();
  execFileSync("git", ["-C", branch.root, "switch", "-q", "-c", "mutable"]);
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(branch),
        root: branch.root
      }),
    /clean detached exact-SHA release worktree/
  );

  const dirty = fixture();
  writeFileSync(join(dirty.root, "untracked.txt"), "dirty\n");
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(dirty),
        root: dirty.root
      }),
    /clean detached exact-SHA release worktree/
  );
});

test("enabled deploys reject permissive modes, mismatched tokens, and reused Queue credentials", () => {
  const permissive = fixture();
  chmodSync(permissive.worker, 0o640);
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(permissive),
        root: permissive.root
      }),
    /mode 0600/
  );

  const mismatch = fixture();
  writeFileSync(
    mismatch.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"x".repeat(64)}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(mismatch),
        root: mismatch.root
      }),
    /must exactly match/
  );

  const reused = fixture();
  const resultToken = "r".repeat(64);
  writeFileSync(
    reused.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${resultToken}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${resultToken}\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(reused),
        root: reused.root
      }),
    /must be distinct/
  );

  const crossRoleReuse = fixture();
  const sharedProviderToken = "s".repeat(64);
  writeFileSync(
    crossRoleReuse.worker,
    `NARRATIVE_RESULT_TOKEN=${sharedProviderToken}\nGEMINI_API_KEY=${sharedProviderToken}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    crossRoleReuse.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${sharedProviderToken}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(crossRoleReuse),
        root: crossRoleReuse.root
      }),
    /NARRATIVE_RESULT_TOKEN and GEMINI_API_KEY must be distinct/
  );
});

test("enabled deploys reject any extra Worker secret", () => {
  const extra = fixture();
  writeFileSync(
    extra.worker,
    `NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nGEMINI_API_KEY=${"g".repeat(32)}\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n`,
    { mode: 0o600 }
  );

  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(extra),
        root: extra.root
      }),
    /must contain exactly/
  );
});

test("enabled deploys compare the effective trimmed token boundary", () => {
  const whitespace = fixture();
  writeFileSync(
    whitespace.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"r".repeat(64)} \n${targetMapLine()}`,
    { mode: 0o600 }
  );

  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(whitespace),
        root: whitespace.root
      }),
    /without surrounding whitespace/
  );
});

test("enabled deploys reject unquoted dotenv comments but accept quoted # tokens", () => {
  const unquoted = fixture();
  writeFileSync(
    unquoted.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}#runtime-would-truncate\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(unquoted),
        root: unquoted.root
      }),
    /contains an unquoted #/
  );

  const quoted = fixture();
  const resultToken = `${"r".repeat(64)}#result`;
  writeFileSync(
    quoted.worker,
    `NARRATIVE_RESULT_TOKEN="${resultToken}"\nGEMINI_API_KEY="${"g".repeat(32)}#gemini"\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    quoted.runner,
    `SURF_NARRATIVE_RESULT_TOKEN="${resultToken}"\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN="${"q".repeat(32)}#queue"\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  const resolved = resolveNarrativeDeploySecrets({
      config: enabledConfig(),
      environment: deployEnvironment(quoted),
      root: quoted.root
    });
  assert.equal(resolved.workerSecretsFile, realpathSync(quoted.workerSnapshot));
  assert.doesNotThrow(resolved.assertUnchanged);
});

test("enabled deploys reject duplicate or malformed dotenv assignments", () => {
  const duplicate = fixture();
  writeFileSync(
    duplicate.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\nNARRATIVE_RUNNER_CF_API_TOKEN=${"z".repeat(32)}\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(duplicate),
        root: duplicate.root
      }),
    /duplicate NARRATIVE_RUNNER_CF_API_TOKEN/
  );

  const malformed = fixture();
  writeFileSync(
    malformed.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nthis is not dotenv\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(malformed),
        root: malformed.root
      }),
    /line 2 is malformed/
  );
});

test("enabled deploys require the runner Queue name to match the active producer", () => {
  const missing = fixture();
  writeFileSync(
    missing.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine()}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(missing),
        root: missing.root
      }),
    /NARRATIVE_RUNNER_CF_QUEUE_NAME must be an exact/
  );

  const mismatch = fixture();
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig("renamed-narrative"),
        environment: deployEnvironment(mismatch),
        root: mismatch.root
      }),
    /must exactly match the active NARRATIVE_QUEUE producer/
  );

  const wrongDlq = fixture();
  writeFileSync(
    wrongDlq.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine().replace("surf-narrative-dlq", "wrong-dlq")}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(wrongDlq),
        root: wrongDlq.root
      }),
    /must exactly match the active narrative DLQ/
  );
});

test("enabled deploys reject a JSON runner file that the verified wrapper cannot load", () => {
  const candidate = fixture();
  const runnerJson = join(candidate.root, "runner.json");
  writeFileSync(
    runnerJson,
    JSON.stringify({
      SURF_NARRATIVE_RESULT_TOKEN: "r".repeat(64),
      NARRATIVE_RUNNER_CF_QUEUE_NAME: "surf-narrative",
      NARRATIVE_RUNNER_CF_DLQ_NAME: "surf-narrative-dlq",
      NARRATIVE_RUNNER_RELEASE_SHA: candidate.releaseSha,
      NARRATIVE_RUNNER_STATUS_HMAC_KEY: "h".repeat(64),
      NARRATIVE_RUNNER_CF_API_TOKEN: "q".repeat(32),
      NARRATIVE_RUNNER_TARGET_MAP_JSON: JSON.stringify({
        "surf.analysis.v5": {
          url: surfResultUrl,
          tokenEnv: "SURF_NARRATIVE_RESULT_TOKEN"
        }
      })
    }),
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: {
          ...deployEnvironment(candidate),
          SURF_NARRATIVE_RUNNER_ENV_FILE: runnerJson
        },
        root: candidate.root
      }),
    /must be a dotenv file/
  );
});

test("enabled deploy staging rejects process-control and non-runner environment keys", () => {
  for (const [name, value] of [
    ["NODE_OPTIONS", "--require=/tmp/untrusted.cjs"],
    ["HOME", "/tmp/untrusted-home"]
  ]) {
    const candidate = fixture();
    writeFileSync(
      candidate.runner,
      `${readFileSync(candidate.runner, "utf8")}${name}=${value}\n`,
      { mode: 0o600 }
    );
    assert.throws(
      () =>
        resolveNarrativeDeploySecrets({
          config: enabledConfig(),
          environment: deployEnvironment(candidate),
          root: candidate.root
        }),
      new RegExp(`unsupported runner environment setting ${name}`)
    );
    assert.equal(existsSync(candidate.workerSnapshot), false);
  }
});

test("enabled deploy staging rejects extra targets that alias reserved environment keys", () => {
  for (const name of [
    "NODE_OPTIONS",
    "HOME",
    "PATH",
    "NARRATIVE_RUNNER_CF_API_TOKEN"
  ]) {
    const candidate = fixture();
    const targetMap = {
      "surf.analysis.v5": {
        url: surfResultUrl,
        tokenEnv: "SURF_NARRATIVE_RESULT_TOKEN"
      },
      "future.analysis.v1": {
        url: "https://future.example/api/internal/narratives/results",
        tokenEnv: name
      }
    };
    const original = readFileSync(candidate.runner, "utf8").replace(
      /^NARRATIVE_RUNNER_TARGET_MAP_JSON=.*$/m,
      `NARRATIVE_RUNNER_TARGET_MAP_JSON=${JSON.stringify(targetMap)}`
    );
    writeFileSync(
      candidate.runner,
      `${original}${name.startsWith("NARRATIVE_RUNNER_") ? "" : `${name}=reserved-value\n`}`,
      { mode: 0o600 }
    );
    assert.throws(
      () =>
        resolveNarrativeDeploySecrets({
          config: enabledConfig(),
          environment: deployEnvironment(candidate),
          root: candidate.root
        }),
      new RegExp(`unsupported runner target token environment ${name}`)
    );
    assert.equal(existsSync(candidate.workerSnapshot), false);
  }
});

test("enabled deploys reject a typoed current target", () => {
  const candidate = fixture();
  writeFileSync(
    candidate.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine({ targetId: "surf.analysis.v5-typo" })}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(candidate),
        root: candidate.root
      }),
    /must contain surf\.analysis\.v5/
  );
});

test("enabled deploys reject an alternate target token environment", () => {
  const candidate = fixture();
  writeFileSync(
    candidate.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nALTERNATE_RESULT_TOKEN=${"r".repeat(64)}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine({ tokenEnv: "ALTERNATE_RESULT_TOKEN" })}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(candidate),
        root: candidate.root
      }),
    /tokenEnv must be SURF_NARRATIVE_RESULT_TOKEN/
  );
});

test("enabled deploys reject a callback on the wrong origin", () => {
  const candidate = fixture();
  writeFileSync(
    candidate.runner,
    `SURF_NARRATIVE_RESULT_TOKEN=${"r".repeat(64)}\nNARRATIVE_RUNNER_CF_QUEUE_NAME=surf-narrative\nNARRATIVE_RUNNER_CF_API_TOKEN=${"q".repeat(32)}\n${targetMapLine({ url: "https://wrong.example/api/internal/narratives/results" })}`,
    { mode: 0o600 }
  );
  assert.throws(
    () =>
      resolveNarrativeDeploySecrets({
        config: enabledConfig(),
        environment: deployEnvironment(candidate),
        root: candidate.root
      }),
    /expected production Surf origin/
  );
});
