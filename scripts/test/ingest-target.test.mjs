import assert from "node:assert/strict";
import test from "node:test";
import { resolveIngestTarget } from "../lib/ingest-target.mjs";

test("local ingest ignores ambient production configuration", () => {
  assert.deepEqual(
    resolveIngestTarget("--local", {
      SURF_BASE_URL: "https://production.example",
      SURF_INGEST_TOKEN: "production-secret"
    }),
    { baseUrl: "http://127.0.0.1:8787", token: undefined }
  );
});

test("remote ingest requires and normalizes an explicit HTTPS origin", () => {
  assert.deepEqual(
    resolveIngestTarget("--remote", {
      SURF_BASE_URL: "https://surf.example/",
      SURF_INGEST_TOKEN: "secret"
    }),
    { baseUrl: "https://surf.example", token: "secret" }
  );
  assert.throws(
    () =>
      resolveIngestTarget("--remote", {
        SURF_BASE_URL: "https://surf.example/path",
        SURF_INGEST_TOKEN: "secret"
      }),
    /bare HTTPS origin/
  );
  assert.throws(
    () =>
      resolveIngestTarget("--remote", {
        SURF_BASE_URL: "http://surf.example",
        SURF_INGEST_TOKEN: "secret"
      }),
    /https:\/\//
  );
});
