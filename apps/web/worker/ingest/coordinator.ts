import {
  getOperationalObservedWaveSources,
  isNorcalSpotId,
  NORCAL_SPOTS
} from "@surf/forecast-core";
import { fetchCdipMopForecastsForSpots } from "../adapters/cdip-mop";
import { fetchCoopsTidePredictionsForSpots } from "../adapters/coops";
import { fetchNdbcRealtimeObservationsForStations } from "../adapters/ndbc";
import { fetchNwsContextForSpots } from "../adapters/nws";
import { fetchNwsGridWaveForSpots } from "../adapters/nws-grid-wave";
import { withPublicFeedUserAgent } from "../adapters/http";
import type { SourceCaveat, SourceFetch } from "../adapters/types";
import { combineStatus } from "../adapters/types";
import { sha256StableJson } from "../forecast-history";
import { materializeForecastReadModels } from "../forecast-read-model";
import type { Env } from "../index";
import {
  persistCdipMopForecasts,
  persistIssuedForecasts,
  persistNwsRows,
  persistTideEvents,
  persistTideForecasts,
  persistWaveForecasts,
  persistWaveObservations
} from "./normalized-data";
import {
  capturingFetcher,
  CDIP_RAW_CAPTURE_LIMIT_BYTES,
  persistRawArtifacts
} from "./raw-artifacts";
import { pruneRetainedData } from "./retention";
import {
  defaultRunIdSuffix,
  finalizeSourceRun,
  recordSourceRun,
  SOURCE_RUNS_CONTRACT
} from "./source-runs";
import type {
  CaptureBuffer,
  IngestKind,
  IngestQueueMessage,
  IngestSummary
} from "./types";

const NDBC_REALTIME_STATIONS = [
  ...new Set(
    NORCAL_SPOTS.flatMap((spot) =>
      getOperationalObservedWaveSources(spot).map((source) => source.stationId)
    )
  )
];

export function shouldCaptureForecastHistory(kind: IngestKind, requestedAt: string): boolean {
  if (kind === "manual-ingest") return true;
  const time = new Date(requestedAt);
  return !Number.isNaN(time.getTime()) && time.getUTCHours() % 6 === 0;
}

function bodyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeIngestMessage(value: unknown, fallbackRegion: string): IngestQueueMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ingest queue message must be an object");
  }

  const record = value as Record<string, unknown>;
  if (record.job === "forecast-materialization") {
    const spotId = bodyString(record.spotId);
    const ingestId = bodyString(record.ingestId);
    const requestedAt = bodyString(record.requestedAt);
    const generatedAt = bodyString(record.generatedAt);
    const sourceCompletedAt = bodyString(record.sourceCompletedAt);
    if (
      !spotId ||
      !isNorcalSpotId(spotId) ||
      !ingestId ||
      !requestedAt ||
      !generatedAt ||
      !sourceCompletedAt ||
      !Number.isFinite(Date.parse(requestedAt)) ||
      !Number.isFinite(Date.parse(generatedAt)) ||
      !Number.isFinite(Date.parse(sourceCompletedAt))
    ) {
      throw new Error("Forecast materialization queue message is invalid");
    }
    return {
      job: "forecast-materialization",
      ingestId,
      spotId,
      requestedAt,
      region: bodyString(record.region) ?? fallbackRegion,
      generatedAt,
      sourceCompletedAt,
      captureHistory: record.captureHistory === true
    };
  }
  if (record.job !== undefined && record.job !== "source-ingest") {
    throw new Error("Ingest queue message has an unknown job type");
  }
  const hasValidKind = record.kind === "manual-ingest" || record.kind === "scheduled-ingest";
  if (record.job === undefined && !hasValidKind) {
    throw new Error("Legacy ingest queue message is invalid");
  }
  const kind: "manual-ingest" | "scheduled-ingest" =
    record.kind === "manual-ingest" ? "manual-ingest" : "scheduled-ingest";
  const requestedAt = bodyString(record.requestedAt);
  const forecastGeneratedAt = bodyString(record.forecastGeneratedAt);
  const ingestId = bodyString(record.ingestId);
  if (
    !requestedAt ||
    !Number.isFinite(Date.parse(requestedAt)) ||
    (record.job === "source-ingest" &&
      (!ingestId ||
        !forecastGeneratedAt ||
        !Number.isFinite(Date.parse(forecastGeneratedAt))))
  ) {
    throw new Error("Source ingest queue message is invalid");
  }
  const legacyIngestId = `legacy-${requestedAt.replace(/[^0-9]/g, "")}`;
  return {
    job: "source-ingest",
    kind,
    ingestId: ingestId ?? legacyIngestId,
    requestedAt,
    forecastGeneratedAt:
      forecastGeneratedAt && Number.isFinite(Date.parse(forecastGeneratedAt))
        ? forecastGeneratedAt
        : requestedAt,
    region: bodyString(record.region) ?? fallbackRegion
  };
}

