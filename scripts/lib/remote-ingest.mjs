import { randomUUID } from "node:crypto";
import {
  isWorkerVersionId,
  responseWorkerVersion,
  SURF_EXPECTED_WORKER_VERSION_HEADER,
  workerVersionRequestHeaders
} from "./worker-version.mjs";

export const REMOTE_INGEST_POLL_INTERVAL_MS = 5_000;
export const REMOTE_INGEST_TIMEOUT_MS = 10 * 60_000;
export const REMOTE_INGEST_REQUEST_TIMEOUT_MS = 30_000;
export const REMOTE_INGEST_HANDOFF_TIMEOUT_MS = 60_000;

const FORECAST_INTERVALS = ["3h", "1h"];
const REMOTE_INGEST_HANDOFF_MAX_ATTEMPTS = 3;
const REMOTE_INGEST_HANDOFF_MAX_SESSIONS = 60;
const REMOTE_INGEST_HANDOFF_MAX_PROBES = 60;
const REMOTE_INGEST_HANDOFF_BACKOFF_MS = [1_000, 2_000];
const REMOTE_INGEST_PROBE_BACKOFF_MS = 1_000;
const CLOUDFLARE_WORKERS_VERSION_KEY_HEADER =
  "Cloudflare-Workers-Version-Key";
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

function redactSensitiveValues(value, sensitiveValues = []) {
  let safeValue = String(value);
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) {
      safeValue = safeValue.split(sensitiveValue).join("[REDACTED]");
    }
  }
  return safeValue;
}

async function responseEvidence(response, sensitiveValues = []) {
  const rawBody = await response.text();
  let payload = null;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    // Preserve non-JSON Cloudflare/proxy failures in the bounded diagnostic.
  }
  const safeBody = redactSensitiveValues(rawBody, sensitiveValues);
  const body = safeBody
    .slice(0, 2_000)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return {
    payload,
    exactHonoNotFound: rawBody === "404 Not Found",
    body: body || "<empty>",
    contentType: response.headers.get("Content-Type")
  };
}

function exactObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isJsonContentType(value) {
  return (
    typeof value === "string" &&
    value.split(";", 1)[0].trim().toLowerCase() === "application/json"
  );
}

function isTypedStaleVersionRejection(response, expectedVersionId) {
  return Boolean(
    response.status === 409 &&
      isWorkerVersionId(response.workerVersion) &&
      response.workerVersion !== expectedVersionId &&
      isJsonContentType(response.contentType) &&
      exactObjectKeys(response.payload, [
        "error",
        "expectedWorkerVersion",
        "actualWorkerVersion"
      ]) &&
      response.payload.error === "worker_version_mismatch" &&
      response.payload.expectedWorkerVersion === expectedVersionId &&
      response.payload.actualWorkerVersion === response.workerVersion
  );
}

