import { describe, expect, it } from "vitest";
import {
  directModelQualityFixture,
  nwsFallbackQualityFixture,
  withImplementationPlumbing,
  withIrrelevantRecommendationEvidence,
  withLockedModelCitation,
  withRepeatedPickProse,
  withSwappedRoles
} from "./quality-fixtures";
import { evaluateForecastBriefQuality } from "./quality";
import { validateForecastBriefDraft } from "./validator";

describe("forecast brief deterministic quality evaluation", () => {
  it("accepts a natural direct-model explanation with useful, varied evidence", async () => {
    const { draft, bundle } = await directModelQualityFixture();

    const report = evaluateForecastBriefQuality(draft, bundle);
    expect(report).toMatchObject({
      policyVersion: "surf-brief-quality-v2",
      passed: true,
      checks: {
        citationRelevance: true,
        roleCoverage: true,
        evidenceDiversity: true,
        nonRepetition: true,
        noImplementationPlumbing: true,
        naturalness: true
      }
    });
    expect(report.metrics.referencedFactKinds).toBeGreaterThanOrEqual(3);
    expect(report.metrics.exactFactCopies).toBe(0);
    expect(report.metrics.uniqueProseRatio).toBe(1);
    expect(() => validateForecastBriefDraft(draft, bundle)).not.toThrow();
  });

  it("accepts natural synthesis while the NWS fallback caveats remain code-owned", async () => {
    const { draft, bundle } = await nwsFallbackQualityFixture();

    const report = evaluateForecastBriefQuality(draft, bundle);

    expect(report.passed).toBe(true);
    expect(bundle.facts.some((fact) => fact.role === "locked" && fact.id.includes("fallback"))).toBe(
      true
    );
    expect(
      draft.summary.factRefs.some(
        (factId) => bundle.facts.find((fact) => fact.id === factId)?.role === "locked"
      )
    ).toBe(false);
    expect(() => validateForecastBriefDraft(draft, bundle)).not.toThrow();
  });

  it("rejects implementation plumbing even when the prose is otherwise grounded", async () => {
    const fixture = withImplementationPlumbing(await directModelQualityFixture());

    const report = evaluateForecastBriefQuality(fixture.draft, fixture.bundle);

    expect(report.passed).toBe(false);
    expect(report.checks.noImplementationPlumbing).toBe(false);
    expect(report.issues.join(" ")).toMatch(/internal band label|deterministic plumbing/i);
  });

  it("rejects recommendation rank as the sole explanation for a window", async () => {
    const fixture = withIrrelevantRecommendationEvidence(await directModelQualityFixture());

    const report = evaluateForecastBriefQuality(fixture.draft, fixture.bundle);

    expect(report.checks.citationRelevance).toBe(false);
    expect(report.checks.roleCoverage).toBe(false);
    expect(report.issues.join(" ")).toMatch(/only spot identity or recommendation rank|substantive support/i);
  });

  it("rejects useful evidence borrowed from another recommendation window", async () => {
    const fixture = await directModelQualityFixture();
    const draft = structuredClone(fixture.draft);
    const otherWindowId = draft.picks[1]!.windowId;
    const otherWindowSupport = fixture.bundle.facts.find(
      (fact) =>
        fact.windowId === otherWindowId &&
        fact.role === "support" &&
        fact.kind !== "recommendation"
    )!;
    draft.picks[0]!.why.factRefs = [otherWindowSupport.id];

    const report = evaluateForecastBriefQuality(draft, fixture.bundle);

    expect(report.checks.citationRelevance).toBe(false);
    expect(report.issues.join(" ")).toMatch(/evidence from another forecast window|lacks evidence/i);
  });

  it("rejects swapped support and tradeoff evidence", async () => {
    const fixture = withSwappedRoles(await directModelQualityFixture());

    const report = evaluateForecastBriefQuality(fixture.draft, fixture.bundle);

    expect(report.checks.roleCoverage).toBe(false);
    expect(report.issues.join(" ")).toMatch(/does not cite substantive support|does not cite an available tradeoff/i);
  });

  it("rejects repeated recommendation prose even when each pick cites its own window", async () => {
    const fixture = withRepeatedPickProse(await directModelQualityFixture());

    const report = evaluateForecastBriefQuality(fixture.draft, fixture.bundle);

    expect(report.checks.nonRepetition).toBe(false);
    expect(report.metrics.uniqueProseRatio).toBeLessThan(1);
    expect(report.issues.join(" ")).toMatch(/duplicates prose|sentence pattern/i);
  });

  it("keeps locked caveats outside model-authored citations", async () => {
    const fixture = withLockedModelCitation(await nwsFallbackQualityFixture());

    const report = evaluateForecastBriefQuality(fixture.draft, fixture.bundle);

    expect(report.checks.citationRelevance).toBe(false);
    expect(report.issues.join(" ")).toMatch(/code-owned locked fact/i);
  });

  it("rejects verbatim source-fact copy as a fact dump rather than synthesis", async () => {
    const fixture = await directModelQualityFixture();
    const draft = structuredClone(fixture.draft);
    const fact = fixture.bundle.facts.find(
      (candidate) => candidate.role !== "locked" && candidate.kind === "condition"
    )!;
    draft.summary = { text: fact.statement, factRefs: [fact.id] };

    const report = evaluateForecastBriefQuality(draft, fixture.bundle);

    expect(report.checks.naturalness).toBe(false);
    expect(report.metrics.exactFactCopies).toBe(1);
    expect(report.issues.join(" ")).toMatch(/copies a cited fact instead of synthesizing it/i);
  });
});
