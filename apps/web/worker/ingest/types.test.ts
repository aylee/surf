import { describe, expect, it } from "vitest";
import { ingestRequiresRetry } from "./types";

describe("ingest retry policy", () => {
  it("acks partial results that contain only source caveats", () => {
    expect(ingestRequiresRetry({ status: "partial", errors: [] })).toBe(false);
  });

  it("retries failures and partial results with errors", () => {
    expect(ingestRequiresRetry({ status: "failure", errors: [] })).toBe(true);
    expect(ingestRequiresRetry({ status: "partial", errors: ["provider failed"] })).toBe(true);
  });
});
