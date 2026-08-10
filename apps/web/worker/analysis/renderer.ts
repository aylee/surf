import { SurfAnalysisReportV3Schema, type SurfAnalysisReportV3 } from "@surf/contracts";
import type {
  SurfAnalysisEditorialCard,
  SurfAnalysisPlanV5,
  SurfAnalysisValidationSnapshot
} from "./types";

const SLOT_PATTERN = /\{\{([a-z][a-z_]*)\}\}/g;

function renderTemplate(
  template: string,
  snapshot: SurfAnalysisValidationSnapshot
): string {
  const values = new Map(snapshot.slots.map((slot) => [slot.id, slot.value]));
  const rendered = template.replace(SLOT_PATTERN, (_token, id: string) => {
    const value = values.get(id);
    if (!value) throw new Error(`Cannot render unknown Analysis value slot ${id}`);
    return value;
  });
  if (/[{}]/.test(rendered)) throw new Error("Analysis contains an unrendered value slot");
  return rendered.replace(/\s+/g, " ").trim();
}

function selectedCard(
  id: string,
  snapshot: SurfAnalysisValidationSnapshot
): SurfAnalysisEditorialCard {
  const card = snapshot.cards.find((candidate) => candidate.id === id);
  if (!card) throw new Error(`Cannot render unknown Analysis card ${id}`);
  return card;
}

function renderCard(id: string, snapshot: SurfAnalysisValidationSnapshot): string {
  return renderTemplate(selectedCard(id, snapshot).template, snapshot);
}

export function renderSurfAnalysisReport(options: {
  draft: SurfAnalysisPlanV5;
  snapshot: SurfAnalysisValidationSnapshot;
  revisionId: string;
  publishedAt: string;
}): SurfAnalysisReportV3 {
  const primary = renderTemplate(
    "{{primary_session}} is the main call: {{primary_surf_size}} surf from {{primary_swell}}, with {{primary_wind_surface}}.",
    options.snapshot
  );
  const tide = options.snapshot.slots.find(({ id }) => id === "primary_tide_sentence")?.value;
  const confidence = renderTemplate("{{confidence_sentence}}", options.snapshot);
  const callSentences = [
    primary,
    ...(options.draft.call.primarySupportCardId
      ? [renderCard(options.draft.call.primarySupportCardId, options.snapshot)]
      : []),
    ...(options.draft.call.primaryTradeoffCardId
      ? [renderCard(options.draft.call.primaryTradeoffCardId, options.snapshot)]
      : []),
    ...(tide ? [tide] : []),
    ...(options.draft.call.alternateCardId
      ? [renderCard(options.draft.call.alternateCardId, options.snapshot)]
      : [])
  ];

  return SurfAnalysisReportV3Schema.parse({
    schemaVersion: 3,
    spotId: options.snapshot.spotId,
    localDate: options.snapshot.localDate,
    revisionId: options.revisionId,
    headline: renderTemplate("{{headline_call}}", options.snapshot),
    paragraphs: [
      [
        renderCard(options.draft.outlook.leadCardId, options.snapshot),
        renderCard(options.draft.outlook.supportingCardId, options.snapshot)
      ].join(" "),
      callSentences.join(" "),
      [confidence, renderCard(options.draft.close.watchCardId, options.snapshot)].join(" ")
    ],
    updatedAt: options.publishedAt
  });
}
