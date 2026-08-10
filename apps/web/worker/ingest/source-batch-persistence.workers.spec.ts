/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  getOperationalObservedWaveSources,
  NORCAL_SPOTS,
  type NorcalSpotProfile
} from "@surf/forecast-core";
import type { CdipMopForecastRow } from "../adapters/cdip-mop";
import type { TideEventRow, TidePredictionRow } from "../adapters/coops";
import type { NdbcObservationRow } from "../adapters/ndbc";
import type { NwsContextRow } from "../adapters/nws";
import type { NwsGridWaveForecastRow } from "../adapters/nws-grid-wave";
import type { AdapterOutcome } from "../adapters/types";
import {
  persistCdipMopForecasts,
  persistNwsRows,
  persistTideEvents,
  persistTideForecasts,
  persistWaveForecasts,
  persistWaveObservations
} from "./normalized-data";
import { persistRawArtifacts } from "./raw-artifacts";
import { pruneRetainedData } from "./retention";
import { NORCAL_SOURCE_BATCHES } from "./source-batches";
import { finalizeSourceRuns, recordSourceRuns } from "./source-runs";
import type {
  ArtifactPersistenceResult,
  CaptureBuffer,
  PersistenceResult
} from "./types";

const GENERATED_AT = "2026-10-30T07:00:00.000Z";
const SOURCE_IDS = [
  "coops:tide-predictions",
  "nws:point-forecast-alerts",
  "nws:mtr-grid-wave",
  "cdip:mop-forecast",
  "ndbc:realtime2-standard-meteorological"
] as const;

function countedDatabase(db: D1Database): { db: D1Database; count: () => number } {
  let preparedStatements = 0;
  return {
    db: {
      prepare(sql: string) {
        preparedStatements += 1;
        return db.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        return db.batch(statements);
      }
    } as D1Database,
    count: () => preparedStatements
  };
}

async function seedBatchReferences(spots: readonly NorcalSpotProfile[]): Promise<void> {
  await env.DB.batch(
    spots.map((spot) =>
      env.DB.prepare(
        `insert or ignore into spots (
           id, name, region, lat, lon, timezone, shore_normal_deg, config_json, active
         ) values (?, ?, 'norcal', ?, ?, ?, ?, '{}', 1)`
      ).bind(spot.id, spot.name, spot.lat, spot.lon, spot.timezone, spot.shoreNormalDeg)
    )
  );
  const normalizedObservationSourceIds = [
    ...new Set(
      spots.flatMap((spot) =>
        getOperationalObservedWaveSources(spot).map(({ stationId }) => `ndbc-${stationId}`)
      )
    )
  ];
  await env.DB.batch(
    [...SOURCE_IDS, ...normalizedObservationSourceIds].map((sourceId) =>
      env.DB.prepare(
        `insert or ignore into sources (
           id, name, type, provider, format, parser_runtime, attribution,
           refresh_minutes, active
         ) values (?, ?, 'test', 'test', 'json', 'typescript', 'test', 60, 1)`
      ).bind(sourceId, sourceId)
    )
  );
}

function instantAtHour(hour: number): string {
  return new Date(Date.parse(GENERATED_AT) + hour * 60 * 60 * 1000).toISOString();
}

function adapterOutcome<Row>(
  sourceId: string,
  rows: Row[],
  metadata: Record<string, unknown> = {}
): AdapterOutcome<Row> {
  return {
    sourceId,
    provider: "test",
    capabilities: [],
    status: "success",
    rows,
    caveats: [],
    errors: [],
    fetchedAt: GENERATED_AT,
    metadata
  };
}

