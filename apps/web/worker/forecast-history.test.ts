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

function batchingDb(): { db: D1Database; batches: D1PreparedStatement[][] } {
  const batches: D1PreparedStatement[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { sql, values } as unknown as D1PreparedStatement;
        }
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      batches.push(statements);
      return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
    }
  } as unknown as D1Database;
  return { db, batches };
}

function oneWindowFixture() {
  const response = buildFixtureForecast("bolinas", new Date("2026-07-10T13:00:00.000Z"));
  return { ...response, windows: response.windows.slice(0, 1) };
}

function withCdipDiagnostic() {
  const response = oneWindowFixture();
  return {
    ...response,
    windows: response.windows.map((window) => ({
      ...window,
      waveProvenance: {
        sourceId: "cdip:mop-forecast",
        provider: "CDIP MOP nearshore model",
        sourceUrl: "https://example.com/SF043_forecast.nc.ascii",
        sourceUpdatedAt: "2026-07-10T11:55:00.000Z",
        modelCycleAt: "2026-07-10T00:00:00.000Z",
        rawSignificantHeightFt: 3,
        breakingHeightScale: 1,
        exposureScale: 1,
        shoalingFactor: 1.42,
        totalHeightFactor: 1.42,
        breakerIndex: 0.78,
        breakingDepthM: 1.68,
        incidenceAngleDeg: 12,
        experimentalBreakingHeightFt: 4.26,
        transformMethod: "linear-energy-flux-snell-depth-limited" as const,
        transformVersion: "bulk-hs-linear-shoaling-v1" as const,
        estimatedBreakingHeightFt: null,
        modeledNearshoreSignificantHeightFt: 3,
        heightSemantics: "modeled_significant_wave_height_not_breaking_face_height" as const,
        modelPointId: "SF043",
        modelPointWaterDepthM: 10,
        modelPointShoreNormalDeg: 305.41,
        pointRelationship: "direct_nearshore_point" as const,
        sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle" as const,
        derivation: "cdip_mop_point_hs" as const
      }
    }))
  };
}

describe("forecast-as-issued snapshots", () => {
  it("persists the displayed facts, raw facts, provenance, and version identifiers", async () => {
    const { db, writes } = recordingDb();
    const response = withCdipDiagnostic();
    const result = await persistForecastSnapshots(db, response, {
      capturedAt: "2026-07-10T12:05:00.000Z",
      issuedAt: "2026-07-10T12:00:00.000Z",
      sourceIssueFingerprint: "source-fingerprint-1"
    });

    expect(result.rowsWritten).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.issueId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(writes).toHaveLength(3);
    expect(writes[0]?.sql).toContain("insert into forecast_configs");
    expect(writes[1]?.sql).toContain("insert into forecast_issues");
    expect(writes[2]?.sql.replace(/\s+/g, " ")).toContain(
      "on conflict(spot_id, issue_id, valid_at) do nothing"
    );
    expect((writes[0]?.values[2] as string).length).toBeGreaterThan(1000);
    expect(JSON.parse(writes[1]?.values[7] as string)).toMatchObject({
      observation: null
    });
    expect(writes[1]?.values[8]).toBe(1);

    const values = writes[2]!.values;
    expect(values).toHaveLength(34);
    expect(values.slice(0, 11)).toEqual([
      "bolinas",
      result.issueId,
      "2026-07-10T12:05:00.000Z",
      "2026-07-10T12:00:00.000Z",
      response.windows[0]!.forecastAt,
      1,
      "scored",
      response.windows[0]!.qualityLabel,
      "clean",
      response.windows[0]!.waveHeightFt,
      snapshotHeightLabel(response.windows[0]!.waveHeightFt)
    ]);
    expect(JSON.parse(values[24] as string)).toEqual(["fixture"]);
    expect(JSON.parse(values[25] as string)).toEqual([
      {
        derivation: "cdip_mop_point_hs",
        modelCycleAt: "2026-07-10T00:00:00.000Z",
        sourceId: "cdip:mop-forecast",
        sourceUpdatedAt: "2026-07-10T11:55:00.000Z",
        transformVersion: "bulk-hs-linear-shoaling-v1"
      }
    ]);
    expect(JSON.parse(values[27] as string)).toMatchObject({
      spotId: "bolinas",
      displayedHeightLabel: "2–3 ft",
      surfaceCondition: "clean",
      waveProvenance: {
        experimentalBreakingHeightFt: 4.26,
        modelPointShoreNormalDeg: 305.41,
        shoalingFactor: 1.42,
        transformVersion: "bulk-hs-linear-shoaling-v1"
      }
    });
    expect(JSON.parse(values[28] as string)).toEqual({
      configHash: values[29]
    });
    expect((values[28] as string).length).toBeLessThan(100);
    expect(values[29]).toMatch(/^[a-f0-9]{64}$/);
    expect(values[30]).toBe(FORECAST_ENGINE_VERSION);
    expect(values[31]).toBe(FORECAST_PRESENTATION_VERSION);
    expect(values[32]).toBe(1);
  });

  it("writes each issue envelope and its daylight windows in one D1 batch", async () => {
    const { db, batches } = batchingDb();
    const result = await persistForecastSnapshots(db, oneWindowFixture(), {
      capturedAt: "2026-07-10T12:05:00.000Z",
      issuedAt: "2026-07-10T12:00:00.000Z"
    });

    expect(result.errors).toEqual([]);
    expect(result.rowsWritten).toBe(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
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

  it("changes issue identity when an experimental transform fact changes", async () => {
    const first = withCdipDiagnostic();
    const changed = {
      ...first,
      windows: first.windows.map((window) => ({
        ...window,
        waveProvenance: window.waveProvenance
          ? { ...window.waveProvenance, shoalingFactor: 1.5, totalHeightFactor: 1.5 }
          : null
      }))
    };

    const firstResult = await persistForecastSnapshots(recordingDb().db, first, {
      capturedAt: "2026-07-10T12:05:00.000Z",
      issuedAt: "2026-07-10T12:00:00.000Z",
      sourceIssueFingerprint: "same-source-fingerprint"
    });
    const changedResult = await persistForecastSnapshots(recordingDb().db, changed, {
      capturedAt: "2026-07-10T12:06:00.000Z",
      issuedAt: "2026-07-10T12:00:00.000Z",
      sourceIssueFingerprint: "same-source-fingerprint"
    });

    expect(changedResult.issueId).not.toBe(firstResult.issueId);
  });

  it("canonicalizes objects before hashing or storing them", () => {
    expect(stableJson({ z: 1, nested: { b: 2, a: 1 }, a: 0 })).toBe(
      '{"a":0,"nested":{"a":1,"b":2},"z":1}'
    );
  });
});
