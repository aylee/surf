import type { SourceFetch } from "../adapters/types";
import { errorMessage } from "../adapters/types";
import type {
  ArtifactPersistenceResult,
  CaptureBuffer,
  SourceRunRecord
} from "./types";

import {
  RAW_ARTIFACT_RETENTION_DAYS,
  RAW_ARTIFACT_METADATA_RETENTION_DAYS,
  RAW_CAPTURE_BATCH_LIMIT_BYTES,
  RAW_CAPTURE_MAX_RESPONSES,
  rawArtifactsAvailableUntil,
  rawArtifactMetadataExpiresAt
} from "./raw-policy";

const DEFAULT_RAW_CAPTURE_LIMIT_BYTES = RAW_CAPTURE_BATCH_LIMIT_BYTES;
export const CDIP_RAW_CAPTURE_LIMIT_BYTES = 64 * 1024;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function arrayBufferWithLimit(
  response: Response,
  maxBytes: number,
  budget: { bytes: number }
): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void response.body?.cancel("raw capture limit exceeded").catch(() => {});
    throw new Error(`response Content-Length ${contentLength} exceeds ${maxBytes}-byte raw capture limit`);
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let complete = false;
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("raw capture exceeded 5000ms deadline")), 5000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes ||
          budget.bytes + value.byteLength > RAW_CAPTURE_BATCH_LIMIT_BYTES) {
        throw new Error(`stream exceeds raw capture byte budget (${maxBytes} per response, ${RAW_CAPTURE_BATCH_LIMIT_BYTES} per source batch)`);
      }
      budget.bytes += value.byteLength;
      totalBytes += value.byteLength;
      chunks.push(value);
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    complete = true;
    return combined.buffer;
  } finally {
    clearTimeout(timeout!);
    if (!complete) {
      budget.bytes -= totalBytes;
      // A tee cancellation waits for the original response. The adapter
      // cannot consume that branch until this wrapper returns.
      void reader.cancel("raw capture stopped").catch(() => {});
    } else {
      reader.releaseLock();
    }
  }
}

export function capturingFetcher(
  fetcher: SourceFetch,
  captures: CaptureBuffer,
  maxCaptureBytes = DEFAULT_RAW_CAPTURE_LIMIT_BYTES
): SourceFetch {
  const budget = { bytes: 0 };
  let responses = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetcher(input, init);
    if (response.ok && (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "HEAD") {
      try {
        if (budget.bytes >= RAW_CAPTURE_BATCH_LIMIT_BYTES || responses >= RAW_CAPTURE_MAX_RESPONSES) {
          throw new Error("source batch raw capture budget exhausted");
        }
        responses += 1;
        const body = await arrayBufferWithLimit(response.clone(), maxCaptureBytes, budget);
        captures.items.push({
          requestUrl: requestUrl(input),
          contentType: response.headers.get("content-type") ?? "application/octet-stream",
          capturedAt: new Date().toISOString(),
          body
        });
      } catch (error) {
        captures.errors.push(`${requestUrl(input)} raw capture failed: ${errorMessage(error)}`);
      }
    }
    return response;
  }) as SourceFetch;
}

function safeKeyPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function artifactExtension(contentType: string): string {
  if (contentType.includes("json") || contentType.includes("geo+json")) return "json";
  if (contentType.includes("text")) return "txt";
  return "bin";
}

