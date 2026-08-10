import { describe, expect, it } from "vitest";
import { loadRunnerConfig, redactedConfigSummary } from "../src/config";

function validEnv(): NodeJS.ProcessEnv {
  return {
    NARRATIVE_RUNNER_ID: "macbook-runner",
    NARRATIVE_RUNNER_CF_API_BASE_URL: "https://api.cloudflare.com/client/v4",
    NARRATIVE_RUNNER_CF_ACCOUNT_ID: "account-id",
    NARRATIVE_RUNNER_CF_QUEUE_ID: "queue-id",
    NARRATIVE_RUNNER_CF_API_TOKEN: "queue-secret",
    NARRATIVE_RUNNER_OMLX_BASE_URL: "http://127.0.0.1:8000/v1",
    NARRATIVE_RUNNER_OMLX_MODEL: "local-model",
    NARRATIVE_RUNNER_TARGET_MAP_JSON: JSON.stringify({
      "surf.analysis.v3": {
        url: "https://surf.example/api/internal/narratives/results",
        tokenEnv: "SURF_RESULT_TOKEN"
      }
    }),
    SURF_RESULT_TOKEN: "result-secret"
  };
}

describe("runner runtime configuration", () => {
  it("keeps callback credentials behind the runtime logical-target map", () => {
    const config = loadRunnerConfig(validEnv());
    expect(config.targets.get("surf.analysis.v3")).toEqual({
      url: "https://surf.example/api/internal/narratives/results",
      token: "result-secret"
    });
    const summary = redactedConfigSummary(config);
    expect(summary).toMatchObject({
      runnerId: "macbook-runner",
      modelId: "local-model",
      concurrency: 1,
      targetIds: ["surf.analysis.v3"]
    });
    expect(config.idleMaxMs).toBe(600_000);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("queue-secret");
    expect(serialized).not.toContain("result-secret");
    expect(serialized).not.toContain("surf.example");
  });

  it("permits plaintext oMLX only on loopback", () => {
    const env = validEnv();
    env.NARRATIVE_RUNNER_OMLX_BASE_URL = "http://studio.lan:8000/v1";
    expect(() => loadRunnerConfig(env)).toThrow(/HTTPS or loopback HTTP/);
  });

  it("permits local Wrangler callbacks on loopback but rejects remote plaintext targets", () => {
    const local = validEnv();
    local.NARRATIVE_RUNNER_TARGET_MAP_JSON = JSON.stringify({
      "surf.analysis.v3": {
        url: "http://127.0.0.1:8787/api/internal/narratives/results",
        tokenEnv: "SURF_RESULT_TOKEN"
      }
    });
    expect(loadRunnerConfig(local).targets.get("surf.analysis.v3")?.url).toBe(
      "http://127.0.0.1:8787/api/internal/narratives/results"
    );

    const remote = validEnv();
    remote.NARRATIVE_RUNNER_TARGET_MAP_JSON = JSON.stringify({
      "surf.analysis.v3": {
        url: "http://worker.lan:8787/api/internal/narratives/results",
        tokenEnv: "SURF_RESULT_TOKEN"
      }
    });
    expect(() => loadRunnerConfig(remote)).toThrow(/HTTPS or loopback HTTP/);
  });

  it("requires the separately named token for every target", () => {
    const env = validEnv();
    delete env.SURF_RESULT_TOKEN;
    expect(() => loadRunnerConfig(env)).toThrow(
      /Missing required runtime setting SURF_RESULT_TOKEN/
    );
  });

  it("requires lease visibility to cover inference, submission, and margin", () => {
    const env = validEnv();
    env.NARRATIVE_RUNNER_OMLX_TIMEOUT_MS = "10000";
    env.NARRATIVE_RUNNER_RESULT_TIMEOUT_MS = "5000";
    env.NARRATIVE_RUNNER_QUEUE_TIMEOUT_MS = "1000";
    env.NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS = "20999";
    expect(() => loadRunnerConfig(env)).toThrow(/Queue settlement/);
    env.NARRATIVE_RUNNER_VISIBILITY_TIMEOUT_MS = "21000";
    expect(() => loadRunnerConfig(env)).not.toThrow();
  });
});
