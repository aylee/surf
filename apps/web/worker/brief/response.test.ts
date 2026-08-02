import { describe, expect, it } from "vitest";
import { assembleModelForecastBrief } from "./brief";
import { buildForecastFactBundle } from "./facts";
import {
  buildDisabledForecastBriefResponse,
  buildForecastBriefResponse
} from "./response";
import { briefForecastFixture, validDraftFor } from "./test-helpers";
import { validateForecastBriefDraft } from "./validator";

function modelBriefDb(row: Record<string, unknown>): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          return /count\(\*\)/i.test(sql) ? { count: 1 } : row;
        }
      };
      return statement;
    }
  } as unknown as D1Database;
}

describe("forecast brief public response", () => {
  it("uses a deterministic response when the feature kill switch is off", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());

    const response = buildDisabledForecastBriefResponse(bundle);

    expect(response).toMatchObject({
      status: "deterministic_fallback",
      fallbackReason: "AI forecast briefs are disabled for this Worker version.",
      availableRevisions: 0,
      brief: { provider: "deterministic" }
    });
  });

  it("falls back deterministically when brief storage is unavailable", async () => {
    const db = {
      prepare() {
        throw new Error("table unavailable");
      }
    } as unknown as D1Database;
    const bundle = await buildForecastFactBundle(briefForecastFixture());

    const response = await buildForecastBriefResponse(db, bundle);

    expect(response.status).toBe("deterministic_fallback");
    expect(response.brief.provider).toBe("deterministic");
    expect(response.availableRevisions).toBe(0);
  });

  it("returns the latest validated model revision while its material facts remain current", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const { validation } = validateForecastBriefDraft(draft, bundle);
    const brief = assembleModelForecastBrief({
      bundle,
      draft,
      revision: 1,
      generatedAt: "2026-08-02T14:00:00.000Z"
    });
    const db = modelBriefDb({
      spot_id: brief.spotId,
      local_date: brief.localDate,
      revision: brief.revision,
      input_fingerprint: brief.inputFingerprint,
      material_fingerprint: bundle.materialFingerprint,
      status: "validated",
      generated_at: brief.generatedAt,
      expires_at: null,
      provider: brief.provider,
      model_id: brief.modelId,
      prompt_version: brief.promptVersion,
      schema_version: brief.schemaVersion,
      brief_json: JSON.stringify(brief),
      fact_refs_json: JSON.stringify(validation.referencedFactIds),
      validation_json: JSON.stringify(validation),
      created_at: brief.generatedAt
    });

    const response = await buildForecastBriefResponse(db, bundle);

    expect(response.status).toBe("model");
    expect(response.brief).toEqual(brief);
    expect(response.availableRevisions).toBe(1);
  });

  it("returns a labeled deterministic stale response after material facts change", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const { validation } = validateForecastBriefDraft(draft, bundle);
    const brief = assembleModelForecastBrief({
      bundle,
      draft,
      revision: 4,
      generatedAt: "2026-08-02T14:00:00.000Z"
    });
    const response = await buildForecastBriefResponse(
      modelBriefDb({
        spot_id: brief.spotId,
        local_date: brief.localDate,
        revision: brief.revision,
        input_fingerprint: brief.inputFingerprint,
        material_fingerprint: "0".repeat(64),
        status: "validated",
        generated_at: brief.generatedAt,
        expires_at: null,
        provider: brief.provider,
        model_id: brief.modelId,
        prompt_version: brief.promptVersion,
        schema_version: brief.schemaVersion,
        brief_json: JSON.stringify(brief),
        fact_refs_json: JSON.stringify(validation.referencedFactIds),
        validation_json: JSON.stringify(validation),
        created_at: brief.generatedAt
      }),
      bundle,
      new Date("2026-08-02T15:00:00.000Z")
    );

    expect(response).toMatchObject({
      status: "stale",
      fallbackReason: "Forecast inputs changed materially after the latest validated model brief.",
      brief: { provider: "deterministic", revision: 4 }
    });
  });
});
