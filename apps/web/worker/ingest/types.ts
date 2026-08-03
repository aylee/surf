import type { SpotId } from "@surf/contracts";
import type { AdapterStatus, SourceCaveat } from "../adapters/types";

export type IngestKind = "manual-ingest" | "scheduled-ingest" | "queued-ingest";

export type SourceIngestQueueMessage = {
  job: "source-ingest";
  kind: "manual-ingest" | "scheduled-ingest";
  ingestId: string;
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

export type IngestQueueMessage =
  | SourceIngestQueueMessage
  | ForecastMaterializationQueueMessage;

export type SourceRunRecord = {
  id: string;
  sourceId: string;
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
  };
};

export function ingestRequiresRetry(
  summary: Pick<IngestSummary, "status" | "errors">
): boolean {
  return summary.status === "failure" || summary.errors.length > 0;
}
