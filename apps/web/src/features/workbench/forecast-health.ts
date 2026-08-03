import {
  ForecastResponseSchema,
  type ForecastResponse,
  type SourceCapability,
  type SourceFreshness
} from "@surf/contracts";

const MINUTE_MS = 60_000;

// Mirrors the temporal source contracts used when the Worker materializes a
// forecast. Static and derived capabilities retain their published status.
const staleAfterMinutes: Partial<Record<SourceCapability, number>> = {
  forecast_wave_offshore: 12 * 60,
  forecast_wave_nearshore: 12 * 60,
  observed_wave: 2 * 60,
  tide: 12 * 60,
  wind: 6 * 60,
  hazard: 6 * 60,
  comparison_forecast: 12 * 60
};

function hasScoredWindow(forecast: ForecastResponse): boolean {
  return forecast.windows.some((window) => (
    window.ratingStatus === "scored" &&
    Number.isFinite(new Date(window.forecastAt).getTime())
  ));
}

function ageSourceFreshness(
  source: SourceFreshness,
  elapsedMinutes: number
): SourceFreshness {
  const freshnessMinutes = source.freshnessMinutes === null
    ? null
    : source.freshnessMinutes + elapsedMinutes;
  const staleAfter = staleAfterMinutes[source.capability];
  const status = freshnessMinutes === null
    ? "missing"
    : staleAfter === undefined
      ? source.status
      : freshnessMinutes <= staleAfter
        ? "fresh"
        : "stale";
  return { ...source, freshnessMinutes, status };
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
