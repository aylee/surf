export const REMOTE_INGEST_POLL_INTERVAL_MS = 5_000;
export const REMOTE_INGEST_TIMEOUT_MS = 10 * 60_000;

const FORECAST_INTERVALS = ["3h", "1h"];

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

async function configuredSpotIds(baseUrl, fetcher) {
  const response = await fetcher(`${baseUrl}/api/spots`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`spot catalog request failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  const spotIds = Array.isArray(payload?.spots)
    ? payload.spots.flatMap((spot) => typeof spot?.id === "string" && spot.id ? [spot.id] : [])
    : [];
  if (spotIds.length === 0 || new Set(spotIds).size !== spotIds.length) {
    throw new Error("spot catalog did not contain a non-empty set of unique spot IDs");
  }
  return spotIds;
}

async function inspectForecastReadModel(
  baseUrl,
  spotId,
  interval,
  expectedIngestId,
  requestedAtMs,
  minimumGeneratedAtMs,
  fetcher
) {
  const path = `/api/forecast/${encodeURIComponent(spotId)}?interval=${interval}`;
  const response = await fetcher(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" }
  });
  if (response.status === 503) {
    const payload = await jsonOrNull(response);
    if (isTypedPendingForecast(payload, spotId, interval)) {
      return { spotId, interval, status: "pending", materializedAt: null };
    }
    throw new Error(`${path} returned an invalid retryable-unavailable response`);
  }
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }

  const materializedAt = response.headers.get("X-Surf-Forecast-Materialized-At");
  const generatedAt = response.headers.get("X-Surf-Forecast-Generated-At");
  const ingestId = response.headers.get("X-Surf-Ingest-Id");
  await response.body?.cancel();
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
      ingestId === expectedIngestId
        ? "ready"
        : "pending",
    materializedAt: Number.isFinite(materializedAtMs) ? materializedAt : null
  };
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
    timeoutMs = REMOTE_INGEST_TIMEOUT_MS
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
  if (!(pollIntervalMs > 0) || !(timeoutMs > 0)) {
    throw new Error("remote ingest polling interval and timeout must be positive");
  }

  const spotIds = await configuredSpotIds(baseUrl, fetcher);
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
    const states = await Promise.all(
      [...pending.values()].map(({ spotId, interval }) =>
        inspectForecastReadModel(
          baseUrl,
          spotId,
          interval,
          ingestId,
          requestedAtMs,
          minimumGeneratedAtMs,
          fetcher
        )
      )
    );
    for (const state of states) {
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
  const { baseUrl, token, fetcher = globalThis.fetch } = options;
  const response = await fetcher(`${baseUrl}/api/ingest/once`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    }
  });
  const payload = await jsonOrNull(response);
  if (
    response.status !== 202 ||
    payload?.status !== "accepted" ||
    typeof payload?.ingestId !== "string" ||
    !payload.ingestId ||
    !validTimestamp(payload?.requestedAt) ||
    !validTimestamp(payload?.forecastGeneratedAt)
  ) {
    throw new Error(
      `remote ingest enqueue failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
  const result = await waitForRemoteForecastReadModels({
    ...options,
    requestedAt: payload.requestedAt,
    forecastGeneratedAt: payload.forecastGeneratedAt,
    ingestId: payload.ingestId,
    fetcher
  });
  return { ...result, ingestId: payload.ingestId };
}
