import { describe, expect, it, vi } from "vitest";
import { assembleModelForecastBrief } from "./brief";
import { buildForecastFactBundle } from "./facts";
import {
  buildDisabledForecastBriefResponse,
  buildForecastBriefResponse
} from "./response";
import { briefForecastFixture, validDraftFor } from "./test-helpers";
import { validateForecastBriefDraft } from "./validator";

function modelBriefDb(input: Record<string, unknown> | Record<string, unknown>[]): D1Database {
  const rows = Array.isArray(input) ? input : [input];
  return {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async first() {
          if (/count\(\*\)/i.test(sql)) return { count: rows.length };
          const materialFingerprint = /material_fingerprint\s*=\s*\?/i.test(sql)
            ? bindings[2]
            : null;
          return [...rows]
            .filter(
              (row) =>
                materialFingerprint === null ||
                row.material_fingerprint === materialFingerprint
            )
            .sort((left, right) => Number(right.revision) - Number(left.revision))[0] ?? null;
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
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = {
      prepare() {
        throw new Error("table unavailable");
      }
    } as unknown as D1Database;
    const bundle = await buildForecastFactBundle(briefForecastFixture());

    const response = await buildForecastBriefResponse(db, bundle);

    expect(response.status).toBe("deterministic_fallback");
    expect(response.brief.provider).toBe("deterministic");
    expect(response.fallbackReason).toBeNull();
    expect(response.availableRevisions).toBe(0);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toContain('"errorName":"Error"');
    expect(warning.mock.calls[0]?.[0]).toContain('"errorMessage":"table unavailable"');
    expect(JSON.stringify(response)).not.toContain("table unavailable");
    warning.mockRestore();
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
      fallbackReason: "No validated model brief matches the current forecast inputs.",
      brief: { provider: "deterministic", revision: 4 }
    });
  });

  it("serves the newest revision matching the current policy instead of a later incompatible row", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const { validation } = validateForecastBriefDraft(draft, bundle);
    const current = assembleModelForecastBrief({
      bundle,
      draft,
      revision: 2,
      generatedAt: "2026-08-02T14:00:00.000Z"
    });
    const compatibleRow = {
      spot_id: current.spotId,
      local_date: current.localDate,
      revision: current.revision,
      input_fingerprint: current.inputFingerprint,
      material_fingerprint: bundle.materialFingerprint,
      status: "validated",
      generated_at: current.generatedAt,
      expires_at: null,
      provider: current.provider,
      model_id: current.modelId,
      prompt_version: current.promptVersion,
      schema_version: current.schemaVersion,
      brief_json: JSON.stringify(current),
      fact_refs_json: JSON.stringify(validation.referencedFactIds),
      validation_json: JSON.stringify(validation),
      created_at: current.generatedAt
    };
    const incompatibleBrief = { ...current, revision: 3 };
    const incompatibleRow = {
      ...compatibleRow,
      revision: 3,
      material_fingerprint: "f".repeat(64),
      brief_json: JSON.stringify(incompatibleBrief)
    };

    const response = await buildForecastBriefResponse(
      modelBriefDb([incompatibleRow, compatibleRow]),
      bundle
    );

    expect(response.status).toBe("model");
    expect(response.brief.revision).toBe(2);
    expect(response.brief.inputFingerprint).toBe(bundle.inputFingerprint);
    expect(response.availableRevisions).toBe(2);
  });

  it("serves a persisted v1 validation record that predates claim-level references", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const { validation } = validateForecastBriefDraft(draft, bundle);
    const current = assembleModelForecastBrief({
      bundle,
      draft,
      revision: 1,
      generatedAt: "2026-08-02T14:00:00.000Z"
    });
    const legacyBrief = {
      ...current,
      schemaVersion: 1,
      promptVersion: "surf-brief-v1"
    };
    const legacyValidation = {
      valid: validation.valid,
      checkedAt: validation.checkedAt,
      referencedFactIds: validation.referencedFactIds
    };
    const response = await buildForecastBriefResponse(
      modelBriefDb({
        spot_id: legacyBrief.spotId,
        local_date: legacyBrief.localDate,
        revision: legacyBrief.revision,
        input_fingerprint: legacyBrief.inputFingerprint,
        material_fingerprint: bundle.materialFingerprint,
        status: "validated",
        generated_at: legacyBrief.generatedAt,
        expires_at: null,
        provider: legacyBrief.provider,
        model_id: legacyBrief.modelId,
        prompt_version: legacyBrief.promptVersion,
        schema_version: legacyBrief.schemaVersion,
        brief_json: JSON.stringify(legacyBrief),
        fact_refs_json: JSON.stringify(validation.referencedFactIds),
        validation_json: JSON.stringify(legacyValidation),
        created_at: legacyBrief.generatedAt
      }),
      bundle
    );

    expect(response.status).toBe("model");
    expect(response.brief).toMatchObject({
      schemaVersion: 1,
      promptVersion: "surf-brief-v1",
      provider: "google"
    });
  });

  it("falls back safely when claim references disagree with validation metadata", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const { validation } = validateForecastBriefDraft(draft, bundle);
    const brief = assembleModelForecastBrief({
      bundle,
      draft,
      revision: 1,
      generatedAt: "2026-08-02T14:00:00.000Z"
    });
    const mismatchedValidation = {
      ...validation,
      claimRefs: [{ path: "summary", factRefs: [validation.referencedFactIds[0]!] }]
    };

    try {
      const response = await buildForecastBriefResponse(
        modelBriefDb({
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
          validation_json: JSON.stringify(mismatchedValidation),
          created_at: brief.generatedAt
        }),
        bundle
      );

      expect(response).toMatchObject({
        status: "deterministic_fallback",
        fallbackReason: null,
        availableRevisions: 0,
        brief: { provider: "deterministic" }
      });
      expect(JSON.stringify(response)).not.toMatch(/claim references|validation metadata/i);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toContain("claim references do not match");
    } finally {
      warning.mockRestore();
    }
  });

  it("falls back safely when a stored expiration timestamp is malformed", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const { validation } = validateForecastBriefDraft(draft, bundle);
    const brief = assembleModelForecastBrief({
      bundle,
      draft,
      revision: 1,
      generatedAt: "2026-08-02T14:00:00.000Z"
    });

    try {
      const response = await buildForecastBriefResponse(
        modelBriefDb({
          spot_id: brief.spotId,
          local_date: brief.localDate,
          revision: brief.revision,
          input_fingerprint: brief.inputFingerprint,
          material_fingerprint: bundle.materialFingerprint,
          status: "validated",
          generated_at: brief.generatedAt,
          expires_at: "not-an-iso-timestamp",
          provider: brief.provider,
          model_id: brief.modelId,
          prompt_version: brief.promptVersion,
          schema_version: brief.schemaVersion,
          brief_json: JSON.stringify(brief),
          fact_refs_json: JSON.stringify(validation.referencedFactIds),
          validation_json: JSON.stringify(validation),
          created_at: brief.generatedAt
        }),
        bundle
      );

      expect(response).toMatchObject({
        status: "deterministic_fallback",
        fallbackReason: null,
        availableRevisions: 0,
        brief: { provider: "deterministic" }
      });
      expect(JSON.stringify(response)).not.toContain("not-an-iso-timestamp");
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toContain("expiration is invalid");
    } finally {
      warning.mockRestore();
    }
  });
});