describe("source-batch persistence in real Workerd D1", () => {
  it("persists production-shaped 120/121-hour rows within 31 source D1 statements", async () => {
    const configured = NORCAL_SOURCE_BATCHES[0]!;
    const spots = configured.spotIds.map((spotId) =>
      NORCAL_SPOTS.find(({ id }) => id === spotId)!
    );
    await seedBatchReferences(spots);

    const tideRows: TidePredictionRow[] = spots.flatMap((spot, spotIndex) =>
      Array.from({ length: spotIndex % 2 === 0 ? 121 : 120 }, (_, hour) => ({
        spotId: spot.id,
        stationId: spot.sourceMap.coopsTide.stationId,
        forecastAt: instantAtHour(hour),
        tideFtMllw: 2.5 + (hour % 8) / 10,
        tideTrend: hour % 2 === 0 ? "rising" : "falling"
      }))
    );
    const tideEvents: TideEventRow[] = spots.map((spot) => ({
      spotId: spot.id,
      stationId: spot.sourceMap.coopsTide.stationId,
      eventAt: instantAtHour(121),
      tideFtMllw: 4.8,
      eventType: "high"
    }));
    const nwsRows: NwsContextRow[] = spots.map((spot, spotIndex) => ({
      spotId: spot.id,
      pointUrl: `https://api.weather.gov/points/${spot.lat},${spot.lon}`,
      forecastUrl: `https://api.weather.gov/gridpoints/test/${spot.id}`,
      alertsUrl: `https://api.weather.gov/alerts/active?spot=${spot.id}`,
      office: "MTR",
      gridX: 80 + spotIndex,
      gridY: 100,
      forecastZone: "PZZ545",
      alertsFetchSucceeded: true,
      windForecasts: Array.from({ length: spotIndex % 2 === 0 ? 121 : 120 }, (_, hour) => ({
        spotId: spot.id,
        issuedAt: GENERATED_AT,
        forecastAt: instantAtHour(hour),
        periodEndAt: instantAtHour(hour + 1),
        windSpeedKt: 5,
        windDirectionDeg: 270,
        gustKt: 8,
        shortForecast: "Clear",
        sourceUrl: `https://api.weather.gov/gridpoints/test/${spot.id}`
      })),
      hazards: [{
        spotId: spot.id,
        event: "Beach Hazards Statement",
        severity: "Moderate",
        urgency: "Expected",
        certainty: "Likely",
        headline: "Test hazard",
        effectiveAt: GENERATED_AT,
        expiresAt: "2026-08-13T09:00:00.000Z",
        sourceUrl: `https://api.weather.gov/alerts/active?spot=${spot.id}`
      }]
    }));
    const nwsWaveRows: NwsGridWaveForecastRow[] = spots.flatMap((spot) =>
      Array.from({ length: 41 }, (_, index) => ({
        spotId: spot.id,
        sourceId: "nws:mtr-grid-wave",
        sourceUrl: spot.sourceMap.nwsWaveGrid.forecastGridData,
        modelCycleAt: GENERATED_AT,
        forecastAt: instantAtHour(index * 3),
        leadHour: index * 3,
        significantHeightM: 1.4,
        estimatedBreakingHeightM: 1.4,
        breakingHeightScale: 1,
        primarySwellHeightM: 1.2,
        primarySwellPeriodS: 11,
        primarySwellDirectionDeg: 290,
        secondarySwellHeightM: null,
        secondarySwellPeriodS: null,
        secondarySwellDirectionDeg: null,
        windWaveHeightM: 0.2
      }))
    );
    const cdipRows: CdipMopForecastRow[] = spots.flatMap((spot) => {
      const point = spot.sourceMap.cdipMop.modelPoint;
      if (!point) return [];
      return Array.from({ length: 41 }, (_, index) => ({
        spotId: spot.id,
        sourceId: "cdip:mop-forecast",
        sourceUrl: point.forecastAsciiUrl,
        metadataUrl: point.forecastDasUrl,
        sourceFileUrl: point.forecastFileUrl,
        sourceUpdatedAt: GENERATED_AT,
        sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle",
        modelCycleAt: GENERATED_AT,
        modelPointId: point.id,
        modelPointLat: point.lat,
        modelPointLon: point.lon,
        modelPointWaterDepthM: point.waterDepthM,
        modelPointShoreNormalDeg: point.shoreNormalDeg,
        pointRelationship: point.relationship,
        forecastAt: instantAtHour(index * 3),
        leadHour: index * 3,
        significantHeightM: 1.5,
        nearshoreHeightM: 1.5,
        exposureAdjustedPointHeightM: 1.5,
        experimentalBreakingHeightM: null,
        breakingDepthM: null,
        shoalingFactor: null,
        totalHeightFactor: null,
        breakerIndex: null,
        incidenceAngleDeg: null,
        transformMethod: null,
        transformVersion: "bulk-hs-linear-shoaling-v1",
        nearshoreHeightScale: point.nearshoreHeightScale,
        peakPeriodS: 11,
        peakDirectionDeg: 290,
        meanDirectionDeg: 285,
        heightSemantics: "modeled_significant_wave_height_not_breaking_face_height"
      }));
    });
    const ndbcRows: NdbcObservationRow[] = [
      ...new Set(
        spots.flatMap((spot) =>
          getOperationalObservedWaveSources(spot).map(({ stationId }) => stationId)
        )
      )
    ].map((stationId) => ({
      stationId,
      observedAt: GENERATED_AT,
      waveHeightM: 1.6,
      dominantPeriodS: 12,
      averagePeriodS: 8,
      meanWaveDirectionDeg: 285,
      waterTempC: 13
    }));
    const coops = Object.assign(
      adapterOutcome("coops:tide-predictions", tideRows),
      { events: tideEvents }
    );
    const nws = adapterOutcome("nws:point-forecast-alerts", nwsRows, {
      windRowCount: nwsRows.reduce((total, row) => total + row.windForecasts.length, 0)
    });
    const nwsWave = adapterOutcome("nws:mtr-grid-wave", nwsWaveRows);
    const cdip = adapterOutcome("cdip:mop-forecast", cdipRows);
    const ndbc = adapterOutcome("ndbc:realtime2-standard-meteorological", ndbcRows);
    const outcomes = [coops, nws, nwsWave, cdip, ndbc] as const;

    const counted = countedDatabase(env.DB);
    const sourceRuns = await recordSourceRuns(
      counted.db,
      outcomes.map((outcome) => ({
        outcome,
        startedAt: GENERATED_AT,
        completedAt: GENERATED_AT,
        idSuffix: `ingest.${configured.batchKey}`
      }))
    );
    const tidePersistence = await persistTideForecasts(
      counted.db, sourceRuns[0]!.id, tideRows, GENERATED_AT
    );
    const tideEventPersistence = await persistTideEvents(
      counted.db, sourceRuns[0]!.id, tideEvents, GENERATED_AT
    );
    const nwsPersistence = await persistNwsRows(
      counted.db, sourceRuns[1]!.id, nwsRows, GENERATED_AT, true
    );
    const wavePersistence = await persistWaveForecasts(
      counted.db, sourceRuns[2]!.id, nwsWaveRows, GENERATED_AT
    );
    const cdipPersistence = await persistCdipMopForecasts(
      counted.db, sourceRuns[3]!.id, cdipRows, GENERATED_AT
    );
    const observationPersistence = await persistWaveObservations(
      counted.db, sourceRuns[4]!.id, ndbcRows, GENERATED_AT, spots
    );
    const normalized: PersistenceResult[] = [
      {
        rowsWritten: tidePersistence.rowsWritten + tideEventPersistence.rowsWritten,
        errors: [...tidePersistence.errors, ...tideEventPersistence.errors]
      },
      nwsPersistence,
      wavePersistence,
      cdipPersistence,
      observationPersistence
    ];
    const bucketKeys: string[] = [];
    const bucket = {
      async put(key: string) {
        bucketKeys.push(key);
        return {};
      }
    } as unknown as R2Bucket;
    const artifactResults: ArtifactPersistenceResult[] = [];
    for (const [index, run] of sourceRuns.entries()) {
      const captures: CaptureBuffer = {
        items: [0, 1].map((captureIndex) => ({
          requestUrl: `https://provider.test/${run.sourceId}/${captureIndex}`,
          contentType: "application/json",
          capturedAt: GENERATED_AT,
          body: new TextEncoder().encode(`${index}:${captureIndex}`).buffer
        })),
        errors: []
      };
      artifactResults.push(
        await persistRawArtifacts(
          bucket,
          counted.db,
          run,
          captures,
          `ingest.${configured.batchKey}`,
          GENERATED_AT
        )
      );
    }
    const finalized = await finalizeSourceRuns(
      counted.db,
      sourceRuns.map((run, index) => ({
        run,
        outcome: outcomes[index]!,
        normalized: normalized[index]!,
        artifacts: artifactResults[index]!,
        completedAt: GENERATED_AT
      }))
    );
    const retention = await pruneRetainedData(counted.db, new Date(GENERATED_AT));

    expect(sourceRuns.every(({ recorded }) => recorded)).toBe(true);
    expect(finalized.every(({ recorded }) => recorded)).toBe(true);
    expect(normalized.flatMap(({ errors }) => errors)).toEqual([]);
    expect(artifactResults.flatMap(({ errors }) => errors)).toEqual([]);
    expect(retention.errors).toEqual([]);
    expect(counted.count()).toBe(32);
    expect(bucketKeys).toHaveLength(SOURCE_IDS.length * 3);
    expect(
      await env.DB.prepare("select count(*) as count from tide_forecasts").first<{ count: number }>()
    ).toEqual({ count: tideRows.length });
    expect(
      await env.DB.prepare("select count(*) as count from wind_forecasts").first<{ count: number }>()
    ).toEqual({ count: nwsRows.reduce((total, row) => total + row.windForecasts.length, 0) });
    expect(
      await env.DB.prepare("select count(*) as count from source_artifacts").first<{ count: number }>()
    ).toEqual({ count: SOURCE_IDS.length * 2 });
    expect(
      await env.DB.prepare("select event_at from tide_events order by event_at desc limit 1").first()
    ).toMatchObject({ event_at: instantAtHour(121) });
    expect(
      await env.DB.prepare(
        "select ends_at from hazard_events where spot_id = ? order by updated_at desc limit 1"
      ).bind(spots[0]!.id).first()
    ).toEqual({ ends_at: "2026-08-13T09:00:00.000Z" });
  });

  it("withdraws alerts only after a successful active-alert response", async () => {
    const spot = NORCAL_SPOTS.find(({ id }) => id === "linda-mar")!;
    await seedBatchReferences([spot]);
    const run = (await recordSourceRuns(env.DB, [{
      outcome: adapterOutcome("nws:point-forecast-alerts", [], { windRowCount: 0 }),
      startedAt: GENERATED_AT,
      completedAt: GENERATED_AT,
      idSuffix: "alerts"
    }]))[0]!;
    await env.DB.prepare(
      `insert into hazard_events (
        spot_id, source_id, source_run_id, event_id, event_type, headline, updated_at
      ) values ('linda-mar', 'nws:point-forecast-alerts', ?, 'old-null-ended',
                'Beach Hazards Statement', 'Old alert', ?)`
    ).bind(run.id, GENERATED_AT).run();
    const context = (alertsFetchSucceeded: boolean): NwsContextRow => ({
      spotId: "linda-mar",
      pointUrl: "https://api.weather.gov/points/test",
      forecastUrl: "https://api.weather.gov/forecast/test",
      alertsUrl: "https://api.weather.gov/alerts/active?point=test",
      office: "MTR",
      gridX: 1,
      gridY: 1,
      forecastZone: "PZZ545",
      windForecasts: [],
      hazards: [],
      alertsFetchSucceeded
    });

    await persistNwsRows(env.DB, run.id, [context(false)], GENERATED_AT, false);
    expect(
      await env.DB.prepare(
        "select event_id from hazard_events where spot_id = 'linda-mar' and event_id = 'old-null-ended'"
      ).first()
    ).toEqual({ event_id: "old-null-ended" });

    await persistNwsRows(env.DB, run.id, [context(true)], GENERATED_AT, false);
    expect(
      await env.DB.prepare(
        "select event_id from hazard_events where spot_id = 'linda-mar' and event_id = 'old-null-ended'"
      ).first()
    ).toBeNull();
  });
});
