import type { SpotId } from "@surf/contracts";
import { isNorcalSpotId, NORCAL_SPOTS } from "@surf/forecast-core";

export const SOURCE_BATCH_SCHEMA_VERSION = 1 as const;
export const SOURCE_BATCH_MAX_SPOTS = 4;

export type ConfiguredSourceBatch = Readonly<{
  batchKey: string;
  spotIds: readonly SpotId[];
}>;

export function canonicalSourceBatchSpotIds(values: readonly string[]): SpotId[] {
  if (values.length < 1 || values.length > SOURCE_BATCH_MAX_SPOTS) {
    throw new Error(
      `Source batch must contain from 1 through ${SOURCE_BATCH_MAX_SPOTS} configured spots`
    );
  }

  const spotIds: SpotId[] = [];
  for (const value of values) {
    if (!isNorcalSpotId(value)) {
      throw new Error(`Source batch contains an unknown NorCal spot: ${value}`);
    }
    spotIds.push(value);
  }
  if (new Set(spotIds).size !== spotIds.length) {
    throw new Error("Source batch spot IDs must be unique");
  }
  return [...spotIds].sort();
}

export function sourceBatchKey(values: readonly string[]): string {
  return `spots.${canonicalSourceBatchSpotIds(values).join(".")}`;
}

export function sourceBatchRunSuffix(ingestId: string, batchKey: string): string {
  return `${ingestId}.${batchKey}`;
}

function configuredBatches(): ConfiguredSourceBatch[] {
  const spotIds = NORCAL_SPOTS.map(({ id }) => id);
  const batches: ConfiguredSourceBatch[] = [];
  for (let offset = 0; offset < spotIds.length; offset += SOURCE_BATCH_MAX_SPOTS) {
    const canonical = canonicalSourceBatchSpotIds(
      spotIds.slice(offset, offset + SOURCE_BATCH_MAX_SPOTS)
    );
    batches.push(
      Object.freeze({
        batchKey: sourceBatchKey(canonical),
        spotIds: Object.freeze(canonical)
      })
    );
  }
  return batches;
}

export const NORCAL_SOURCE_BATCHES: readonly ConfiguredSourceBatch[] = Object.freeze(
  configuredBatches()
);
