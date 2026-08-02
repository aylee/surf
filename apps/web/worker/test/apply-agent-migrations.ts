/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.prepare(
    `insert into spots (
       id, name, region, lat, lon, timezone, shore_normal_deg, config_json, active
     ) values (?, ?, 'norcal', ?, ?, 'America/Los_Angeles', ?, '{}', 1),
              (?, ?, 'norcal', ?, ?, 'America/Los_Angeles', ?, '{}', 1)`
  )
    .bind(
      "linda-mar",
      "Linda Mar",
      37.594,
      -122.506,
      250,
      "bolinas",
      "Bolinas",
      37.909,
      -122.687,
      215
    )
    .run();
});
