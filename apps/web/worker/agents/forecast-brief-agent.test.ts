import { describe, expect, it } from "vitest";
import { retryDelaySecondsAfterFailure } from "./retry-policy";

describe("ForecastBriefAgent retry policy", () => {
  it("uses bounded delayed retries and then exhausts", () => {
    expect(retryDelaySecondsAfterFailure(1)).toBe(5 * 60);
    expect(retryDelaySecondsAfterFailure(2)).toBe(30 * 60);
    expect(retryDelaySecondsAfterFailure(3)).toBe(2 * 60 * 60);
    expect(retryDelaySecondsAfterFailure(4)).toBeNull();
  });
});
