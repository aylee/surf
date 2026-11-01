import { createHash } from "node:crypto";

export function validateObjectPage(value, { prefix, after }) {
  if (!Array.isArray(value)) throw new Error("Expected cf object metadata array; audit is incomplete");
  let previous = after;
  for (const object of value) {
    if (!object || typeof object.key !== "string" || !object.key.startsWith(prefix) ||
        (previous !== undefined && object.key <= previous) ||
        !Number.isSafeInteger(object.size) || object.size < 0 ||
        typeof object.etag !== "string" || !Number.isFinite(Date.parse(object.last_modified))) {
      throw new Error("Invalid, repeated, or unordered object metadata; audit is incomplete");
    }
    previous = object.key;
  }
  return value;
}

export function createRawStorageSummary({ bucket, prefix, before }) {
  const groups = new Map();
  const hashes = new Map();
  let count = 0, bytes = 0, selectedCount = 0, selectedBytes = 0, duplicateBytes = 0;
  let oldest = null, newest = null;
  const inventoryHash = createHash("sha256");
  return {
    add(object, line) {
      inventoryHash.update(line);
      const selected = Date.parse(object.last_modified) < Date.parse(before);
      count += 1; bytes += object.size;
      if (selected) { selectedCount += 1; selectedBytes += object.size; }
      const at = new Date(object.last_modified).toISOString();
      oldest = oldest === null || at < oldest ? at : oldest;
      newest = newest === null || at > newest ? at : newest;
      const match = /^raw\/(?:v2\/)?([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(object.key);
      const groupKey = match ? `${match[1]}/${match[2]}-${match[3]}-${match[4]}` : "other";
      const group = groups.get(groupKey) ?? { count: 0, bytes: 0, selectedCount: 0, selectedBytes: 0 };
      group.count += 1; group.bytes += object.size;
      if (selected) { group.selectedCount += 1; group.selectedBytes += object.size; }
      groups.set(groupKey, group);
      const checksum = object.custom_metadata?.checksumSha256;
      if (typeof checksum === "string" && /^[a-f0-9]{64}$/.test(checksum)) {
        const identity = `${object.custom_metadata.sourceId}\n${object.http_metadata?.contentType}\n${checksum}`;
        if (hashes.has(identity)) duplicateBytes += object.size;
        else hashes.set(identity, object.key);
      }
    },
    finish({ complete, pages, startedAt, finishedAt }) {
      return { schemaVersion: 1, bucket, prefix, before, complete, pages, startedAt, finishedAt,
        count, bytes, oldest, newest, selectedCount, selectedBytes,
        duplicateBytes, duplicateMethod: "Repeated source/MIME/SHA-256 metadata; no payload downloads",
        inventorySha256: inventoryHash.digest("hex"),
        selection: "last_modified strictly before cutoff; inventory is a listing pass, not an atomic snapshot",
        groups: Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) };
    }
  };
}
