export const FORECAST_BRIEF_RETRY_DELAYS_SECONDS = [
  5 * 60,
  30 * 60,
  2 * 60 * 60
] as const;

export function retryDelaySecondsAfterFailure(attemptCount: number): number | null {
  return FORECAST_BRIEF_RETRY_DELAYS_SECONDS[attemptCount - 1] ?? null;
}
