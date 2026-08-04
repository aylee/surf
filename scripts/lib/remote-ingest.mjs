import {
  responseWorkerVersion,
  SURF_EXPECTED_WORKER_VERSION_HEADER,
  workerVersionRequestHeaders
} from "./worker-version.mjs";

export const REMOTE_INGEST_POLL_INTERVAL_MS = 5_000;
export const REMOTE_INGEST_TIMEOUT_MS = 10 * 60_000;
export const REMOTE_INGEST_REQUEST_TIMEOUT_MS = 30_000;

const FORECAST_INTERVALS = ["3h", "1h"];
const CLOUDFLARE_1102_TYPE =
  "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/";

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function jsonOrNull(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isTypedPendingForecast(value, spotId, interval) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.error === "forecast_temporarily_unavailable" &&
      value.retryable === true &&
      value.spotId === spotId &&
      value.interval === interval
  );
}

function isCloudflare1102Problem(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.type === CLOUDFLARE_1102_TYPE &&
      value.status === 503 &&
      value.error_code === 1102 &&
      value.error_name === "worker_exceeded_resources" &&
      value.error_category === "worker" &&
      value.cloudflare_error === true
  );
}

function requestTimeoutError(timeoutMs) {
  const error = new Error(`request timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

function transportError(cause) {
  const error = new Error(`forecast transport failed: ${cause?.message ?? String(cause)}`, {
    cause
  });
  error.name = "TransportError";
  return error;
}

function isFetchTransportFailure(error) {
  return error instanceof TypeError || error?.name === "AbortError";
}

async function requestWithTimeout(fetcher, input, init, timeoutMs, consume) {
  if (!(timeoutMs > 0)) throw new Error("remote ingest request timeout must be positive");
  const controller = new AbortController();
  const timeoutFailure = requestTimeoutError(timeoutMs);
  let timedOut = false;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(timeoutFailure);
      controller.abort(timeoutFailure);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        let response;
        try {
          response = await fetcher(input, {
            ...init,
            signal: controller.signal
          });
        } catch (error) {
          if (isFetchTransportFailure(error)) throw transportError(error);
          throw error;
        }
        return consume(response);
      })(),
      timeout
    ]);
  } catch (error) {
    if (timedOut) throw timeoutFailure;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The caller already captured the response headers that decide readiness.
  }
}

async function configuredSpotIds(
  baseUrl,
  fetcher,
  expectedVersionId,
  expectedWorkerName,
  requestTimeoutMs
) {
  return requestWithTimeout(
    fetcher,
    `${baseUrl}/api/spots`,
    {
      headers: workerVersionRequestHeaders({
        expectedVersionId,
        expectedWorkerName,
        headers: { Accept: "application/json" }
      })
    },
    requestTimeoutMs,
    async (response) => {
      if (!response.ok) {
        throw new Error(
          `spot catalog request failed: ${response.status} ${await response.text()}`
        );
      }
      const actualVersionId = responseWorkerVersion(response);
      if (expectedVersionId && actualVersionId !== expectedVersionId) {
        await cancelBody(response);
        throw new Error(
          `spot catalog was served by Worker version ${actualVersionId ?? "unknown"}; expected ${expectedVersionId}`
        );
      }
      const payload = await response.json();
      const spotIds = Array.isArray(payload?.spots)
        ? payload.spots.flatMap((spot) =>
            typeof spot?.id === "string" && spot.id ? [spot.id] : []
          )
        : [];
      if (spotIds.length === 0 || new Set(spotIds).size !== spotIds.length) {
        throw new Error("spot catalog did not contain a non-empty set of unique spot IDs");
      }
      return spotIds;
    }
  );
}

async function inspectForecastReadModel(
  baseUrl,
  spotId,
  interval,
  expectedIngestId,
  requestedAtMs,
  minimumGeneratedAtMs,
  fetcher,
  expectedVersionId,
  expectedWorkerName,
  requestTimeoutMs
) {
  const path = `/api/forecast/${encodeURIComponent(spotId)}?interval=${interval}`;
  try {
    return await requestWithTimeout(
      fetcher,
      `${baseUrl}${path}`,
      {
        headers: workerVersionRequestHeaders({
          expectedVersionId,
          expectedWorkerName,
          headers: { Accept: "application/json" }
        })
      },
      requestTimeoutMs,
      async (response) => {
        if (response.status === 503) {
          const payload = await jsonOrNull(response);
          if (
            isTypedPendingForecast(payload, spotId, interval) ||
            isCloudflare1102Problem(payload)
          ) {
            return { spotId, interval, status: "pending", materializedAt: null };
          }
          throw new Error(`${path} returned an invalid retryable-unavailable response`);
        }
        if (!response.ok) {
          throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
        }

        if (
          expectedVersionId &&
          responseWorkerVersion(response) !== expectedVersionId
        ) {
          await cancelBody(response);
          return { spotId, interval, status: "pending", materializedAt: null };
        }

        const materializedAt = response.headers.get("X-Surf-Forecast-Materialized-At");
        const generatedAt = response.headers.get("X-Surf-Forecast-Generated-At");
        const responseIngestId = response.headers.get("X-Surf-Ingest-Id");
        await cancelBody(response);
        const materializedAtMs = materializedAt ? Date.parse(materializedAt) : Number.NaN;
        const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
        return {
          spotId,
          interval,
          status:
            Number.isFinite(materializedAtMs) &&
            materializedAtMs >= requestedAtMs &&
            Number.isFinite(generatedAtMs) &&
            generatedAtMs >= minimumGeneratedAtMs &&
            responseIngestId === expectedIngestId
              ? "ready"
              : "pending",
          materializedAt: Number.isFinite(materializedAtMs) ? materializedAt : null
        };
      }
    );
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "TransportError") {
      return { spotId, interval, status: "pending", materializedAt: null };
    }
    throw error;
  }
}

export async function waitForRemoteForecastReadModels(options) {
  const {
    baseUrl,
    ingestId,
    requestedAt,
    forecastGeneratedAt = requestedAt,
    fetcher = globalThis.fetch,
    now = Date.now,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    pollIntervalMs = REMOTE_INGEST_POLL_INTERVAL_MS,
    timeoutMs = REMOTE_INGEST_TIMEOUT_MS,
    requestTimeoutMs = REMOTE_INGEST_REQUEST_TIMEOUT_MS,
    expectedVersionId,
    expectedWorkerName,
    spotIds: configuredSpotIdsOption
  } = options;
  const requestedAtMs = Date.parse(requestedAt);
  if (typeof ingestId !== "string" || !ingestId) {
    throw new Error("queued ingest returned an invalid ingestId");
  }
  if (!Number.isFinite(requestedAtMs)) throw new Error("queued ingest returned an invalid requestedAt");
  const minimumGeneratedAtMs = Date.parse(forecastGeneratedAt);
  if (!Number.isFinite(minimumGeneratedAtMs)) {
    throw new Error("queued ingest returned an invalid forecastGeneratedAt");
  }
  if (!(pollIntervalMs > 0) || !(timeoutMs > 0) || !(requestTimeoutMs > 0)) {
    throw new Error("remote ingest polling interval and timeouts must be positive");
  }

  const spotIds = configuredSpotIdsOption ?? await configuredSpotIds(
    baseUrl,
    fetcher,
    expectedVersionId,
    expectedWorkerName,
    requestTimeoutMs
  );
  const targets = spotIds.flatMap((spotId) =>
    FORECAST_INTERVALS.map((interval) => ({ spotId, interval }))
  );
  const deadlineMs = now() + timeoutMs;
  let attempts = 0;
  const pending = new Map(
    targets.map((target) => [`${target.spotId}:${target.interval}`, target])
  );
  let latestMaterializedAt = null;

  while (true) {
    attempts += 1;
    for (const { spotId, interval } of [...pending.values()]) {
      const remainingBeforeRequestMs = deadlineMs - now();
      if (remainingBeforeRequestMs <= 0) break;
      const state = await inspectForecastReadModel(
        baseUrl,
        spotId,
        interval,
        ingestId,
        requestedAtMs,
        minimumGeneratedAtMs,
        fetcher,
        expectedVersionId,
        expectedWorkerName,
        Math.min(requestTimeoutMs, remainingBeforeRequestMs)
      );
      if (state.status !== "ready") continue;
      pending.delete(`${state.spotId}:${state.interval}`);
      if (
        state.materializedAt &&
        (!latestMaterializedAt ||
          Date.parse(state.materializedAt) > Date.parse(latestMaterializedAt))
      ) {
        latestMaterializedAt = state.materializedAt;
      }
    }
    if (pending.size === 0) {
      return {
        status: "published",
        requestedAt,
        attempts,
        spots: spotIds.length,
        forecastReadModels: targets.length,
        materializedAt: latestMaterializedAt
      };
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      const pendingLabels = [...pending.values()]
        .map((state) => `${state.spotId}:${state.interval}`)
        .join(", ");
      throw new Error(
        `queued ingest did not publish fresh forecast read models within ${timeoutMs}ms; pending: ${pendingLabels}`
      );
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

export async function enqueueAndWaitForRemoteIngest(options) {
  const {
    baseUrl,
    token,
    fetcher = globalThis.fetch,
    expectedVersionId,
    expectedWorkerName,
    requestTimeoutMs = REMOTE_INGEST_REQUEST_TIMEOUT_MS
  } = options;
  const spotIds = await configuredSpotIds(
    baseUrl,
    fetcher,
    expectedVersionId,
    expectedWorkerName,
    requestTimeoutMs
  );
  const enqueueHeaders = workerVersionRequestHeaders({
    expectedVersionId,
    expectedWorkerName,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });
  if (expectedVersionId) {
    enqueueHeaders.set(SURF_EXPECTED_WORKER_VERSION_HEADER, expectedVersionId);
  }
  const enqueue = await requestWithTimeout(
    fetcher,
    `${baseUrl}${expectedVersionId ? "/api/ingest/deploy" : "/api/ingest/once"}`,
    {
      method: "POST",
      headers: enqueueHeaders
    },
    requestTimeoutMs,
    async (response) => ({
      status: response.status,
      workerVersion: responseWorkerVersion(response),
      payload: await jsonOrNull(response)
    })
  );
  const { payload } = enqueue;
  if (
    enqueue.status !== 202 ||
    (expectedVersionId && enqueue.workerVersion !== expectedVersionId) ||
    payload?.status !== "accepted" ||
    typeof payload?.ingestId !== "string" ||
    !payload.ingestId ||
    !validTimestamp(payload?.requestedAt) ||
    !validTimestamp(payload?.forecastGeneratedAt)
  ) {
    throw new Error(
      `remote ingest enqueue failed: ${enqueue.status} ${JSON.stringify(payload)}`
    );
  }
  const result = await waitForRemoteForecastReadModels({
    ...options,
    requestedAt: payload.requestedAt,
    forecastGeneratedAt: payload.forecastGeneratedAt,
    ingestId: payload.ingestId,
    fetcher,
    spotIds
  });
  return {
    ...result,
    ingestId: payload.ingestId,
    ...(expectedVersionId ? { workerVersion: expectedVersionId } : {})
  };
}
