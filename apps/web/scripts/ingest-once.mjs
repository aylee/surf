#!/usr/bin/env node

import { loadRootEnv } from "../../../scripts/lib/root-env.mjs";
import { resolveIngestTarget } from "../../../scripts/lib/ingest-target.mjs";

const mode = process.argv[2];
if (mode === "--remote") loadRootEnv();
const { baseUrl, token } = resolveIngestTarget(mode, process.env);
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
const persistenceFailed =
  (summary?.errors?.length ?? 0) > 0 ||
  (summary?.sourceRuns ?? []).some(
    (run) => run?.recorded !== true || Number(run?.errorCount) > 0
  );
if (summary?.status === "failure" || persistenceFailed || !hasCoreForecastInputs) {
  throw new Error(
    `ingest completed with ${summary?.status ?? "an unknown status"}: ${JSON.stringify(summary?.errors ?? [])}`
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