export async function persistRawArtifacts(
  bucket: R2Bucket,
  db: D1Database,
  run: SourceRunRecord,
  captures: CaptureBuffer,
  _idSuffix: string,
  createdAt: string
): Promise<ArtifactPersistenceResult> {
  const errors = [...captures.errors];
  if (captures.items.length === 0) {
    return { rowsWritten: 0, errors, manifestKey: null, manifestJson: null };
  }
  if (typeof bucket.put !== "function") {
    return {
      rowsWritten: 0,
      errors: [...errors, `${run.sourceId}: R2 binding does not expose put().`],
      manifestKey: null,
      manifestJson: null
    };
  }
  if (typeof db.prepare !== "function") {
    return {
      rowsWritten: 0,
      errors: [...errors, `${run.sourceId}: D1 binding does not expose raw_artifact_captures.`],
      manifestKey: null,
      manifestJson: null
    };
  }

  // The source generation is stable across Queue redelivery; completion time
  // is not. Partition with the generation date so a retry across UTC midnight
  // cannot remap the same artifact IDs to new R2 keys and orphan the old keys.
  const date = run.startedAt.slice(0, 10).replaceAll("-", "/");
  const prefix = `raw/v2/${safeKeyPart(run.sourceId)}/${date}`;
  const availableUntil = rawArtifactsAvailableUntil(run.startedAt);
  const metadataExpiresAt = rawArtifactMetadataExpiresAt(createdAt);
  let storedBytes = 0;
  let reusedArtifacts = 0;
  const artifacts: Array<{
    id: string;
    r2Key: string;
    requestUrl: string;
    contentType: string;
    byteSize: number;
    checksumSha256: string;
    capturedAt: string;
    storedBytes: number;
    contentEncoding: "gzip";
  }> = [];

  const orderedCaptures = (
    await Promise.all(
      captures.items.map(async (capture) => ({
        capture,
        checksumSha256: hex(await crypto.subtle.digest("SHA-256", capture.body))
      }))
    )
  ).sort((left, right) =>
    left.capture.requestUrl.localeCompare(right.capture.requestUrl) ||
    left.capture.contentType.localeCompare(right.capture.contentType) ||
    left.checksumSha256.localeCompare(right.checksumSha256)
  );

  for (const [index, { capture, checksumSha256 }] of orderedCaptures.entries()) {
    try {
      // MIME participates in identity; equal bodies with different MIME types
      // cannot race to change the shared object's download metadata.
      const identity = hex(await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(`${capture.contentType}\n${checksumSha256}`)));
      const r2Key = `${prefix}/${identity}.${artifactExtension(capture.contentType)}.gz`;
      const id = `${run.id}-artifact-${index + 1}`;
      const compressed = await new Response(
        new Response(capture.body).body!.pipeThrough(new CompressionStream("gzip"))
      ).arrayBuffer();
      const stored = await bucket.put(r2Key, compressed, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: capture.contentType, contentEncoding: "gzip" },
        customMetadata: {
          sourceId: run.sourceId,
          schemaVersion: "2",
          checksumSha256,
          availableUntil
        }
      });
      if (stored === null) reusedArtifacts += 1;
      else storedBytes += compressed.byteLength;
      artifacts.push({
        id,
        r2Key,
        requestUrl: capture.requestUrl,
        contentType: capture.contentType,
        byteSize: capture.body.byteLength,
        checksumSha256,
        capturedAt: capture.capturedAt,
        storedBytes: compressed.byteLength,
        contentEncoding: "gzip"
      });
    } catch (error) {
      errors.push(`${run.sourceId} raw artifact ${index + 1}: ${errorMessage(error)}`);
    }
  }

  // Count accepted R2 bytes even when the following D1 metadata write fails.
  console.log(JSON.stringify({
    event: "raw_artifact_storage",
    sourceId: run.sourceId,
    sourceRunId: run.id,
    rawBytes: artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0),
    storedBytes,
    reusedArtifacts,
    artifacts: artifacts.length,
    availableUntil,
    metadataExpiresAt,
    errors: errors.length
  }));

  if (artifacts.length > 0) {
    try {
      await db.prepare(
        `insert into raw_artifact_captures (
          id, source_run_id, source_id, r2_key, content_type,
          byte_size, checksum_sha256, created_at, available_until, metadata_expires_at,
          request_url, captured_at, stored_bytes, content_encoding
        )
        select
          json_extract(item.value, '$.id'), ?, ?,
          json_extract(item.value, '$.r2Key'),
          json_extract(item.value, '$.contentType'),
          json_extract(item.value, '$.byteSize'),
          json_extract(item.value, '$.checksumSha256'), ?, ?, ?,
          json_extract(item.value, '$.requestUrl'),
          json_extract(item.value, '$.capturedAt'),
          json_extract(item.value, '$.storedBytes'), 'gzip'
        from json_each(?) as item
        where 1
        on conflict(id) do update set
          r2_key = excluded.r2_key,
          content_type = excluded.content_type,
          byte_size = excluded.byte_size,
          checksum_sha256 = excluded.checksum_sha256,
          request_url = excluded.request_url,
          captured_at = excluded.captured_at,
          stored_bytes = excluded.stored_bytes,
          available_until = excluded.available_until,
          metadata_expires_at = excluded.metadata_expires_at`
      ).bind(
        run.id,
        run.sourceId,
        createdAt,
        availableUntil,
        metadataExpiresAt,
        JSON.stringify(artifacts)
      ).run();
    } catch (error) {
      errors.push(`${run.sourceId} raw artifact metadata: ${errorMessage(error)}`);
      return { rowsWritten: 0, errors, manifestKey: null, manifestJson: null };
    }
  }

  // D1 already owns the per-run manifest. Keeping another copy in R2 adds
  // objects without helping any live reader. Payloads alone live in R2.
  const manifestJson = JSON.stringify({
    schemaVersion: 2,
    sourceId: run.sourceId,
    sourceRunId: run.id,
    createdAt,
    retentionDays: RAW_ARTIFACT_RETENTION_DAYS,
    metadataRetentionDays: RAW_ARTIFACT_METADATA_RETENTION_DAYS,
    availableUntil,
    metadataExpiresAt,
    artifacts
  });
  return { rowsWritten: artifacts.length, errors, manifestKey: null, manifestJson };
}
