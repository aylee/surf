import { SurfAnalysisReportV3Schema, type SurfAnalysisReportV3 } from "@surf/contracts";
import type {
  SurfAnalysisDraftV3,
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

export function renderSurfAnalysisReport(options: {
  draft: SurfAnalysisDraftV3;
  snapshot: SurfAnalysisValidationSnapshot;
  revisionId: string;
  publishedAt: string;
}): SurfAnalysisReportV3 {
  return SurfAnalysisReportV3Schema.parse({
    schemaVersion: 3,
    spotId: options.snapshot.spotId,
    localDate: options.snapshot.localDate,
    revisionId: options.revisionId,
    headline: renderTemplate("{{headline_call}}", options.snapshot),
    paragraphs: [
      renderTemplate(options.draft.paragraphs.setup.template, options.snapshot),
      renderTemplate(options.draft.paragraphs.plan.template, options.snapshot),
      renderTemplate(options.draft.paragraphs.confidence.template, options.snapshot)
    ],
    updatedAt: options.publishedAt
  });
}
