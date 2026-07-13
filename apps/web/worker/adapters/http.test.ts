import { describe, expect, it, vi } from "vitest";
import { PUBLIC_FEED_USER_AGENT, withPublicFeedUserAgent } from "./http";

describe("public feed identity", () => {
  it("overrides adapter headers with the operator-configured identity", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("User-Agent")).toBe(
        "my-surf/1.0 (operator@example.com)"
      );
      return new Response("ok");
    });

    await withPublicFeedUserAgent(fetcher, "my-surf/1.0 (operator@example.com)")(
      "https://example.test",
      { headers: { "User-Agent": "stale default" } }
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses the project identity when no deployment override is configured", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("User-Agent")).toBe(PUBLIC_FEED_USER_AGENT);
      return new Response("ok");
    });

    await withPublicFeedUserAgent(fetcher)("https://example.test");
  });
});
