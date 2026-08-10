import {
  SurfAnalysisResponseV3Schema,
  type SurfAnalysisResponseV3
} from "@surf/contracts";
import type { ForecastFactBundle } from "../brief/types";
import { boundedErrorName } from "../logging";
import {
  getLatestNarrativeJobForFacts,
  NARRATIVE_MAX_ENQUEUE_ATTEMPTS
} from "../narrative/repository";
import { buildSurfAnalysisSnapshot } from "./snapshot";
import {
  SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
  SURF_ANALYSIS_PROMPT_VERSION,
  SURF_ANALYSIS_RESULT_TARGET
} from "./types";
import {
  countSurfAnalysisRevisions,
  getLatestSurfAnalysisRevision
} from "./repository";

export function unavailableSurfAnalysisResponse(
  availableRevisions = 0
): SurfAnalysisResponseV3 {
  return SurfAnalysisResponseV3Schema.parse({
    schemaVersion: 3,
    status: "unavailable",
    report: null,
    message: "Analysis unavailable",
    detail: "No validated report is available for this forecast.",
    availableRevisions
  });
}

export async function buildSurfAnalysisResponse(
  db: D1Database,
  bundle: ForecastFactBundle,
  now = new Date(),
  pipelineEnabled = true
): Promise<SurfAnalysisResponseV3> {
  if (bundle.input.recommendationWindowIds.length === 0) {
    return unavailableSurfAnalysisResponse();
  }
  try {
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const [revision, job, availableRevisions] = await Promise.all([
      getLatestSurfAnalysisRevision({
        db,
        spotId: bundle.input.spotId,
        localDate: bundle.input.localDate,
        factFingerprint: snapshot.factFingerprint
      }),
      getLatestNarrativeJobForFacts({
        db,
        domain: "surf",
        entityId: bundle.input.spotId,
        localDate: bundle.input.localDate,
        factFingerprint: snapshot.factFingerprint,
        promptVersion: SURF_ANALYSIS_PROMPT_VERSION,
        outputSchemaVersion: SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
        resultTarget: SURF_ANALYSIS_RESULT_TARGET
      }),
      countSurfAnalysisRevisions(db, bundle.input.spotId, bundle.input.localDate)
    ]);
    if (revision) {
      return SurfAnalysisResponseV3Schema.parse({
        schemaVersion: 3,
        status: "published",
        report: revision.report,
        availableRevisions
      });
    }
    if (!pipelineEnabled) {
      return unavailableSurfAnalysisResponse(availableRevisions);
    }
    const activeLease =
      job?.enqueueLeaseUntil !== null &&
      job?.enqueueLeaseUntil !== undefined &&
      new Date(job.enqueueLeaseUntil).getTime() > now.getTime();
    const hasEnqueueAttemptRemaining =
      job !== null && job.enqueueAttempts < NARRATIVE_MAX_ENQUEUE_ATTEMPTS;
    const pending =
      job !== null &&
      new Date(job.job.deadlineAt).getTime() > now.getTime() &&
      ((job.status === "pending" && job.enqueuedAt !== null) ||
        (job.status === "enqueueing" &&
          (activeLease || hasEnqueueAttemptRemaining)) ||
        (job.status === "enqueue_failed" && hasEnqueueAttemptRemaining));
    if (pending) {
      return SurfAnalysisResponseV3Schema.parse({
        schemaVersion: 3,
        status: "pending",
        report: null,
        message: "Analysis is being prepared.",
        availableRevisions
      });
    }
    return unavailableSurfAnalysisResponse(availableRevisions);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "surf_analysis_storage_read_failed",
        message: "Analysis storage read failed closed",
        spotId: bundle.input.spotId,
        localDate: bundle.input.localDate,
        reasonCode: "analysis_storage_read_failed",
        errorName: boundedErrorName(error)
      })
    );
    return unavailableSurfAnalysisResponse();
  }
}
