import { buildDeterministicForecastBrief } from "./brief";
import {
  countValidatedForecastBriefRevisions,
  getLatestValidatedForecastBrief,
  getLatestValidatedForecastBriefForMaterialFingerprint
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
    const [current, latest, availableRevisions] = await Promise.all([
      getLatestValidatedForecastBriefForMaterialFingerprint(
        db,
        bundle.input.spotId,
        bundle.input.localDate,
        bundle.materialFingerprint
      ),
      getLatestValidatedForecastBrief(db, bundle.input.spotId, bundle.input.localDate),
      countValidatedForecastBriefRevisions(db, bundle.input.spotId, bundle.input.localDate)
    ]);
    if (!latest && !current) {
      return ForecastBriefResponseSchema.parse({
        status: "deterministic_fallback",
        brief: buildDeterministicForecastBrief(bundle),
        fallbackReason: "No validated model brief has been published for this forecast date.",
        availableRevisions
      });
    }
    const currentExpired =
      current?.expiresAt !== null &&
      current?.expiresAt !== undefined &&
      new Date(current.expiresAt).getTime() <= now.getTime();
    if (current && !currentExpired) {
      return ForecastBriefResponseSchema.parse({
        status: "model",
        brief: current.brief,
        fallbackReason: null,
        availableRevisions
      });
    }
    const fallbackRevision = current?.brief.revision ?? latest?.brief.revision ?? 1;
    return ForecastBriefResponseSchema.parse({
      status: "stale",
      brief: buildDeterministicForecastBrief(bundle, fallbackRevision),
      fallbackReason: currentExpired
        ? "The latest validated model brief has expired."
        : "No validated model brief matches the current forecast inputs.",
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
