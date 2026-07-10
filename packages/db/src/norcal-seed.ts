import {
  getOperationalObservedWaveSources,
  NORCAL_REFERENCE_CONFIG,
  NORCAL_REFERENCE_CONFIG_VERSION
} from "@surf/forecast-core";
import { NORCAL_SEED_CONFIG, type SourceSeedRow } from "./norcal-seed-config";

type SqlValue = string | number | null;

type SpotSeedRow = {
  id: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  timezone: string;
  shoreNormalDeg: number;
  configJson: string;
  active: number;
};

const SOURCE_COLUMNS = [
  "id",
  "name",
  "type",
  "provider",
  "external_id",
  "url",
  "format",
  "parser_runtime",
  "attribution",
  "license_note",
  "refresh_minutes",
  "active",
  "metadata_json"
] as const;

const SPOT_COLUMNS = [
  "id",
  "name",
  "region",
  "lat",
  "lon",
  "timezone",
  "shore_normal_deg",
  "config_json",
  "active"
] as const;

const RETIRED_SOURCE_IDS = [
  "noaa-gfswave-norcal",
  "cdip-mop-norcal-unmapped",
  "nws-grid-norcal",
  "nws-alerts-norcal"
] as const;

function sqlLiteral(value: SqlValue): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot render non-finite SQL number: ${value}`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function renderValues(rows: SqlValue[][]): string {
  return rows.map((row) => `  (${row.map(sqlLiteral).join(", ")})`).join(",\n");
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values)];
}

function runtimeSourceMetadata(source: SourceSeedRow): Record<string, unknown> {
  if (source.id === "ndbc:realtime2-standard-meteorological") {
    return {
      ...source.metadata,
      stations: orderedUnique(
        NORCAL_REFERENCE_CONFIG.spots.flatMap((spot) =>
          getOperationalObservedWaveSources(spot).map((mapping) => mapping.stationId)
        )
      )
    };
  }
  if (source.id === "coops:tide-predictions") {
    return {
      ...source.metadata,
      stations: orderedUnique(
        NORCAL_REFERENCE_CONFIG.spots.map((spot) => spot.sourceMap.coopsTide.stationId)
      )
    };
  }
  return source.metadata;
}

function sourceValues(source: SourceSeedRow): SqlValue[] {
  return [
    source.id,
    source.name,
    source.type,
    source.provider,
    source.externalId,
    source.url,
    source.format,
    source.parserRuntime,
    source.attribution,
    source.licenseNote,
    source.refreshMinutes,
    source.active ? 1 : 0,
    JSON.stringify(runtimeSourceMetadata(source))
  ];
}

function spotValues(spot: SpotSeedRow): SqlValue[] {
  return [
    spot.id,
    spot.name,
    spot.region,
    spot.lat,
    spot.lon,
    spot.timezone,
    spot.shoreNormalDeg,
    spot.configJson,
    spot.active
  ];
}

function buildSpotRows(): SpotSeedRow[] {
  return NORCAL_REFERENCE_CONFIG.spots.map((spot) => ({
    id: spot.id,
    name: spot.name,
    region: spot.region,
    lat: spot.lat,
    lon: spot.lon,
    timezone: spot.timezone,
    shoreNormalDeg: spot.shoreNormalDeg,
    configJson: JSON.stringify({
      bestSwellDeg: spot.bestSwellDeg,
      workableSwellDeg: spot.workableSwellDeg,
      bestPeriodSec: spot.bestPeriodSec,
      bestTideFt: spot.bestTideFt,
      offshoreWindFromDeg: spot.offshoreWindFromDeg,
      maxGoodWindKt: spot.maxGoodWindKt,
      maxOkWindKt: spot.maxOkWindKt,
      notes: spot.notes
    }),
    active: 1
  }));
}

export function validateNorcalSeedConfig(): void {
  if (NORCAL_SEED_CONFIG.referenceConfigVersion !== NORCAL_REFERENCE_CONFIG_VERSION) {
    throw new Error(
      `Seed config targets reference version ${NORCAL_SEED_CONFIG.referenceConfigVersion}, expected ${NORCAL_REFERENCE_CONFIG_VERSION}`
    );
  }

  const sourceIds = new Set<string>();
  for (const source of NORCAL_SEED_CONFIG.sources) {
    if (sourceIds.has(source.id)) throw new Error(`Duplicate source ID in seed config: ${source.id}`);
    sourceIds.add(source.id);
    if (!Number.isInteger(source.refreshMinutes) || source.refreshMinutes <= 0) {
      throw new Error(`Invalid refresh interval for ${source.id}`);
    }
    new URL(source.url);
  }

  for (const spot of NORCAL_REFERENCE_CONFIG.spots) {
    for (const source of getOperationalObservedWaveSources(spot)) {
      if (!sourceIds.has(source.sourceId)) {
        throw new Error(`Missing source catalog row ${source.sourceId} required by ${spot.id}`);
      }
    }

    const requiredSourceIds = [
      spot.sourceMap.cdipMop.sourceId,
      `coops-${spot.sourceMap.coopsTide.stationId}`,
      spot.sourceMap.nwsWaveGrid.sourceId
    ];
    for (const sourceId of requiredSourceIds) {
      if (!sourceIds.has(sourceId)) throw new Error(`Missing source catalog row ${sourceId} required by ${spot.id}`);
    }
  }

  for (const sourceId of [
    "coops:tide-predictions",
    "nws:point-forecast-alerts",
    "nws:mtr-grid-wave",
    "cdip:mop-forecast",
    "ndbc:realtime2-standard-meteorological"
  ]) {
    if (!sourceIds.has(sourceId)) {
      throw new Error(`Missing source catalog row ${sourceId} required by the ingest pipeline`);
    }
  }
}

export function generateNorcalSeedSql(): string {
  validateNorcalSeedConfig();
  const spots = buildSpotRows();

  return `-- Generated from @surf/forecast-core's NorCal reference config and packages/db/src/norcal-seed-config.ts.
-- DO NOT EDIT BY HAND. Run: pnpm --filter @surf/db seed:generate
-- Reference config: ${NORCAL_REFERENCE_CONFIG.id} (schema ${NORCAL_REFERENCE_CONFIG.schemaVersion})

insert into spots (${SPOT_COLUMNS.join(", ")}) values
${renderValues(spots.map(spotValues))}
on conflict(id) do update set
  name = excluded.name,
  region = excluded.region,
  lat = excluded.lat,
  lon = excluded.lon,
  timezone = excluded.timezone,
  shore_normal_deg = excluded.shore_normal_deg,
  config_json = excluded.config_json,
  active = excluded.active;

insert into sources (${SOURCE_COLUMNS.join(", ")}) values
${renderValues(NORCAL_SEED_CONFIG.sources.map(sourceValues))}
on conflict(id) do update set
  name = excluded.name,
  type = excluded.type,
  provider = excluded.provider,
  external_id = excluded.external_id,
  url = excluded.url,
  format = excluded.format,
  parser_runtime = excluded.parser_runtime,
  attribution = excluded.attribution,
  license_note = excluded.license_note,
  refresh_minutes = excluded.refresh_minutes,
  active = excluded.active,
  metadata_json = excluded.metadata_json;

-- These IDs belonged to earlier generated seeds but are not live v1 adapters.
-- Keep upgrade behavior explicit without deleting historical source/run rows.
update sources set active = 0
where id in (${RETIRED_SOURCE_IDS.map(sqlLiteral).join(", ")});
`;
}
