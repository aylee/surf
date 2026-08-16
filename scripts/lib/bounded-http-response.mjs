const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function positiveBound(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32 * 1024 * 1024) {
    throw new Error("HTTP response byte bound must be a positive integer no greater than 32 MiB");
  }
  return value;
}

function labelText(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error("HTTP response label is invalid");
  }
  return value;
}

async function cancel(reader) {
  try {
    await reader.cancel();
  } catch {
    // The bounded failure remains authoritative.
  }
}

export async function readBoundedResponseBytes(
  response,
  { maxBytes = DEFAULT_MAX_BYTES, label = "HTTP response" } = {}
) {
  const maximum = positiveBound(maxBytes);
  const boundedLabel = labelText(label);
  const declared = response?.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`${boundedLabel} returned an invalid Content-Length`);
    }
    if (length > maximum) {
      try {
        await response.body?.cancel();
      } catch {
        // The bounded failure remains authoritative.
      }
      throw new Error(`${boundedLabel} exceeded its ${maximum}-byte limit`);
    }
  }
  if (response?.body === null) return Buffer.alloc(0);
  if (!response?.body || typeof response.body.getReader !== "function") {
    throw new Error(`${boundedLabel} returned no readable body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await cancel(reader);
        throw new Error(`${boundedLabel} returned non-byte body data`);
      }
      total += value.byteLength;
      if (total > maximum) {
        await cancel(reader);
        throw new Error(`${boundedLabel} exceeded its ${maximum}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedResponseText(response, options) {
  return (await readBoundedResponseBytes(response, options)).toString("utf8");
}

export async function readBoundedResponseJson(response, options) {
  const label = options?.label ?? "HTTP response";
  const raw = await readBoundedResponseText(response, options);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${labelText(label)} returned malformed JSON`);
  }
}
