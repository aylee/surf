import { readFileSync } from "node:fs";
import {
  NARRATIVE_JOB_MAX_BYTES,
  serializedNarrativeJobBytes
} from "@surf/narrative-contracts";
import { NORCAL_SPOTS } from "@surf/forecast-core";
import { describe, expect, it } from "vitest";
import { buildForecastFactBundle } from "../brief/facts";
import { briefForecastFixture } from "../brief/test-helpers";
import { NORCAL_SOURCE_BATCHES } from "../ingest/source-batches";
import { SURF_ANALYSIS_SIGNAL_MAX_QUEUE_RETRIES } from "../ingest/types";
import {
  NARRATIVE_RECONCILIATION_LIMIT,
  surfAnalysisFallbackDelaySeconds,
  SURF_ANALYSIS_FUTURE_CADENCE_HOURS
} from "../narrative";
import { renderSurfAnalysisReport } from "./renderer";
import {
  SURF_ANALYSIS_RESPONSE_JSON_SCHEMA,
  buildSurfAnalysisSnapshot,
  buildSurfNarrativeJob
} from "./snapshot";
import {
  SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION,
  SURF_ANALYSIS_PROMPT_VERSION,
  SURF_ANALYSIS_RESULT_TARGET,
  SurfAnalysisPlanV5Schema,
  SurfAnalysisValueSlotSchema,
  type SurfAnalysisPlanV5,
  type SurfAnalysisValidationSnapshot
} from "./types";
import { validateSurfAnalysisDraft } from "./validator";

function firstCard(
  snapshot: SurfAnalysisValidationSnapshot,
  placement: SurfAnalysisValidationSnapshot["cards"][number]["placement"],
  preferred?: string
) {
  return (
    snapshot.cards.find(
      (card) => card.placement === placement && (!preferred || card.id.includes(preferred))
    ) ?? snapshot.cards.find((card) => card.placement === placement)
  );
}

function goldenPlan(
  snapshot: SurfAnalysisValidationSnapshot,
  options: { includeAlternate?: boolean } = {}
): SurfAnalysisPlanV5 {
  const outlook = snapshot.cards.filter(({ placement }) => placement === "outlook");
  const support =
    firstCard(snapshot, "primary_support", "wind") ??
    firstCard(snapshot, "primary_support", "surface") ??
    firstCard(snapshot, "primary_support");
  const tradeoff = firstCard(snapshot, "primary_tradeoff");
  const alternate = firstCard(snapshot, "alternate", "contrast") ?? firstCard(snapshot, "alternate");
  const watch = firstCard(snapshot, "watch", "caveat") ?? firstCard(snapshot, "watch");
  if (outlook.length < 2 || !support || !watch) throw new Error("Incomplete Analysis fixture");
  return {
    schemaVersion: 1,
    outlook: {
      leadCardId:
        outlook.find(({ id }) => id === "outlook:surface-arc")?.id ?? outlook[0]!.id,
      supportingCardId:
        outlook.find(({ id }) => id === "outlook:size-arc")?.id ?? outlook[1]!.id
    },
    call: {
      primarySupportCardId: support.id,
      primaryTradeoffCardId: tradeoff?.id ?? null,
      alternateCardId:
        options.includeAlternate === false || snapshot.callMode === "primary_only"
          ? null
          : alternate?.id ?? null
    },
    close: { watchCardId: watch.id }
  };
}

async function fixtureSnapshot(): Promise<SurfAnalysisValidationSnapshot> {
  return buildSurfAnalysisSnapshot(await buildForecastFactBundle(briefForecastFixture()));
}

async function primaryOnlySnapshot(): Promise<SurfAnalysisValidationSnapshot> {
  const bundle = await buildForecastFactBundle(briefForecastFixture());
  const primaryId = bundle.input.recommendationWindowIds[0]!;
  bundle.input.recommendationWindowIds = [primaryId];
  bundle.input.recommendations = bundle.input.recommendations.filter(
    ({ representativeWindowId }) => representativeWindowId === primaryId
  );
  return buildSurfAnalysisSnapshot(bundle);
}

function renderValidated(plan: SurfAnalysisPlanV5, snapshot: SurfAnalysisValidationSnapshot) {
  const validated = validateSurfAnalysisDraft(plan, snapshot);
  return {
    validated,
    report: renderSurfAnalysisReport({
      draft: validated.draft,
      snapshot,
      revisionId: "revision.fixture",
      publishedAt: "2026-08-02T14:00:00.000Z"
    })
  };
}

