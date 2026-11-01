import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { capturingFetcher, persistRawArtifacts } from "./raw-artifacts";
import { RAW_ARTIFACT_PROVIDER_PREFIXES, RAW_CAPTURE_BATCH_LIMIT_BYTES, rawArtifactsAvailableUntil, rawArtifactMetadataExpiresAt, shouldCaptureRawArtifacts } from "./raw-policy";
import type { CaptureBuffer } from "./types";

describe("bounded raw diagnostic capture", () => {
  it("samples four UTC generations a day and preserves explicit manual diagnosis", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const generation = new Date(`2026-11-01T${String(hour).padStart(2, "0")}:17:00Z`);
      expect(shouldCaptureRawArtifacts("queued-ingest", generation)).toBe(hour % 6 === 0);
      expect(shouldCaptureRawArtifacts("scheduled-ingest", generation)).toBe(hour % 6 === 0);
      expect(shouldCaptureRawArtifacts("manual-ingest", generation)).toBe(true);
    }
  });

  it("keeps 30-day availability and a separate 35-day metadata buffer for delayed writes", () => {
    expect(rawArtifactsAvailableUntil("2026-11-01T18:17:00.000Z"))
      .toBe("2026-12-01T00:00:00.000Z");
    expect(rawArtifactMetadataExpiresAt("2026-11-02T10:30:00.000Z"))
      .toBe("2026-12-07T10:30:00.000Z");
  });

  it("limits the physical 30-day policy to the five known legacy and v2 providers", () => {
    const proposal = JSON.parse(readFileSync(new URL("../../../../docs/raw-storage-lifecycle.proposed.json", import.meta.url), "utf8"));
    const expiryRules = proposal.rules.filter((rule: { deleteObjectsTransition?: unknown }) => rule.deleteObjectsTransition);
    expect(expiryRules.map((rule: { conditions: { prefix: string } }) => rule.conditions.prefix).sort())
      .toEqual(RAW_ARTIFACT_PROVIDER_PREFIXES.flatMap((provider) => [`raw/${provider}/`, `raw/v2/${provider}/`]).sort());
    expect(expiryRules.every((rule: { deleteObjectsTransition: { condition: { type: string; maxAge: number } } }) =>
      rule.deleteObjectsTransition.condition.type === "Age" && rule.deleteObjectsTransition.condition.maxAge === 30 * 86_400)).toBe(true);
    expect(proposal.rules.find((rule: { abortMultipartUploadsTransition?: unknown }) => rule.abortMultipartUploadsTransition)
      .abortMultipartUploadsTransition.condition.maxAge).toBe(7 * 86_400);
  });

  it("returns an oversized tee without waiting for the adapter to consume its original", async () => {
    const captures: CaptureBuffer = { items: [], errors: [] };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      }
    });
    const fetcher = capturingFetcher(async () => new Response(body), captures, 1);
    const response = await fetcher("https://provider.test/oversized");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(captures.items).toEqual([]);
    expect(captures.errors).toHaveLength(1);
  }, 1000);

  it("bounds slow capture without taking ownership of the provider body", async () => {
    vi.useFakeTimers();
    try {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const captures: CaptureBuffer = { items: [], errors: [] };
      const pending = capturingFetcher(async () => new Response(stream), captures)("https://provider.test/slow");
      await vi.advanceTimersByTimeAsync(5001);
      const response = await pending;
      controller.enqueue(new Uint8Array([1]));
      controller.close();
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1]);
      expect(captures.items).toEqual([]);
      expect(captures.errors[0]).toContain("deadline");
    } finally { vi.useRealTimers(); }
  });

  it("shares one memory budget across concurrent responses and still returns every original", async () => {
    const captures: CaptureBuffer = { items: [], errors: [] };
    const bytes = new Uint8Array(300_000);
    const fetcher = capturingFetcher(async () => new Response(bytes), captures);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => fetcher(`https://provider.test/${index}`)));
    expect(await Promise.all(responses.map(async (response) => (await response.arrayBuffer()).byteLength)))
      .toEqual(Array(20).fill(bytes.byteLength));
    expect(captures.items.reduce((sum, capture) => sum + capture.body.byteLength, 0))
      .toBeLessThanOrEqual(RAW_CAPTURE_BATCH_LIMIT_BYTES);
    expect(captures.errors.length).toBeGreaterThan(0);
  });

  it("ignores failed responses and Request-based HEAD responses", async () => {
    const captures: CaptureBuffer = { items: [], errors: [] };
    await capturingFetcher(async () => new Response("upstream failure", { status: 503 }), captures)("https://provider.test/error");
    await capturingFetcher(async () => new Response(null), captures)(new Request("https://provider.test/head", { method: "HEAD" }));
    expect(captures).toEqual({ items: [], errors: [] });
  });
  it("accounts for R2 bytes when D1 metadata fails without advertising a valid manifest", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const captures: CaptureBuffer = { items: [{ requestUrl: "https://provider.test/data",
        contentType: "text/plain", capturedAt: "2026-11-01T00:17:00.000Z",
        body: new TextEncoder().encode("diagnostic".repeat(100)).buffer }], errors: [] };
      const result = await persistRawArtifacts({ put: async () => ({}) } as unknown as R2Bucket,
        { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("metadata unavailable"); } }) }) } as unknown as D1Database,
        { id: "run", sourceId: "test", startedAt: "2026-11-01T00:17:00.000Z", status: "success",
          recorded: true, rowCount: 0, caveatCount: 0, errorCount: 0, error: null },
        captures, "run", "2026-11-01T00:17:00.000Z");
      expect(result).toMatchObject({ rowsWritten: 0, manifestKey: null, manifestJson: null });
      expect(result.errors[0]).toContain("metadata unavailable");
      const metrics = log.mock.calls.map(([entry]) => JSON.parse(String(entry)));
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({ event: "raw_artifact_storage", artifacts: 1, reusedArtifacts: 0 });
      expect(metrics[0].storedBytes).toBeGreaterThan(0);
    } finally { log.mockRestore(); }
  });

});
