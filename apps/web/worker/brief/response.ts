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
  } catch (error) {
    const errorName = error instanceof Error && error.name ? error.name : "UnknownError";
    const errorMessage = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .slice(0, 240);
    console.warn(
      JSON.stringify({
        message: "forecast brief storage read used the fact-based summary",
        spotId: bundle.input.spotId,
        localDate: bundle.input.localDate,
        errorName,
        errorMessage
      })
    );
    return ForecastBriefResponseSchema.parse({
      status: "deterministic_fallback",
      brief: buildDeterministicForecastBrief(bundle),
      fallbackReason: null,
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
