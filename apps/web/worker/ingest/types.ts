import type { SpotId } from "@surf/contracts";
import type { AdapterStatus, SourceCaveat } from "../adapters/types";
import type { ForecastMaterializationOutcome } from "../forecast-read-model";

export type IngestKind = "manual-ingest" | "scheduled-ingest" | "queued-ingest";

export type SourceIngestQueueMessage = {
  job: "source-ingest";
  kind: "manual-ingest" | "scheduled-ingest";
  ingestId: string;
  requestedAt: string;
  forecastGeneratedAt: string;
  region: string;
};

export type SourceBatchQueueMessage = {
  job: "source-batch";
  schemaVersion: 1;
  kind: "manual-ingest" | "scheduled-ingest";
  ingestId: string;
  batchKey: string;
  spotIds: SpotId[];
  requestedAt: string;
  forecastGeneratedAt: string;
  region: string;
};

export type ForecastMaterializationQueueMessage = {
  job: "forecast-materialization";
  ingestId: string;
  spotId: SpotId;
  requestedAt: string;
  region: string;
  generatedAt: string;
  sourceCompletedAt: string;
  captureHistory: boolean;
};

export const SURF_ANALYSIS_SIGNAL_SCHEMA_VERSION = 1 as const;
// Analysis is advisory to deterministic forecast publication. This signal is
// deliberately ACK-only: ledger reconciliation and the next exact generation
// recover delivery without spending the source-ingest retry/DLQ budget.
export const SURF_ANALYSIS_SIGNAL_MAX_QUEUE_RETRIES = 0 as const;

export type SurfAnalysisSignalQueueMessage = {
  job: "analysis-signal";
  schemaVersion: typeof SURF_ANALYSIS_SIGNAL_SCHEMA_VERSION;
  domain: "surf";
  ingestId: string;
  spotId: SpotId;
  generationId: string;
  generatedAt: string;
  materializedAt: string;
  region: string;
};

export type IngestQueueMessage =
  | SourceIngestQueueMessage
  | SourceBatchQueueMessage
  | ForecastMaterializationQueueMessage
  | SurfAnalysisSignalQueueMessage;

export type SourceRunRecord = {
  id: string;
  sourceId: string;
  startedAt: string;
  status: AdapterStatus;
  recorded: boolean;
  rowCount: number;
  caveatCount: number;
  errorCount: number;
  error: string | null;
};

export type PersistenceResult = {
  rowsWritten: number;
  errors: string[];
};

export type RawCapture = {
  requestUrl: string;
  contentType: string;
  capturedAt: string;
  body: ArrayBuffer;
};

export type CaptureBuffer = {
  items: RawCapture[];
  errors: string[];
};

export type ArtifactPersistenceResult = PersistenceResult & {
  manifestKey: string | null;
  manifestJson: string | null;
};

export type PendingStatement = {
  label: string;
  statement: D1PreparedStatement;
};

export type IngestSummary = {
  kind: IngestKind;
  region: string;
  requestedAt: string;
  startedAt: string;
  completedAt: string;
  status: AdapterStatus;
  sourceRuns: SourceRunRecord[];
  counts: {
    tidePredictionRows: number;
    nwsSpotContexts: number;
    nwsWindForecastRows: number;
    nwsHazards: number;
    nwsWaveForecastRows: number;
    cdipMopWaveForecastRows: number;
    ndbcObservationRows: number;
    forecastSnapshotRows: number;
    forecastReadModelRows: number;
    forecastFactBundleRows: number;
  };
  caveats: SourceCaveat[];
  errors: string[];
  dbContract: string;
  publication: {
    ingestId: string;
    generatedAt: string;
    sourceCompletedAt: string;
    sourceIssueFingerprint: string;
    sourcePersistenceReady: boolean;
    sourcePersistenceErrors: string[];
    deferred: boolean;
    captureHistory: boolean;
    forecastOutcomes: ForecastMaterializationOutcome[];
  };
};

export function ingestRequiresRetry(
  summary: Pick<IngestSummary, "status" | "errors">
): boolean {
  return summary.status === "failure" || summary.errors.length > 0;
}
