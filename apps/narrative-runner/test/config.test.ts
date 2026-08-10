import { describe, expect, it } from "vitest";
import { loadRunnerConfig, redactedConfigSummary } from "../src/config";

function validEnv(): NodeJS.ProcessEnv {
  return {
    NARRATIVE_RUNNER_ID: "macbook-runner",
    NARRATIVE_RUNNER_RELEASE_SHA: "a".repeat(40),
    NARRATIVE_RUNNER_STATUS_HMAC_KEY: "h".repeat(64),
    NARRATIVE_RUNNER_CF_API_BASE_URL: "https://api.cloudflare.com/client/v4",
    NARRATIVE_RUNNER_CF_ACCOUNT_ID: "account-id",
    NARRATIVE_RUNNER_CF_QUEUE_ID: "queue-id",
    NARRATIVE_RUNNER_CF_QUEUE_NAME: "surf-narrative",
    NARRATIVE_RUNNER_CF_DLQ_NAME: "surf-narrative-dlq",
    NARRATIVE_RUNNER_CF_API_TOKEN: "queue-secret",
    NARRATIVE_RUNNER_OMLX_BASE_URL: "http://127.0.0.1:8000/v1",
    NARRATIVE_RUNNER_OMLX_MODEL: "local-model",
    NARRATIVE_RUNNER_TARGET_MAP_JSON: JSON.stringify({
      "surf.analysis.v5": {
        url: "https://surf.example/api/internal/narratives/results",
        tokenEnv: "SURF_RESULT_TOKEN"
      }
    }),
    SURF_RESULT_TOKEN: "result-secret"
  };
}

describe("runner runtime configuration", () => {
  const load = (env = validEnv(), expectedReleaseSha = env.NARRATIVE_RUNNER_RELEASE_SHA!) =>
    loadRunnerConfig(env, expectedReleaseSha);

  it("keeps callback credentials behind the runtime logical-target map", () => {
    const config = load();
    expect(config.targets.get("surf.analysis.v5")).toEqual({
      url: "https://surf.example/api/internal/narratives/results",
      token: "result-secret"
    });
    const summary = redactedConfigSummary(config);
    expect(summary).toMatchObject({
      runnerId: "macbook-runner",
      releaseSha: "a".repeat(40),
      runtimeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      modelId: "local-model",
      queueName: "surf-narrative",
      queueDeadLetterName: "surf-narrative-dlq",
      omlxThinkingEnabled: false,
      concurrency: 1,
      targetIds: ["surf.analysis.v5"]
    });
    expect(config.idleMaxMs).toBe(120_000);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("queue-secret");
    expect(serialized).not.toContain("result-secret");
    expect(serialized).not.toContain("surf.example");
  });

  it("changes the secret-safe runtime fingerprint across credential or release rotation", () => {
    const baseline = load();
    const queueRotated = validEnv();
    queueRotated.NARRATIVE_RUNNER_CF_API_TOKEN = "z".repeat(64);
    const targetRotated = validEnv();
    targetRotated.SURF_RESULT_TOKEN = "y".repeat(64);
    const releaseRotated = validEnv();
    releaseRotated.NARRATIVE_RUNNER_RELEASE_SHA = "c".repeat(40);

    for (const candidate of [queueRotated, targetRotated, releaseRotated]) {
      expect(load(candidate).runtimeFingerprint).not.toBe(
        baseline.runtimeFingerprint
      );
    }
  });

  it("binds the runner environment release to the immutable launch argument", () => {
    const mismatch = validEnv();
    expect(() => load(mismatch, "b".repeat(40))).toThrow(
      /must equal the immutable expected release SHA/
    );
    expect(() => load(mismatch, "")).toThrow(/expected release argument/);
  });

  it("requires an explicit expected Queue name for the ID-to-name preflight", () => {
    const env = validEnv();
    delete env.NARRATIVE_RUNNER_CF_QUEUE_NAME;
    expect(() => load(env)).toThrow(
      /Missing required runtime setting NARRATIVE_RUNNER_CF_QUEUE_NAME/
    );
  });

  it("requires an explicit expected DLQ name for the Queue topology preflight", () => {
    const env = validEnv();
    delete env.NARRATIVE_RUNNER_CF_DLQ_NAME;
    expect(() => load(env)).toThrow(
      /Missing required runtime setting NARRATIVE_RUNNER_CF_DLQ_NAME/
    );
  });

  it("pins the production Cloudflare API origin and path exactly", () => {
    for (const apiBaseUrl of [
      "https://api.cloudflare.com",
      "https://api.cloudflare.com/client/v4/",
      "https://api.cloudflare.com/client/v4?account=other",
      "https://cloudflare.example/client/v4",
      "http://127.0.0.1:8787/client/v4"
    ]) {
      const env = validEnv();
      env.NARRATIVE_RUNNER_CF_API_BASE_URL = apiBaseUrl;
      expect(() => load(env)).toThrow(
        /must be exactly https:\/\/api\.cloudflare\.com\/client\/v4/
      );
    }
  });

  it("disables hidden oMLX reasoning by default and requires explicit boolean opt-in", () => {
    expect(load().omlx.enableThinking).toBe(false);
    const enabled = validEnv();
    enabled.NARRATIVE_RUNNER_OMLX_ENABLE_THINKING = "true";
    expect(load(enabled).omlx.enableThinking).toBe(true);
    enabled.NARRATIVE_RUNNER_OMLX_ENABLE_THINKING = "sometimes";
    expect(() => load(enabled)).toThrow(/must be either true or false/);
  });

  it("permits plaintext oMLX only on loopback", () => {
    const env = validEnv();
    env.NARRATIVE_RUNNER_OMLX_BASE_URL = "http://studio.lan:8000/v1";
    expect(() => load(env)).toThrow(/HTTPS or loopback HTTP/);
  });

  it("permits local Wrangler callbacks on loopback but rejects remote plaintext targets", () => {
    const local = validEnv();
    local.NARRATIVE_RUNNER_TARGET_MAP_JSON = JSON.stringify({
      "surf.analysis.v5": {
        url: "http://127.0.0.1:8787/api/internal/narratives/results",
        tokenEnv: "SURF_RESULT_TOKEN"
      }
    });
    expect(load(local).targets.get("surf.analysis.v5")?.url).toBe(
      "http://127.0.0.1:8787/api/internal/narratives/results"
    );

    const remote = validEnv();
    remote.NARRATIVE_RUNNER_TARGET_MAP_JSON = JSON.stringify({
      "surf.analysis.v5": {
        url: "http://worker.lan:8787/api/internal/narratives/results",
        tokenEnv: "SURF_RESULT_TOKEN"
      }
    });
    expect(() => load(remote)).toThrow(/HTTPS or loopback HTTP/);
  });

  it("requires the separately named token for every target", () => {
    const env = validEnv();
    delete env.SURF_RESULT_TOKEN;
    expect(() => load(env)).toThrow(
      /Missing required runtime setting SURF_RESULT_TOKEN/
    );
  });

  it("requires lease visibility to cover inference, submission, and margin", () => {
    const env = validEnv();
    env.NARRATIVE_RUNNER_OMLX_TIMEOUT_MS = "10000";
    env.NARRATIVE_RUNNER_RESULT_TIMEOUT_MS = "5000";
    env.NARRATIVE_RUNNER_QUEUE_TIMEOUT_MS = "1000";
    env.NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS = "20999";
    expect(() => load(env)).toThrow(/Queue settlement/);
    env.NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS = "21000";
    expect(() => load(env)).not.toThrow();
  });
});
