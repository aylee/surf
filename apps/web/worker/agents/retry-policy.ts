export const FORECAST_BRIEF_RETRY_DELAYS_SECONDS = [
  5 * 60,
  30 * 60,
  2 * 60 * 60
] as const;

export type ForecastBriefFailureDisposition = "transient" | "regenerable" | "terminal";

export class StoredForecastFactBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredForecastFactBundleError";
  }
}

type ErrorShape = {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  isRetryable?: unknown;
  response?: { status?: unknown };
};

function errorShape(error: unknown): ErrorShape {
  return typeof error === "object" && error !== null ? (error as ErrorShape) : {};
}

function statusCodeFor(error: unknown): number | null {
  const shaped = errorShape(error);
  const candidate = shaped.statusCode ?? shaped.status ?? shaped.response?.status;
  return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : null;
}

/**
 * Classify only failures at the model-generation boundary. Unknown failures fail
 * closed so storage/programming errors are not silently retried as provider outages.
 */
export function classifyForecastBriefFailure(
  error: unknown
): ForecastBriefFailureDisposition {
  if (error instanceof StoredForecastFactBundleError) return "terminal";

  const shaped = errorShape(error);
  const statusCode = statusCodeFor(error);
  if (statusCode === 401 || statusCode === 403) return "terminal";
  if (
    shaped.isRetryable === true ||
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 429 ||
    (statusCode !== null && statusCode >= 500 && statusCode <= 599)
  ) {
    return "transient";
  }
  if (statusCode !== null && statusCode >= 400 && statusCode <= 499) return "terminal";

  const name = typeof shaped.name === "string" ? shaped.name : "";
  if (
    name === "ForecastBriefPolicyError" ||
    name === "ZodError" ||
    name === "AI_NoObjectGeneratedError" ||
    name === "AI_NoOutputGeneratedError" ||
    name === "AI_TypeValidationError" ||
    name === "AI_JSONParseError"
  ) {
    return "regenerable";
  }

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    name === "FetchError"
  ) {
    return "transient";
  }

  const message =
    typeof shaped.message === "string" ? shaped.message : typeof error === "string" ? error : "";
  if (
    /(?:network|fetch failed|timed? out|timeout|econnreset|enotfound|socket|connection|rate.?limit|quota)/i.test(
      message
    )
  ) {
    return "transient";
  }

  return "terminal";
}

export function retryDelaySecondsAfterFailure(
  attemptCount: number,
  disposition: ForecastBriefFailureDisposition = "transient"
): number | null {
  if (disposition === "terminal") return null;
  if (disposition === "regenerable") return attemptCount === 1 ? 5 * 60 : null;
  return FORECAST_BRIEF_RETRY_DELAYS_SECONDS[attemptCount - 1] ?? null;
}
