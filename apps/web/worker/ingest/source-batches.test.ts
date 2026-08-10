import { describe, expect, it } from "vitest";
import {
  getOperationalObservedWaveSources,
  NORCAL_SPOTS
} from "@surf/forecast-core";
import {
  buildCoopsTideEventsUrl,
  buildCoopsTidePredictionsUrl,
  fetchCoopsTidePredictionsForSpots
} from "../adapters/coops";
import { fetchCdipMopForecastsForSpots } from "../adapters/cdip-mop";
import { buildNdbcRealtimeUrl, fetchNdbcRealtimeObservationsForStations } from "../adapters/ndbc";
import {
  buildNwsAlertsUrl,
  buildNwsPointUrl,
  fetchNwsContextForSpots
} from "../adapters/nws";
import { fetchNwsGridWaveForSpots } from "../adapters/nws-grid-wave";
import type { AdapterOutcome } from "../adapters/types";
import { normalizeIngestMessage, sourceProviderHorizon } from "./coordinator";
import { persistRawArtifacts } from "./raw-artifacts";
import { recordSourceRun } from "./source-runs";
import {
  canonicalSourceBatchSpotIds,
  NORCAL_SOURCE_BATCHES,
  SOURCE_BATCH_MAX_SPOTS,
  SOURCE_BATCH_SCHEMA_VERSION,
  sourceBatchKey,
  sourceBatchRunSuffix
} from "./source-batches";
import type { CaptureBuffer } from "./types";

const NOW = new Date("2026-08-03T01:02:03.456Z");
const HORIZON_HOURS = 120;

type ProviderRequest = Readonly<{ method: string; url: string }>;

function requestLabel(request: ProviderRequest): string {
  return `${request.method} ${request.url}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function countingWorstCaseFetcher(requests: ProviderRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, url });
    const parsed = new URL(url);

    if (parsed.hostname === "api.weather.gov" && parsed.pathname.startsWith("/points/")) {
      return Response.json({
        properties: {
          forecastHourly: `https://forecast.test${parsed.pathname}`
        }
      });
    }
    if (parsed.hostname === "forecast.test") {
      return Response.json({ properties: { periods: [] } });
    }
    if (parsed.hostname === "api.weather.gov" && parsed.pathname === "/alerts/active") {
      return Response.json({ features: [] });
    }
    if (parsed.hostname.endsWith("cdip.ucsd.edu")) {
      const body =
        method === "HEAD"
          ? null
          : parsed.pathname.endsWith(".das")
            ? 'Attributes { NC_GLOBAL { String history "Runtime arguments: model -s 202608030000"; } }'
            : "";
      return new Response(body, {
        status: 200,
        headers: method === "HEAD" ? undefined : { "content-type": "text/plain" }
      });
    }

    return new Response("upstream unavailable", { status: 500 });
  }) as typeof fetch;
}

function expectedRequestsForBatch(
  spots: (typeof NORCAL_SPOTS)[number][],
  end: Date
): ProviderRequest[] {
  const tideStations = [
    ...new Set(spots.map(({ sourceMap }) => sourceMap.coopsTide.stationId))
  ].sort();
  const operationalStations = [
    ...new Set(
      spots.flatMap((spot) =>
        getOperationalObservedWaveSources(spot).map(({ stationId }) => stationId)
      )
    )
  ].sort();

  return [
    ...tideStations.flatMap((stationId) => [
      { method: "GET", url: buildCoopsTidePredictionsUrl(stationId, NOW, end) },
      { method: "GET", url: buildCoopsTideEventsUrl(stationId, NOW, end) }
    ]),
    ...spots.flatMap((spot) => {
      const pointUrl = buildNwsPointUrl(spot.lat, spot.lon);
      return [
        { method: "GET", url: pointUrl },
        { method: "GET", url: `https://forecast.test${new URL(pointUrl).pathname}` },
        { method: "GET", url: buildNwsAlertsUrl(spot.lat, spot.lon) }
      ];
    }),
    ...spots.map((spot) => ({
      method: "GET",
      url: spot.sourceMap.nwsWaveGrid.forecastGridData
    })),
    ...spots.flatMap((spot) => {
      const point = spot.sourceMap.cdipMop.modelPoint;
      return point
        ? [
            { method: "GET", url: point.forecastAsciiUrl },
            { method: "GET", url: point.forecastDasUrl },
            { method: "HEAD", url: point.forecastFileUrl }
          ]
        : [];
    }),
    ...operationalStations.map((stationId) => ({
      method: "GET",
      url: buildNdbcRealtimeUrl(stationId)
    }))
  ];
}

