import { randomUUID } from "node:crypto";
import {
  isWorkerVersionId,
  responseWorkerVersion,
  SURF_EXPECTED_WORKER_VERSION_HEADER,
  workerVersionRequestHeaders
} from "./worker-version.mjs";
import { SCHEDULED_INGEST_MINUTE } from "./ingest-schedule.mjs";
import {
  readBoundedResponseJson,
  readBoundedResponseText
} from "./bounded-http-response.mjs";

export const REMOTE_INGEST_POLL_INTERVAL_MS = 5_000;
export const REMOTE_INGEST_TIMEOUT_MS = 10 * 60_000;
export const REMOTE_INGEST_REQUEST_TIMEOUT_MS = 30_000;
export const REMOTE_INGEST_HANDOFF_TIMEOUT_MS = 60_000;

const HOUR_MS = 60 * 60_000;
const SCHEDULED_INGEST_SETTLE_MS = 10 * 60_000;
const SCHEDULED_INGEST_SAFETY_MS = 60_000;
const FORECAST_INTERVALS = ["3h", "1h"];
const REMOTE_INGEST_HANDOFF_MAX_ATTEMPTS = 3;
const REMOTE_INGEST_HANDOFF_MAX_SESSIONS = 60;
const REMOTE_INGEST_HANDOFF_MAX_PROBES = 60;
const REMOTE_INGEST_HANDOFF_BACKOFF_MS = [1_000, 2_000];
const REMOTE_INGEST_PROBE_BACKOFF_MS = 1_000;
const CRON_SAFE_DEFERRAL_MAX_SLEEP_ATTEMPTS = 3;
const REMOTE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const REMOTE_ERROR_MAX_BYTES = 16 * 1024;
const REMOTE_MAX_SPOTS = 64;
const CLOUDFLARE_WORKERS_VERSION_KEY_HEADER =
  "Cloudflare-Workers-Version-Key";
const CLOUDFLARE_1102_TYPE =
  "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/";
const FORECAST_GENERATION_PATTERN =
  /^sha256:[a-f0-9]{64}(?::ingest:([A-Za-z0-9][A-Za-z0-9._-]{0,127}))?$/;

function cronSafeDeployDeferralMs(nowMs, verificationTimeoutMs, handoffTimeoutMs) {
  if (!Number.isFinite(nowMs)) {
    throw new Error("remote ingest cron-safety clock must be finite");
  }
  const protectedWindowMs =
    verificationTimeoutMs + handoffTimeoutMs + SCHEDULED_INGEST_SAFETY_MS;
  const safeWindowMs = HOUR_MS - SCHEDULED_INGEST_SETTLE_MS;
  if (!(protectedWindowMs > 0) || protectedWindowMs >= safeWindowMs) {
    throw new Error(
      `remote ingest verification window must be shorter than ${safeWindowMs}ms after including handoff and safety budgets`
    );
  }

  const hourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const cronThisHourMs = hourStartMs + SCHEDULED_INGEST_MINUTE * 60_000;
  const previousCronMs = nowMs < cronThisHourMs
    ? cronThisHourMs - HOUR_MS
    : cronThisHourMs;
  const nextCronMs = previousCronMs + HOUR_MS;
  const previousSettleBoundaryMs = previousCronMs + SCHEDULED_INGEST_SETTLE_MS;

  if (nowMs < previousSettleBoundaryMs) {
    return previousSettleBoundaryMs - nowMs;
  }
  if (nowMs + protectedWindowMs >= nextCronMs) {
    return nextCronMs + SCHEDULED_INGEST_SETTLE_MS - nowMs;
  }
  return 0;
}

