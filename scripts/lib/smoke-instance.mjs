import {
  responseWorkerVersion,
  workerVersionRequestHeaders
} from "./worker-version.mjs";

export const SMOKE_REQUEST_TIMEOUT_MS = 15_000;
export const SMOKE_TIMEOUT_MS = 2 * 60_000;

function timeoutError(message) {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

async function requestWithTimeout(fetcher, input, init, timeoutMs, consume) {
  const controller = new AbortController();
  const timeoutFailure = timeoutError(`smoke request timed out after ${timeoutMs}ms`);
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
        const response = await fetcher(input, {
          ...init,
          signal: controller.signal
        });
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

function nextRequestTimeout(deadlineMs, now, requestTimeoutMs, timeoutMs) {
  const remainingMs = deadlineMs - now();
  if (remainingMs <= 0) {
    throw timeoutError(`cloud smoke exceeded its ${timeoutMs}ms overall timeout`);
  }
  return Math.min(requestTimeoutMs, remainingMs);
}

function localDateKey(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  }).formatToParts(date);
  const part = (type) => parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

async function requireWorkerVersion(response, path, expectedVersionId) {
  const actualVersionId = responseWorkerVersion(response);
  if (expectedVersionId && actualVersionId !== expectedVersionId) {
    await response.body?.cancel();
    throw new Error(
      `${path} was served by Worker version ${actualVersionId ?? "unknown"}; expected ${expectedVersionId}.`
    );
  }
  return actualVersionId;
}

async function getJson(
  baseUrl,
  path,
  label,
  fetcher,
  expectedVersionId,
  requestTimeoutMs
) {
  return requestWithTimeout(
    fetcher,
    `${baseUrl}${path}`,
    {
      headers: workerVersionRequestHeaders(expectedVersionId, {
        Accept: "application/json"
      })
    },
    requestTimeoutMs,
    async (response) => {
      const workerVersion = await requireWorkerVersion(
        response,
        path,
        expectedVersionId
      );
      if (!response.ok) {
        throw new Error(
          `${label} ${path} failed: ${response.status} ${await response.text()}`
        );
      }
      return { payload: await response.json(), workerVersion };
    }
  );
}

function isRetryableForecastUnavailable(value, spotId, interval) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.error === "forecast_temporarily_unavailable" &&
      value.retryable === true &&
      value.spotId === spotId &&
      value.interval === interval
  );
}

async function getForecastReadModel(
  baseUrl,
  spot,
  interval,
  label,
  requireForecastData,
  fetcher,
  expectedVersionId,
  requestTimeoutMs
) {
  const path = `/api/forecast/${encodeURIComponent(spot.id)}?interval=${interval}`;
  return requestWithTimeout(
    fetcher,
    `${baseUrl}${path}`,
    {
      headers: workerVersionRequestHeaders(expectedVersionId, {
        Accept: "application/json"
      })
    },
    requestTimeoutMs,
    async (response) => {
      await requireWorkerVersion(response, path, expectedVersionId);
      if (response.status === 503 && !requireForecastData) {
        const body = await response.json().catch(() => null);
        if (isRetryableForecastUnavailable(body, spot.id, interval)) {
          return { status: "pending", forecast: null };
        }
        throw new Error(
          `${label} ${path} returned an invalid setup-time unavailable response: ${JSON.stringify(body)}`
        );
      }
      if (!response.ok) {
        throw new Error(
          `${label} ${path} failed: ${response.status} ${await response.text()}`
        );
      }
      return { status: "ready", forecast: await response.json() };
    }
  );
}

