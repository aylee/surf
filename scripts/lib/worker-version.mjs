export const SURF_WORKER_VERSION_HEADER = "X-Surf-Worker-Version";
export const SURF_EXPECTED_WORKER_VERSION_HEADER =
  "X-Surf-Expected-Worker-Version";
export const CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER =
  "Cloudflare-Workers-Version-Overrides";

export const WORKER_VERSION_POLL_INTERVAL_MS = 1_000;
export const WORKER_VERSION_TIMEOUT_MS = 60_000;
export const WORKER_VERSION_REQUEST_TIMEOUT_MS = 10_000;
export const WORKER_VERSION_CONSECUTIVE_READY = 3;

const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OVERRIDE_ADDRESSABLE_WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function isWorkerVersionId(value) {
  return typeof value === "string" && VERSION_ID_PATTERN.test(value);
}

export function assertWorkerVersionId(
  value,
  label = "expected Worker version ID"
) {
  if (!isWorkerVersionId(value)) throw new Error(`${label} must be a UUID`);
}

function assertWorkerName(value) {
  if (
    typeof value !== "string" ||
    !OVERRIDE_ADDRESSABLE_WORKER_NAME_PATTERN.test(value)
  ) {
    throw new Error(
      "expected Worker name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens"
    );
  }
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Worker readiness base URL must be a bare HTTP(S) origin");
  }
  return url.toString().replace(/\/$/, "");
}

export function workerVersionRequestHeaders(
  {
    expectedVersionId,
    expectedWorkerName,
    headers: baseHeaders,
    override = true
  } = {}
) {
  const headers = new Headers(baseHeaders);
  const hasVersion = expectedVersionId !== undefined && expectedVersionId !== null;
  const hasWorkerName = expectedWorkerName !== undefined && expectedWorkerName !== null;
  if (hasVersion !== hasWorkerName) {
    throw new Error(
      "expected Worker version ID and Worker name must be provided together"
    );
  }
  if (!hasVersion) return headers;
  assertWorkerVersionId(expectedVersionId);
  assertWorkerName(expectedWorkerName);
  if (override) {
    headers.set(
      CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
      `${expectedWorkerName}="${expectedVersionId}"`
    );
  }
  return headers;
}

function rolloutProbeUrl(healthUrl, expectedVersionId, phase, attempt) {
  const url = new URL(healthUrl);
  url.searchParams.set("surf_rollout_probe", expectedVersionId);
  url.searchParams.set("phase", phase);
  url.searchParams.set("attempt", String(attempt));
  return url.toString();
}

export function responseWorkerVersion(response) {
  const value = response?.headers?.get?.(SURF_WORKER_VERSION_HEADER)?.trim();
  return value || null;
}

function timeoutError(timeoutMs) {
  const error = new Error(`request timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

async function fetchWithTimeout(fetcher, input, init, timeoutMs) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetcher(input, { ...init, signal: controller.signal }),
      timeout
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function errorLabel(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function cancelBody(response) {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  } catch {
    // Readiness inspects headers only. A body cancellation failure must not hide
    // the status/version evidence that controls the rollout decision.
  }
}

export async function waitForWorkerVersion(options) {
  const {
    baseUrl,
    expectedVersionId,
    expectedWorkerName,
    fetcher = globalThis.fetch,
    now = Date.now,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    pollIntervalMs = WORKER_VERSION_POLL_INTERVAL_MS,
    timeoutMs = WORKER_VERSION_TIMEOUT_MS,
    consecutiveReady = WORKER_VERSION_CONSECUTIVE_READY,
    requestTimeoutMs = WORKER_VERSION_REQUEST_TIMEOUT_MS
  } = options;

  assertWorkerVersionId(expectedVersionId);
  assertWorkerName(expectedWorkerName);
  if (typeof fetcher !== "function" || typeof now !== "function" || typeof sleep !== "function") {
    throw new Error("Worker readiness requires fetch, clock, and sleep functions");
  }
  if (!(pollIntervalMs > 0) || !(timeoutMs > 0) || !(requestTimeoutMs > 0)) {
    throw new Error("Worker readiness polling interval and timeouts must be positive");
  }
  if (!Number.isInteger(consecutiveReady) || consecutiveReady < 1) {
    throw new Error("Worker readiness consecutive response count must be a positive integer");
  }

  const healthUrl = `${normalizedBaseUrl(baseUrl)}/api/health`;
  const deadlineMs = now() + timeoutMs;
  let attempts = 0;
  let overrideReachable = false;
  let readyResponses = 0;
  let lastState = "no request completed";

  while (true) {
    const remainingBeforeRequestMs = deadlineMs - now();
    if (remainingBeforeRequestMs <= 0) break;

    attempts += 1;
    const phase = overrideReachable ? "default" : "override";
    let response;
    try {
      response = await fetchWithTimeout(
        fetcher,
        rolloutProbeUrl(healthUrl, expectedVersionId, phase, attempts),
        {
          method: "GET",
          cache: "no-store",
          headers: workerVersionRequestHeaders({
            ...(overrideReachable
              ? {}
              : { expectedVersionId, expectedWorkerName }),
            headers: {
              Accept: "application/json",
              "Cache-Control": "no-store"
            }
          })
        },
        Math.min(requestTimeoutMs, remainingBeforeRequestMs)
      );
    } catch (error) {
      readyResponses = 0;
      lastState = `${phase} request error (${errorLabel(error)})`;
    }

    if (response) {
      const actualVersionId = responseWorkerVersion(response);
      if (response.status === 200) {
        if (actualVersionId === expectedVersionId) {
          if (!overrideReachable) {
            overrideReachable = true;
            readyResponses = 0;
            lastState = "exact override reached the expected version; awaiting default-route convergence";
          } else {
            readyResponses += 1;
            lastState = `default route returned the expected version (${readyResponses}/${consecutiveReady} consecutive)`;
          }
          cancelBody(response);
          if (overrideReachable && readyResponses >= consecutiveReady) {
            return {
              status: "ready",
              baseUrl: normalizedBaseUrl(baseUrl),
              workerName: expectedWorkerName,
              workerVersion: expectedVersionId,
              attempts,
              overrideReachable: true,
              consecutiveReady: readyResponses
            };
          }
        } else {
          readyResponses = 0;
          lastState = `${phase} route returned Worker version ${actualVersionId ?? "unknown"}; expected ${expectedVersionId}`;
          cancelBody(response);
        }
      } else if (retryableStatus(response.status)) {
        readyResponses = 0;
        lastState = `${phase} route returned retryable HTTP ${response.status}`;
        cancelBody(response);
      } else {
        cancelBody(response);
        throw new Error(
          `Worker version readiness failed fast: ${phase} /api/health probe returned HTTP ${response.status}; expected 200 from ${expectedVersionId}`
        );
      }
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  throw new Error(
    `Worker version ${expectedVersionId} did not become ready at ${healthUrl} within ${timeoutMs}ms after ${attempts} attempt(s); last state: ${lastState}`
  );
}
