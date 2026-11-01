import type { IngestKind } from "./types";

// Raw bodies support incident diagnosis, not forecast reads or video replay.
// UTC generation time makes sampling stable across delayed Queue deliveries.
export const RAW_ARTIFACT_RETENTION_DAYS = 30;
// Keep references beyond normal upload-age expiry and processing lag.
export const RAW_ARTIFACT_METADATA_RETENTION_DAYS = 35;
export const RAW_ARTIFACT_PROVIDER_PREFIXES = [
  "cdip-mop-forecast",
  "coops-tide-predictions",
  "ndbc-realtime2-standard-meteorological",
  "nws-mtr-grid-wave",
  "nws-point-forecast-alerts"
] as const;
export const RAW_CAPTURE_CADENCE_HOURS = 6;
export const RAW_CAPTURE_BATCH_LIMIT_BYTES = 2 * 1024 * 1024;
export const RAW_CAPTURE_MAX_RESPONSES = 40;

export function shouldCaptureRawArtifacts(kind: IngestKind, generation: Date): boolean {
  return kind === "manual-ingest" || generation.getUTCHours() % RAW_CAPTURE_CADENCE_HOURS === 0;
}

export function rawArtifactsAvailableUntil(generationAt: string): string {
  // Date partitions are immutable even when a delivery crosses midnight.
  // Lifecycle expiry is conservative: never promise availability past the
  // generation-date boundary, even if an object was actually written later.
  const midnight = Date.parse(`${generationAt.slice(0, 10)}T00:00:00.000Z`);
  return new Date(midnight + RAW_ARTIFACT_RETENTION_DAYS * 86_400_000).toISOString();
}

export function rawArtifactMetadataExpiresAt(createdAt: string): string {
  // Use persistence time rather than generation midnight: a delayed delivery
  // must still retain its references for five days beyond upload-age expiry.
  return new Date(Date.parse(createdAt) + RAW_ARTIFACT_METADATA_RETENTION_DAYS * 86_400_000).toISOString();
}