function validateForecast(spot, interval, forecast, requireForecastData) {
  if (forecast?.spot?.id !== spot.id) {
    throw new Error(`Forecast identity mismatch for ${spot.id}.`);
  }
  if (forecast?.interval !== interval) {
    throw new Error(`Forecast interval mismatch for ${spot.id}: expected ${interval}.`);
  }
  if (!Array.isArray(forecast.windows) || forecast.windows.length === 0) {
    throw new Error(`Expected forecast windows for ${spot.id}.`);
  }

  const localDates = new Set(
    forecast.windows
      .map((window) => localDateKey(window?.forecastAt, spot.timezone))
      .filter(Boolean)
  );
  if (localDates.size < 5) {
    throw new Error(`Expected a five-day horizon for ${spot.id}; received ${localDates.size} local dates.`);
  }

  if (
    requireForecastData &&
    !forecast.windows.some(
      (window) => window?.ratingStatus === "scored" && Number.isFinite(window?.waveHeightFt)
    )
  ) {
    throw new Error(`${spot.id} has no scored window with sourced wave data.`);
  }
}

export async function smokeForecastInstance(
  configuredUrl,
  {
    label,
    requireForecastData = true,
    expectedVersionId,
    fetcher = globalThis.fetch,
    now = Date.now,
    requestTimeoutMs = SMOKE_REQUEST_TIMEOUT_MS,
    timeoutMs = SMOKE_TIMEOUT_MS
  }
) {
  if (
    typeof fetcher !== "function" ||
    typeof now !== "function" ||
    !(requestTimeoutMs > 0) ||
    !(timeoutMs > 0)
  ) {
    throw new Error("cloud smoke requires fetch, clock, and positive request/overall timeouts");
  }
  const baseUrl = configuredUrl.replace(/\/$/, "");
  const deadlineMs = now() + timeoutMs;
  const healthResponse = await getJson(
    baseUrl,
    "/api/health",
    label,
    fetcher,
    expectedVersionId,
    nextRequestTimeout(deadlineMs, now, requestTimeoutMs, timeoutMs)
  );
  const spotsResponse = await getJson(
    baseUrl,
    "/api/spots",
    label,
    fetcher,
    expectedVersionId,
    nextRequestTimeout(deadlineMs, now, requestTimeoutMs, timeoutMs)
  );
  const health = healthResponse.payload;
  const spots = spotsResponse.payload;

  if (health.status !== "ok") {
    throw new Error(`Unexpected health status: ${JSON.stringify(health)}`);
  }
  if (!Array.isArray(spots.spots) || spots.spots.length === 0) {
    throw new Error(`Expected at least one configured spot, got: ${JSON.stringify(spots)}`);
  }

  const spotIds = new Set();
  for (const spot of spots.spots) {
    if (typeof spot?.id !== "string" || typeof spot?.timezone !== "string") {
      throw new Error(`Invalid spot response: ${JSON.stringify(spot)}`);
    }
    if (spotIds.has(spot.id)) throw new Error(`Duplicate configured spot: ${spot.id}`);
    spotIds.add(spot.id);
  }

  const requests = spots.spots.flatMap((spot) =>
    ["3h", "1h"].map((interval) => ({ spot, interval }))
  );
  const results = [];
  for (const { spot, interval } of requests) {
    results.push(
      await getForecastReadModel(
        baseUrl,
        spot,
        interval,
        label,
        requireForecastData,
        fetcher,
        expectedVersionId,
        nextRequestTimeout(deadlineMs, now, requestTimeoutMs, timeoutMs)
      )
    );
  }
  results.forEach((result, index) => {
    if (result.status === "pending") return;
    const request = requests[index];
    validateForecast(request.spot, request.interval, result.forecast, requireForecastData);
  });
  const readyForecasts = results.filter((result) => result.status === "ready").length;
  const pendingForecasts = results.length - readyForecasts;

  return {
    status: "ok",
    baseUrl,
    spots: spots.spots.length,
    forecastReadModels: readyForecasts,
    pendingForecastReadModels: pendingForecasts,
    dataCheck: requireForecastData ? "scored forecasts present" : "API structure only",
    ...(healthResponse.workerVersion
      ? { workerVersion: healthResponse.workerVersion }
      : {}),
    generatedAt: new Date().toISOString()
  };
}
