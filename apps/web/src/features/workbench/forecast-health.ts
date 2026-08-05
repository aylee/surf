import {
  ForecastResponseSchema,
  sourceFreshnessVerdict,
  type ForecastResponse,
  type SourceFreshness
} from "@surf/contracts";

const MINUTE_MS = 60_000;

function hasScoredWindow(forecast: ForecastResponse): boolean {
  return forecast.windows.some((window) => (
    window.ratingStatus === "scored" &&
    Number.isFinite(new Date(window.forecastAt).getTime())
  ));
}

// Ages the stored materialization forward with the browser clock. The status
// re-derivation uses only the entry's own adapter-declared cadence via the
// shared contracts verdict — this module owns no freshness thresholds.
// Pre-cadence entries keep the status the Worker shipped.
function ageSourceFreshness(
  source: SourceFreshness,
  elapsedMinutes: number
): SourceFreshness {
  const freshnessMinutes = source.freshnessMinutes === null
    ? null
    : source.freshnessMinutes + elapsedMinutes;
  const aged = { ...source, freshnessMinutes };
  if (freshnessMinutes === null) return { ...aged, status: "missing" };
  const verdict = sourceFreshnessVerdict(aged);
  if (verdict === null) return aged;
  return { ...aged, status: verdict === "late" ? "stale" : "fresh" };
}

export function ageForecastFreshness(
  forecast: ForecastResponse,
  now = new Date()
): ForecastResponse {
  const generatedAtMs = Date.parse(forecast.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return forecast;
  const elapsedMinutes = Math.max(
    0,
    Math.round((now.getTime() - generatedAtMs) / MINUTE_MS)
  );
  if (elapsedMinutes === 0) return forecast;

  const ageObservation = (observation: NonNullable<ForecastResponse["observation"]>) => ({
    ...observation,
    sourceFreshnessMinutes: observation.sourceFreshnessMinutes + elapsedMinutes
  });

  return {
    ...forecast,
    windows: forecast.windows.map((window) => ({
      ...window,
      sourceFreshnessMinutes: window.sourceFreshnessMinutes + elapsedMinutes,
      sourceFreshness: window.sourceFreshness?.map((source) =>
        ageSourceFreshness(source, elapsedMinutes)
      )
    })),
    observation: forecast.observation ? ageObservation(forecast.observation) : forecast.observation,
    observations: forecast.observations?.map(ageObservation)
  };
}

export function parseUsableForecastResponse(
  value: unknown,
  now = new Date()
): ForecastResponse {
  const parsed = ForecastResponseSchema.safeParse(value);
  if (!parsed.success || !hasScoredWindow(parsed.data)) {
    throw new Error("Forecast update did not contain a usable window");
  }
  return ageForecastFreshness(parsed.data, now);
}

export function isUsableForecastResponse(value: unknown): value is ForecastResponse {
  const parsed = ForecastResponseSchema.safeParse(value);
  return parsed.success && hasScoredWindow(parsed.data);
}
