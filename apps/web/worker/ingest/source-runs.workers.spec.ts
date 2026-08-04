/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AdapterOutcome } from "../adapters/types";
import { sourceGenerationIsCurrent } from "./queue";
import { recordSourceRun } from "./source-runs";

const sourceId = "test:monotonic-source";
const lineage = "stable-deploy-lineage";
const t1 = "2026-08-04T01:00:00.000Z";
const t15 = "2026-08-04T01:05:00.000Z";
const t2 = "2026-08-04T01:10:00.000Z";

function outcome(generation: string): AdapterOutcome<never> {
  return {
    sourceId,
    provider: "test",
    capabilities: [],
    status: "success",
    rows: [],
    caveats: [],
    errors: [],
    fetchedAt: generation,
    metadata: { generation }
  };
}

async function record(generation: string) {
  return recordSourceRun(env.DB, outcome(generation), {
    startedAt: generation,
    completedAt: generation,
    idSuffix: lineage
  });
}

describe("source-run generation fencing in workerd D1", () => {
  it("advances a reused lineage monotonically and rejects a delayed intermediate generation", async () => {
    await env.DB.prepare(
      `insert into sources (
         id, name, type, provider, format, parser_runtime, attribution,
         refresh_minutes, active
       ) values (?, 'Monotonic test source', 'test', 'test', 'json', 'typescript',
                 'test only', 60, 1)`
    )
      .bind(sourceId)
      .run();

    await expect(record(t1)).resolves.toMatchObject({ recorded: true });
    await expect(record(t2)).resolves.toMatchObject({ recorded: true });

    const afterAdvance = await env.DB.prepare(
      `select started_at, metadata_json from source_runs where id = ?`
    )
      .bind(`${sourceId.replace(/[^a-z0-9]+/g, "-")}-${lineage}`)
      .first<{ started_at: string; metadata_json: string }>();
    expect(afterAdvance?.started_at).toBe(t2);
    expect(JSON.parse(afterAdvance?.metadata_json ?? "null").metadata.generation).toBe(t2);
    await expect(sourceGenerationIsCurrent(env.DB, t15)).resolves.toBe(false);

    await expect(record(t15)).resolves.toMatchObject({ recorded: true });
    const afterDelayedReplay = await env.DB.prepare(
      `select started_at, metadata_json from source_runs where id = ?`
    )
      .bind(`${sourceId.replace(/[^a-z0-9]+/g, "-")}-${lineage}`)
      .first<{ started_at: string; metadata_json: string }>();
    expect(afterDelayedReplay?.started_at).toBe(t2);
    expect(JSON.parse(afterDelayedReplay?.metadata_json ?? "null").metadata.generation).toBe(t2);
  });
});
