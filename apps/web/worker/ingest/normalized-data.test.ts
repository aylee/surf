import { describe, expect, it } from "vitest";
import { persistTideEvents } from "./normalized-data";

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
    expect(writes[0]?.values).toEqual([
      "obsf-central",
      "coops:tide-predictions",
      "coops-run",
      "9414290",
      "2026-07-10T06:12:00.000Z",
      4.8,
      "high",
      JSON.stringify({
        spotId: "obsf-central",
        stationId: "9414290",
        eventAt: "2026-07-10T06:12:00.000Z",
        tideFtMllw: 4.8,
        eventType: "high"
      }),
      "2026-07-10T02:40:00.000Z"
    ]);
  });
});