export async function runNorcalIngest(
  env: Env,
  options: {
    kind: IngestKind;
    requestedAt?: string;
    region?: string;
    fetcher?: SourceFetch;
    now?: Date;
    idSuffix?: string;
    ingestId?: string;
    deferForecastMaterialization?: boolean;
  }
): Promise<IngestSummary> {
  const startedAt = new Date().toISOString();
  const requestedAt = options.requestedAt ?? startedAt;
  const region = options.region ?? env.SURF_REGION;
  const now = options.now ?? new Date();
  // Queue retries keep this logical generation timestamp stable. Persist it in
  // source_runs.started_at so the existing time index can fence unordered
  // source jobs without ordering them by whichever provider fetch finished last.
  const sourceGenerationAt = now.toISOString();
  const ingestId = options.ingestId ?? options.idSuffix ?? defaultRunIdSuffix();
  const idSuffix = options.idSuffix ?? ingestId;
  const captureHistory = shouldCaptureForecastHistory(options.kind, requestedAt);
  const horizonHours = 120;
  const caveats: SourceCaveat[] = [];

  if (region !== "norcal") {
    caveats.push({
      code: "ingest_region_unsupported",
      message: `Only norcal v1 spots are configured; received region ${region}.`
    });
  }

  const baseFetcher = withPublicFeedUserAgent(
    options.fetcher ?? globalThis.fetch.bind(globalThis),
    env.SURF_USER_AGENT
  );
  const captures: [CaptureBuffer, CaptureBuffer, CaptureBuffer, CaptureBuffer, CaptureBuffer] = [
    { items: [], errors: [] },
    { items: [], errors: [] },
    { items: [], errors: [] },
    { items: [], errors: [] },
    { items: [], errors: [] }
  ];
  const [coops, nws, nwsWave, cdipMop, ndbc] = await Promise.all([
    fetchCoopsTidePredictionsForSpots(NORCAL_SPOTS, {
      fetcher: capturingFetcher(baseFetcher, captures[0]),
      now,
      horizonHours
    }),
    fetchNwsContextForSpots(NORCAL_SPOTS, {
      fetcher: capturingFetcher(baseFetcher, captures[1])
    }),
    fetchNwsGridWaveForSpots(NORCAL_SPOTS, {
      fetcher: capturingFetcher(baseFetcher, captures[2]),
      now,
      horizonHours
    }),
    fetchCdipMopForecastsForSpots(NORCAL_SPOTS, {
      fetcher: capturingFetcher(baseFetcher, captures[3], CDIP_RAW_CAPTURE_LIMIT_BYTES),
      now,
      horizonHours
    }),
    fetchNdbcRealtimeObservationsForStations(NDBC_REALTIME_STATIONS, {
      fetcher: capturingFetcher(baseFetcher, captures[4]),
      now
    })
  ]);

  const fetchedAt = new Date().toISOString();
  const outcomes = [coops, nws, nwsWave, cdipMop, ndbc] as const;
  const sourceIssueFingerprint = await sha256StableJson({
    coops: coops.rows,
    nws: nws.rows,
    nwsWave: nwsWave.rows,
    cdipMop: cdipMop.rows
  });
  const sourceRuns = [
    await recordSourceRun(env.DB, coops, {
      startedAt: sourceGenerationAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, nws, {
      startedAt: sourceGenerationAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, nwsWave, {
      startedAt: sourceGenerationAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, cdipMop, {
      startedAt: sourceGenerationAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, ndbc, {
      startedAt: sourceGenerationAt,
      completedAt: fetchedAt,
      idSuffix
    })
  ];
  const coopsRun = sourceRuns[0]!;
  const nwsRun = sourceRuns[1]!;
  const nwsWaveRun = sourceRuns[2]!;
  const cdipMopRun = sourceRuns[3]!;
  const ndbcRun = sourceRuns[4]!;
  const tidePersistence = await persistTideForecasts(env.DB, coopsRun.id, coops.rows, fetchedAt);
  const tideEventPersistence = await persistTideEvents(env.DB, coopsRun.id, coops.events, fetchedAt);
  const nwsPersistence = await persistNwsRows(
    env.DB,
    nwsRun.id,
    nws.rows,
    fetchedAt,
    captureHistory
  );
  const wavePersistence = await persistWaveForecasts(env.DB, nwsWaveRun.id, nwsWave.rows, fetchedAt);
  const cdipMopPersistence = await persistCdipMopForecasts(env.DB, cdipMopRun.id, cdipMop.rows, fetchedAt);
  const observationPersistence = await persistWaveObservations(env.DB, ndbcRun.id, ndbc.rows, fetchedAt);
  const artifactPersistence = [
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, coopsRun, captures[0], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, nwsRun, captures[1], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, nwsWaveRun, captures[2], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, cdipMopRun, captures[3], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, ndbcRun, captures[4], idSuffix, fetchedAt)
  ];
  const completedAt = new Date().toISOString();
  const finalizedRuns = [
    await finalizeSourceRun(
      env.DB,
      coopsRun,
      coops,
      {
        rowsWritten: tidePersistence.rowsWritten + tideEventPersistence.rowsWritten,
        errors: [...tidePersistence.errors, ...tideEventPersistence.errors]
      },
      artifactPersistence[0]!,
      completedAt
    ),
    await finalizeSourceRun(env.DB, nwsRun, nws, nwsPersistence, artifactPersistence[1]!, completedAt),
    await finalizeSourceRun(env.DB, nwsWaveRun, nwsWave, wavePersistence, artifactPersistence[2]!, completedAt),
    await finalizeSourceRun(env.DB, cdipMopRun, cdipMop, cdipMopPersistence, artifactPersistence[3]!, completedAt),
    await finalizeSourceRun(env.DB, ndbcRun, ndbc, observationPersistence, artifactPersistence[4]!, completedAt)
  ];
  const snapshotPersistence = captureHistory && !options.deferForecastMaterialization
    ? await persistIssuedForecasts(env, now, completedAt)
    : { rowsWritten: 0, errors: [] };
  const retentionPersistence = captureHistory
    ? await pruneRetainedData(env.DB, now)
    : { rowsWritten: 0, errors: [] };

  const dbErrors = finalizedRuns.flatMap((run) => (run.recorded ? [] : [`${run.sourceId}: ${run.error}`]));
  const sourceRunRecordErrors = sourceRuns.flatMap((run) =>
    run.recorded ? [] : [`${run.sourceId}: ${run.error}`]
  );
  const sourcePersistenceErrors = [
    ...sourceRunRecordErrors,
    ...dbErrors,
    ...tidePersistence.errors,
    ...tideEventPersistence.errors,
    ...nwsPersistence.errors,
    ...wavePersistence.errors,
    ...cdipMopPersistence.errors,
    ...observationPersistence.errors
  ];
  const adapterErrors = outcomes.flatMap((outcome) => outcome.errors);
  const preMaterializationErrors = [
    ...tidePersistence.errors,
    ...tideEventPersistence.errors,
    ...nwsPersistence.errors,
    ...wavePersistence.errors,
    ...cdipMopPersistence.errors,
    ...observationPersistence.errors,
    ...artifactPersistence.flatMap((result) => result.errors),
    ...snapshotPersistence.errors,
    ...retentionPersistence.errors
  ];
  // Publication is evaluated per spot from the normalized rows that are
  // actually readable. Optional observations, raw-artifact archival,
  // history, retention, or another spot's provider error must not freeze all
  // healthy forecasts. Each spot materialization independently refuses an
  // unscored generation and preserves its prior row.
  const readModelPersistence = options.deferForecastMaterialization
    ? { rowsWritten: 0, forecastRowsWritten: 0, factBundleRowsWritten: 0, errors: [] }
    : await materializeForecastReadModels(env, now, sourceIssueFingerprint, completedAt);
  const persistenceErrors = [
    ...sourceRunRecordErrors,
    ...preMaterializationErrors,
    ...readModelPersistence.errors
  ];
  const dbCaveats = finalizedRuns.flatMap((run): SourceCaveat[] =>
    run.recorded
      ? []
      : [
          {
            code: "source_run_not_recorded",
            message: `${run.sourceId} did not persist to source_runs: ${run.error}`
          }
        ]
  );
  const persistenceCaveats: SourceCaveat[] = persistenceErrors.map((error) => ({
    code: "normalized_row_not_recorded",
    message: error
  }));
  const status = combineStatus([
    combineStatus(outcomes.map((outcome) => outcome.status)),
    combineStatus(finalizedRuns.map((run) => run.status)),
    dbErrors.length > 0 || persistenceErrors.length > 0 ? "failure" : "success"
  ]);

  return {
    kind: options.kind,
    region,
    requestedAt,
    startedAt,
    completedAt,
    status,
    sourceRuns: finalizedRuns,
    counts: {
      tidePredictionRows: coops.rows.length,
      nwsSpotContexts: nws.rows.length,
      nwsWindForecastRows: nws.metadata.windRowCount,
      nwsHazards: nws.metadata.hazardCount,
      nwsWaveForecastRows: nwsWave.rows.length,
      cdipMopWaveForecastRows: cdipMop.rows.length,
      ndbcObservationRows: ndbc.rows.length,
      forecastSnapshotRows: snapshotPersistence.rowsWritten,
      forecastReadModelRows: readModelPersistence.forecastRowsWritten,
      forecastFactBundleRows: readModelPersistence.factBundleRowsWritten
    },
    caveats: [
      ...caveats,
      ...coops.caveats,
      ...nws.caveats,
      ...nwsWave.caveats,
      ...cdipMop.caveats,
      ...ndbc.caveats,
      ...dbCaveats,
      ...persistenceCaveats
    ],
    errors: [...adapterErrors, ...dbErrors, ...persistenceErrors],
    dbContract: SOURCE_RUNS_CONTRACT,
    publication: {
      ingestId,
      generatedAt: now.toISOString(),
      sourceCompletedAt: completedAt,
      sourceIssueFingerprint,
      sourcePersistenceReady: sourcePersistenceErrors.length === 0,
      sourcePersistenceErrors,
      deferred: options.deferForecastMaterialization === true,
      captureHistory
    }
  };
}
