export type NarrativeFeatureBindings = {
  NARRATIVE_ENABLED?: string;
  NARRATIVE_QUEUE?: Queue;
  NARRATIVE_FALLBACK_QUEUE?: Queue;
  NARRATIVE_RESULT_TOKEN?: string;
  GEMINI_API_KEY?: string;
  NARRATIVE_FALLBACK_MODEL?: string;
  NARRATIVE_FALLBACK_DELAY_SECONDS?: string;
  NARRATIVE_FALLBACK_DAILY_CAP?: string;
  NARRATIVE_FALLBACK_ROLLING_31_DAY_CAP?: string;
};

export const NARRATIVE_FALLBACK_DEFAULT_MODEL = "gemini-3.6-flash";
export const NARRATIVE_FALLBACK_DEFAULT_DELAY_SECONDS = 600;
export const NARRATIVE_FALLBACK_MAX_DELAY_SECONDS = 12 * 60 * 60;
export const NARRATIVE_FALLBACK_MAX_DAILY_ATTEMPTS = 4;
export const NARRATIVE_FALLBACK_MAX_ROLLING_31_DAY_ATTEMPTS = 100;

export type NarrativeFallbackConfig = {
  modelId: string;
  delaySeconds: number;
  dailyCap: number;
  rolling31DayCap: number;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function narrativeFallbackConfig(
  env: NarrativeFeatureBindings
): NarrativeFallbackConfig {
  const modelId = env.NARRATIVE_FALLBACK_MODEL?.trim() ||
    NARRATIVE_FALLBACK_DEFAULT_MODEL;
  if (!/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(modelId)) {
    throw new Error("NARRATIVE_FALLBACK_MODEL must be a stable model identifier");
  }
  return {
    modelId,
    delaySeconds: boundedInteger(
      env.NARRATIVE_FALLBACK_DELAY_SECONDS,
      NARRATIVE_FALLBACK_DEFAULT_DELAY_SECONDS,
      60,
      NARRATIVE_FALLBACK_MAX_DELAY_SECONDS,
      "NARRATIVE_FALLBACK_DELAY_SECONDS"
    ),
    dailyCap: boundedInteger(
      env.NARRATIVE_FALLBACK_DAILY_CAP,
      NARRATIVE_FALLBACK_MAX_DAILY_ATTEMPTS,
      1,
      NARRATIVE_FALLBACK_MAX_DAILY_ATTEMPTS,
      "NARRATIVE_FALLBACK_DAILY_CAP"
    ),
    rolling31DayCap: boundedInteger(
      env.NARRATIVE_FALLBACK_ROLLING_31_DAY_CAP,
      NARRATIVE_FALLBACK_MAX_ROLLING_31_DAY_ATTEMPTS,
      1,
      NARRATIVE_FALLBACK_MAX_ROLLING_31_DAY_ATTEMPTS,
      "NARRATIVE_FALLBACK_ROLLING_31_DAY_CAP"
    )
  };
}

export function narrativeEnabled(env: NarrativeFeatureBindings): boolean {
  if (
    env.NARRATIVE_ENABLED?.trim().toLowerCase() !== "true" ||
    !env.NARRATIVE_QUEUE ||
    !env.NARRATIVE_FALLBACK_QUEUE ||
    !env.NARRATIVE_RESULT_TOKEN?.trim() ||
    !env.GEMINI_API_KEY?.trim()
  ) {
    return false;
  }
  try {
    narrativeFallbackConfig(env);
    return true;
  } catch {
    return false;
  }
}