function isExactLegacyPatchlessRejection(response, legacyPatchlessVersionId) {
  return Boolean(
    legacyPatchlessVersionId &&
      response.status === 404 &&
      response.workerVersion === legacyPatchlessVersionId &&
      response.exactHonoNotFound === true &&
      response.contentType === "text/plain; charset=UTF-8"
  );
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

function annotatedRequestFailure(
  error,
  {
    phase,
    method,
    path,
    mutationPossible,
    handoff,
    safeRejections = [],
    sensitiveValues = []
  }
) {
  const rawCause = error instanceof Error ? error : new Error(String(error));
  const cause = new Error(
    redactSensitiveValues(rawCause.message, sensitiveValues)
  );
  cause.name = rawCause.name;
  const ambiguity = mutationPossible
    ? "mutation may have occurred; do not retry"
    : "mutation did not begin";
  const handoffContext = handoff ? `; ${handoffDiagnosticContext(handoff)}` : "";
  const safeRejectionContext = safeRejections.length > 0
    ? `; safeRejections=${safeRejectionDiagnostics(safeRejections)}`
    : "";
  const annotated = new Error(
    `remote ingest ${phase} request failed: ${method} ${path}; ${ambiguity}${handoffContext}${safeRejectionContext}; ${cause.name}: ${cause.message}`,
    { cause }
  );
  annotated.name = cause.name;
  return annotated;
}

function handoffState(startedAtMs, deadlineMs, now, authenticatedAttempts) {
  const currentMs = now();
  return {
    authenticatedAttempts,
    maxAuthenticatedAttempts: REMOTE_INGEST_HANDOFF_MAX_ATTEMPTS,
    elapsedMs: Math.max(0, currentMs - startedAtMs),
    remainingMs: Math.max(0, deadlineMs - currentMs),
    timeoutMs: deadlineMs - startedAtMs
  };
}

function handoffDiagnosticContext({
  authenticatedAttempts,
  maxAuthenticatedAttempts,
  sessionCount,
  catalogCount,
  probeCount,
  elapsedMs,
  remainingMs,
  timeoutMs
}) {
  return [
    `authenticatedAttempts=${authenticatedAttempts}/${maxAuthenticatedAttempts}`,
    ...(Number.isInteger(sessionCount) ? [`sessionCount=${sessionCount}`] : []),
    ...(Number.isInteger(catalogCount) ? [`catalogCount=${catalogCount}`] : []),
    ...(Number.isInteger(probeCount) ? [`probeCount=${probeCount}`] : []),
    `handoffElapsedMs=${elapsedMs}`,
    `handoffRemainingMs=${remainingMs}`,
    `handoffDeadlineMs=${timeoutMs}`
  ].join(" ");
}

function handoffSessionBudgetError(handoff, safeRejections = []) {
  const evidence = safeRejections.length > 0
    ? safeRejectionDiagnostics(safeRejections)
    : "none";
  return new Error(
    `remote ingest affinity session budget exhausted: ${handoffDiagnosticContext(handoff)} latestCatalog=${handoff.latestCatalogEvidence ?? "none"} latestProbe=${handoff.latestProbeEvidence ?? "none"} safeRejections=${evidence}; no request-attributable Queue mutation was accepted`
  );
}

function handoffDeadlineError(handoff, safeRejections) {
  const evidence = safeRejections.length > 0
    ? safeRejectionDiagnostics(safeRejections)
    : "none";
  return new Error(
    `remote ingest handoff deadline reached: ${handoffDiagnosticContext(handoff)} latestCatalog=${handoff.latestCatalogEvidence ?? "none"} latestProbe=${handoff.latestProbeEvidence ?? "none"} safeRejections=${evidence}; no request-attributable Queue mutation was accepted`
  );
}

function handoffProbeBudgetError(handoff, safeRejections) {
  const evidence = safeRejections.length > 0
    ? safeRejectionDiagnostics(safeRejections)
    : "none";
  return new Error(
    `remote ingest handoff probe budget exhausted: ${handoffDiagnosticContext(handoff)} latestCatalog=${handoff.latestCatalogEvidence ?? "none"} latestProbe=${handoff.latestProbeEvidence ?? "none"} safeRejections=${evidence}; no request-attributable Queue mutation was accepted`
  );
}

function handoffExhaustedError(handoff, safeRejections) {
  return new Error(
    `remote ingest handoff exhausted: ${handoffDiagnosticContext(handoff)} latestCatalog=${handoff.latestCatalogEvidence ?? "none"} latestProbe=${handoff.latestProbeEvidence ?? "none"} safeRejections=${safeRejectionDiagnostics(safeRejections)}; no request-attributable Queue mutation was accepted`
  );
}

function safeRejectionEvidence(authenticatedAttempt, response, kind) {
  return {
    authenticatedAttempt,
    kind,
    status: response.status,
    workerVersion: response.workerVersion,
    cfRay: response.cfRay ?? "missing",
    contentType: response.contentType ?? "missing",
    body: response.body
  };
}

function safeRejectionDiagnostic(evidence) {
  return [
    `authenticatedAttempt=${evidence.authenticatedAttempt}`,
    `kind=${evidence.kind}`,
    `status=${evidence.status}`,
    `workerVersion=${evidence.workerVersion}`,
    `cfRay=${evidence.cfRay}`,
    `contentType=${evidence.contentType}`,
    `body=${evidence.body}`
  ].join(" ");
}

function safeRejectionDiagnostics(safeRejections) {
  return safeRejections.map(safeRejectionDiagnostic).join(" | ");
}

function probeResponseEvidence(probeCount, response) {
  return [
    `probe=${probeCount}`,
    `status=${response.status}`,
    `workerVersion=${response.workerVersion ?? "missing"}`,
    `authenticate=${response.authenticate ?? "missing"}`,
    `cfRay=${response.cfRay ?? "missing"}`,
    `contentType=${response.contentType ?? "missing"}`,
    `body=${response.body}`
  ].join(" ");
}

function boundedErrorEvidence(error, sensitiveValues = []) {
  return redactSensitiveValues(
    `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    sensitiveValues
  )
    .slice(0, 2_000)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function probeRequestEvidence(probeCount, error, sensitiveValues = []) {
  return `probe=${probeCount} requestError=${boundedErrorEvidence(error, sensitiveValues)}`;
}

function withProbeState(
  handoff,
  probeCount,
  latestProbeEvidence,
  sessionCount,
  catalogCount,
  latestCatalogEvidence
) {
  return {
    ...handoff,
    probeCount,
    latestProbeEvidence,
    sessionCount,
    catalogCount,
    latestCatalogEvidence
  };
}

function withCatalogState(
  handoff,
  catalogCount,
  latestCatalogEvidence,
  sessionCount,
  probeCount,
  latestProbeEvidence
) {
  return {
    ...handoff,
    catalogCount,
    latestCatalogEvidence,
    sessionCount,
    probeCount,
    latestProbeEvidence
  };
}

function nextVersionAffinityKey(factory, sessions) {
  const key = factory();
  if (!isWorkerVersionId(key)) {
    throw new Error("version affinity key factory must return a UUID");
  }
  if (sessions.usedKeys.has(key)) {
    throw new Error("version affinity key factory reused a discarded session key");
  }
  sessions.usedKeys.add(key);
  sessions.count += 1;
  return key;
}

function configuredSpotIdsFromPayload(payload, { strict = false } = {}) {
  if (!Array.isArray(payload?.spots)) return null;
  if (
    strict &&
    !payload.spots.every(
      (spot) =>
        spot &&
        typeof spot === "object" &&
        typeof spot.id === "string" &&
        spot.id
    )
  ) {
    return null;
  }
  const spotIds = payload.spots.flatMap((spot) =>
    typeof spot?.id === "string" && spot.id ? [spot.id] : []
  );
  return spotIds.length > 0 && new Set(spotIds).size === spotIds.length
    ? spotIds
    : null;
}

function catalogResponseEvidence(catalogCount, response) {
  return [
    `catalog=${catalogCount}`,
    `status=${response.status}`,
    `workerVersion=${response.workerVersion ?? "missing"}`,
    `cfRay=${response.cfRay ?? "missing"}`,
    `contentType=${response.contentType ?? "missing"}`,
    `body=${response.body}`
  ].join(" ");
}

function catalogRequestEvidence(
  catalogCount,
  error,
  sensitiveValues = []
) {
  return `catalog=${catalogCount} requestError=${boundedErrorEvidence(error, sensitiveValues)}`;
}

function catalogDeadlineError(handoff, safeRejections = []) {
  const safeRejectionContext = safeRejections.length > 0
    ? ` safeRejections=${safeRejectionDiagnostics(safeRejections)}`
    : "";
  return new Error(
    `remote ingest catalog handoff deadline reached: ${handoffDiagnosticContext(handoff)} latestCatalog=${handoff.latestCatalogEvidence ?? "none"} latestProbe=${handoff.latestProbeEvidence ?? "none"}${safeRejectionContext}; no request-attributable Queue mutation was accepted`
  );
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

function cancelBodyWithoutWaiting(response) {
  void response.body?.cancel().catch(() => {
    // Header-only classifications must never wait on an untrusted body stream.
  });
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
        override: false,
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
      const spotIds = configuredSpotIdsFromPayload(payload);
      if (!spotIds) {
        throw new Error("spot catalog did not contain a non-empty set of unique spot IDs");
      }
      return spotIds;
    }
  );
}

async function configuredSpotIdsForHandoff({
  baseUrl,
  fetcher,
  expectedVersionId,
  expectedWorkerName,
  versionAffinityKeyFactory,
  affinitySessions,
  requestTimeoutMs,
  handoffStartedAtMs,
  handoffDeadlineMs,
  authenticatedAttempts,
  initialCatalogCount = 0,
  initialLatestCatalogEvidence = "none",
  initialProbeCount = 0,
  initialLatestProbeEvidence = "none",
  safeRejections = [],
  now,
  sleep
}) {
  const catalogPath = "/api/spots";
  let catalogCount = initialCatalogCount;
  let latestCatalogEvidence = initialLatestCatalogEvidence;

  while (true) {
    let handoff = withCatalogState(
      handoffState(
        handoffStartedAtMs,
        handoffDeadlineMs,
        now,
        authenticatedAttempts
      ),
      catalogCount,
      latestCatalogEvidence,
      affinitySessions.count,
      initialProbeCount,
      initialLatestProbeEvidence
    );
    if (handoff.remainingMs <= 0) {
      throw catalogDeadlineError(handoff, safeRejections);
    }
    if (affinitySessions.count >= REMOTE_INGEST_HANDOFF_MAX_SESSIONS) {
      throw handoffSessionBudgetError(handoff, safeRejections);
    }

    const versionAffinityKey = nextVersionAffinityKey(
      versionAffinityKeyFactory,
      affinitySessions
    );
    const catalogHeaders = workerVersionRequestHeaders({
      expectedVersionId,
      expectedWorkerName,
      override: false,
      headers: {
        Accept: "application/json",
        [CLOUDFLARE_WORKERS_VERSION_KEY_HEADER]: versionAffinityKey
      }
    });
    catalogCount += 1;
    let catalog;
    let exactTargetCatalogHeaders;
    try {
      catalog = await requestWithTimeout(
        fetcher,
        `${baseUrl}${catalogPath}`,
        {
          headers: catalogHeaders,
          cache: "no-store",
          redirect: "error"
        },
        Math.min(requestTimeoutMs, handoff.remainingMs),
        async (response) => {
          const headers = {
            status: response.status,
            workerVersion: responseWorkerVersion(response),
            cfRay: response.headers.get("CF-Ray"),
            contentType: response.headers.get("Content-Type")
          };
          if (headers.workerVersion === expectedVersionId) {
            exactTargetCatalogHeaders = headers;
            if (!(response.status >= 200 && response.status < 300)) {
              cancelBodyWithoutWaiting(response);
              return {
                ...headers,
                payload: null,
                exactHonoNotFound: false,
                body: "<unread target catalog HTTP defect>"
              };
            }
          }
          const evidence = await responseEvidence(response, [
            versionAffinityKey
          ]);
          return { ...headers, ...evidence };
        }
      );
      latestCatalogEvidence = catalogResponseEvidence(catalogCount, catalog);
    } catch (error) {
      if (exactTargetCatalogHeaders) {
        catalog = {
          ...exactTargetCatalogHeaders,
          body: `<unread target catalog body: ${boundedErrorEvidence(error, [versionAffinityKey])}>`
        };
        latestCatalogEvidence = catalogResponseEvidence(catalogCount, catalog);
        handoff = withCatalogState(
          handoffState(
            handoffStartedAtMs,
            handoffDeadlineMs,
            now,
            authenticatedAttempts
          ),
          catalogCount,
          latestCatalogEvidence,
          affinitySessions.count,
          initialProbeCount,
          initialLatestProbeEvidence
        );
        throw new Error(
          `${remoteIngestDiagnostic({
            phase: "catalog",
            method: "GET",
            path: catalogPath,
            handoff,
            safeRejections,
            ...catalog
          })}; expected Worker returned an unreadable spot catalog; mutation did not begin`
        );
      }
      latestCatalogEvidence = catalogRequestEvidence(catalogCount, error, [
        versionAffinityKey
      ]);
      handoff = withCatalogState(
        handoffState(
          handoffStartedAtMs,
          handoffDeadlineMs,
          now,
          authenticatedAttempts
        ),
        catalogCount,
        latestCatalogEvidence,
        affinitySessions.count,
        initialProbeCount,
        initialLatestProbeEvidence
      );
      if (handoff.remainingMs <= REMOTE_INGEST_PROBE_BACKOFF_MS) {
        throw catalogDeadlineError(handoff, safeRejections);
      }
      await sleep(REMOTE_INGEST_PROBE_BACKOFF_MS);
      continue;
    }

    handoff = withCatalogState(
      handoffState(
        handoffStartedAtMs,
        handoffDeadlineMs,
        now,
        authenticatedAttempts
      ),
      catalogCount,
      latestCatalogEvidence,
      affinitySessions.count,
      initialProbeCount,
      initialLatestProbeEvidence
    );
    if (catalog.workerVersion === expectedVersionId) {
      const spotIds = configuredSpotIdsFromPayload(catalog.payload, {
        strict: true
      });
      if (!(catalog.status >= 200 && catalog.status < 300) || !spotIds) {
        throw new Error(
          `${remoteIngestDiagnostic({
            phase: "catalog",
            method: "GET",
            path: catalogPath,
            handoff,
            safeRejections,
            ...catalog
          })}; expected Worker returned an invalid spot catalog; mutation did not begin`
        );
      }
      return {
        spotIds,
        versionAffinityKey,
        catalogCount,
        latestCatalogEvidence
      };
    }

    if (handoff.remainingMs <= REMOTE_INGEST_PROBE_BACKOFF_MS) {
      throw catalogDeadlineError(handoff, safeRejections);
    }
    await sleep(REMOTE_INGEST_PROBE_BACKOFF_MS);
  }
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
          override: false,
          headers: { Accept: "application/json" }
        })
      },
      requestTimeoutMs,
      async (response) => {
        if (
          expectedVersionId &&
          responseWorkerVersion(response) !== expectedVersionId
        ) {
          await cancelBody(response);
          return { spotId, interval, status: "pending", materializedAt: null };
        }

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
    legacyPatchlessVersionId,
    now = Date.now,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    logger = console,
    requestTimeoutMs = REMOTE_INGEST_REQUEST_TIMEOUT_MS,
    handoffTimeoutMs = REMOTE_INGEST_HANDOFF_TIMEOUT_MS,
    versionAffinityKeyFactory = randomUUID
  } = options;

  if (legacyPatchlessVersionId !== undefined) {
    if (!expectedVersionId) {
      throw new Error(
        "legacy patchless Worker version requires an expected Worker version"
      );
    }
    if (!isWorkerVersionId(legacyPatchlessVersionId)) {
      throw new Error("legacy patchless Worker version ID must be a UUID");
    }
    if (legacyPatchlessVersionId === expectedVersionId) {
      throw new Error(
        "legacy patchless Worker version must differ from the expected Worker version"
      );
    }
  }
  if (
    expectedVersionId &&
    (!(handoffTimeoutMs > 0) || handoffTimeoutMs > REMOTE_INGEST_HANDOFF_TIMEOUT_MS)
  ) {
    throw new Error(
      `remote ingest handoff timeout must be positive and no greater than ${REMOTE_INGEST_HANDOFF_TIMEOUT_MS}ms`
    );
  }
  if (expectedVersionId && typeof versionAffinityKeyFactory !== "function") {
    throw new Error("version affinity key factory must be a function");
  }

  let versionAffinityKey;
  let handoffStartedAtMs;
  let handoffDeadlineMs;
  let spotIds;
  const affinitySessions = { count: 0, usedKeys: new Set() };
  if (expectedVersionId) {
    handoffStartedAtMs = now();
    handoffDeadlineMs = handoffStartedAtMs + handoffTimeoutMs;
  } else {
    spotIds = await configuredSpotIds(
      baseUrl,
      fetcher,
      expectedVersionId,
      expectedWorkerName,
      requestTimeoutMs
    );
  }
  const enqueueHeaders = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  });
  if (expectedVersionId) {
    enqueueHeaders.set(SURF_EXPECTED_WORKER_VERSION_HEADER, expectedVersionId);
  }
  const enqueuePath = "/api/ingest/once";
  const enqueueMethod = expectedVersionId ? "PATCH" : "POST";

  let enqueue;
  let enqueueHandoff;
  let authenticatedAttempts = 0;
  const safeRejections = [];
  if (!expectedVersionId) {
    try {
      enqueue = await requestWithTimeout(
        fetcher,
        `${baseUrl}${enqueuePath}`,
        {
          method: enqueueMethod,
          headers: enqueueHeaders,
          cache: "no-store",
          redirect: "error"
        },
        requestTimeoutMs,
        async (response) => {
          const evidence = await responseEvidence(response, [token]);
          return {
            status: response.status,
            workerVersion: responseWorkerVersion(response),
            cfRay: response.headers.get("CF-Ray"),
            ...evidence
          };
        }
      );
    } catch (error) {
      throw annotatedRequestFailure(error, {
        phase: "enqueue",
        method: enqueueMethod,
        path: enqueuePath,
        mutationPossible: true,
        sensitiveValues: [token]
      });
    }
  } else {
    let catalogCount = 0;
    let latestCatalogEvidence = "none";
    let probeCount = 0;
    let latestProbeEvidence = "none";
    const currentHandoff = () =>
      withProbeState(
        handoffState(
          handoffStartedAtMs,
          handoffDeadlineMs,
          now,
          authenticatedAttempts
        ),
        probeCount,
        latestProbeEvidence,
        affinitySessions.count,
        catalogCount,
        latestCatalogEvidence
      );

    while (authenticatedAttempts < REMOTE_INGEST_HANDOFF_MAX_ATTEMPTS) {
      let handoff;
      while (true) {
        handoff = currentHandoff();
        if (affinitySessions.count >= REMOTE_INGEST_HANDOFF_MAX_SESSIONS) {
          throw handoffSessionBudgetError(handoff, safeRejections);
        }
        const catalog = await configuredSpotIdsForHandoff({
          baseUrl,
          fetcher,
          expectedVersionId,
          expectedWorkerName,
          versionAffinityKeyFactory,
          affinitySessions,
          requestTimeoutMs,
          handoffStartedAtMs,
          handoffDeadlineMs,
          authenticatedAttempts,
          initialCatalogCount: catalogCount,
          initialLatestCatalogEvidence: latestCatalogEvidence,
          initialProbeCount: probeCount,
          initialLatestProbeEvidence: latestProbeEvidence,
          safeRejections,
          now,
          sleep
        });
        spotIds = catalog.spotIds;
        versionAffinityKey = catalog.versionAffinityKey;
        catalogCount = catalog.catalogCount;
        latestCatalogEvidence = catalog.latestCatalogEvidence;

        handoff = currentHandoff();
        if (handoff.remainingMs <= 0) {
          throw handoffDeadlineError(handoff, safeRejections);
        }
        if (probeCount >= REMOTE_INGEST_HANDOFF_MAX_PROBES) {
          throw handoffProbeBudgetError(handoff, safeRejections);
        }

        const routeProbeHeaders = new Headers({
          Accept: "application/json",
          [SURF_EXPECTED_WORKER_VERSION_HEADER]: expectedVersionId,
          [CLOUDFLARE_WORKERS_VERSION_KEY_HEADER]: versionAffinityKey
        });
        probeCount += 1;
        let routeProbe;
        try {
          routeProbe = await requestWithTimeout(
            fetcher,
            `${baseUrl}${enqueuePath}`,
            {
              method: enqueueMethod,
              headers: routeProbeHeaders,
              cache: "no-store",
              redirect: "error"
            },
            Math.min(requestTimeoutMs, handoff.remainingMs),
            async (response) => {
              const headers = {
                status: response.status,
                workerVersion: responseWorkerVersion(response),
                authenticate: response.headers.get("WWW-Authenticate"),
                cfRay: response.headers.get("CF-Ray"),
                contentType: response.headers.get("Content-Type")
              };
              if (
                (response.status >= 200 && response.status < 300) ||
                headers.workerVersion === expectedVersionId
              ) {
                cancelBodyWithoutWaiting(response);
                return {
                  ...headers,
                  payload: null,
                  exactHonoNotFound: false,
                  body:
                    response.status >= 200 && response.status < 300
                      ? "<unread unauthenticated 2xx>"
                      : response.status === 401 &&
                          headers.authenticate === "Bearer"
                        ? "<unread exact auth challenge>"
                        : "<unread target auth-contract defect>"
                };
              }
              return {
                ...headers,
                ...(await responseEvidence(response, [versionAffinityKey]))
              };
            }
          );
          latestProbeEvidence = probeResponseEvidence(probeCount, routeProbe);
        } catch (error) {
          latestProbeEvidence = probeRequestEvidence(probeCount, error, [
            versionAffinityKey
          ]);
          handoff = currentHandoff();
          if (handoff.remainingMs <= REMOTE_INGEST_PROBE_BACKOFF_MS) {
            throw handoffDeadlineError(handoff, safeRejections);
          }
          await sleep(REMOTE_INGEST_PROBE_BACKOFF_MS);
          continue;
        }

        handoff = currentHandoff();
        const exactTargetProbe =
          routeProbe.status === 401 &&
          routeProbe.workerVersion === expectedVersionId &&
          routeProbe.authenticate === "Bearer";
        if (exactTargetProbe) break;

        if (routeProbe.status >= 200 && routeProbe.status < 300) {
          throw new Error(
            `${remoteIngestDiagnostic({
              phase: "route probe",
              method: enqueueMethod,
              path: enqueuePath,
              handoff,
              safeRejections,
              ...routeProbe
            })}; unauthenticated PATCH returned 2xx, so mutation may have occurred; do not retry`
          );
        }
        if (routeProbe.workerVersion === expectedVersionId) {
          throw new Error(
            `${remoteIngestDiagnostic({
              phase: "route probe",
              method: enqueueMethod,
              path: enqueuePath,
              handoff,
              safeRejections,
              ...routeProbe
            })}; expected Worker violated the exact 401 Bearer auth invariant; mutation did not begin`
          );
        }
        if (handoff.remainingMs <= REMOTE_INGEST_PROBE_BACKOFF_MS) {
          throw handoffDeadlineError(handoff, safeRejections);
        }
        await sleep(REMOTE_INGEST_PROBE_BACKOFF_MS);
      }

      handoff = currentHandoff();
      if (handoff.remainingMs <= 0) {
        throw handoffDeadlineError(handoff, safeRejections);
      }

      enqueueHeaders.set(
        CLOUDFLARE_WORKERS_VERSION_KEY_HEADER,
        versionAffinityKey
      );
      handoff = currentHandoff();
      if (handoff.remainingMs <= 0) {
        throw handoffDeadlineError(handoff, safeRejections);
      }
      const authenticatedRequestTimeoutMs = Math.min(
        requestTimeoutMs,
        handoff.remainingMs
      );
      authenticatedAttempts += 1;
      try {
        enqueue = await requestWithTimeout(
          fetcher,
          `${baseUrl}${enqueuePath}`,
          {
            method: enqueueMethod,
            headers: enqueueHeaders,
            cache: "no-store",
            redirect: "error"
          },
          authenticatedRequestTimeoutMs,
          async (response) => {
            const evidence = await responseEvidence(response, [
              token,
              versionAffinityKey
            ]);
            return {
              status: response.status,
              workerVersion: responseWorkerVersion(response),
              cfRay: response.headers.get("CF-Ray"),
              ...evidence
            };
          }
        );
      } catch (error) {
        handoff = currentHandoff();
        throw annotatedRequestFailure(error, {
          phase: "enqueue",
          method: enqueueMethod,
          path: enqueuePath,
          mutationPossible: true,
          handoff,
          safeRejections,
          sensitiveValues: [token, versionAffinityKey]
        });
      }

      enqueueHandoff = currentHandoff();
      if (enqueue.status === 202) break;

      const typedStale = isTypedStaleVersionRejection(
        enqueue,
        expectedVersionId
      );
      const exactLegacy = isExactLegacyPatchlessRejection(
        enqueue,
        legacyPatchlessVersionId
      );
      if (!typedStale && !exactLegacy) {
        throw new Error(
          `${remoteIngestDiagnostic({
            phase: "enqueue",
            method: enqueueMethod,
            path: enqueuePath,
            handoff: enqueueHandoff,
            safeRejections,
            ...enqueue
          })}; mutation may have occurred; do not retry`
        );
      }

      const safeRejection = safeRejectionEvidence(
        authenticatedAttempts,
        enqueue,
        typedStale ? "typed-stale-409" : "exact-legacy-404"
      );
      safeRejections.push(safeRejection);
      logger.warn(
        JSON.stringify({
          event: "remote_ingest_safe_rejection",
          ...safeRejection
        })
      );
      if (authenticatedAttempts === REMOTE_INGEST_HANDOFF_MAX_ATTEMPTS) {
        throw handoffExhaustedError(enqueueHandoff, safeRejections);
      }

      versionAffinityKey = undefined;
      const backoffMs =
        REMOTE_INGEST_HANDOFF_BACKOFF_MS[authenticatedAttempts - 1];
      if (enqueueHandoff.remainingMs <= backoffMs) {
        throw handoffDeadlineError(enqueueHandoff, safeRejections);
      }
      await sleep(backoffMs);
    }
  }

  const { payload } = enqueue;
  if (
    enqueue.status !== 202 ||
    (expectedVersionId && enqueue.workerVersion !== expectedVersionId) ||
    payload?.status !== "accepted" ||
    typeof payload?.ingestId !== "string" ||
    !payload.ingestId ||
    (expectedVersionId && payload.ingestId !== expectedVersionId) ||
    !validTimestamp(payload?.requestedAt) ||
    !validTimestamp(payload?.forecastGeneratedAt) ||
    payload.forecastGeneratedAt !== payload.requestedAt
  ) {
    throw new Error(
      `${remoteIngestDiagnostic({
        phase: "enqueue",
        method: enqueueMethod,
        path: enqueuePath,
        handoff: enqueueHandoff,
        safeRejections,
        ...enqueue
      })}; mutation may have occurred; do not retry`
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
    ...(expectedVersionId
      ? {
          workerVersion: expectedVersionId,
          versionAffinitySessions:
            enqueueHandoff?.sessionCount ?? affinitySessions.count,
          authenticatedAttempts:
            enqueueHandoff?.authenticatedAttempts ?? authenticatedAttempts
        }
      : {})
  };
}

function remoteIngestDiagnostic({
  phase,
  method,
  path,
  status,
  workerVersion,
  cfRay,
  body,
  handoff,
  safeRejections = []
}) {
  return [
    `remote ingest ${phase} failed:`,
    `${method} ${path}`,
    `status=${status}`,
    `workerVersion=${workerVersion ?? "missing"}`,
    `cfRay=${cfRay ?? "missing"}`,
    `body=${body ?? "<unavailable>"}`,
    ...(handoff ? [handoffDiagnosticContext(handoff)] : []),
    ...(handoff?.latestProbeEvidence
      ? [`latestProbe=${handoff.latestProbeEvidence}`]
      : []),
    ...(safeRejections.length > 0
      ? [`safeRejections=${safeRejectionDiagnostics(safeRejections)}`]
      : [])
  ].join(" ");
}
