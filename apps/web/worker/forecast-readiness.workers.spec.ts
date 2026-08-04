/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FORECAST_READ_MODEL_SCHEMA_VERSION } from "./forecast-read-model";
import { getForecastReadiness } from "./forecast-readiness";

it("queries the active regional target cross-product and preserves missing intervals", async () => {
  await env.DB.prepare("update spots set active = 0 where id = ?")
    .bind("bolinas")
    .run();
  await env.DB.prepare(
    `insert into spots (
       id, name, region, lat, lon, timezone, shore_normal_deg, config_json, active
     ) values (?, ?, 'outside-test-region', ?, ?, 'America/Los_Angeles', ?, '{}', 1)`
  )
    .bind("outside-region", "Outside Region", 38, -123, 270)
    .run();

  const generationId = `sha256:${"b".repeat(64)}:ingest:worker-spec-lineage`;
  await env.DB.prepare(
    `insert into forecast_read_models (
       spot_id, interval, generation_id, generated_at, source_issue_fingerprint,
       schema_version, forecast_json, materialized_at
     ) values (?, '3h', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      "linda-mar",
      generationId,
      "2026-08-04T06:13:19.808Z",
      "worker-spec-source-fingerprint",
      FORECAST_READ_MODEL_SCHEMA_VERSION,
      '{"privatePayload":"must-not-leak"}',
      "2026-08-04T06:13:48.853Z"
    )
    .run();

  const result = await getForecastReadiness(env.DB, "norcal");

  expect(result).toEqual({
    forecastReadModels: [
      {
        spotId: "linda-mar",
        interval: "3h",
        generationId,
        ingestId: "worker-spec-lineage",
        generatedAt: "2026-08-04T06:13:19.808Z",
        materializedAt: "2026-08-04T06:13:48.853Z"
      },
      {
        spotId: "linda-mar",
        interval: "1h",
        generationId: null,
        ingestId: null,
        generatedAt: null,
        materializedAt: null
      }
    ]
  });
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
});
