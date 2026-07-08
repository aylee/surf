import { describe, expect, it } from "vitest";
import type { Env } from "./index";
import worker from "./index";

function env(): Env {
  return {
    ENVIRONMENT: "test",
    SURF_REGION: "norcal",
    REPORT_AGENT_ENABLED: "false",
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    DB: {} as D1Database,
    RAW_ARTIFACTS: {} as R2Bucket,
    CACHE: {} as KVNamespace,
    INGEST_QUEUE: { send: async () => undefined } as unknown as Queue
  };
}

describe("worker api", () => {
  it("returns health", async () => {
    const request = new Request("http://surf.test/api/health") as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "surf" });
  });

  it("returns v1 spots", async () => {
    const request = new Request("http://surf.test/api/spots") as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, env(), {} as ExecutionContext);
    const body = (await response.json()) as { spots: unknown[] };
    expect(body.spots).toHaveLength(6);
  });
});
