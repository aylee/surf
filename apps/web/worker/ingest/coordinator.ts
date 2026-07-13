import { getOperationalObservedWaveSources, NORCAL_SPOTS } from "@surf/forecast-core";
import { fetchCdipMopForecastsForSpots } from "../adapters/cdip-mop";
import { fetchCoopsTidePredictionsForSpots } from "../adapters/coops";
import { fetchNdbcRealtimeObservationsForStations } from "../adapters/ndbc";
import { fetchNwsContextForSpots } from "../adapters/nws";
import { fetchNwsGridWaveForSpots } from "../adapters/nws-grid-wave";
import { withPublicFeedUserAgent } from "../adapters/http";
import type { SourceCaveat, SourceFetch } from "../adapters/types";
import { combineStatus } from "../adapters/types";
import { sha256StableJson } from "../forecast-history";
import type { Env } from "../index";
import {
  persistCdipMopForecasts,
  persistIssuedForecasts,
  persistNwsRows,
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
  if (!value || typeof value !== "object") {
    return {
      kind: "scheduled-ingest",
      requestedAt: new Date().toISOString(),
      region: fallbackRegion
    };
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind === "manual-ingest" || record.kind === "scheduled-ingest" ? record.kind : "scheduled-ingest";
  return {
    kind,
    requestedAt: bodyString(record.requestedAt) ?? new Date().toISOString(),
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
  }
): Promise<IngestSummary> {
  const startedAt = new Date().toISOString();
  const requestedAt = options.requestedAt ?? startedAt;
  const region = options.region ?? env.SURF_REGION;
  const now = options.now ?? new Date();
  const idSuffix = options.idSuffix ?? defaultRunIdSuffix();
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
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, nws, {
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, nwsWave, {
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, cdipMop, {
      startedAt,
      completedAt: fetchedAt,
      idSuffix
    }),
    await recordSourceRun(env.DB, ndbc, {
      startedAt,
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
  const normalizedPersistence = [
    tidePersistence,
    nwsPersistence,
    wavePersistence,
    cdipMopPersistence,
    observationPersistence
  ];
  const artifactPersistence = [
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, coopsRun, captures[0], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, nwsRun, captures[1], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, nwsWaveRun, captures[2], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, cdipMopRun, captures[3], idSuffix, fetchedAt),
    await persistRawArtifacts(env.RAW_ARTIFACTS, env.DB, ndbcRun, captures[4], idSuffix, fetchedAt)
  ];
  const completedAt = new Date().toISOString();
  const finalizedRuns = [
    await finalizeSourceRun(env.DB, coopsRun, coops, normalizedPersistence[0]!, artifactPersistence[0]!, completedAt),
    await finalizeSourceRun(env.DB, nwsRun, nws, normalizedPersistence[1]!, artifactPersistence[1]!, completedAt),
    await finalizeSourceRun(env.DB, nwsWaveRun, nwsWave, normalizedPersistence[2]!, artifactPersistence[2]!, completedAt),
    await finalizeSourceRun(env.DB, cdipMopRun, cdipMop, normalizedPersistence[3]!, artifactPersistence[3]!, completedAt),
    await finalizeSourceRun(env.DB, ndbcRun, ndbc, normalizedPersistence[4]!, artifactPersistence[4]!, completedAt)
  ];
  const snapshotPersistence = captureHistory
    ? await persistIssuedForecasts(env, now, completedAt, sourceIssueFingerprint)
    : { rowsWritten: 0, errors: [] };
  const retentionPersistence = captureHistory
    ? await pruneRetainedData(env.DB, now)
    : { rowsWritten: 0, errors: [] };

  const dbErrors = finalizedRuns.flatMap((run) => (run.recorded ? [] : [`${run.sourceId}: ${run.error}`]));
  const persistenceErrors = [
    ...tidePersistence.errors,
    ...nwsPersistence.errors,
    ...wavePersistence.errors,
    ...cdipMopPersistence.errors,
    ...observationPersistence.errors,
    ...artifactPersistence.flatMap((result) => result.errors),
    ...snapshotPersistence.errors,
    ...retentionPersistence.errors
  ];
  const adapterErrors = outcomes.flatMap((outcome) => outcome.errors);
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
      forecastSnapshotRows: snapshotPersistence.rowsWritten
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
    dbContract: SOURCE_RUNS_CONTRACT
  };
}
