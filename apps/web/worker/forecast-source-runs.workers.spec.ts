/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildForecastResponse } from "./forecast";
import type { Env } from "./index";

// Pins reference-driven source-run freshness against real D1/SQLite. Served
// rows stay pinned to the run that wrote them even after more than 100 newer
// batch runs land, so the read path must resolve exactly those CO-OPS/NWS run
// IDs instead of guessing from global recency.
describe("forecast source-run retention in workerd D1", () => {
  it("resolves older referenced CO-OPS and NWS runs after more than 100 newer batch runs", async () => {
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
       values ('nws:point-forecast-alerts', 'NWS point forecast', 'weather', 'nws', 'json', 'typescript', 'test', 60, 1)`
    ).run();
    await env.DB.prepare(
      `insert or ignore into sources (id, name, type, provider, format, parser_runtime, attribution, refresh_minutes, active)
       values ('test:filler', 'Filler source', 'test', 'test', 'json', 'typescript', 'test', 60, 1)`
    ).run();

    await env.DB.batch([
      env.DB.prepare(
        `insert into source_runs (id, run_key, source_id, run_kind, started_at, completed_at, status)
         values ('coops-old-partial', 'coops-old-partial-key', 'coops:tide-predictions', 'live', ?, ?, 'partial')`
      ).bind(oldRunCompletedAt, oldRunCompletedAt),
      env.DB.prepare(
        `insert into source_runs (id, run_key, source_id, run_kind, started_at, completed_at, status)
         values ('nws-old-partial', 'nws-old-partial-key', 'nws:point-forecast-alerts', 'live', ?, ?, 'partial')`
      ).bind(oldRunCompletedAt, oldRunCompletedAt)
    ]);

    // Production batching creates many globally newer runs that have no
    // bearing on the source IDs referenced by this spot's retained rows.
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

    // Tide and wind rows still cover the horizon and reference the older runs.
    const forecastStatements = [];
    for (let hour = 0; hour < 8; hour += 1) {
      const forecastAt = new Date(now.getTime() + hour * 60 * 60_000).toISOString();
      forecastStatements.push(
        env.DB.prepare(
          `insert into tide_forecasts (spot_id, source_id, source_run_id, station_id, forecast_at, tide_ft_mllw, created_at)
           values ('bolinas', 'coops:tide-predictions', 'coops-old-partial', '9414958', ?, 3.1, ?)`
        ).bind(forecastAt, oldRunCompletedAt),
        env.DB.prepare(
          `insert into wind_forecasts (
             spot_id, source_id, source_run_id, forecast_at, wind_speed_ms,
             wind_direction_deg, gust_ms, weather_summary, created_at
           ) values (
             'bolinas', 'nws:point-forecast-alerts', 'nws-old-partial', ?, 3.0,
             90, 4.0, 'Clear', ?
           )`
        ).bind(forecastAt, oldRunCompletedAt)
      );
    }
    await env.DB.batch(forecastStatements);

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

    const response = await buildForecastResponse(env as unknown as Env, "bolinas", now, "1h");
    const sourceFreshness = response.windows
      .find((window) => window.forecastAt === now.toISOString())
      ?.sourceFreshness;
    const tideEntry = sourceFreshness?.find((entry) => entry.capability === "tide");
    const windEntry = sourceFreshness?.find((entry) => entry.capability === "wind");

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
    expect(windEntry).toMatchObject({
      sourceId: "nws:point-forecast-alerts",
      sourceRunId: "nws-old-partial",
      updatedAt: oldRunCompletedAt,
      freshnessMinutes: 31 * 60,
      status: "stale",
      expectedCadenceMinutes: 360,
      graceMinutes: 180
    });
  });
});
