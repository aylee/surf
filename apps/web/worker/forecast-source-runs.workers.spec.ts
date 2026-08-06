/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildForecastResponse } from "./forecast";
import type { Env } from "./index";

// Pins reference-driven source-run retention against real D1/SQLite: the
// recent-100 window alone evicts a still-referenced run after ~20 hours of
// five-per-hour run traffic, while the slowest declared late boundary (tide,
// 1440 + 360) is 30 hours. Served rows stay pinned to the run that wrote
// them — including OLDER runs of a source that keeps landing newer partial
// runs during a per-station outage — so the read path must resolve exactly
// the referenced runs and let freshness age to "late" instead of flipping to
// "missing".
describe("forecast source-run retention in workerd D1", () => {
  it("resolves an evicted referenced partial run so tide reaches its declared late verdict", async () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const oldRunCompletedAt = "2026-08-04T05:00:00.000Z"; // 31h before now

    await env.DB.prepare(
      `insert or ignore into spots (id, name, region, lat, lon, timezone, config_json, active)
       values ('bolinas', 'Bolinas', 'norcal', 37.9, -122.68, 'America/Los_Angeles', '{}', 1)`
    ).run();
    await env.DB.prepare(
      `insert or ignore into sources (id, name, type, provider, format, parser_runtime, attribution, refresh_minutes, active)
       values ('coops:tide-predictions', 'CO-OPS tide predictions', 'tide', 'noaa', 'json', 'typescript', 'test', 60, 1)`
    ).run();
    await env.DB.prepare(
      `insert or ignore into sources (id, name, type, provider, format, parser_runtime, attribution, refresh_minutes, active)
       values ('test:filler', 'Filler source', 'test', 'test', 'json', 'typescript', 'test', 60, 1)`
    ).run();

    // The referenced run finalized PARTIAL (rows landed, one station degraded)
    // and is 31 hours old — far outside the recent-100 window below.
    await env.DB.prepare(
      `insert into source_runs (id, run_key, source_id, run_kind, started_at, completed_at, status)
       values ('coops-old-partial', 'coops-old-partial-key', 'coops:tide-predictions', 'live', ?, ?, 'partial')`
    )
      .bind(oldRunCompletedAt, oldRunCompletedAt)
      .run();

    // 110 newer completed filler runs across the last ~20 hours evict the old
    // run from the plain `order by completed_at desc limit 100` window.
    const fillerStatements = [];
    for (let index = 0; index < 110; index += 1) {
      const completedAt = new Date(now.getTime() - (index + 1) * 10 * 60_000).toISOString();
      fillerStatements.push(
        env.DB.prepare(
          `insert into source_runs (id, run_key, source_id, run_kind, started_at, completed_at, status)
           values (?, ?, 'test:filler', 'live', ?, ?, 'success')`
        ).bind(`filler-${index}`, `filler-key-${index}`, completedAt, completedAt)
      );
    }
    await env.DB.batch(fillerStatements);

    // Tide rows still cover the horizon and reference the evicted partial run.
    const tideStatements = [];
    for (let hour = 0; hour < 8; hour += 1) {
      const forecastAt = new Date(now.getTime() + hour * 60 * 60_000).toISOString();
      tideStatements.push(
        env.DB.prepare(
          `insert into tide_forecasts (spot_id, source_id, source_run_id, station_id, forecast_at, tide_ft_mllw, created_at)
           values ('bolinas', 'coops:tide-predictions', 'coops-old-partial', '9414958', ?, 3.1, ?)`
        ).bind(forecastAt, oldRunCompletedAt)
      );
    }
    await env.DB.batch(tideStatements);

    // A NEWER partial run for the same source exists (a per-station outage
    // keeps producing runs that rewrite only the healthy spots' rows). The
    // served rows above stay pinned to the older run, which must still
    // resolve even though it is neither recent nor the source's newest run.
    const newerPartialAt = new Date(now.getTime() - 30 * 60_000).toISOString();
    await env.DB.prepare(
      `insert into source_runs (id, run_key, source_id, run_kind, started_at, completed_at, status)
       values ('coops-newer-partial', 'coops-newer-partial-key', 'coops:tide-predictions', 'live', ?, ?, 'partial')`
    )
      .bind(newerPartialAt, newerPartialAt)
      .run();

    const response = await buildForecastResponse(env as unknown as Env, "bolinas", now);
    const tideEntry = response.windows[0]?.sourceFreshness?.find((entry) => entry.capability === "tide");

    // The referenced run resolves exactly: the entry ages honestly past the
    // 30-hour boundary instead of going missing.
    expect(tideEntry).toMatchObject({
      sourceId: "coops:tide-predictions",
      sourceRunId: "coops-old-partial",
      updatedAt: oldRunCompletedAt,
      freshnessMinutes: 31 * 60,
      status: "stale",
      expectedCadenceMinutes: 1440,
      graceMinutes: 360
    });
  });
});
