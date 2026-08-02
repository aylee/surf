import { describe, expect, it } from "vitest";
import { buildForecastFactBundle } from "./facts";
import { persistValidatedForecastBrief } from "./repository";
import { briefForecastFixture, validDraftFor } from "./test-helpers";
import { validateForecastBriefDraft } from "./validator";

function emptyRepositoryDb(): { db: D1Database; statements: string[] } {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          return sql.includes("coalesce(max(revision)") ? { revision: 1 } : null;
        },
        async run() {
          return { success: true, meta: {}, results: [] };
        }
      };
      return statement;
    }
  } as unknown as D1Database;
  return { db, statements };
}

describe("forecast brief D1 repository", () => {
  it("persists only a validated model brief in the revisions table", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const draft = validDraftFor(bundle);
    const { validation } = validateForecastBriefDraft(draft, bundle);
    const { db, statements } = emptyRepositoryDb();

    const persisted = await persistValidatedForecastBrief({ db, bundle, draft, validation });

    expect(persisted.brief.provider).toBe("google");
    expect(persisted.materialFingerprint).toBe(bundle.materialFingerprint);
    expect(statements.some((sql) => /insert into forecast_brief_revisions/i.test(sql))).toBe(true);
  });
});