async function waitForCronSafeDeployWindow(options) {
  const {
    now,
    sleep,
    logger,
    verificationTimeoutMs,
    handoffTimeoutMs
  } = options;
  const observedAtMs = now();
  const delayMs = cronSafeDeployDeferralMs(
    observedAtMs,
    verificationTimeoutMs,
    handoffTimeoutMs
  );
  if (delayMs === 0) return observedAtMs;
  if (!(delayMs > 0) || delayMs >= HOUR_MS) {
    throw new Error("remote ingest cron-safety deferral exceeded its hourly bound");
  }
  const resumeAtMs = observedAtMs + delayMs;
  logger.info?.(
    JSON.stringify({
      event: "remote_ingest_cron_deferral",
      observedAt: new Date(observedAtMs).toISOString(),
      resumeAt: new Date(resumeAtMs).toISOString(),
      delayMs,
      scheduledIngestMinute: SCHEDULED_INGEST_MINUTE,
      settleMs: SCHEDULED_INGEST_SETTLE_MS,
      verificationTimeoutMs,
      handoffTimeoutMs
    })
  );
  let previousAtMs = observedAtMs;
  for (
    let attempt = 1;
    attempt <= CRON_SAFE_DEFERRAL_MAX_SLEEP_ATTEMPTS;
    attempt += 1
  ) {
    await sleep(resumeAtMs - previousAtMs);
    const resumedAtMs = now();
    if (!Number.isFinite(resumedAtMs)) {
      throw new Error(
        "remote ingest cron-safety clock became invalid during deferral; mutation did not begin"
      );
    }
    if (resumedAtMs <= previousAtMs) {
      throw new Error(
        "remote ingest cron-safety clock did not advance during deferral; mutation did not begin"
      );
    }
    previousAtMs = resumedAtMs;
    if (resumedAtMs < resumeAtMs) continue;
    if (
      cronSafeDeployDeferralMs(
        resumedAtMs,
        verificationTimeoutMs,
        handoffTimeoutMs
      ) !== 0
    ) {
      throw new Error(
        "remote ingest cron-safety wait did not reach a safe verification window; mutation did not begin"
      );
    }
    return resumedAtMs;
  }
  throw new Error(
    "remote ingest cron-safety wait ended before the required settle boundary; mutation did not begin"
  );
}

