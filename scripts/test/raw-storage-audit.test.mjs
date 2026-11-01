import { test } from "node:test";
import assert from "node:assert/strict";
import { createRawStorageSummary, validateObjectPage } from "../lib/raw-storage-audit.mjs";

const object = (key, at = "2026-10-01T00:00:00Z") => ({ key, size: 100, etag: "etag", last_modified: at,
  custom_metadata: { checksumSha256: "a".repeat(64), sourceId: "test" }, http_metadata: { contentType: "application/json" } });

test("pagination rejects repeated/unordered keys and metadata outside the requested prefix", () => {
  const options = { prefix: "raw/", after: "raw/a" };
  assert.throws(() => validateObjectPage([object("raw/a")], options));
  assert.throws(() => validateObjectPage([object("raw/c"), object("raw/b")], options));
  assert.throws(() => validateObjectPage([object("other/b")], options));
  assert.throws(() => validateObjectPage({ objects: [] }, options));
  assert.deepEqual(validateObjectPage([], options), []);
});

test("summaries count exact cutoff, age bounds, duplicate bytes, and preserve incomplete status", () => {
  const summary = createRawStorageSummary({ bucket: "test", prefix: "raw/", before: "2026-10-25T00:00:00Z" });
  for (const value of [object("raw/test/2026/10/01/a"), object("raw/test/2026/10/25/b", "2026-10-25T00:00:00Z")]) {
    summary.add(value, JSON.stringify(value) + "\n");
  }
  const result = summary.finish({ complete: false, pages: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.count, 2); assert.equal(result.bytes, 200);
  assert.equal(result.selectedCount, 1); assert.equal(result.selectedBytes, 100);
  assert.equal(result.duplicateBytes, 100);
  assert.equal(result.oldest, "2026-10-01T00:00:00.000Z");
  assert.equal(result.newest, "2026-10-25T00:00:00.000Z");
  assert.match(result.inventorySha256, /^[a-f0-9]{64}$/);
});