describe("Surf Analysis v5 editorial plan", () => {
  it("tiers future watchdogs behind a daily-rotating current-date order", () => {
    const currentDelays = NORCAL_SPOTS.map(({ id }) =>
      surfAnalysisFallbackDelaySeconds({
        baseDelaySeconds: 600,
        spotId: id,
        localDate: "2026-08-10"
      })
    );
    const nextDayDelays = NORCAL_SPOTS.map(({ id }) =>
      surfAnalysisFallbackDelaySeconds({
        baseDelaySeconds: 600,
        spotId: id,
        localDate: "2026-08-11"
      })
    );
    const futureDelay = surfAnalysisFallbackDelaySeconds({
      baseDelaySeconds: 600,
      spotId: NORCAL_SPOTS[0]!.id,
      localDate: "2026-08-11",
      futureDatePriority: 1
    });

    expect(Math.min(...currentDelays)).toBeGreaterThanOrEqual(600);
    expect(Math.max(...currentDelays)).toBeLessThan(720);
    expect(new Set(currentDelays).size).toBeGreaterThanOrEqual(8);
    expect(nextDayDelays).not.toEqual(currentDelays);
    expect(futureDelay).toBeGreaterThanOrEqual(900);
  });

  it("retains complete hourly fact provenance on code-owned slots", () => {
    const factRefs = Array.from({ length: 48 }, (_, index) => `condition-or-wind:w${index}`);
    const parsed = SurfAnalysisValueSlotSchema.parse({
      id: "day_surface_evolution",
      value: "clean with offshore wind through daylight",
      description: "complete hourly surface evolution",
      claim: "outlook_surface",
      factRefs,
      domains: ["surface", "wind"],
      syntax: "predicate",
      authorship: "code",
      required: true
    });
    expect(parsed.factRefs).toEqual(factRefs);
    expect(() =>
      SurfAnalysisValueSlotSchema.parse({ ...parsed, factRefs: [...factRefs, ...factRefs] })
    ).toThrow();
  });

  it("renders a useful report using only code-owned cards and values", async () => {
    const snapshot = await fixtureSnapshot();
    const { report, validated } = renderValidated(goldenPlan(snapshot), snapshot);
    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.cards.every(({ preview }) => preview.length > 0)).toBe(true);
    expect(snapshot.slots.every(({ authorship }) => authorship === "code")).toBe(true);
    expect(report.schemaVersion).toBe(3);
    expect(report.headline).toContain("best window");
    expect(report.paragraphs).toHaveLength(3);
    expect(report.paragraphs[1]).toContain(
      snapshot.slots.find(({ id }) => id === "primary_surf_size")!.value
    );
    expect(report.paragraphs.join(" ")).not.toMatch(/This is a (?:low|medium|high) confidence call/i);
    expect(report.paragraphs.join(" ")).not.toMatch(/tide timing unavailable|\{\{/i);
    const confidence = snapshot.slots.find(({ id }) => id === "confidence_sentence")!;
    expect(report.paragraphs[2]).toMatch(new RegExp(`^${confidence.value.replace(".", "\\.")} `));
    expect(report.paragraphs.join(" ").match(/confidence/gi)).toHaveLength(1);
    expect(confidence.factRefs).toEqual([
      snapshot.facts.find(
        (fact) => fact.windowId === snapshot.recommendationWindowIds[0] && fact.kind === "confidence"
      )!.id
    ]);
    expect(validated.validation.usedCardIds.length).toBeGreaterThanOrEqual(5);
    expect(validated.validation.claimRefs.map(({ path }) => path)).toContain(
      "call.primarySupportCardId"
    );
  });

  it("contains no model-authored prose field", async () => {
    const snapshot = await fixtureSnapshot();
    const plan = goldenPlan(snapshot);
    expect(SurfAnalysisPlanV5Schema.parse(plan)).toEqual(plan);
    expect(() =>
      SurfAnalysisPlanV5Schema.parse({ ...plan, prose: "Invented forecast prose." })
    ).toThrow();
    const selectedIds = [
      plan.outlook.leadCardId,
      plan.outlook.supportingCardId,
      plan.call.primarySupportCardId,
      plan.call.primaryTradeoffCardId,
      plan.call.alternateCardId,
      plan.close.watchCardId
    ].filter((value): value is string => value !== null);
    expect(selectedIds.every((id) => snapshot.cards.some((card) => card.id === id))).toBe(true);
    expect(selectedIds.every((id) => !/\s/.test(id))).toBe(true);
  });

  it("rejects unknown, cross-placement, and repeated card selections", async () => {
    const snapshot = await fixtureSnapshot();
    const plan = goldenPlan(snapshot);
    expect(() =>
      validateSurfAnalysisDraft(
        { ...plan, close: { watchCardId: "watch:not-real" } },
        snapshot
      )
    ).toThrow(/unknown card/i);
    expect(() =>
      validateSurfAnalysisDraft(
        { ...plan, close: { watchCardId: plan.outlook.leadCardId } },
        snapshot
      )
    ).toThrow(/belongs in/i);
    expect(() =>
      validateSurfAnalysisDraft(
        { ...plan, outlook: { ...plan.outlook, supportingCardId: plan.outlook.leadCardId } },
        snapshot
      )
    ).toThrow(/repeats card/i);
  });

  it("rejects tampered code-owned card previews and provenance", async () => {
    const snapshot = await fixtureSnapshot();
    const plan = goldenPlan(snapshot);
    const badPreview = structuredClone(snapshot);
    badPreview.cards[0]!.preview += " invented";
    expect(() => validateSurfAnalysisDraft(plan, badPreview)).toThrow(/preview does not match/i);

    const badFact = structuredClone(snapshot);
    badFact.cards[0]!.factRefs = ["fact:not-present"];
    expect(() => validateSurfAnalysisDraft(plan, badFact)).toThrow(
      /omits provenance|unknown fact/i
    );

    const crossWindow = structuredClone(snapshot);
    const support = crossWindow.cards.find(({ placement }) => placement === "primary_support")!;
    const backupSlot = crossWindow.slots.find(({ id }) => id === "backup_surf_size")!;
    support.template = `${support.template} {{backup_surf_size}}`;
    support.preview = `${support.preview} ${backupSlot.value}`;
    support.factRefs.push(...backupSlot.factRefs);
    crossWindow.allowedFactRefs.primary.push(...backupSlot.factRefs);
    expect(() => validateSurfAnalysisDraft(plan, crossWindow)).toThrow(/slot outside its placement/i);

    const omittedSlotEvidence = structuredClone(snapshot);
    const surface = omittedSlotEvidence.cards.find(
      ({ id }) => id === "primary:support:surface"
    )!;
    surface.factRefs = [];
    expect(() => validateSurfAnalysisDraft(plan, omittedSlotEvidence)).toThrow(
      /omits provenance for slot/i
    );

    const wrongWindRole = structuredClone(snapshot);
    const windCard = wrongWindRole.cards.find(({ id }) => id === "primary:support:wind")!;
    wrongWindRole.facts.find(({ id }) => id === windCard.factRefs[0])!.role = "tradeoff";
    expect(() => validateSurfAnalysisDraft(plan, wrongWindRole)).toThrow(
      /provenance outside its placement/i
    );
  });

  it("records only fixed and actually rendered value slots", async () => {
    const snapshot = await fixtureSnapshot();
    const plan = goldenPlan(snapshot, { includeAlternate: false });
    const validation = validateSurfAnalysisDraft(plan, snapshot).validation;
    const codeOwnedPaths = validation.claimRefs
      .map(({ path }) => path)
      .filter((path) => path.startsWith("codeOwned."));
    expect(codeOwnedPaths).toContain("codeOwned.confidence_sentence");
    expect(codeOwnedPaths).toContain("codeOwned.primary_session");
    expect(codeOwnedPaths.some((path) => path.includes("backup_"))).toBe(false);
    expect(codeOwnedPaths).not.toContain("codeOwned.day_swell_evolution");
  });

  it.each(["high", "medium", "low"] as const)(
    "renders one code-owned %s confidence sentence with exact provenance",
    async (band) => {
      const bundle = await buildForecastFactBundle(briefForecastFixture());
      const primaryId = bundle.input.recommendationWindowIds[0]!;
      bundle.input.windows.find(({ windowId }) => windowId === primaryId)!.confidenceBand = band;
      const fact = bundle.facts.find(
        (candidate) => candidate.windowId === primaryId && candidate.kind === "confidence"
      )!;
      fact.statement =
        band === "high"
          ? "Confidence is high, which strengthens the forecast call."
          : `Confidence is ${band}, leaving meaningful uncertainty around the forecast call.`;
      fact.role = band === "high" ? "support" : "tradeoff";
      const snapshot = await buildSurfAnalysisSnapshot(bundle);
      const plan = goldenPlan(snapshot);
      const { report, validated } = renderValidated(plan, snapshot);
      const sentence = `Confidence in this timing call is ${band}.`;
      expect(report.paragraphs[2]).toMatch(new RegExp(`^${sentence.replace(".", "\\.")} `));
      expect(report.paragraphs.join(" ").match(/confidence/gi)).toHaveLength(1);
      expect(
        validated.validation.claimRefs.find(({ path }) => path === "codeOwned.confidence_sentence")
      ).toEqual({ path: "codeOwned.confidence_sentence", factRefs: [fact.id] });
    }
  );

  it("rejects a confidence sentence that disagrees with its primary confidence fact", async () => {
    const snapshot = await fixtureSnapshot();
    const plan = goldenPlan(snapshot);
    const confidenceFact = snapshot.facts.find(
      (fact) => fact.windowId === snapshot.recommendationWindowIds[0] && fact.kind === "confidence"
    )!;
    const actualBand = confidenceFact.statement.match(/\b(low|medium|high)\b/i)![1]!.toLowerCase();
    snapshot.slots.find(({ id }) => id === "confidence_sentence")!.value =
      `Confidence in this timing call is ${actualBand === "high" ? "low" : "high"}.`;
    expect(() => validateSurfAnalysisDraft(plan, snapshot)).toThrow(/does not match/i);
  });

  it.each([
    ["clean", "poor", "tradeoff", true],
    ["fair", "good", "support", false]
  ] as const)(
    "derives %s surface editorial cards from surface semantics despite a %s quality label",
    async (surfaceCondition, qualityLabel, expectedFactRole, expectSurfaceSupport) => {
      const forecast = briefForecastFixture();
      forecast.windows = forecast.windows.map((window) => ({
        ...window,
        surfaceCondition,
        qualityLabel
      }));
      const bundle = await buildForecastFactBundle(forecast);
      const primaryId = bundle.input.recommendationWindowIds[0]!;
      const condition = bundle.facts.find(
        (fact) => fact.windowId === primaryId && fact.kind === "condition"
      )!;
      expect(condition.role).toBe(expectedFactRole);
      const snapshot = await buildSurfAnalysisSnapshot(bundle);
      const surfaceCards = snapshot.cards.filter(
        ({ semanticKey }) => semanticKey === "primary:surface"
      );
      expect(surfaceCards.some(({ placement }) => placement === "primary_support")).toBe(
        expectSurfaceSupport
      );
      expect(surfaceCards.some(({ placement }) => placement === "primary_tradeoff")).toBe(false);
      expect(snapshot.cards.some(({ id }) => id === "primary:support:wind")).toBe(true);
      expect(() => validateSurfAnalysisDraft(goldenPlan(snapshot), snapshot)).not.toThrow();
    }
  );

  it("requires the outlook to synthesize waves with surface or wind", async () => {
    const snapshot = await fixtureSnapshot();
    const plan = goldenPlan(snapshot);
    expect(() =>
      validateSurfAnalysisDraft(
        {
          ...plan,
          outlook: {
            leadCardId: "outlook:size-arc",
            supportingCardId: "outlook:swell-arc"
          }
        },
        snapshot
      )
    ).toThrow(/wave plus surface or wind/i);
  });

  it("requires available support and tradeoff selections but never invents one", async () => {
    const snapshot = await fixtureSnapshot();
    const plan = goldenPlan(snapshot);
    expect(() =>
      validateSurfAnalysisDraft(
        { ...plan, call: { ...plan.call, primarySupportCardId: null } },
        snapshot
      )
    ).toThrow(/omitted.*support/i);

    const hasTradeoff = snapshot.cards.some(({ placement }) => placement === "primary_tradeoff");
    if (!hasTradeoff) {
      expect(() =>
        validateSurfAnalysisDraft(
          { ...plan, call: { ...plan.call, primaryTradeoffCardId: "primary:tradeoff:wind" } },
          snapshot
        )
      ).toThrow(/invented.*tradeoff/i);
    }
  });

  it("allows the editor to omit an unhelpful backup but never invent one", async () => {
    const snapshot = await fixtureSnapshot();
    expect(() =>
      validateSurfAnalysisDraft(goldenPlan(snapshot, { includeAlternate: false }), snapshot)
    ).not.toThrow();

    const primaryOnly = await primaryOnlySnapshot();
    const plan = goldenPlan(primaryOnly);
    expect(plan.call.alternateCardId).toBeNull();
    expect(() => validateSurfAnalysisDraft(plan, primaryOnly)).not.toThrow();
    expect(() =>
      validateSurfAnalysisDraft(
        { ...plan, call: { ...plan.call, alternateCardId: "alternate:session" } },
        primaryOnly
      )
    ).toThrow(/invented an alternate/i);
  });

  it("rejects the old v4 prose-template output", async () => {
    const snapshot = await fixtureSnapshot();
    expect(() =>
      validateSurfAnalysisDraft(
        {
          outlook: {
            wave: { template: "Surf is {{day_surf_evolution}}." },
            surface: { template: "Surface is {{day_surface_evolution}}." }
          },
          call: { primary: { template: "old" }, alternate: null },
          confidence: { template: "old" }
        },
        snapshot
      )
    ).toThrow();
  });

  it("renders official tide extrema as complete neutral sentences", async () => {
    const forecast = briefForecastFixture();
    const base = await buildForecastFactBundle(forecast);
    const primaryId = base.input.recommendationWindowIds[0]!;
    const primary = base.input.windows.find(({ windowId }) => windowId === primaryId)!;
    forecast.tideEvents = [
      {
        stationId: "9414290",
        eventAt: new Date(
          (new Date(primary.validFrom).getTime() + new Date(primary.validTo).getTime()) / 2
        ).toISOString(),
        type: "low",
        heightFtMllw: -1.8,
        sourceRunId: "tide-fixture"
      }
    ];
    const snapshot = await buildSurfAnalysisSnapshot(await buildForecastFactBundle(forecast));
    const tide = snapshot.slots.find(({ id }) => id === "primary_tide_sentence")!;
    expect(tide.value).toMatch(/^A low tide .+ falls inside the window\.$/);
    const report = renderValidated(goldenPlan(snapshot), snapshot).report;
    expect(report.paragraphs[1]).toContain(tide.value);
  });

  it.each([
    ["before", "low", /^The window follows a low tide .+\.$/],
    ["after", "high", /^A high tide .+ follows the window\.$/]
  ] as const)("renders an official tide event %s the window grammatically", async (relation, type, pattern) => {
    const forecast = briefForecastFixture();
    const base = await buildForecastFactBundle(forecast);
    const primaryId = base.input.recommendationWindowIds[0]!;
    const primary = base.input.windows.find(({ windowId }) => windowId === primaryId)!;
    forecast.tideEvents = [
      {
        stationId: "9414290",
        eventAt: new Date(
          relation === "before"
            ? new Date(primary.validFrom).getTime() - 30 * 60_000
            : new Date(primary.validTo).getTime() + 30 * 60_000
        ).toISOString(),
        type,
        heightFtMllw: relation === "before" ? -1.2 : 4.8,
        sourceRunId: "tide-fixture"
      }
    ];
    const snapshot = await buildSurfAnalysisSnapshot(await buildForecastFactBundle(forecast));
    expect(snapshot.slots.find(({ id }) => id === "primary_tide_sentence")!.value).toMatch(pattern);
  });

  it("omits unavailable tide context instead of printing an unavailable label", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    bundle.input.tideEvents = [];
    bundle.input.windows.forEach((window) => {
      window.tideFt = null;
      window.tideTrend = null;
    });
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    expect(snapshot.slots.some(({ id }) => id === "primary_tide_sentence")).toBe(false);
    expect(renderValidated(goldenPlan(snapshot), snapshot).report.paragraphs.join(" ")).not.toMatch(
      /tide timing unavailable/i
    );
  });

  it("fails closed on scored-looking recommendations with unknown surface or wind", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const primaryId = bundle.input.recommendationWindowIds[0]!;
    const primary = bundle.input.windows.find(({ windowId }) => windowId === primaryId)!;
    primary.surfaceCondition = "unknown";
    primary.windRelation = "unknown";
    primary.windSpeedKt = 0;
    expect(() => buildSurfAnalysisSnapshot(bundle)).rejects.toThrow(/unknown surface guidance/i);

    primary.surfaceCondition = "clean";
    expect(() => buildSurfAnalysisSnapshot(bundle)).rejects.toThrow(/unknown wind guidance/i);

    primary.windRelation = "offshore";
    primary.windSpeedKt = null;
    expect(() => buildSurfAnalysisSnapshot(bundle)).rejects.toThrow(/invalid wind speed guidance/i);
  });

  it("fails closed when a primary or backup representative is unscored", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const backupId = bundle.input.recommendationWindowIds[1]!;
    bundle.input.windows.find(({ windowId }) => windowId === backupId)!.ratingStatus = "unknown";
    expect(() => buildSurfAnalysisSnapshot(bundle)).rejects.toThrow(/backup.*not scored/i);
  });

  it("makes a stale required source the only eligible concrete watch", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const primaryId = bundle.input.recommendationWindowIds[0]!;
    bundle.input.windows.find(({ windowId }) => windowId === primaryId)!.requiredSourceStatus =
      "stale";
    const source = bundle.facts.find(
      (fact) => fact.windowId === primaryId && fact.kind === "source"
    )!;
    source.role = "tradeoff";
    source.statement = "A required forecast source is stale, limiting confidence in this window.";
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    expect(
      snapshot.cards.filter(({ placement }) => placement === "watch").map(({ id }) => id)
    ).toEqual(["watch:source"]);
    expect(() => validateSurfAnalysisDraft(goldenPlan(snapshot), snapshot)).not.toThrow();
  });

  it("advertises the exact v5 selector contract without a copyable assistant few-shot", async () => {
    const snapshot = await fixtureSnapshot();
    const job = await buildSurfNarrativeJob(snapshot);
    expect(serializedNarrativeJobBytes(job)).toBeLessThan(NARRATIVE_JOB_MAX_BYTES);
    expect(SURF_ANALYSIS_PROMPT_VERSION).toBe("surf-analysis-v5-editorial-1");
    expect(SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION).toBe(6);
    expect(SURF_ANALYSIS_RESULT_TARGET).toBe("surf.analysis.v5");
    expect(job.promptVersion).toBe(SURF_ANALYSIS_PROMPT_VERSION);
    expect(job.outputSchemaVersion).toBe(SURF_ANALYSIS_OUTPUT_SCHEMA_VERSION);
    expect(job.result.target).toBe(SURF_ANALYSIS_RESULT_TARGET);
    expect(job.inference.messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(SURF_ANALYSIS_RESPONSE_JSON_SCHEMA.properties).toHaveProperty("close");
    const payload = JSON.parse(job.inference.messages.at(-1)!.content) as {
      candidates: { outlook: Array<{ id: string; preview: string; factRefs: string[] }> };
    };
    expect(payload.candidates.outlook).toHaveLength(3);
    expect(payload.candidates.outlook.every(({ preview }) => preview.length > 0)).toBe(true);
    expect(payload.candidates.outlook.every(({ factRefs }) => factRefs.length > 0)).toBe(true);
  });

  it("keeps generation identity stable across irrelevant material and deadline drift", async () => {
    const snapshot = await fixtureSnapshot();
    const changed = {
      ...snapshot,
      materialFingerprint: "b".repeat(64),
      deadlineAt: new Date(new Date(snapshot.deadlineAt).getTime() + 60 * 60_000).toISOString()
    };
    const [before, after] = await Promise.all([
      buildSurfNarrativeJob(snapshot),
      buildSurfNarrativeJob(changed)
    ]);
    expect(after.factFingerprint).toBe(before.factFingerprint);
    expect(after.generationFingerprint).toBe(before.generationFingerprint);
  });

  it("does not churn generation for an unused fact but does for selectable-card evidence", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const backupId = bundle.input.recommendationWindowIds[1]!;
    const unusedCaveat = bundle.facts.find(
      (fact) => fact.windowId === backupId && fact.kind === "caveat"
    )!;
    const selectableWind = bundle.facts.find(
      (fact) => fact.windowId === backupId && fact.kind === "wind"
    )!;
    expect(unusedCaveat).toBeTruthy();
    expect(selectableWind).toBeTruthy();

    const beforeSnapshot = await buildSurfAnalysisSnapshot(structuredClone(bundle));
    const beforeJob = await buildSurfNarrativeJob(beforeSnapshot);

    const irrelevantBundle = structuredClone(bundle);
    irrelevantBundle.facts.find(({ id }) => id === unusedCaveat.id)!.statement +=
      " This unused backup caveat changed.";
    const irrelevantSnapshot = await buildSurfAnalysisSnapshot(irrelevantBundle);
    const irrelevantJob = await buildSurfNarrativeJob(irrelevantSnapshot);
    expect(irrelevantSnapshot.facts.some(({ id }) => id === unusedCaveat.id)).toBe(false);
    expect(irrelevantSnapshot.factFingerprint).toBe(beforeSnapshot.factFingerprint);
    expect(irrelevantJob.generationFingerprint).toBe(beforeJob.generationFingerprint);
    expect(irrelevantJob.jobId).toBe(beforeJob.jobId);

    const determinantBundle = structuredClone(bundle);
    determinantBundle.facts.find(({ id }) => id === selectableWind.id)!.statement +=
      " This evidence changes the alternate-card selection context.";
    const determinantSnapshot = await buildSurfAnalysisSnapshot(determinantBundle);
    const determinantJob = await buildSurfNarrativeJob(determinantSnapshot);
    expect(determinantSnapshot.facts.some(({ id }) => id === selectableWind.id)).toBe(true);
    expect(determinantSnapshot.factFingerprint).not.toBe(beforeSnapshot.factFingerprint);
    expect(determinantJob.generationFingerprint).not.toBe(beforeJob.generationFingerprint);
    expect(determinantJob.jobId).not.toBe(beforeJob.jobId);
  });

  it("uses the chronologically latest recommendation end for the inference deadline", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    bundle.input.recommendations = bundle.input.recommendationWindowIds.map(
      (representativeWindowId, index) => ({
        representativeWindowId,
        constituentWindowIds: [representativeWindowId],
        startAt: representativeWindowId,
        endAt: new Date(
          new Date(representativeWindowId).getTime() + (index === 0 ? 6 : 3) * 60 * 60_000
        ).toISOString()
      })
    );
    bundle.input.recommendations.reverse();
    const latest = Math.max(
      ...bundle.input.recommendations.map(({ endAt }) => new Date(endAt).getTime())
    );
    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    expect(new Date(snapshot.deadlineAt).getTime()).toBe(latest + 3 * 60 * 60_000);
  });

  it("changes the code-owned size card and fingerprint for a material midday peak", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const before = await buildSurfAnalysisSnapshot(structuredClone(bundle));
    const daylight = bundle.input.windows.filter(({ isDaylight }) => isDaylight);
    const middle = daylight[Math.floor(daylight.length / 2)]!;
    middle.surfSizeFt = (middle.surfSizeFt ?? 2) + 5;
    middle.surfSizeLabel = "8–10 ft";
    const after = await buildSurfAnalysisSnapshot(bundle);
    expect(after.cards.find(({ id }) => id === "outlook:size-arc")!.preview).not.toBe(
      before.cards.find(({ id }) => id === "outlook:size-arc")!.preview
    );
    expect(after.factFingerprint).not.toBe(before.factFingerprint);
  });

  it("changes the surface editorial option when the daylight texture arc changes", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const before = await buildSurfAnalysisSnapshot(structuredClone(bundle));
    const daylight = bundle.input.windows.filter(({ isDaylight }) => isDaylight);
    daylight.forEach((window, index) => {
      window.surfaceCondition = index < daylight.length / 2 ? "fair" : "choppy";
    });
    const after = await buildSurfAnalysisSnapshot(bundle);
    expect(after.cards.find(({ id }) => id === "outlook:surface-arc")!.preview).not.toBe(
      before.cards.find(({ id }) => id === "outlook:surface-arc")!.preview
    );
  });

  it.each([
    ["unknown", "unknown", "unavailable"],
    ["unknown", "offshore", "unavailable"],
    ["fair", "unknown", "fair, with wind relationship unavailable"]
  ] as const)(
    "renders %s surface with %s wind as honest unavailable-state copy",
    async (surfaceCondition, windRelation, expected) => {
      const bundle = await buildForecastFactBundle(briefForecastFixture());
      const recommendationIds = new Set(bundle.input.recommendationWindowIds);
      const changed = bundle.input.windows.filter(
        ({ isDaylight, windowId }) => isDaylight && !recommendationIds.has(windowId)
      );
      expect(changed.length).toBeGreaterThan(0);
      changed.forEach((window) => {
        window.surfaceCondition = surfaceCondition;
        window.windRelation = windRelation;
      });

      const snapshot = await buildSurfAnalysisSnapshot(bundle);
      const preview = snapshot.cards.find(({ id }) => id === "outlook:surface-arc")!.preview;
      expect(preview).toContain(expected);
      expect(preview).not.toContain("unknown with an unknown wind relationship");
    }
  );

  it("does not hide intervening surface changes behind an all-clean sampled summary", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const daylight = bundle.input.windows.filter(({ isDaylight }) => isDaylight);
    expect(daylight.length).toBeGreaterThanOrEqual(5);
    daylight.forEach((window) => {
      window.surfaceCondition = "clean";
      window.windRelation = "offshore";
    });
    daylight[1]!.surfaceCondition = "fair";
    daylight.at(-2)!.surfaceCondition = "fair";

    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const preview = snapshot.cards.find(({ id }) => id === "outlook:surface-arc")!.preview;
    expect(preview).toContain("with variable conditions between");
    expect(preview).not.toMatch(/clean .+ early, clean .+ around midday, then clean .+ late/i);
  });

  it("keeps the conservative NorCal Queue envelope inside Workers Paid monthly inclusion", () => {
    const guide = readFileSync(
      new URL("../../../../docs/narrative-runner.md", import.meta.url),
      "utf8"
    );
    const environment = readFileSync(
      new URL("../../../narrative-runner/.env.example", import.meta.url),
      "utf8"
    );
    const wrangler = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const messageRetries = Number(guide.match(/--message-retries\s+(\d+)/)?.[1]);
    const idleMaxMs = Number(environment.match(/NARRATIVE_RUNNER_IDLE_MAX_MS=(\d+)/)?.[1]);
    const ingestMaxRetries = Number(
      wrangler.match(/"queue":\s*"surf-ingest"[\s\S]*?"max_retries":\s*(\d+)/)?.[1]
    );
    expect(messageRetries).toBe(0);
    expect(idleMaxMs).toBe(120_000);
    expect(ingestMaxRetries).toBe(3);
    expect(SURF_ANALYSIS_SIGNAL_MAX_QUEUE_RETRIES).toBe(0);
    expect(NARRATIVE_JOB_MAX_BYTES).toBeLessThan(64_000 - 100);

    const hourlyCycles = 24;
    const completeDates = 5;
    const configuredBatchSpotIds = NORCAL_SOURCE_BATCHES.flatMap(({ spotIds }) => spotIds);
    expect(new Set(configuredBatchSpotIds)).toEqual(new Set(NORCAL_SPOTS.map(({ id }) => id)));
    const ingestMessagesPerCycle = 1 + NORCAL_SOURCE_BATCHES.length + NORCAL_SPOTS.length * 2;
    const ingestOperations = ingestMessagesPerCycle * hourlyCycles * 3;
    const retryableIngestMessagesPerCycle = ingestMessagesPerCycle - NORCAL_SPOTS.length;
    const ingestRetryReads = retryableIngestMessagesPerCycle * hourlyCycles * ingestMaxRetries;
    const ingestDlqOperations = retryableIngestMessagesPerCycle * hourlyCycles * 2;
    const initialNarrativeMessages =
      NORCAL_SPOTS.length *
      (hourlyCycles +
        (completeDates - 1) * (hourlyCycles / SURF_ANALYSIS_FUTURE_CADENCE_HOURS));
    const narrativeMessages = initialNarrativeMessages + NARRATIVE_RECONCILIATION_LIMIT * hourlyCycles;
    const localNarrativeOperations = narrativeMessages * 5;
    const fallbackWatchdogOperations = narrativeMessages * 3;
    let emptyPullOperations = 0;
    for (let hour = 0; hour < hourlyCycles; hour += 1) {
      let elapsedMs = 0;
      let emptyPullCount = 0;
      while (elapsedMs < 60 * 60_000) {
        emptyPullOperations += 1;
        emptyPullCount += 1;
        elapsedMs += Math.max(
          1,
          Math.round(Math.min(idleMaxMs, 5_000 * 2 ** (emptyPullCount - 1)) * 0.8)
        );
      }
    }
    const conservativeDailyOperations =
      ingestOperations +
      ingestRetryReads +
      ingestDlqOperations +
      localNarrativeOperations +
      fallbackWatchdogOperations * 3 +
      emptyPullOperations;
    expect(conservativeDailyOperations).toBe(18_344);
    expect(conservativeDailyOperations * 31).toBe(568_664);
    expect(conservativeDailyOperations * 31).toBeLessThan(1_000_000);
  });
});
