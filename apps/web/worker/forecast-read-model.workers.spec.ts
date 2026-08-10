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
  it("publishes once, skips equal redelivery, and supersedes a strictly older batch", async () => {
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

    const duplicate = await persistForecastMaterialization({
      db: env.DB,
      ...newer,
      factBundles: [newerBundle],
      sourceIssueFingerprint: "newer-worker-spec-source",
      materializedAt: "2026-08-04T13:05:30.000Z",
      ingestId: "newer-worker-spec-ingest"
    });
    expect(duplicate).toMatchObject({
      rowsWritten: 0,
      forecastRowsWritten: 0,
      factBundleRowsWritten: 0,
      errors: []
    });
    expect(duplicate.forecastOutcomes).toEqual([
      expect.objectContaining({
        interval: "3h",
        generationId: published.forecastOutcomes[0]!.generationId,
        outcome: "skip",
        reasonCode: "forecast_generation_already_active",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        generationId: published.forecastOutcomes[0]!.generationId,
        outcome: "skip",
        reasonCode: "forecast_generation_already_active",
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
      `select interval, generation_id, generated_at, materialized_at
       from forecast_read_models
       where spot_id = ?
       order by interval desc`
    )
      .bind("linda-mar")
      .all<{
        interval: string;
        generation_id: string;
        generated_at: string;
        materialized_at: string;
      }>();
    expect(activeRows.results).toHaveLength(2);
    expect(new Set(activeRows.results.map(({ generated_at }) => generated_at))).toEqual(
      new Set([newer.threeHour.generatedAt])
    );
    expect(new Set(activeRows.results.map(({ generation_id }) => generation_id))).toEqual(
      new Set(published.forecastOutcomes.map(({ generationId }) => generationId))
    );
    expect(new Set(activeRows.results.map(({ materialized_at }) => materialized_at))).toEqual(
      new Set(["2026-08-04T13:05:00.000Z"])
    );
    const activeBundles = await env.DB.prepare(
      `select generation_id, materialized_at
       from forecast_fact_bundles
       where spot_id = ?`
    )
      .bind("linda-mar")
      .all<{ generation_id: string; materialized_at: string }>();
    expect(activeBundles.results).toEqual([
      expect.objectContaining({
        generation_id: published.forecastOutcomes[0]!.generationId,
        materialized_at: "2026-08-04T13:05:00.000Z"
      })
    ]);
  });

  it("fills a missing interval on a partial same-generation retry without rewriting active rows", async () => {
    const generation = forecastGeneration("2026-08-06T13:00:00.000Z");
    const bundle = await buildForecastFactBundle(generation.threeHour);
    const options = {
      db: env.DB,
      ...generation,
      factBundles: [bundle],
      sourceIssueFingerprint: "partial-worker-spec-source",
      materializedAt: "2026-08-06T13:05:00.000Z",
      ingestId: "partial-worker-spec-ingest"
    };
    const initial = await persistForecastMaterialization(options);
    expect(initial.forecastRowsWritten).toBe(2);

    await env.DB.prepare(
      `delete from forecast_read_models where spot_id = ? and interval = '1h'`
    )
      .bind("linda-mar")
      .run();

    const retried = await persistForecastMaterialization({
      ...options,
      materializedAt: "2026-08-06T13:06:00.000Z"
    });
    expect(retried).toMatchObject({
      rowsWritten: 1,
      forecastRowsWritten: 1,
      factBundleRowsWritten: 0,
      errors: []
    });
    expect(retried.forecastOutcomes).toEqual([
      expect.objectContaining({
        interval: "3h",
        generationId: initial.forecastOutcomes[0]!.generationId,
        outcome: "skip",
        reasonCode: "forecast_generation_already_active",
        retryable: false
      }),
      expect.objectContaining({
        interval: "1h",
        generationId: initial.forecastOutcomes[0]!.generationId,
        outcome: "publish",
        reasonCode: "forecast_generation_published",
        retryable: false
      })
    ]);

    const active = await env.DB.prepare(
      `select interval, generation_id, materialized_at
       from forecast_read_models
       where spot_id = ?
       order by interval desc`
    )
      .bind("linda-mar")
      .all<{ interval: string; generation_id: string; materialized_at: string }>();
    expect(active.results).toEqual([
      expect.objectContaining({
        interval: "3h",
        materialized_at: "2026-08-06T13:05:00.000Z"
      }),
      expect.objectContaining({
        interval: "1h",
        materialized_at: "2026-08-06T13:06:00.000Z"
      })
    ]);
    expect(new Set(active.results.map(({ generation_id }) => generation_id))).toEqual(
      new Set([initial.forecastOutcomes[0]!.generationId])
    );
  });
});
