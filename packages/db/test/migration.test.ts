import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateNorcalSeedSql, validateNorcalSeedConfig } from "../src/norcal-seed";

const migrationSql = readFileSync(new URL("../migrations/0000_initial.sql", import.meta.url), "utf8");
const historyMigrationSql = readFileSync(
  new URL("../migrations/0001_forecast_history.sql", import.meta.url),
  "utf8"
);
const allMigrationSql = `${migrationSql}\n${historyMigrationSql}`;
const seedSql = readFileSync(new URL("../seeds/0000_v1_norcal.sql", import.meta.url), "utf8");

const appliedMigrationHashes = {
  "0000_initial.sql": "f020c33694ac21a922820ed50b50588f6dfe6f2afca842ed53c091239860c482",
  "0001_forecast_history.sql": "4648120b46a8991a8b734a7546501461a16b2db37654eeeca629e471725293eb"
};

function tableBody(tableName: string): string {
  const match = allMigrationSql.match(
    new RegExp(`create table if not exists ${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`, "i")
  );
  if (!match?.[1]) {
    throw new Error(`Missing table ${tableName}`);
  }
  return match[1].replace(/\s+/g, " ").toLowerCase();
}

describe("D1 migration", () => {
  const requiredTables = {
    spots: ["id text primary key", "region text not null", "config_json text not null"],
    sources: ["type text not null", "format text not null", "parser_runtime text not null", "attribution text not null"],
    source_runs: ["run_key text not null", "source_id text not null", "status text not null", "raw_r2_key text", "artifact_manifest_json text"],
    source_artifacts: ["source_run_id text not null", "r2_key text not null", "checksum_sha256 text"],
    wave_forecasts: ["source_run_id text", "model_cycle_at text not null", "forecast_at text not null", "lead_hour integer not null", "nearshore_height_m real"],
    tide_forecasts: ["station_id text not null", "forecast_at text not null", "tide_ft_mllw real not null", "tide_trend text"],
    wind_forecasts: ["forecast_at text not null", "wind_speed_ms real", "wind_direction_deg integer", "gust_ms real"],
    wave_observations: ["observed_at text not null", "wave_height_m real", "peak_period_s real", "water_temp_c real"],
    hazard_events: ["event_id text not null", "headline text not null", "severity text", "starts_at text"],
    wind_forecast_issues: [
      "source_run_id text not null",
      "issue_key text not null",
      "issued_at text not null",
      "forecast_at text not null",
      "lead_hours real"
    ],
    forecast_snapshots: [
      "issue_id text not null",
      "captured_at text not null",
      "issued_at text not null",
      "valid_at text not null",
      "lead_hours real not null",
      "surface_condition text not null",
      "displayed_height_label text not null",
      "source_run_ids_json text not null",
      "raw_facts_json text not null",
      "spot_config_hash text not null",
      "forecast_engine_version text not null"
    ],
    forecast_configs: [
      "config_hash text not null",
      "config_json text not null",
      "created_at text not null"
    ],
    forecast_issues: [
      "issue_id text not null",
      "captured_at text not null",
      "issued_at text not null",
      "source_issue_fingerprint text not null",
      "spot_config_hash text not null",
      "issue_context_json text not null",
      "expected_window_count integer not null"
    ]
  };

  it("keeps already-applied migrations byte-for-byte immutable", () => {
    expect(createHash("sha256").update(migrationSql).digest("hex")).toBe(
      appliedMigrationHashes["0000_initial.sql"]
    );
    expect(createHash("sha256").update(historyMigrationSql).digest("hex")).toBe(
      appliedMigrationHashes["0001_forecast_history.sql"]
    );
  });

  it("creates the normalized v1 operational tables with required columns", () => {
    for (const [tableName, columns] of Object.entries(requiredTables)) {
      const body = tableBody(tableName);
      for (const column of columns) {
        expect(body, `${tableName}.${column}`).toContain(column);
      }
    }
  });

  it("keeps idempotency and read-path indexes for source runs and core forecast rows", () => {
    const normalizedSql = allMigrationSql.replace(/\s+/g, " ").toLowerCase();

    expect(normalizedSql).toContain("create unique index if not exists source_runs_run_key_idx on source_runs (run_key)");
    expect(normalizedSql).toContain("create index if not exists wave_forecasts_spot_forecast_at_idx on wave_forecasts (spot_id, forecast_at)");
    expect(normalizedSql).toContain("create index if not exists tide_forecasts_spot_forecast_at_idx on tide_forecasts (spot_id, forecast_at)");
    expect(normalizedSql).toContain("create index if not exists wind_forecasts_spot_forecast_at_idx on wind_forecasts (spot_id, forecast_at)");
    expect(normalizedSql).toContain("create index if not exists wind_forecast_issues_spot_forecast_at_idx on wind_forecast_issues (spot_id, forecast_at)");
    expect(normalizedSql).toContain("create index if not exists forecast_snapshots_spot_valid_at_idx on forecast_snapshots (spot_id, valid_at)");
    expect(normalizedSql).toContain("create index if not exists forecast_snapshots_captured_at_idx on forecast_snapshots (captured_at)");
    expect(normalizedSql).toContain("create index if not exists wind_forecast_issues_captured_at_idx on wind_forecast_issues (captured_at)");
    expect(normalizedSql).toContain("create index if not exists source_runs_started_at_idx on source_runs (started_at)");
    expect(normalizedSql).toContain("create index if not exists source_artifacts_created_at_idx on source_artifacts (created_at)");
    expect(normalizedSql).toContain("create index if not exists wave_forecasts_forecast_at_idx on wave_forecasts (forecast_at)");
    expect(normalizedSql).toContain("create index if not exists tide_forecasts_forecast_at_idx on tide_forecasts (forecast_at)");
    expect(normalizedSql).toContain("create index if not exists wind_forecasts_forecast_at_idx on wind_forecasts (forecast_at)");
    expect(normalizedSql).toContain("create index if not exists wave_observations_observed_at_idx on wave_observations (observed_at)");
    expect(normalizedSql).toContain("create index if not exists hazard_events_updated_at_idx on hazard_events (updated_at)");
  });

  it("adds forecast history without altering or dropping the live read-model tables", () => {
    const normalizedHistory = historyMigrationSql.replace(/\s+/g, " ").toLowerCase();

    expect(normalizedHistory).not.toContain("alter table");
    expect(normalizedHistory).not.toContain("drop table");
    expect(normalizedHistory).toContain(
      "primary key (spot_id, source_id, issue_key, forecast_at)"
    );
    expect(normalizedHistory).toContain("primary key (spot_id, issue_id, valid_at)");
    expect(normalizedHistory).toContain("primary key (spot_id, config_hash)");
    expect(normalizedHistory).toContain("primary key (spot_id, issue_id)");
    expect(normalizedHistory).toContain(
      "foreign key (spot_id, spot_config_hash) references forecast_configs(spot_id, config_hash)"
    );
  });
});

