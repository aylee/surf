import type { SourceFetch } from "../adapters/types";
import { errorMessage } from "../adapters/types";
import type {
  ArtifactPersistenceResult,
  CaptureBuffer,
  SourceRunRecord
} from "./types";

const DEFAULT_RAW_CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
export const CDIP_RAW_CAPTURE_LIMIT_BYTES = 64 * 1024;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function arrayBufferWithLimit(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`response Content-Length ${contentLength} exceeds ${maxBytes}-byte raw capture limit`);
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("raw capture limit exceeded");
      throw new Error(`stream exceeds ${maxBytes}-byte raw capture limit`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

export function capturingFetcher(
  fetcher: SourceFetch,
  captures: CaptureBuffer,
  maxCaptureBytes = DEFAULT_RAW_CAPTURE_LIMIT_BYTES
): SourceFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetcher(input, init);
    if (response.ok && (init?.method ?? "GET").toUpperCase() !== "HEAD") {
      try {
        const clone = response.clone();
        captures.items.push({
          requestUrl: requestUrl(input),
          contentType: clone.headers.get("content-type") ?? "application/octet-stream",
          capturedAt: new Date().toISOString(),
          body: await arrayBufferWithLimit(clone, maxCaptureBytes)
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
  idSuffix: string,
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
      errors: [...errors, `${run.sourceId}: D1 binding does not expose source_artifacts.`],
      manifestKey: null,
      manifestJson: null
    };
  }

  const date = createdAt.slice(0, 10).replaceAll("-", "/");
  const prefix = `raw/${safeKeyPart(run.sourceId)}/${date}/${safeKeyPart(idSuffix)}`;
  const artifacts: Array<{
    id: string;
    r2Key: string;
    requestUrl: string;
    contentType: string;
    byteSize: number;
    checksumSha256: string;
    capturedAt: string;
  }> = [];

  for (const [index, capture] of captures.items.entries()) {
    try {
      const checksumSha256 = hex(await crypto.subtle.digest("SHA-256", capture.body));
      const r2Key = `${prefix}/${String(index + 1).padStart(2, "0")}-${checksumSha256.slice(0, 12)}.${artifactExtension(capture.contentType)}`;
      const id = `${run.id}-artifact-${index + 1}`;
      await bucket.put(r2Key, capture.body, {
        httpMetadata: { contentType: capture.contentType },
        customMetadata: {
          sourceId: run.sourceId,
          sourceRunId: run.id,
          requestUrl: capture.requestUrl,
          checksumSha256
        }
      });
      await db
        .prepare(
          `insert into source_artifacts (
            id, source_run_id, source_id, r2_key, artifact_type, content_type,
            byte_size, checksum_sha256, created_at, metadata_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            r2_key = excluded.r2_key,
            content_type = excluded.content_type,
            byte_size = excluded.byte_size,
            checksum_sha256 = excluded.checksum_sha256,
            metadata_json = excluded.metadata_json`
        )
        .bind(
          id,
          run.id,
          run.sourceId,
          r2Key,
          "upstream_response",
          capture.contentType,
          capture.body.byteLength,
          checksumSha256,
          createdAt,
          JSON.stringify({ requestUrl: capture.requestUrl, capturedAt: capture.capturedAt })
        )
        .run();
      artifacts.push({
        id,
        r2Key,
        requestUrl: capture.requestUrl,
        contentType: capture.contentType,
        byteSize: capture.body.byteLength,
        checksumSha256,
        capturedAt: capture.capturedAt
      });
    } catch (error) {
      errors.push(`${run.sourceId} raw artifact ${index + 1}: ${errorMessage(error)}`);
    }
  }

  const manifestJson = JSON.stringify({
    sourceId: run.sourceId,
    sourceRunId: run.id,
    createdAt,
    artifacts
  });
  const manifestKey = `${prefix}/manifest.json`;
  try {
    await bucket.put(manifestKey, manifestJson, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sourceId: run.sourceId, sourceRunId: run.id }
    });
  } catch (error) {
    errors.push(`${run.sourceId} raw manifest: ${errorMessage(error)}`);
    return { rowsWritten: artifacts.length, errors, manifestKey: null, manifestJson: null };
  }

  return {
    rowsWritten: artifacts.length,
    errors,
    manifestKey,
    manifestJson
  };
}
