import { buildFixtureForecast } from "@surf/forecast-core";
import { describe, expect, it } from "vitest";
import {
  FORECAST_ENGINE_VERSION,
  FORECAST_PRESENTATION_VERSION,
  persistForecastSnapshots,
  snapshotHeightLabel,
  stableJson
} from "./forecast-history";

type Write = {
  sql: string;
  values: unknown[];
};

function recordingDb(): { db: D1Database; writes: Write[] } {
  const writes: Write[] = [];
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
  return { db, writes };
}

function oneWindowFixture() {
  const response = buildFixtureForecast("bolinas", new Date("2026-07-10T12:00:00.000Z"));
  return { ...response, windows: response.windows.slice(0, 1) };
}

describe("forecast-as-issued snapshots", () => {
  it("persists the displayed facts, raw facts, provenance, and version identifiers", async () => {
    const { db, writes } = recordingDb();
    const response = oneWindowFixture();
    const result = await persistForecastSnapshots(db, response, {
      capturedAt: "2026-07-10T12:05:00.000Z",
      issuedAt: "2026-07-10T12:00:00.000Z",
      sourceIssueFingerprint: "source-fingerprint-1"
    });

    expect(result.rowsWritten).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.issueId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql.replace(/\s+/g, " ")).toContain(
      "on conflict(spot_id, issue_id, valid_at) do nothing"
    );

    const values = writes[0]!.values;
    expect(values).toHaveLength(34);
    expect(values.slice(0, 11)).toEqual([
      "bolinas",
      result.issueId,
      "2026-07-10T12:05:00.000Z",
      "2026-07-10T12:00:00.000Z",
      response.windows[0]!.forecastAt,
      0,
      "scored",
      response.windows[0]!.qualityLabel,
      "clean",
      response.windows[0]!.waveHeightFt,
      snapshotHeightLabel(response.windows[0]!.waveHeightFt)
    ]);
    expect(JSON.parse(values[24] as string)).toEqual(["fixture"]);
    expect(JSON.parse(values[27] as string)).toMatchObject({
      spotId: "bolinas",
      displayedHeightLabel: "2–3 ft",
      surfaceCondition: "clean"
    });
    expect(values[29]).toMatch(/^[a-f0-9]{64}$/);
    expect(values[30]).toBe(FORECAST_ENGINE_VERSION);
    expect(values[31]).toBe(FORECAST_PRESENTATION_VERSION);
    expect(values[32]).toBe(1);
  });

  it("deduplicates retry identity without erasing distinct forecast facts", async () => {
    const first = oneWindowFixture();
    const retry = {
      ...oneWindowFixture(),
      generatedAt: "2026-07-10T12:07:00.000Z",
      windows: oneWindowFixture().windows.map((window) => ({
        ...window,
        sourceRunIds: ["different-retry-run"]
      }))
    };
    const changed = {
      ...retry,
      windows: retry.windows.map((window) => ({
        ...window,
        waveHeightFt: (window.waveHeightFt ?? 0) + 0.5
      }))
    };

    const firstResult = await persistForecastSnapshots(recordingDb().db, first, {
      capturedAt: "2026-07-10T12:05:00.000Z",
      issuedAt: "2026-07-10T12:00:00.000Z",
      sourceIssueFingerprint: "source-fingerprint-1"
    });
    const retryResult = await persistForecastSnapshots(recordingDb().db, retry, {
      capturedAt: "2026-07-10T12:08:00.000Z",
      issuedAt: "2026-07-10T12:01:00.000Z",
      sourceIssueFingerprint: "source-fingerprint-1"
    });
    const changedResult = await persistForecastSnapshots(recordingDb().db, changed, {
      capturedAt: "2026-07-10T13:05:00.000Z",
      issuedAt: "2026-07-10T13:00:00.000Z",
      sourceIssueFingerprint: "source-fingerprint-1"
    });

    expect(retryResult.issueId).toBe(firstResult.issueId);
    expect(changedResult.issueId).not.toBe(firstResult.issueId);
  });

  it("canonicalizes objects before hashing or storing them", () => {
    expect(stableJson({ z: 1, nested: { b: 2, a: 1 }, a: 0 })).toBe(
      '{"a":0,"nested":{"a":1,"b":2},"z":1}'
    );
  });
});