describe("v1 seed SQL", () => {
  it("is generated deterministically from the validated reference config", () => {
    expect(() => validateNorcalSeedConfig()).not.toThrow();
    expect(seedSql).toBe(generateNorcalSeedSql());
  });

  it("seeds all v1 spots and public source records", () => {
    const spotIds = ["obsf-north", "obsf-central", "obsf-south", "linda-mar", "stinson", "bolinas"];
    const sourceIds = [
      "cdip:mop-forecast",
      "ndbc:realtime2-standard-meteorological",
      "ndbc-46237",
      "ndbc-46026",
      "ndbc-46013",
      "ndbc-46012",
      "coops-9414290",
      "coops-9414131",
      "coops-9414958",
      "coops:tide-predictions",
      "nws:mtr-grid-wave",
      "nws:point-forecast-alerts"
    ];

    for (const spotId of spotIds) {
      expect(seedSql).toContain(`'${spotId}'`);
    }

    for (const sourceId of sourceIds) {
      expect(seedSql).toContain(`'${sourceId}'`);
    }
  });

  it("uses upserts for spots and sources", () => {
    const normalizedSeed = seedSql.replace(/\s+/g, " ").toLowerCase();

    expect(normalizedSeed.match(/on conflict\(id\) do update set/g)).toHaveLength(2);
  });

  it("derives adapter station metadata and retires superseded generated sources", () => {
    expect(seedSql).toContain(
      '"stations":["46237","46026","46013","46012"]'
    );
    expect(seedSql).toContain('"stations":["9414290","9414131","9414958"]');
    expect(seedSql).toContain(
      "update sources set active = 0\nwhere id in ('noaa-gfswave-norcal', 'cdip-mop-norcal-unmapped', 'nws-grid-norcal', 'nws-alerts-norcal');"
    );
  });
});
