#!/usr/bin/env node

import { loadRootEnv } from "../../../scripts/lib/root-env.mjs";
import { resolveIngestTarget } from "../../../scripts/lib/ingest-target.mjs";
import {
  enqueueAndWaitForRemoteIngest,
  formatRemoteIngestReleaseReceipt,
  REMOTE_INGEST_RECEIPT_MODE_ENV,
  REMOTE_INGEST_RECEIPT_MODE_V1
} from "../../../scripts/lib/remote-ingest.mjs";
import { isWorkerVersionId } from "../../../scripts/lib/worker-version.mjs";

const mode = process.argv[2];
if (mode === "--remote") loadRootEnv();
const { baseUrl, token } = resolveIngestTarget(mode, process.env);

if (mode === "--remote") {
  const receiptMode = process.env[REMOTE_INGEST_RECEIPT_MODE_ENV];
  const expectedVersionId =
    process.env.SURF_EXPECTED_WORKER_VERSION?.trim() || undefined;
  if (
    receiptMode !== undefined &&
    receiptMode !== REMOTE_INGEST_RECEIPT_MODE_V1
  ) {
    throw new Error("Remote ingest receipt mode is invalid; mutation did not begin");
  }
  if (
    receiptMode === REMOTE_INGEST_RECEIPT_MODE_V1 &&
    !isWorkerVersionId(expectedVersionId)
  ) {
    throw new Error(
      "Release receipt mode requires an exact expected Worker version; mutation did not begin"
    );
  }
  const result = await enqueueAndWaitForRemoteIngest({
    baseUrl,
    token,
    expectedVersionId,
    expectedWorkerName: process.env.SURF_EXPECTED_WORKER_NAME?.trim() || undefined,
    // Bootstrap-only escape hatch for the one immutable production Worker
    // deployed before PATCH /api/ingest/once existed. Never persist this in
    // Wrangler or repo config; omit it after that version has aged out.
    legacyPatchlessVersionId:
      process.env.SURF_LEGACY_PATCHLESS_WORKER_VERSION?.trim() || undefined
  });
  if (receiptMode === REMOTE_INGEST_RECEIPT_MODE_V1) {
    process.stdout.write(
      `${formatRemoteIngestReleaseReceipt(result, expectedVersionId)}\n`
    );
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} else {
  const response = await fetch(`${baseUrl}/api/ingest/once`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  });
  if (!response.ok) {
    throw new Error(`ingest request failed: ${response.status} ${await response.text()}`);
  }
  const summary = await response.json();
  const counts = summary?.counts ?? {};
  const hasCoreForecastInputs =
    (Number(counts.nwsWaveForecastRows) > 0 || Number(counts.cdipMopWaveForecastRows) > 0) &&
    Number(counts.nwsWindForecastRows) > 0 &&
    Number(counts.tidePredictionRows) > 0;
  const hasPublishedReadModels =
    Number(counts.forecastReadModelRows) > 0 &&
    Number(counts.forecastFactBundleRows) > 0;
  const persistenceFailed =
    (summary?.errors?.length ?? 0) > 0 ||
    (summary?.sourceRuns ?? []).some(
      (run) => run?.recorded !== true || Number(run?.errorCount) > 0
    );
  if (
    summary?.status === "failure" ||
    persistenceFailed ||
    !hasCoreForecastInputs ||
    !hasPublishedReadModels
  ) {
    const validationFailures = [
      ...(!hasCoreForecastInputs ? ["core forecast inputs were empty"] : []),
      ...(!hasPublishedReadModels ? ["forecast read models were not published"] : [])
    ];
    throw new Error(
      `ingest completed with ${summary?.status ?? "an unknown status"}: ${JSON.stringify([
        ...(summary?.errors ?? []),
        ...validationFailures
      ])}`
    );
  }
  if (summary.status === "partial") {
    const partialSources = (summary.sourceRuns ?? [])
      .filter((run) => run?.status === "partial")
      .map((run) => run.sourceId);
    console.warn(
      `Ingest completed with non-fatal source caveats (${partialSources.join(", ") || "unspecified source"}); the strict smoke test will verify usable forecasts.`
    );
  }
  console.log(
    JSON.stringify(
      {
        status: summary.status,
        region: summary.region,
        requestedAt: summary.requestedAt,
        completedAt: summary.completedAt,
        sources: (summary.sourceRuns ?? []).map((run) => ({
          id: run.sourceId,
          status: run.status,
          rows: run.rowCount
        })),
        counts: summary.counts,
        caveatCount: summary.caveats?.length ?? 0,
        errors: summary.errors ?? []
      },
      null,
      2
    )
  );
}
