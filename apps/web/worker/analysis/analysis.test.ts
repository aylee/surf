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
  SURF_ANALYSIS_FUTURE_CADENCE_HOURS
} from "../narrative";
import { renderSurfAnalysisReport } from "./renderer";
import { buildSurfAnalysisSnapshot, buildSurfNarrativeJob } from "./snapshot";
import type {
  SurfAnalysisDraftV3,
  SurfAnalysisValidationSnapshot
} from "./types";
import { SurfAnalysisDraftV3Schema } from "./types";
import { validateSurfAnalysisDraft } from "./validator";

function goldenDraft(_snapshot: SurfAnalysisValidationSnapshot): SurfAnalysisDraftV3 {
  return {
    paragraphs: {
      setup: {
        template:
          "Surf is {{day_surf_evolution}}; swell is {{day_swell_evolution}}."
      },
      plan: {
        template:
          "The best window is {{primary_session}}, with {{primary_surf_size}} surf, {{primary_wind_surface}}, and {{primary_tide_timing}}. The alternate window is {{backup_session}}."
      },
      confidence: {
        template:
          "This is a {{forecast_confidence}} call. The main uncertainty remains: {{bust_factor}}"
      }
    }
  };
}

async function fixtureSnapshot(): Promise<SurfAnalysisValidationSnapshot> {
  return buildSurfAnalysisSnapshot(
    await buildForecastFactBundle(briefForecastFixture())
  );
}