describe("configured source batches", () => {
  it("partitions the checked-in NorCal catalog exactly once into canonical stable batches", () => {
    const allBatchSpotIds = NORCAL_SOURCE_BATCHES.flatMap(({ spotIds }) => spotIds);

    expect(NORCAL_SOURCE_BATCHES).toHaveLength(3);
    expect(new Set(allBatchSpotIds).size).toBe(NORCAL_SPOTS.length);
    expect([...allBatchSpotIds].sort()).toEqual(NORCAL_SPOTS.map(({ id }) => id).sort());
    for (const { batchKey, spotIds } of NORCAL_SOURCE_BATCHES) {
      expect(spotIds.length).toBeGreaterThan(0);
      expect(spotIds.length).toBeLessThanOrEqual(SOURCE_BATCH_MAX_SPOTS);
      expect(spotIds).toEqual([...spotIds].sort());
      expect(new Set(spotIds).size).toBe(spotIds.length);
      expect(batchKey).toBe(sourceBatchKey(spotIds));
      expect(sourceBatchRunSuffix("root-id", batchKey)).toBe(`root-id.${batchKey}`);
    }
  });

  it("normalizes reordered versioned messages and rejects ambiguous batch identities", () => {
    const configured = NORCAL_SOURCE_BATCHES[0]!;
    const base = {
      job: "source-batch",
      schemaVersion: SOURCE_BATCH_SCHEMA_VERSION,
      kind: "scheduled-ingest",
      ingestId: "ingest-123",
      batchKey: configured.batchKey,
      spotIds: [...configured.spotIds].reverse(),
      requestedAt: NOW.toISOString(),
      forecastGeneratedAt: NOW.toISOString(),
      region: "norcal"
    };

    expect(normalizeIngestMessage(base, "norcal")).toEqual({
      ...base,
      spotIds: [...configured.spotIds]
    });
    expect(() =>
      normalizeIngestMessage({ ...base, spotIds: [configured.spotIds[0], configured.spotIds[0]] }, "norcal")
    ).toThrow(/invalid spot IDs/i);
    expect(() =>
      normalizeIngestMessage({ ...base, spotIds: NORCAL_SPOTS.slice(0, 5).map(({ id }) => id) }, "norcal")
    ).toThrow(/invalid spot IDs/i);
    expect(() =>
      normalizeIngestMessage({ ...base, spotIds: ["not-a-spot"] }, "norcal")
    ).toThrow(/invalid spot IDs/i);
    expect(() =>
      normalizeIngestMessage({ ...base, batchKey: "spots.wrong" }, "norcal")
    ).toThrow(/mismatched batch key/i);
    const subset = [configured.spotIds[0]!];
    expect(() =>
      normalizeIngestMessage(
        { ...base, spotIds: subset, batchKey: sourceBatchKey(subset) },
        "norcal"
      )
    ).toThrow(/configured batch/i);
    expect(() =>
      normalizeIngestMessage({ ...base, schemaVersion: 2 }, "norcal")
    ).toThrow(/invalid/i);
    expect(canonicalSourceBatchSpotIds([...configured.spotIds].reverse())).toEqual(
      configured.spotIds
    );
  });

  it("reuses source-run and raw-artifact identities for reordered batch redelivery", async () => {
    const configured = NORCAL_SOURCE_BATCHES[0]!;
    const firstSuffix = sourceBatchRunSuffix(
      "ingest-123",
      sourceBatchKey(configured.spotIds)
    );
    const replaySuffix = sourceBatchRunSuffix(
      "ingest-123",
      sourceBatchKey([...configured.spotIds].reverse())
    );
    expect(replaySuffix).toBe(firstSuffix);

    const sourceRunWrites: unknown[][] = [];
    const sourceRunDb = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            sourceRunWrites.push(values);
            return { run: async () => ({ success: true }) };
          }
        };
      }
    } as unknown as D1Database;
    const outcome: AdapterOutcome<never> = {
      sourceId: "test:batch-source",
      provider: "test",
      capabilities: [],
      status: "success",
      rows: [],
      caveats: [],
      errors: [],
      fetchedAt: NOW.toISOString(),
      metadata: {}
    };
    const sourceRunOptions = {
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      idSuffix: firstSuffix
    };
    const firstRun = await recordSourceRun(sourceRunDb, outcome, sourceRunOptions);
    const replayRun = await recordSourceRun(sourceRunDb, outcome, {
      ...sourceRunOptions,
      idSuffix: replaySuffix
    });

    expect(replayRun.id).toBe(firstRun.id);
    expect(JSON.parse(String(sourceRunWrites[1]?.[0]))).toEqual(
      JSON.parse(String(sourceRunWrites[0]?.[0]))
    );

    const artifactWrites: unknown[][] = [];
    const artifactDb = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            artifactWrites.push(values);
            return { run: async () => ({ success: true }) };
          }
        };
      }
    } as unknown as D1Database;
    const objectKeys: string[] = [];
    const bucket = {
      put: async (key: string) => {
        objectKeys.push(key);
        return {};
      }
    } as unknown as R2Bucket;
    const captures: CaptureBuffer = {
      items: [
        {
          requestUrl: "https://provider.test/z-source",
          contentType: "application/json",
          capturedAt: NOW.toISOString(),
          body: new Uint8Array([1, 2, 3]).buffer
        },
        {
          requestUrl: "https://provider.test/a-source",
          contentType: "text/plain",
          capturedAt: NOW.toISOString(),
          body: new Uint8Array([4, 5, 6]).buffer
        }
      ],
      errors: []
    };

    await persistRawArtifacts(
      bucket,
      artifactDb,
      firstRun,
      captures,
      firstSuffix,
      NOW.toISOString()
    );
    await persistRawArtifacts(
      bucket,
      artifactDb,
      replayRun,
      { ...captures, items: [...captures.items].reverse() },
      replaySuffix,
      new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString()
    );

    expect(objectKeys.slice(3)).toEqual(objectKeys.slice(0, 3));
    expect(new Set(objectKeys).size).toBe(3);
    const artifactIdentity = (write: unknown[] | undefined) =>
      JSON.parse(String(write?.[3])).map(
        ({ id, r2Key, requestUrl }: { id: string; r2Key: string; requestUrl: string }) =>
          ({ id, r2Key, requestUrl })
      );
    expect(artifactIdentity(artifactWrites[1])).toEqual(artifactIdentity(artifactWrites[0]));
    expect(artifactIdentity(artifactWrites[0]).map(({ requestUrl }: { requestUrl: string }) => requestUrl))
      .toEqual([
        "https://provider.test/a-source",
        "https://provider.test/z-source"
      ]);
  });

  it.each([
    ["normal", "2026-07-01T07:17:00.000Z", "2026-07-06T07:00:00.000Z", 120],
    ["spring-forward", "2026-03-08T08:17:00.000Z", "2026-03-13T07:00:00.000Z", 119],
    ["fall-back", "2026-11-01T07:17:00.000Z", "2026-11-06T08:00:00.000Z", 121]
  ])(
    "fetches CO-OPS through the exact fifth local-date boundary during %s",
    async (_label, nowAt, expectedEndAt, expectedHours) => {
      const spot = NORCAL_SPOTS.find(({ id }) => id === "obsf-central")!;
      const horizon = sourceProviderHorizon(new Date(nowAt), [spot]);
      const outcome = await fetchCoopsTidePredictionsForSpots([spot], {
        now: new Date(nowAt),
        horizonHours: horizon.hours,
        horizonEndAt: horizon.endAt,
        fetcher: async () => Response.json({
          predictions: [{ t: nowAt.slice(0, 10) + " 12:00", v: "1.2", type: "H" }]
        })
      });

      expect(horizon).toEqual({ endAt: expectedEndAt, hours: expectedHours });
      expect(outcome.metadata.windowEnd).toBe(expectedEndAt);
      expect(outcome.metadata.requestUrls).toHaveLength(2);
      expect(outcome.metadata.requestUrls.every((url) =>
        new URL(url).searchParams.get("end_date") ===
          expectedEndAt.replace(/[-:T]/g, "").slice(0, 8) + " " + expectedEndAt.slice(11, 16)
      )).toBe(true);
    }
  );

  it("keeps every configured five-provider attempt below the Free Worker request ceiling", async () => {
    const totals: number[] = [];

    for (const batch of NORCAL_SOURCE_BATCHES) {
      const spots = batch.spotIds.map((spotId) =>
        NORCAL_SPOTS.find(({ id }) => id === spotId)!
      );
      const stationIds = [
        ...new Set(
          spots.flatMap((spot) =>
            getOperationalObservedWaveSources(spot).map(({ stationId }) => stationId)
          )
        )
      ];
      const requests: ProviderRequest[] = [];
      const fetcher = countingWorstCaseFetcher(requests);
      const horizon = sourceProviderHorizon(NOW, spots);

      await fetchCoopsTidePredictionsForSpots(spots, {
        fetcher,
        now: NOW,
        horizonHours: horizon.hours,
        horizonEndAt: horizon.endAt
      });
      await fetchNwsContextForSpots(spots, { fetcher });
      await fetchNwsGridWaveForSpots(spots, {
        fetcher,
        now: NOW,
        horizonHours: HORIZON_HOURS,
        horizonEndAt: horizon.endAt
      });
      await fetchCdipMopForecastsForSpots(spots, {
        fetcher,
        now: NOW,
        horizonHours: horizon.hours,
        horizonEndAt: horizon.endAt
      });
      await fetchNdbcRealtimeObservationsForStations(stationIds, { fetcher, now: NOW });

      const expected = expectedRequestsForBatch(spots, new Date(horizon.endAt));
      expect(requests.map(requestLabel).sort(), batch.batchKey).toEqual(
        expected.map(requestLabel).sort()
      );
      expect(requests.length, batch.batchKey).toBeLessThan(50);
      totals.push(requests.length);
    }

    expect(totals).toEqual([36, 36, 25]);
  });
});
