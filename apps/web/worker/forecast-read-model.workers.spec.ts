/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildForecastFactBundle } from "./brief";
import { persistForecastMaterialization } from "./forecast-read-model";

function forecastGeneration(generatedAt: string) {
  const fixture = buildFixtureForecast("linda-mar", new Date(generatedAt));
  return {
    threeHour: { ...fixture, interval: "3h" as const },
    hourly: { ...fixture, interval: "1h" as const }
  };
}

describe("forecast read-model conditional publication in workerd D1", () => {
  it("publishes a generation once and reports a strictly older batch as superseded", async () => {
    const newer = forecastGeneration("2026-08-04T13:00:00.000Z");
    const newerBundle = await buildForecastFactBundle(newer.threeHour);

    const published = await persistForecastMaterialization({
      db: env.DB,
      ...newer,
      factBundles: [newerBundle],
      sourceIssueFingerprint: "newer-worker-spec-source",
      materializedAt: "2026-08-04T13:05:00.000Z",
      ingestId: "newer-worker-spec-ingest"
    });

    expect(published).toMatchObject({
      forecastRowsWritten: 2,
      factBundleRowsWritten: 1,
      errors: []
    });
    expect(published.forecastOutcomes).toEqual([
      expect.objectContaining({
        interval: "3h",
        outcome: "publish",
        reasonCode: "forecast_generation_published",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        outcome: "publish",
        reasonCode: "forecast_generation_published",
        retryable: false
      })
    ]);

    const older = forecastGeneration("2026-08-04T12:00:00.000Z");
    const olderBundle = await buildForecastFactBundle(older.threeHour);
    const superseded = await persistForecastMaterialization({
      db: env.DB,
      ...older,
      factBundles: [olderBundle],
      sourceIssueFingerprint: "older-worker-spec-source",
      materializedAt: "2026-08-04T13:06:00.000Z",
      ingestId: "older-worker-spec-ingest"
    });

    expect(superseded).toMatchObject({
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: []
    });
    expect(superseded.forecastOutcomes).toEqual([
      expect.objectContaining({
        interval: "3h",
        outcome: "supersede",
        reasonCode: "newer_generation_active",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        outcome: "supersede",
        reasonCode: "newer_generation_active",
        retryable: false
      })
    ]);

    const activeRows = await env.DB.prepare(
      `select interval, generation_id, generated_at
       from forecast_read_models
       where spot_id = ?
       order by interval desc`
    )
      .bind("linda-mar")
      .all<{ interval: string; generation_id: string; generated_at: string }>();
    expect(activeRows.results).toHaveLength(2);
    expect(new Set(activeRows.results.map(({ generated_at }) => generated_at))).toEqual(
      new Set([newer.threeHour.generatedAt])
    );
    expect(new Set(activeRows.results.map(({ generation_id }) => generation_id))).toEqual(
      new Set(published.forecastOutcomes.map(({ generationId }) => generationId))
    );
  });
});
