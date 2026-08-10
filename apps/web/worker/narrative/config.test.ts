import { describe, expect, it } from "vitest";
import {
  narrativeEnabled,
  narrativeFallbackConfig,
  NARRATIVE_FALLBACK_MAX_DELAY_SECONDS,
  NARRATIVE_FALLBACK_MAX_DAILY_ATTEMPTS,
  NARRATIVE_FALLBACK_MAX_ROLLING_31_DAY_ATTEMPTS
} from "./config";

function enabledBindings() {
  return {
    NARRATIVE_ENABLED: "true",
    NARRATIVE_QUEUE: {} as Queue,
    NARRATIVE_FALLBACK_QUEUE: {} as Queue,
    NARRATIVE_RESULT_TOKEN: "result-token",
    GEMINI_API_KEY: "gemini-token"
  };
}

describe("narrative fallback config", () => {
  it("requires both Queue routes, callback auth, and Gemini auth", () => {
    expect(narrativeEnabled(enabledBindings())).toBe(true);
    for (const key of [
      "NARRATIVE_QUEUE",
      "NARRATIVE_FALLBACK_QUEUE",
      "NARRATIVE_RESULT_TOKEN",
      "GEMINI_API_KEY"
    ] as const) {
      const bindings = enabledBindings();
      delete bindings[key];
      expect(narrativeEnabled(bindings)).toBe(false);
    }
  });

  it("fails closed above the reviewed cost caps", () => {
    expect(() =>
      narrativeFallbackConfig({
        ...enabledBindings(),
        NARRATIVE_FALLBACK_DAILY_CAP: String(
          NARRATIVE_FALLBACK_MAX_DAILY_ATTEMPTS + 1
        )
      })
    ).toThrow();
    expect(() =>
      narrativeFallbackConfig({
        ...enabledBindings(),
        NARRATIVE_FALLBACK_ROLLING_31_DAY_CAP: String(
          NARRATIVE_FALLBACK_MAX_ROLLING_31_DAY_ATTEMPTS + 1
        )
      })
    ).toThrow();
    expect(() =>
      narrativeFallbackConfig({
        ...enabledBindings(),
        NARRATIVE_FALLBACK_DELAY_SECONDS: String(
          NARRATIVE_FALLBACK_MAX_DELAY_SECONDS + 1
        )
      })
    ).toThrow();
  });
});
