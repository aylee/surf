import {
  SurfAnalysisDraftV3Schema,
  SurfAnalysisValidationSchema,
  type SurfAnalysisBlockName,
  type SurfAnalysisDraftV3,
  type SurfAnalysisValidation,
  type SurfAnalysisValidationSnapshot
} from "./types";

const SLOT_PATTERN = /\{\{([a-z][a-z_]*)\}\}/g;
const UNSAFE_PATTERN = /(?:https?:\/\/|www\.|<\/?[a-z][^>]*>|\b(?:you|your)\b|\b(?:enter the water|paddle out|swim out|ignore (?:an )?(?:advisory|warning|hazard)|guaranteed safe)\b)/i;
const IMPERATIVE_PATTERN = /(?:^|[.!?;:]\s+|\bso\s+)(?:please\s+)?(?:go|head|paddle|enter|swim|avoid|ignore|skip|wait|bring|wear|take)\b/i;
const MODEL_OWNED_VALUE_PATTERN = /(?:\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:ft|feet|knots?|kt|seconds?|s|percent|%)\b|\b(?:ft|feet|knots?|kt|mph|mllw|am|pm)\b|\b(?:high|medium|low)\s+(?:confidence|tide)\b)/i;
const UNSUPPORTED_DESCRIPTOR_PATTERN = /\b(?:punchy|peaky|hollow|barreling|powerful|soft|weak|strong|consistent|inconsistent|crowded|uncrowded|waist-high|chest-high|head-high|overhead|morning|afternoon|evening|dawn|sunrise|sunset|noon|overnight|clean|fair|choppy|glassy|excellent|good|great|poor|bad|quality|promising|inviting|fun|epic|solid|favorable|favourable|optimal|ideal|offshore|onshore|cross-shore|north|northeast|east|southeast|south|southwest|west|northwest)\b/i;
const UNSUPPORTED_TREND_PATTERN = /\b(?:hold(?:s|ing)?|build(?:s|ing)?|ease(?:s|d|ing)?|vary(?:ing|ies)?|lengthen(?:s|ing)?|shorten(?:s|ing)?|shift(?:s|ing)?|rise(?:s|n|ing)?|fall(?:s|en|ing)?|steady|increase(?:s|d|ing)?|decrease(?:s|d|ing)?)\b/i;
const UNSUPPORTED_CAUSATION_PATTERN = /\b(?:cause|causes|guarantee|guarantees|improve|improves|produce|produces|create|creates|mean|means|ensure|ensures)\b/i;
const IMPLEMENTATION_JARGON_PATTERN = /\b(?:deterministic|schema|fact refs?|source health|guardrails?|validation payload)\b/i;
const MODEL_OWNED_SAFETY_PATTERN = /\b(?:safe|unsafe|safety|risk[- ]?free|no[- ]risk|without risk)\b/i;
const RECOMMENDATION_NEGATION_PATTERN = /\b(?:not|never|avoid|ignore|skip|forget|reject|dismiss|worst|inferior|last choice|do not|don't|should not|shouldn't|instead of|rather than)\b/i;
const PRIMARY_FRAME_PATTERN = /\b(?:best|lead(?:ing|s)?|recommend(?:ed|s)?|top choice|first choice|strongest (?:window|call)|the pick)\b/i;
const BACKUP_FRAME_PATTERN = /\b(?:backup|alternate|alternative|second choice)\b/i;
const UNCERTAINTY_FRAME_PATTERN = /\b(?:uncertainty|risk|bust|caveat|could change|thing to watch|watch item|question mark|wildcard|limitation)\b/i;
const MODEL_OWNED_ASCII_PATTERN = /^[A-Za-z\t\n\r .,;:!?'"()-]*$/;

// Values, conditions, and physical subjects belong to code-owned slots. The
// model may vary connective forecaster phrasing, but an allowlist prevents an
// otherwise grammatical extra clause (for example rain or beach safety) from
// becoming an ungrounded claim that no slot can support.
const CONNECTIVE_WORDS: Record<SurfAnalysisBlockName, ReadonlySet<string>> = {
  headline: new Set(),
  setup: new Set([
    "a", "across", "and", "are", "as", "be", "day", "daylight", "for",
    "forecast", "is", "looks", "over", "set", "should", "surf", "swell",
    "the", "through", "to", "while"
  ]),
  plan: new Set([
    "a", "along", "alongside", "alternate", "alternative", "and", "as", "at",
    "backup", "best", "call", "carrying", "choice", "context", "first", "for",
    "has", "is", "lead", "leading", "leads", "of", "on", "pairing", "pick",
    "recommended", "recommendation", "remains", "session", "strongest", "surf",
    "the", "tide", "top", "with", "window"
  ]),
  confidence: new Set([
    "a", "call", "caveat", "change", "confidence", "could", "forecast", "here",
    "in", "is", "limitation", "main", "mark", "of", "overall", "question",
    "read", "remains", "risk", "the", "thing", "this", "to", "uncertainty",
    "watch", "wildcard", "with"
  ])
};

function blocks(draft: SurfAnalysisDraftV3): Array<{
  name: SurfAnalysisBlockName;
  template: string;
}> {
  return [
    { name: "setup", ...draft.paragraphs.setup },
    { name: "plan", ...draft.paragraphs.plan },
    { name: "confidence", ...draft.paragraphs.confidence }
  ];
}

function slotIds(template: string): string[] {
  return [...template.matchAll(SLOT_PATTERN)].map((match) => match[1]!);
}

function withoutSlots(template: string): string {
  return template.replace(SLOT_PATTERN, " supplied-value ");
}

function sentences(template: string): string[] {
  return (template.replace(/\s+/g, " ").trim().match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function assertTopicHasSlot(sentence: string, topic: RegExp, slotIds: string[]): void {
  if (!topic.test(sentence)) return;
  if (slotIds.some((id) => sentence.includes(`{{${id}}}`))) return;
  throw new Error("Analysis prose makes a factual topic claim outside its code-owned value slot");
}

function assertNaturalParagraph(name: SurfAnalysisBlockName, template: string): void {
  const residualBraces = template.replace(SLOT_PATTERN, "");
  if (/[{}]/.test(residualBraces)) {
    throw new Error(`${name} contains an unknown or malformed value placeholder`);
  }
  if (!MODEL_OWNED_ASCII_PATTERN.test(residualBraces)) {
    throw new Error(`${name} contains non-ASCII model-owned text`);
  }
  const stripped = withoutSlots(template).trim();
  if (UNSAFE_PATTERN.test(stripped)) throw new Error(`${name} contains a link, markup, or directive`);
  if (MODEL_OWNED_SAFETY_PATTERN.test(stripped)) {
    throw new Error(`${name} contains a model-authored safety claim`);
  }
  if (IMPERATIVE_PATTERN.test(stripped)) throw new Error(`${name} contains an imperative directive`);
  if (MODEL_OWNED_VALUE_PATTERN.test(stripped)) {
    throw new Error(`${name} contains a model-authored measurement, time, or score`);
  }
  if (
    UNSUPPORTED_DESCRIPTOR_PATTERN.test(stripped) ||
    UNSUPPORTED_TREND_PATTERN.test(stripped) ||
    UNSUPPORTED_CAUSATION_PATTERN.test(stripped)
  ) {
    throw new Error(`${name} contains an unsupported condition, rating, trend, or causation claim`);
  }
  if (IMPLEMENTATION_JARGON_PATTERN.test(stripped)) {
    throw new Error(`${name} exposes implementation vocabulary`);
  }
  const modelOwnedWords = template.replace(SLOT_PATTERN, " ").toLowerCase();
  const unsupportedWords = (modelOwnedWords.match(/[a-z]+(?:'[a-z]+)?/g) ?? [])
    .filter((word) => !CONNECTIVE_WORDS[name].has(word));
  if (unsupportedWords.length > 0) {
    throw new Error(`${name} contains unsupported model-owned factual vocabulary`);
  }
  for (const sentence of sentences(template)) {
    assertTopicHasSlot(sentence, /\bsurf\b/i, ["day_surf_evolution", "primary_surf_size"]);
    assertTopicHasSlot(sentence, /\bswell\b/i, ["day_swell_evolution"]);
    assertTopicHasSlot(sentence, /\b(?:wind|surface|conditions?)\b/i, ["primary_wind_surface"]);
    assertTopicHasSlot(sentence, /\btide\b/i, ["primary_tide_timing"]);
    assertTopicHasSlot(sentence, /\bconfidence\b/i, ["forecast_confidence"]);
  }
  if (name !== "headline" && stripped.length < 45) {
    throw new Error(`${name} is too short to be a useful forecast paragraph`);
  }
}

function assertRecommendationSemantics(template: string): void {
  const normalized = template.replace(/\s+/g, " ").trim();
  const planSentences = sentences(normalized);
  if (planSentences.length !== 2) {
    throw new Error("plan must contain one best-window sentence and one later backup sentence");
  }
  const primary = planSentences[0]!;
  const backup = planSentences[1]!;
  for (const id of [
    "primary_session",
    "primary_surf_size",
    "primary_wind_surface",
    "primary_tide_timing"
  ]) {
    if (!primary.includes(`{{${id}}}`)) {
      throw new Error("plan best-window sentence is missing a required code-owned value");
    }
  }
  if (primary.includes("{{backup_session}}") || !backup.includes("{{backup_session}}")) {
    throw new Error("plan must keep the backup in a distinct later sentence");
  }
  if (!PRIMARY_FRAME_PATTERN.test(primary) || BACKUP_FRAME_PATTERN.test(primary)) {
    throw new Error("plan must clearly recommend the primary window without a backup frame");
  }
  if (!BACKUP_FRAME_PATTERN.test(backup) || PRIMARY_FRAME_PATTERN.test(backup)) {
    throw new Error("plan must label the later window only as a backup or alternate");
  }
  if (
    RECOMMENDATION_NEGATION_PATTERN.test(primary) ||
    RECOMMENDATION_NEGATION_PATTERN.test(backup)
  ) {
    throw new Error("plan must not negate, reverse, or down-rank the code-owned recommendation");
  }
}

function assertSetupGrammar(template: string): void {
  const normalized = template.replace(/\s+/g, " ").trim();
  const setupSentences = sentences(normalized);
  if (setupSentences.length < 1 || setupSentences.length > 2) {
    throw new Error("setup must contain one or two compact evolution sentences");
  }
  const surfAt = normalized.indexOf("{{day_surf_evolution}}");
  const swellAt = normalized.indexOf("{{day_swell_evolution}}");
  if (surfAt < 0 || swellAt < 0 || surfAt >= swellAt) {
    throw new Error("setup must describe surf before swell");
  }
  if (
    !/\bsurf\b[^.!?]{0,56}\{\{day_surf_evolution\}\}/i.test(normalized) ||
    !/\bswell\b[^.!?]{0,56}\{\{day_swell_evolution\}\}/i.test(normalized)
  ) {
    throw new Error("setup must place each evolution value after its matching surf or swell noun");
  }
  if (
    setupSentences.some(
      (sentence) =>
        !sentence.includes("{{day_surf_evolution}}") &&
        !sentence.includes("{{day_swell_evolution}}")
    )
  ) {
    throw new Error("setup may not append an ungrounded sentence");
  }
  if (RECOMMENDATION_NEGATION_PATTERN.test(normalized)) {
    throw new Error("setup must not negate a code-owned evolution value");
  }
}

function assertConfidenceGrammar(template: string): void {
  const normalized = template.replace(/\s+/g, " ").trim();
  const confidenceAt = normalized.indexOf("{{forecast_confidence}}");
  const bustAt = normalized.indexOf("{{bust_factor}}");
  const confidenceSentences = sentences(normalized);
  if (
    confidenceAt < 0 ||
    bustAt < 0 ||
    confidenceAt >= bustAt ||
    !normalized.endsWith("{{bust_factor}}")
  ) {
    throw new Error("confidence must lead with the confidence band and end at the bust factor");
  }
  if (confidenceSentences.length < 1 || confidenceSentences.length > 2) {
    throw new Error("confidence must contain one or two compact sentences");
  }
  if (
    confidenceSentences.some(
      (sentence) =>
        !sentence.includes("{{forecast_confidence}}") && !sentence.includes("{{bust_factor}}")
    )
  ) {
    throw new Error("confidence may not append an ungrounded sentence");
  }
  const confidenceSentence = confidenceSentences.find((sentence) =>
    sentence.includes("{{forecast_confidence}}")
  )!;
  const bustSentence = confidenceSentences.find((sentence) =>
    sentence.includes("{{bust_factor}}")
  )!;
  if (!/\b(?:confidence|call|read)\b/i.test(confidenceSentence)) {
    throw new Error("confidence band must be framed as confidence in the call");
  }
  if (!UNCERTAINTY_FRAME_PATTERN.test(bustSentence)) {
    throw new Error("bust factor must follow an uncertainty or risk frame");
  }
  if (!/:\s*\{\{bust_factor\}\}$/.test(normalized)) {
    throw new Error("bust factor must be introduced by a colon as a complete final sentence");
  }
  if (RECOMMENDATION_NEGATION_PATTERN.test(normalized)) {
    throw new Error("confidence must not negate its code-owned values");
  }
}

export function validateSurfAnalysisDraft(
  value: unknown,
  snapshot: SurfAnalysisValidationSnapshot,
  now = new Date()
): { draft: SurfAnalysisDraftV3; validation: SurfAnalysisValidation } {
  const draft = SurfAnalysisDraftV3Schema.parse(value);
  const knownFacts = new Set(snapshot.facts.map((fact) => fact.id));
  const knownSlots = new Map(snapshot.slots.map((candidate) => [candidate.id, candidate]));
  const usedSlots: string[] = ["headline_call"];
  const headline = knownSlots.get("headline_call");
  if (!headline || headline.block !== "headline") {
    throw new Error("Analysis snapshot is missing the code-owned headline slot");
  }
  const allowedHeadlineFacts = new Set(snapshot.allowedFactRefs.headline);
  const referencedFacts: string[] = [];
  for (const factRef of headline.factRefs) {
    if (!knownFacts.has(factRef) || !allowedHeadlineFacts.has(factRef)) {
      throw new Error("Code-owned headline provenance is outside its allowed facts");
    }
    referencedFacts.push(factRef);
  }

  for (const block of blocks(draft)) {
    assertNaturalParagraph(block.name, block.template);
    if (block.name === "setup") assertSetupGrammar(block.template);
    if (block.name === "plan") assertRecommendationSemantics(block.template);
    if (block.name === "confidence") assertConfidenceGrammar(block.template);
    const ids = slotIds(block.template);
    for (const id of ids) {
      const candidate = knownSlots.get(id);
      if (!candidate) throw new Error(`${block.name} references unknown value slot ${id}`);
      if (candidate.block !== block.name) {
        throw new Error(`${block.name} uses ${id}, which belongs in ${candidate.block}`);
      }
      if (usedSlots.includes(id)) throw new Error(`Value slot ${id} is used more than once`);
      usedSlots.push(id);
    }

    const allowedFacts = new Set(snapshot.allowedFactRefs[block.name]);
    for (const id of ids) {
      for (const factRef of knownSlots.get(id)!.factRefs) {
        if (!knownFacts.has(factRef)) {
          throw new Error(`${block.name} slot ${id} has unknown fact provenance ${factRef}`);
        }
        if (!allowedFacts.has(factRef)) {
          throw new Error(`${block.name} slot ${id} has provenance outside its allowed facts`);
        }
        referencedFacts.push(factRef);
      }
    }
  }

  for (const required of snapshot.slots.filter((candidate) => candidate.required)) {
    if (!usedSlots.includes(required.id)) throw new Error(`Required value slot ${required.id} is missing`);
  }

  const paragraphTemplates = [
    draft.paragraphs.setup.template,
    draft.paragraphs.plan.template,
    draft.paragraphs.confidence.template
  ].map((template) => withoutSlots(template).replace(/\s+/g, " ").trim().toLowerCase());
  if (new Set(paragraphTemplates).size !== paragraphTemplates.length) {
    throw new Error("Analysis paragraphs repeat the same prose");
  }

  return {
    draft,
    validation: SurfAnalysisValidationSchema.parse({
      valid: true,
      checkedAt: now.toISOString(),
      referencedFactIds: [...new Set(referencedFacts)].sort(),
      usedSlotIds: [...usedSlots].sort()
    })
  };
}