describe("Surf Analysis v3 snapshot and validation", () => {
  it("renders one useful headline and exactly three grounded natural paragraphs", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);

    const validated = validateSurfAnalysisDraft(draft, snapshot);
    const report = renderSurfAnalysisReport({
      draft: validated.draft,
      snapshot,
      revisionId: "revision.fixture",
      publishedAt: "2026-08-02T14:00:00.000Z"
    });

    expect(report.schemaVersion).toBe(3);
    expect(report.headline).toContain("best window");
    expect(report.paragraphs).toHaveLength(3);
    expect(report.paragraphs.join(" ")).toContain(
      snapshot.slots.find((slot) => slot.id === "primary_surf_size")?.value
    );
    expect(report.paragraphs.join(" ")).not.toContain("{{");
    expect(report.paragraphs[0]).toMatch(/^Surf is .+; swell is .+\./);
    expect(report.paragraphs[1]).toContain(" surf, ");
    expect(report.paragraphs[1]).toContain("The alternate window is");
    const bust = snapshot.slots.find((slot) => slot.id === "bust_factor")!.value;
    expect(report.paragraphs[2]!.split(bust)).toHaveLength(2);
    expect(report.paragraphs[2]).not.toMatch(/could weaken.+could weaken/i);
  });

  it("accepts varied connective prose while keeping every factual claim in a slot", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.setup.template =
      "For the day, surf should be {{day_surf_evolution}}. Swell should be {{day_swell_evolution}}.";
    draft.paragraphs.plan.template =
      "{{primary_session}} leads the call, carrying {{primary_surf_size}} surf alongside {{primary_wind_surface}}; tide context is {{primary_tide_timing}}. The backup window is {{backup_session}}.";
    draft.paragraphs.confidence.template =
      "With {{forecast_confidence}} in the call, here is the main thing to watch: {{bust_factor}}";

    const validated = validateSurfAnalysisDraft(draft, snapshot);
    const report = renderSurfAnalysisReport({
      draft: validated.draft,
      snapshot,
      revisionId: "revision.varied",
      publishedAt: "2026-08-02T14:00:00.000Z"
    });

    expect(report.paragraphs).toHaveLength(3);
    expect(report.paragraphs.join(" ")).not.toMatch(/deterministic|schema|source health/i);
    expect(validated.validation.referencedFactIds.length).toBeGreaterThan(0);
  });

  it("rejects recommendation reversals even when every slot and fact is present", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.plan.template =
      "Avoid {{primary_session}} because it is the worst choice, despite {{primary_surf_size}}, {{primary_wind_surface}}, and {{primary_tide_timing}}. Prefer the backup {{backup_session}} instead.";

    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow(/directive|recommend|negate|best-window/i);
  });

  it.each([
    "The best window is {{primary_session}}, pairing {{primary_surf_size}} surf with {{primary_wind_surface}} and {{primary_tide_timing}}. The backup {{backup_session}} is best.",
    "The leading session to ignore is {{primary_session}}, pairing {{primary_surf_size}} with {{primary_wind_surface}} and {{primary_tide_timing}}. The backup is {{backup_session}}."
  ])("rejects recommendation-frame synonym reversals", async (template) => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.plan.template = template;
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow();
  });

  it.each([
    "The punchy peaks are explained by {{day_surf_evolution}} and {{day_swell_evolution}}, with enough extra prose here to clear the paragraph length policy.",
    "The setup uses {{day_surf_evolution}} and {{day_swell_evolution}} around {{unknown_slot}}, with enough extra prose here to clear the paragraph length policy."
  ])("rejects unsupported or malformed model prose", async (template) => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.setup.template = template;
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow();
  });

  it("rejects an appended model-owned surface rating after the grounded setup", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.setup.template =
      "Surf is {{day_surf_evolution}}; swell is {{day_swell_evolution}}. Surface conditions are clean, and the overall quality read is excellent.";
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow(/condition|rating/i);
  });

  it("rejects the live unsupported condition and excellent-rating append", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.setup.template =
      "Surf is {{day_surf_evolution}}; swell is {{day_swell_evolution}}. Surface conditions are clean, and the overall quality read is excellent.";
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow(/condition|rating/i);
  });

  it.each([
    "Surf is {{day_surf_evolution}}, and the beach will be safe; swell is {{day_swell_evolution}}.",
    "Surf is {{day_surf_evolution}}, and the water is unsafe; swell is {{day_swell_evolution}}.",
    "Surf is {{day_surf_evolution}}, with risk-free conditions; swell is {{day_swell_evolution}}."
  ])("rejects model-owned safety claims", async (template) => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.setup.template = template;
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow(/safety claim/i);
  });

  it("rejects an independent weather assertion even when both setup slots are present", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.setup.template =
      "Surf is {{day_surf_evolution}}, and rain is likely; swell is {{day_swell_evolution}}.";
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow(/factual vocabulary/i);
  });

  it.each([
    "The surf 安全 forecast is {{day_surf_evolution}}, while the swell is {{day_swell_evolution}}.",
    "Surf is {{day_surf_evolution}}, with Arabic digit ١; swell is {{day_swell_evolution}}.",
    "Surf is {{day_surf_evolution}} ⚠ while swell is {{day_swell_evolution}}."
  ])("rejects Unicode model-owned text before the connective allowlist", async (template) => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.setup.template = template;
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow(/non-ASCII/i);
  });

  it("does not inspect safety wording supplied by a code-owned value slot", async () => {
    const snapshot = await fixtureSnapshot();
    const bust = snapshot.slots.find((slot) => slot.id === "bust_factor");
    if (!bust) throw new Error("Fixture is missing the bust slot");
    bust.value = "The deterministic hazard input says the beach is unsafe.";
    const draft = goldenDraft(snapshot);

    const validated = validateSurfAnalysisDraft(draft, snapshot);
    const report = renderSurfAnalysisReport({
      draft: validated.draft,
      snapshot,
      revisionId: "revision.code-owned-safety",
      publishedAt: "2026-08-02T14:00:00.000Z"
    });
    expect(report.paragraphs[2]).toContain("the beach is unsafe");
  });

  it("rejects model-authored headline fields because cloud code owns the headline", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = {
      ...goldenDraft(snapshot),
      headline: { template: "{{headline_call}} {{primary_session}}" }
    };
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow();
  });

  it("rejects repeated or appended prose after the terminal bust slot", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.confidence.template =
      "This is a {{forecast_confidence}} call. The main uncertainty is {{bust_factor}} It could weaken the call again.";
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow(
      /end at the bust factor|factual vocabulary/i
    );
  });

  it("rejects placing a complete bust-factor sentence directly after 'is'", async () => {
    const snapshot = await fixtureSnapshot();
    const draft = goldenDraft(snapshot);
    draft.paragraphs.confidence.template =
      "This is a {{forecast_confidence}} call. The main risk is {{bust_factor}}";
    expect(() => validateSurfAnalysisDraft(draft, snapshot)).toThrow(/colon/i);
  });

  it("uses official tide-extrema timing as a code-owned value", async () => {
    const forecast = briefForecastFixture();
    forecast.tideEvents = [
      {
        stationId: "9414290",
        eventAt: "2026-08-02T16:00:00.000Z",
        type: "high",
        heightFtMllw: 4.2,
        sourceRunId: "tide-fixture"
      }
    ];
    const snapshot = await buildSurfAnalysisSnapshot(await buildForecastFactBundle(forecast));
    const tide = snapshot.slots.find((slot) => slot.id === "primary_tide_timing");

    expect(tide?.value).toContain("high tide at");
    expect(tide?.value).toContain("4.2 ft MLLW");
    expect(tide?.factRefs).toEqual(["tide:event:e0"]);
  });

  it("uses a grounded modeled-surf limitation instead of confidence as uncertainty", async () => {
    const forecast = briefForecastFixture();
    forecast.windows = forecast.windows.map((window) => ({
      ...window,
      caveats: [],
      confidence: 90,
      windRelation: "offshore" as const,
      surfaceCondition: "clean" as const,
      sourceFreshness: (window.sourceFreshness ?? []).map((source) => ({
        ...source,
        status: "fresh" as const
      }))
    }));
    const snapshot = await buildSurfAnalysisSnapshot(
      await buildForecastFactBundle(forecast)
    );
    const bust = snapshot.slots.find((slot) => slot.id === "bust_factor");
    expect(bust).toMatchObject({
      value: "Actual breaking surf can differ from the modeled guidance at this spot.",
      factRefs: ["uncertainty:modeled_breaking_calibration"]
    });
    const validated = validateSurfAnalysisDraft(goldenDraft(snapshot), snapshot);
    const report = renderSurfAnalysisReport({
      draft: validated.draft,
      snapshot,
      revisionId: "revision.baseline-uncertainty",
      publishedAt: "2026-08-02T14:00:00.000Z"
    });
    expect(report.paragraphs[2]).toBe(
      "This is a high confidence call. The main uncertainty remains: Actual breaking surf can differ from the modeled guidance at this spot."
    );
    expect(report.paragraphs[2]).not.toMatch(/uncertainty.*strengthens/i);
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
    expect(after.jobId).toBe(before.jobId);
  });

  it("advertises the same model-output bounds enforced by the cloud schema", async () => {
    const job = await buildSurfNarrativeJob(await fixtureSnapshot());
    expect(serializedNarrativeJobBytes(job)).toBeLessThan(NARRATIVE_JOB_MAX_BYTES);
    expect(NARRATIVE_JOB_MAX_BYTES).toBe(60_000);
    const responseSchema = job.inference.responseSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const defs = job.inference.responseSchema.$defs as {
      setupBlock: { required: string[]; properties: { template: { minLength: number; maxLength: number } } };
      planBlock: { required: string[]; properties: { template: { minLength: number; maxLength: number } } };
      confidenceBlock: { required: string[]; properties: { template: { minLength: number; maxLength: number } } };
    };
    expect(Object.values(defs).map((block) => block.properties.template.maxLength)).toEqual([
      1_000,
      1_000,
      1_000
    ]);
    expect(defs.setupBlock.properties.template.minLength).toBe(60);
    expect(defs.planBlock.properties.template.minLength).toBe(145);
    expect(defs.confidenceBlock.properties.template.minLength).toBe(70);
    expect(Object.values(defs).every((block) => block.required[0] === "template")).toBe(true);
    expect(responseSchema.required).toEqual(["paragraphs"]);
    expect(responseSchema.properties.headline).toBeUndefined();
    expect(job.inference.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user"
    ]);
    expect(
      SurfAnalysisDraftV3Schema.parse(
        JSON.parse(job.inference.messages.find((message) => message.role === "assistant")!.content)
      )
    ).toEqual(goldenDraft(await fixtureSnapshot()));
  });

  it("keeps the full NorCal Queue admission envelope below the Free daily limit", () => {
    const guide = readFileSync(
      new URL("../../../../docs/narrative-runner.md", import.meta.url),
      "utf8"
    );
    const environment = readFileSync(
      new URL("../../../narrative-runner/.env.example", import.meta.url),
      "utf8"
    );
    const wrangler = readFileSync(
      new URL("../../wrangler.jsonc", import.meta.url),
      "utf8"
    );
    const messageRetries = Number(
      guide.match(/--message-retries\s+(\d+)/)?.[1]
    );
    const idleMaxMs = Number(
      environment.match(/NARRATIVE_RUNNER_IDLE_MAX_MS=(\d+)/)?.[1]
    );
    expect(messageRetries).toBe(0);
    const ingestMaxRetries = Number(
      wrangler.match(
        /"queue":\s*"surf-ingest"[\s\S]*?"max_retries":\s*(\d+)/
      )?.[1]
    );
    expect(idleMaxMs).toBe(600_000);
    expect(ingestMaxRetries).toBe(3);
    expect(SURF_ANALYSIS_SIGNAL_MAX_QUEUE_RETRIES).toBe(0);
    expect(NARRATIVE_JOB_MAX_BYTES).toBeLessThan(64_000 - 100);

    const hourlyCycles = 24;
    const completeDates = 5;
    const configuredBatchSpotIds = NORCAL_SOURCE_BATCHES.flatMap(({ spotIds }) => spotIds);
    expect(new Set(configuredBatchSpotIds)).toEqual(
      new Set(NORCAL_SPOTS.map(({ id }) => id))
    );
    expect(configuredBatchSpotIds).toHaveLength(NORCAL_SPOTS.length);
    const ingestMessagesPerCycle =
      1 + NORCAL_SOURCE_BATCHES.length +
      NORCAL_SPOTS.length + NORCAL_SPOTS.length;
    const ingestOperations = ingestMessagesPerCycle * hourlyCycles * 3;
    const advisorySignalsPerCycle = NORCAL_SPOTS.length;
    const retryableIngestMessagesPerCycle =
      ingestMessagesPerCycle - advisorySignalsPerCycle;
    const ingestRetryReads =
      retryableIngestMessagesPerCycle * hourlyCycles * ingestMaxRetries;
    const ingestDlqOperations =
      retryableIngestMessagesPerCycle * hourlyCycles * 2;
    const initialNarrativeMessages =
      NORCAL_SPOTS.length *
      (hourlyCycles +
        (completeDates - 1) *
          (hourlyCycles / SURF_ANALYSIS_FUTURE_CADENCE_HOURS));
    const reconciliationMessages =
      NARRATIVE_RECONCILIATION_LIMIT * hourlyCycles;
    const narrativeMessages = initialNarrativeMessages + reconciliationMessages;
    const originalWrite = 1;
    const deliveryReads = 1 + messageRetries;
    const sourceDelete = 1;
    const dlqWrite = 1;
    const dlqRetentionDelete = 1;
    const narrativeDlqOperationsPerMessage =
      originalWrite + deliveryReads + sourceDelete + dlqWrite + dlqRetentionDelete;
    const narrativeOperations =
      narrativeMessages * narrativeDlqOperationsPerMessage;

    // Conservatively reset the empty-pull backoff every hour and use the
    // fastest 0.8 jitter. This intentionally over-counts empty pulls alongside
    // a full narrative backlog.
    let emptyPullOperations = 0;
    for (let hour = 0; hour < hourlyCycles; hour += 1) {
      let elapsedMs = 0;
      let emptyPullCount = 0;
      while (elapsedMs < 60 * 60_000) {
        emptyPullOperations += 1;
        emptyPullCount += 1;
        const ceiling = Math.min(idleMaxMs, 5_000 * 2 ** (emptyPullCount - 1));
        elapsedMs += Math.max(1, Math.round(ceiling * 0.8));
      }
    }

    expect(NORCAL_SPOTS).toHaveLength(11);
    expect(ingestMessagesPerCycle).toBe(26);
    expect(ingestOperations).toBe(1_872);
    expect(ingestRetryReads).toBe(1_080);
    expect(ingestDlqOperations).toBe(720);
    expect(initialNarrativeMessages).toBe(616);
    expect(reconciliationMessages).toBe(360);
    expect(narrativeOperations).toBe(4_880);
    expect(emptyPullOperations).toBe(336);
    const accountOperations =
      ingestOperations +
      ingestRetryReads +
      ingestDlqOperations +
      narrativeOperations +
      emptyPullOperations;
    expect(accountOperations).toBe(8_888);
    expect(accountOperations).toBeLessThan(10_000);
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
      ...bundle.input.recommendations.map((recommendation) =>
        new Date(recommendation.endAt).getTime()
      )
    );

    const snapshot = await buildSurfAnalysisSnapshot(bundle);

    expect(new Date(snapshot.deadlineAt).getTime()).toBe(latest + 3 * 60 * 60_000);
  });

  it("does not flatten a midday size peak when daylight endpoints match", async () => {
    const bundle = await buildForecastFactBundle(briefForecastFixture());
    const before = await buildSurfAnalysisSnapshot(structuredClone(bundle));
    const daylight = bundle.input.windows.filter((window) => window.isDaylight);
    expect(daylight.length).toBeGreaterThan(2);
    const first = daylight[0]!;
    const middle = daylight[Math.floor(daylight.length / 2)]!;
    const last = daylight.at(-1)!;
    last.surfSizeFt = first.surfSizeFt;
    last.surfSizeLabel = first.surfSizeLabel;
    middle.surfSizeFt = (first.surfSizeFt ?? 2) + 5;
    middle.surfSizeLabel = "8–10 ft";

    const snapshot = await buildSurfAnalysisSnapshot(bundle);
    const evolutionSlot = snapshot.slots.find((slot) => slot.id === "day_surf_evolution");
    const middleWaveFact = bundle.facts.find(
      (fact) => fact.windowId === middle.windowId && fact.kind === "wave"
    );

    expect(evolutionSlot?.value).toContain("varying");
    expect(evolutionSlot?.value).not.toContain("holding");
    expect(evolutionSlot?.factRefs).toContain(middleWaveFact?.id);
    expect(snapshot.factFingerprint).not.toBe(before.factFingerprint);
  });
});