function assertCronSafeAuthenticatedMutationWindow(now, verificationTimeoutMs) {
  const observedAtMs = now();
  if (!Number.isFinite(observedAtMs)) {
    throw new Error(
      "remote ingest cron-safety clock became invalid before authenticated PATCH; mutation did not begin"
    );
  }
  const delayMs = cronSafeDeployDeferralMs(
    observedAtMs,
    verificationTimeoutMs,
    0
  );
  if (delayMs === 0) return;
  throw new Error(
    `remote ingest cron-safety window closed before authenticated PATCH at ${new Date(observedAtMs).toISOString()}; required deferral=${delayMs}ms; mutation did not begin`
  );
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function jsonOrNull(response) {
  try {
    return await readBoundedResponseJson(response, {
      maxBytes: REMOTE_RESPONSE_MAX_BYTES,
      label: "remote ingest response"
    });
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
  const rawBody = await readBoundedResponseText(response, {
    maxBytes: REMOTE_ERROR_MAX_BYTES,
    label: "remote ingest diagnostic response"
  });
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

function isTypedPendingForecastReadiness(value) {
  return Boolean(
    exactObjectKeys(value, ["error", "message", "retryable"]) &&
      value.error === "forecast_readiness_unavailable" &&
      value.message === "Forecast readiness is temporarily unavailable." &&
      value.retryable === true
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
  if (payload.spots.length < 1 || payload.spots.length > REMOTE_MAX_SPOTS) return null;
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
          `spot catalog request failed: ${response.status} ${await readBoundedResponseText(response, { maxBytes: REMOTE_ERROR_MAX_BYTES, label: "spot catalog response" })}`
        );
      }
      const actualVersionId = responseWorkerVersion(response);
      if (expectedVersionId && actualVersionId !== expectedVersionId) {
        await cancelBody(response);
        throw new Error(
          `spot catalog was served by Worker version ${actualVersionId ?? "unknown"}; expected ${expectedVersionId}`
        );
      }
      const payload = await readBoundedResponseJson(response, {
        maxBytes: REMOTE_RESPONSE_MAX_BYTES,
        label: "spot catalog response"
      });
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

function canonicalTimestampMs(value) {
  if (typeof value !== "string") return Number.NaN;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) && new Date(timestampMs).toISOString() === value
    ? timestampMs
    : Number.NaN;
}

function invalidForecastReadinessPayload(reason) {
  throw new Error(
    `/api/forecast-readiness returned an invalid successful payload: ${reason}`
  );
}

function classifyForecastReadinessSnapshot(
  payload,
  targets,
  expectedIngestId,
  requestedAtMs,
  minimumGeneratedAtMs
) {
  if (!exactObjectKeys(payload, ["forecastReadModels"])) {
    invalidForecastReadinessPayload("expected only forecastReadModels");
  }
  if (!Array.isArray(payload.forecastReadModels)) {
    invalidForecastReadinessPayload("forecastReadModels must be an array");
  }

  const expectedTargets = new Map(
    targets.map((target) => [`${target.spotId}:${target.interval}`, target])
  );
  const observedTargets = new Map();
  for (const row of payload.forecastReadModels) {
    if (
      !exactObjectKeys(row, [
        "spotId",
        "interval",
        "generationId",
        "ingestId",
        "generatedAt",
        "materializedAt"
      ])
    ) {
      invalidForecastReadinessPayload("each row must contain only the readiness metadata fields");
    }
    if (
      typeof row.spotId !== "string" ||
      !FORECAST_INTERVALS.includes(row.interval)
    ) {
      invalidForecastReadinessPayload("row target identity is invalid");
    }
    const key = `${row.spotId}:${row.interval}`;
    if (!expectedTargets.has(key)) {
      invalidForecastReadinessPayload(`unexpected target ${key}`);
    }
    if (observedTargets.has(key)) {
      invalidForecastReadinessPayload(`duplicate target ${key}`);
    }

    if (row.generationId === null) {
      if (
        row.ingestId !== null ||
        row.generatedAt !== null ||
        row.materializedAt !== null
      ) {
        invalidForecastReadinessPayload(`missing target ${key} has partial metadata`);
      }
      observedTargets.set(key, {
        ...expectedTargets.get(key),
        ingestId: null,
        generatedAt: null,
        generatedAtMs: Number.NaN,
        materializedAt: null
      });
      continue;
    }

    if (typeof row.generationId !== "string") {
      invalidForecastReadinessPayload(`target ${key} generationId is invalid`);
    }
    const generationMatch = FORECAST_GENERATION_PATTERN.exec(row.generationId);
    const generationIngestId = generationMatch?.[1] ?? null;
    if (!generationMatch || row.ingestId !== generationIngestId) {
      invalidForecastReadinessPayload(`target ${key} generation identity is inconsistent`);
    }
    const generatedAtMs = canonicalTimestampMs(row.generatedAt);
    const materializedAtMs = canonicalTimestampMs(row.materializedAt);
    if (
      !Number.isFinite(generatedAtMs) ||
      !Number.isFinite(materializedAtMs) ||
      materializedAtMs < generatedAtMs
    ) {
      invalidForecastReadinessPayload(`target ${key} timestamps are invalid`);
    }

    observedTargets.set(key, {
      ...expectedTargets.get(key),
      ingestId: generationIngestId,
      generatedAt: row.generatedAt,
      generatedAtMs,
      materializedAtMs,
      materializedAt: row.materializedAt
    });
  }

  if (observedTargets.size !== expectedTargets.size) {
    const missing = [...expectedTargets.keys()].filter(
      (key) => !observedTargets.has(key)
    );
    invalidForecastReadinessPayload(`missing targets: ${missing.join(", ")}`);
  }

  const superseded = [...observedTargets.values()].find(
    (target) =>
      target.ingestId &&
      target.ingestId !== expectedIngestId &&
      target.generatedAtMs > minimumGeneratedAtMs
  );
  if (superseded) {
    return {
      status: "superseded",
      spotId: superseded.spotId,
      interval: superseded.interval,
      ingestId: superseded.ingestId,
      generatedAt: superseded.generatedAt,
      materializedAt: superseded.materializedAt
    };
  }

  const pending = [...observedTargets.values()].filter(
    (target) =>
      target.ingestId !== expectedIngestId ||
      target.generatedAtMs < minimumGeneratedAtMs ||
      target.materializedAtMs < requestedAtMs
  );
  if (pending.length > 0) return { status: "pending", pending };
  const latestMaterializedAt = [...observedTargets.values()]
    .map((target) => target.materializedAt)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  return { status: "ready", materializedAt: latestMaterializedAt };
}

async function inspectForecastReadinessSnapshot(
  baseUrl,
  targets,
  expectedIngestId,
  requestedAtMs,
  minimumGeneratedAtMs,
  fetcher,
  expectedVersionId,
  expectedWorkerName,
  requestTimeoutMs
) {
  const path = "/api/forecast-readiness";
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
        }),
        cache: "no-store"
      },
      requestTimeoutMs,
      async (response) => {
        if (
          expectedVersionId &&
          responseWorkerVersion(response) !== expectedVersionId
        ) {
          await cancelBody(response);
          return { status: "pending", pending: targets };
        }

        if (response.status === 503) {
          const payload = await jsonOrNull(response);
          if (
            (isJsonContentType(response.headers.get("Content-Type")) &&
              isTypedPendingForecastReadiness(payload)) ||
            isCloudflare1102Problem(payload)
          ) {
            return { status: "pending", pending: targets };
          }
          throw new Error(`${path} returned an invalid 503 response`);
        }
        if (!response.ok) {
          throw new Error(`${path} failed: ${response.status} ${await readBoundedResponseText(response, { maxBytes: REMOTE_ERROR_MAX_BYTES, label: "forecast readiness response" })}`);
        }
        if (!isJsonContentType(response.headers.get("Content-Type"))) {
          cancelBodyWithoutWaiting(response);
          invalidForecastReadinessPayload("content type must be application/json");
        }
        return classifyForecastReadinessSnapshot(
          await jsonOrNull(response),
          targets,
          expectedIngestId,
          requestedAtMs,
          minimumGeneratedAtMs
        );
      }
    );
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "TransportError") {
      return { status: "pending", pending: targets };
    }
    throw error;
  }
}

