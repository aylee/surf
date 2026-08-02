import { buildDeterministicForecastBrief } from "./brief";
import {
  countValidatedForecastBriefRevisions,
  getLatestValidatedForecastBrief
} from "./repository";
import {
  ForecastBriefResponseSchema,
  type ForecastBriefResponse,
  type ForecastFactBundle
} from "./types";

export async function buildForecastBriefResponse(
  db: D1Database,
  bundle: ForecastFactBundle,
  now = new Date()
): Promise<ForecastBriefResponse> {
  try {
    const [latest, availableRevisions] = await Promise.all([
      getLatestValidatedForecastBrief(db, bundle.input.spotId, bundle.input.localDate),
      countValidatedForecastBriefRevisions(db, bundle.input.spotId, bundle.input.localDate)
    ]);
    if (!latest) {
      return ForecastBriefResponseSchema.parse({
        status: "deterministic_fallback",
        brief: buildDeterministicForecastBrief(bundle),
        fallbackReason: "No validated model brief has been published for this forecast date.",
        availableRevisions
      });
    }
    const expired =
      latest.expiresAt !== null && new Date(latest.expiresAt).getTime() <= now.getTime();
    const materiallyCurrent = latest.materialFingerprint === bundle.materialFingerprint;
    if (!expired && materiallyCurrent) {
      return ForecastBriefResponseSchema.parse({
        status: "model",
        brief: latest.brief,
        fallbackReason: null,
        availableRevisions
      });
    }
    return ForecastBriefResponseSchema.parse({
      status: "stale",
      brief: buildDeterministicForecastBrief(bundle, latest.brief.revision),
      fallbackReason: expired
        ? "The latest validated model brief has expired."
        : "Forecast inputs changed materially after the latest validated model brief.",
      availableRevisions
    });
  } catch {
    return ForecastBriefResponseSchema.parse({
      status: "deterministic_fallback",
      brief: buildDeterministicForecastBrief(bundle),
      fallbackReason: "Model brief storage is unavailable.",
      availableRevisions: 0
    });
  }
}

export function buildDisabledForecastBriefResponse(
  bundle: ForecastFactBundle
): ForecastBriefResponse {
  return ForecastBriefResponseSchema.parse({
    status: "deterministic_fallback",
    brief: buildDeterministicForecastBrief(bundle),
    fallbackReason: "AI forecast briefs are disabled for this Worker version.",
    availableRevisions: 0
  });
}
