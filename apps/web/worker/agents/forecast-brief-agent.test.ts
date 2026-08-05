import { describe, expect, it } from "vitest";
import { compareForecastBriefGeneratedAt } from "./forecast-brief-agent";
import {
  classifyForecastBriefFailure,
  retryDelaySecondsAfterFailure,
  StoredForecastFactBundleError
} from "./retry-policy";

describe("ForecastBriefAgent retry policy", () => {
  it("orders generated-at instants while preserving equal-timestamp revisions", () => {
    expect(
      compareForecastBriefGeneratedAt(
        "2026-08-02T12:59:59.999Z",
        "2026-08-02T13:00:00.000Z"
      )
    ).toBe("older");
    expect(
      compareForecastBriefGeneratedAt(
        "2026-08-02T06:00:00.000-07:00",
        "2026-08-02T13:00:00.000Z"
      )
    ).toBe("equal");
    expect(
      compareForecastBriefGeneratedAt(
        "2026-08-02T13:00:00.001Z",
        "2026-08-02T13:00:00.000Z"
      )
    ).toBe("newer");
    expect(() =>
      compareForecastBriefGeneratedAt("persisted-secret-value", "2026-08-02T13:00:00.000Z")
    ).toThrow("Stored forecast fact bundle is invalid");
  });

  it("uses bounded delayed retries for transient provider failures", () => {
    expect(retryDelaySecondsAfterFailure(1)).toBe(5 * 60);
    expect(retryDelaySecondsAfterFailure(2)).toBe(30 * 60);
    expect(retryDelaySecondsAfterFailure(3)).toBe(2 * 60 * 60);
    expect(retryDelaySecondsAfterFailure(4)).toBeNull();
  });

  it("classifies rate limits, server responses, and network errors as transient", () => {
    expect(
      classifyForecastBriefFailure(Object.assign(new Error("rate limited"), { statusCode: 429 }))
    ).toBe("transient");
    expect(
      classifyForecastBriefFailure(Object.assign(new Error("upstream failed"), { status: 503 }))
    ).toBe("transient");
    expect(classifyForecastBriefFailure(new TypeError("fetch failed"))).toBe("transient");
    expect(
      classifyForecastBriefFailure(
        Object.assign(new Error("provider unavailable"), { isRetryable: true })
      )
    ).toBe("transient");
    expect(
      classifyForecastBriefFailure(Object.assign(new Error("request timeout"), { statusCode: 408 }))
    ).toBe("transient");
    expect(
      classifyForecastBriefFailure(
        Object.assign(new Error("provider conflict"), { statusCode: 409 })
      )
    ).toBe("transient");
    expect(
      classifyForecastBriefFailure(
        Object.assign(new Error("retryable provider response"), {
          statusCode: 400,
          isRetryable: true
        })
      )
    ).toBe("transient");
    expect(classifyForecastBriefFailure(new TypeError("cannot read property of undefined"))).toBe(
      "terminal"
    );
  });

  it("classifies auth and stored-bundle integrity failures as terminal", () => {
    expect(
      classifyForecastBriefFailure(Object.assign(new Error("bad key"), { statusCode: 401 }))
    ).toBe("terminal");
    expect(
      classifyForecastBriefFailure(
        Object.assign(new Error("bad key"), { statusCode: 401, isRetryable: true })
      )
    ).toBe("terminal");
    expect(
      classifyForecastBriefFailure(
        Object.assign(new Error("forbidden"), { response: { status: 403 } })
      )
    ).toBe("terminal");
    expect(
      classifyForecastBriefFailure(new StoredForecastFactBundleError("invalid persisted input"))
    ).toBe("terminal");
    expect(retryDelaySecondsAfterFailure(1, "terminal")).toBeNull();
  });

  it("allows policy and schema quality failures one delayed regeneration at most", () => {
    for (const name of [
      "ForecastBriefPolicyError",
      "ZodError",
      "AI_NoObjectGeneratedError",
      "AI_NoOutputGeneratedError"
    ]) {
      expect(classifyForecastBriefFailure(Object.assign(new Error("invalid output"), { name }))).toBe(
        "regenerable"
      );
    }
    expect(retryDelaySecondsAfterFailure(1, "regenerable")).toBe(5 * 60);
    expect(retryDelaySecondsAfterFailure(2, "regenerable")).toBeNull();
  });
});