export async function inspectRemoteForecastReadModels(options) {
  const {
    baseUrl,
    ingestId,
    requestedAt,
    forecastGeneratedAt = requestedAt,
    inspectionMode = "strict",
    fetcher = globalThis.fetch,
    expectedVersionId,
    expectedWorkerName,
    requestTimeoutMs = REMOTE_INGEST_REQUEST_TIMEOUT_MS,
    spotIds: configuredSpotIdsOption
  } = options;
  const requestedAtMs = Date.parse(requestedAt);
  const minimumGeneratedAtMs = Date.parse(forecastGeneratedAt);
  if (typeof ingestId !== "string" || !ingestId) {
    throw new Error("queued ingest returned an invalid ingestId");
  }
  if (
    !Number.isFinite(requestedAtMs) ||
    !Number.isFinite(minimumGeneratedAtMs)
  ) {
    throw new Error("queued ingest reconciliation requires valid timestamps");
  }
  if (!(requestTimeoutMs > 0)) {
    throw new Error("remote ingest request timeout must be positive");
  }
  if (!["strict", "pre-enqueue"].includes(inspectionMode)) {
    throw new Error("remote ingest inspection mode is invalid");
  }

  const spotIds =
    configuredSpotIdsOption ??
    (await configuredSpotIds(
      baseUrl,
      fetcher,
      expectedVersionId,
      expectedWorkerName,
      requestTimeoutMs
    ));
  const targets = spotIds.flatMap((spotId) =>
    FORECAST_INTERVALS.map((interval) => ({ spotId, interval }))
  );
  const state = await inspectForecastReadinessSnapshot(
    baseUrl,
    targets,
    ingestId,
    requestedAtMs,
    minimumGeneratedAtMs,
    fetcher,
    expectedVersionId,
    expectedWorkerName,
    requestTimeoutMs
  );
  if (state.status === "superseded") {
    if (inspectionMode === "pre-enqueue") {
      // Before the authenticated PATCH, a newer cron lineage proves only that
      // this target is absent. The caller may enqueue a fresh target lineage.
      // Post-enqueue polling uses waitForRemoteForecastReadModels and keeps
      // supersession terminal so mixed-lineage publication cannot pass.
      return Object.freeze({
        status: "target-absent",
        ingestId,
        reason: "newer-non-target-lineage"
      });
    }
    throw new Error(
      `queued ingest ${ingestId} was superseded before release reconciliation; target=${state.spotId}:${state.interval}`
    );
  }
  if (state.status === "ready") {
    return Object.freeze({
      status: "published",
      ingestId,
      spots: spotIds.length,
      forecastReadModels: targets.length,
      materializedAt: state.materializedAt
    });
  }
  return Object.freeze({
    status: "pending",
    ingestId,
    pending: Object.freeze(
      state.pending.map(({ spotId, interval }) => `${spotId}:${interval}`)
    )
  });
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
  let pending = targets;

  while (true) {
    attempts += 1;
    const remainingBeforeRequestMs = deadlineMs - now();
    if (remainingBeforeRequestMs > 0) {
      const state = await inspectForecastReadinessSnapshot(
        baseUrl,
        targets,
        ingestId,
        requestedAtMs,
        minimumGeneratedAtMs,
        fetcher,
        expectedVersionId,
        expectedWorkerName,
        Math.min(requestTimeoutMs, remainingBeforeRequestMs)
      );
      if (state.status === "superseded") {
        throw new Error(
          `queued ingest ${ingestId} was superseded before complete publication; target=${state.spotId}:${state.interval} expectedGeneratedAt=${forecastGeneratedAt} observedIngestId=${state.ingestId} observedGeneratedAt=${state.generatedAt} observedMaterializedAt=${state.materializedAt}; exact-lineage verification cannot converge and the ingest must not be accepted as mixed-lineage success`
        );
      }
      if (state.status === "ready") {
        return {
          status: "published",
          requestedAt,
          attempts,
          spots: spotIds.length,
          forecastReadModels: targets.length,
          materializedAt: state.materializedAt
        };
      }
      pending = state.pending;
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      const pendingLabels = pending
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
    timeoutMs = REMOTE_INGEST_TIMEOUT_MS,
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
  if (!(timeoutMs > 0)) {
    throw new Error(
      "remote ingest publication timeout must be positive; mutation did not begin"
    );
  }
  if (expectedVersionId !== undefined || expectedWorkerName !== undefined) {
    // Validate the fail-closed name/version pair before a cron hold can make a
    // malformed deploy invocation wait needlessly.
    workerVersionRequestHeaders({
      expectedVersionId,
      expectedWorkerName,
      override: false
    });
  }

  // The Queue is intentionally unordered. A newer :17 source generation can
  // therefore overtake one of this deploy's per-spot children, after which the
  // immutable exact-lineage gate can never converge. Hold before even the
  // first read-only affinity session so the wait cannot age a winning key or
  // consume the shared 60-second handoff clock. No network request, token, or
  // mutation crosses this boundary until the conservative settle time.
  let cronSafeHandoffStartedAtMs;
  if (expectedVersionId) {
    cronSafeHandoffStartedAtMs = await waitForCronSafeDeployWindow({
      now,
      sleep,
      logger,
      verificationTimeoutMs: timeoutMs,
      handoffTimeoutMs
    });
  }

  let versionAffinityKey;
  let handoffStartedAtMs;
  let handoffDeadlineMs;
  let spotIds;
  const affinitySessions = { count: 0, usedKeys: new Set() };
  if (expectedVersionId) {
    handoffStartedAtMs = cronSafeHandoffStartedAtMs;
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
      // Do not sleep while holding a proven affinity session. A clock jump or
      // process suspension after the initial guard must fail before the one
      // authenticated Queue mutation, leaving a fresh deploy attempt to wait
      // outside the cron window from the beginning.
      assertCronSafeAuthenticatedMutationWindow(now, timeoutMs);
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
    spotIds,
    timeoutMs
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
