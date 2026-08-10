import { describe, expect, it } from "vitest";
import { NORCAL_SPOTS } from "@surf/forecast-core";
import { persistTideEvents, persistWaveObservations } from "./normalized-data";

describe("normalized tide event persistence", () => {
  it("writes official CO-OPS high/low predictions to their additive read model", async () => {
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                writes.push({ sql, values });
                return { success: true, results: [], meta: { changes: 1 } };
              }
            };
          }
        };
      }
    } as unknown as D1Database;

    const result = await persistTideEvents(
      db,
      "coops-run",
      [{
        spotId: "obsf-central",
        stationId: "9414290",
        eventAt: "2026-07-10T06:12:00.000Z",
        tideFtMllw: 4.8,
        eventType: "high"
      }],
      "2026-07-10T02:40:00.000Z"
    );

    expect(result).toEqual({ rowsWritten: 1, errors: [] });
    expect(writes[0]?.sql).toContain("insert into tide_events");
    expect(writes[0]?.sql).toContain("from json_each(?)");
    expect(JSON.parse(String(writes[0]?.values[0]))).toEqual([{
      spotId: "obsf-central",
      sourceRunId: "coops-run",
      stationId: "9414290",
      eventAt: "2026-07-10T06:12:00.000Z",
      tideFtMllw: 4.8,
      eventType: "high",
      payloadJson: JSON.stringify({
        spotId: "obsf-central",
        stationId: "9414290",
        eventAt: "2026-07-10T06:12:00.000Z",
        tideFtMllw: 4.8,
        eventType: "high"
      }),
      createdAt: "2026-07-10T02:40:00.000Z"
    }]);
  });
});

describe("normalized wave observation persistence", () => {
  it("fans a shared NDBC observation only across the requested source batch", async () => {
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                writes.push({ sql, values });
                return { success: true, results: [], meta: { changes: 1 } };
              }
            };
          }
        };
      }
    } as unknown as D1Database;
    const central = NORCAL_SPOTS.find(({ id }) => id === "obsf-central")!;

    const result = await persistWaveObservations(
      db,
      "ndbc-run",
      [{
        stationId: "46026",
        observedAt: "2026-07-10T02:00:00.000Z",
        waveHeightM: 1.7,
        dominantPeriodS: 12,
        averagePeriodS: 8,
        meanWaveDirectionDeg: 287,
        waterTempC: 13.2
      }],
      "2026-07-10T02:40:00.000Z",
      [central]
    );

    expect(result).toEqual({ rowsWritten: 1, errors: [] });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain("insert into wave_observations");
    expect(writes[0]?.sql).toContain("from json_each(?)");
    expect(JSON.parse(String(writes[0]?.values[0]))).toEqual([
      expect.objectContaining({
        spotId: "obsf-central",
        sourceId: "ndbc-46026",
        sourceRunId: "ndbc-run",
        observedAt: "2026-07-10T02:00:00.000Z"
      })
    ]);
  });
});
