/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { capturingFetcher, persistRawArtifacts } from "./raw-artifacts";
import { pruneRetainedData } from "./retention";
import type { CaptureBuffer, SourceRunRecord } from "./types";

const AT = "2026-11-01T00:17:00.000Z";

async function run(id: string): Promise<SourceRunRecord> {
  await env.DB.prepare(`insert or ignore into sources
    (id, name, type, provider, format, parser_runtime, attribution, refresh_minutes)
    values ('raw-test', 'raw test', 'test', 'test', 'json', 'typescript', 'test', 60)`).run();
  await env.DB.prepare(`insert or ignore into source_runs
    (id, run_key, source_id, run_kind, started_at, status)
    values (?, ?, 'raw-test', 'test', ?, 'success')`).bind(id, id, AT).run();
  return { id, sourceId: "raw-test", startedAt: AT, status: "success", recorded: true,
    rowCount: 0, caveatCount: 0, errorCount: 0, error: null };
}

describe("raw evidence with real workerd R2 and D1", () => {
  it("shares compressed bodies across runs, preserves per-run provenance, and expires only v2 metadata", async () => {
    const captures: CaptureBuffer = { items: [{ requestUrl: "https://provider.test/data",
      contentType: "application/json", capturedAt: AT,
      body: new TextEncoder().encode(JSON.stringify({ forecast: "example ".repeat(1000) })).buffer }], errors: [] };
    const first = await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, await run("raw-first"), captures, "first", AT);
    const manifest = JSON.parse(first.manifestJson!);
    expect(manifest).toMatchObject({ retentionDays: 30, metadataRetentionDays: 35,
      availableUntil: "2026-12-01T00:00:00.000Z", metadataExpiresAt: "2026-12-06T00:17:00.000Z" });
    const key = manifest.artifacts[0].r2Key;
    const object = await env.RAW_ARTIFACTS.get(key);
    expect(object!.httpMetadata).toMatchObject({ contentEncoding: "gzip", contentType: "application/json" });
    expect(object!.size).toBeLessThan(captures.items[0]!.body.byteLength / 2);
    const decompressed = await new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    expect(new Uint8Array(decompressed)).toEqual(new Uint8Array(captures.items[0]!.body));
    const second = await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, await run("raw-second"), captures, "second", AT);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(first.manifestKey).toBeNull();
    expect(JSON.parse(second.manifestJson!).artifacts[0].r2Key).toBe(key);
    // Prove the create-only conditional does not replace immutable evidence.
    const original = await env.RAW_ARTIFACTS.head(key);
    expect(await env.RAW_ARTIFACTS.put(key, "replacement", { onlyIf: new Headers({ "If-None-Match": "*" }) })).toBeNull();
    expect((await env.RAW_ARTIFACTS.head(key))!.etag).toBe(original!.etag);
    const rows = await env.DB.prepare("select source_run_id from raw_artifact_captures where r2_key = ? order by source_run_id").bind(key).all();
    expect(rows.results).toEqual([{ source_run_id: "raw-first" }, { source_run_id: "raw-second" }]);
    await env.DB.prepare("update source_runs set artifact_manifest_json = ? where id = 'raw-first'").bind(first.manifestJson).run();
    await env.DB.prepare(`insert into source_artifacts
      (id, source_run_id, source_id, r2_key, artifact_type, created_at)
      values ('legacy-artifact', 'raw-first', 'raw-test', 'raw/legacy/object.json', 'upstream_response', ?)`).bind(AT).run();
    await env.DB.prepare(`insert into source_artifacts
      (id, source_run_id, source_id, r2_key, artifact_type, created_at)
      values ('known-legacy-artifact', 'raw-second', 'raw-test',
        'raw/coops-tide-predictions/legacy/body.json', 'upstream_response', ?)`).bind(AT).run();
    await env.DB.prepare(`update source_runs set raw_r2_key = ?, artifact_manifest_json = ?, completed_at = ?
      where id = 'raw-second'`).bind("raw/coops-tide-predictions/legacy/manifest.json",
        JSON.stringify({ createdAt: AT }), "2026-11-02T00:17:00.000Z").run();
    await run("raw-unknown");
    await env.DB.prepare(`update source_runs set raw_r2_key = 'raw/unknown/manifest.json',
      artifact_manifest_json = 'not-json', completed_at = ? where id = 'raw-unknown'`).bind(AT).run();
    for (const [id, createdAt, completedAt] of [
      ["raw-bad-number", 123, null],
      ["raw-bad-text", "100", "100"]
    ] as const) {
      await run(id);
      await env.DB.prepare(`update source_runs set raw_r2_key = ?,
        artifact_manifest_json = ?, completed_at = ? where id = ?`)
        .bind(`raw/coops-tide-predictions/${id}/manifest.json`,
          JSON.stringify({ createdAt }), completedAt, id).run();
    }
    // Availability is conservative; references stay through the physical
    // upload-age window plus five days of processing/incident cushion.
    expect((await pruneRetainedData(env.DB, new Date("2026-12-01T00:00:00Z"))).errors).toEqual([]);
    expect(await env.DB.prepare("select count(*) as count from raw_artifact_captures where source_id = 'raw-test'").first())
      .toEqual({ count: 2 });
    expect(await env.DB.prepare("select artifact_manifest_json from source_runs where id = 'raw-first'").first())
      .toEqual({ artifact_manifest_json: first.manifestJson });
    expect(await env.DB.prepare("select count(*) as count from source_artifacts where source_id = 'raw-test'").first())
      .toEqual({ count: 2 });
    expect((await pruneRetainedData(env.DB, new Date("2026-12-06T00:16:59Z"))).errors).toEqual([]);
    expect(await env.DB.prepare("select count(*) as count from raw_artifact_captures where source_id = 'raw-test'").first())
      .toEqual({ count: 2 });
    expect((await pruneRetainedData(env.DB, new Date("2026-12-06T00:17:00Z"))).errors).toEqual([]);
    expect((await env.DB.prepare("select count(*) as count from raw_artifact_captures where source_id = 'raw-test'").first())).toEqual({ count: 0 });
    expect((await env.DB.prepare("select r2_key from source_artifacts where source_id = 'raw-test'").all()).results)
      .toEqual([{ r2_key: "raw/legacy/object.json" }]);
    expect(await env.DB.prepare("select artifact_manifest_json from source_runs where id = 'raw-first'").first())
      .toEqual({ artifact_manifest_json: null });
    // The legacy manifest uses the later actual completion timestamp, rather
    // than an old generation date or its earlier embedded createdAt.
    expect(await env.DB.prepare("select raw_r2_key from source_runs where id = 'raw-second'").first())
      .toEqual({ raw_r2_key: "raw/coops-tide-predictions/legacy/manifest.json" });
    expect((await pruneRetainedData(env.DB, new Date("2026-12-07T00:17:00Z"))).errors).toEqual([]);
    expect(await env.DB.prepare("select raw_r2_key, artifact_manifest_json from source_runs where id = 'raw-second'").first())
      .toEqual({ raw_r2_key: null, artifact_manifest_json: null });
    expect(await env.DB.prepare("select raw_r2_key, artifact_manifest_json from source_runs where id = 'raw-unknown'").first())
      .toEqual({ raw_r2_key: "raw/unknown/manifest.json", artifact_manifest_json: "not-json" });
    for (const id of ["raw-bad-number", "raw-bad-text"]) {
      expect(await env.DB.prepare("select raw_r2_key from source_runs where id = ?").bind(id).first())
        .toEqual({ raw_r2_key: `raw/coops-tide-predictions/${id}/manifest.json` });
    }
    expect(await env.DB.prepare("select count(*) as count from source_runs where source_id = 'raw-test'").first())
      .toEqual({ count: 5 });
    // Local retention is metadata-only; production R2 expiry is an explicit,
    // separately approved lifecycle policy and is never installed by tests.
    expect(await env.RAW_ARTIFACTS.head(key)).not.toBeNull();
  });

  it("does not stall the Workerd tee when an oversized capture is cancelled", async () => {
    const captures: CaptureBuffer = { items: [], errors: [] };
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2])); controller.close();
    } });
    const response = await capturingFetcher(async () => new Response(body), captures, 1)("https://provider.test/large");
    expect((await response.arrayBuffer()).byteLength).toBe(2);
    expect(captures.items).toEqual([]);
    expect(captures.errors).toHaveLength(1);
  }, 1000);
});
