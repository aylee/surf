import { forecastBriefFrame, forecastBriefWindowLabel } from "./facts";
import {
  ForecastBriefDraftSchema,
  type ForecastBriefDraft,
  type ForecastBriefValidation,
  type ForecastFactBundle
} from "./types";

const LINK_PATTERN = /https?:\/\/|www\.|\[[^\]]+\]\s*\(/i;
const HTML_PATTERN = /<\/?[a-z][^>]*>/i;
const IMPERATIVE_SAFETY_PATTERN =
  /\b(?:you\s+should|you\s+must|must|never|always|safe|unsafe|dangerous|do\s+not|don't|avoid|stay\s+out|paddle\s+out|go\s+surf|head\s+into\s+the\s+water|enter\s+the\s+water|low\s+risk|high\s+risk|risk[- ]free)\b/i;
const NUMBER_PATTERN = /\b\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\b/g;
const UNIT_PATTERN =
  /(?:\b\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*)(?:ft|feet|foot|m|meters?|yards?|kt|kts|knots?|mph|mps|s|sec|secs|seconds?|%|minutes?|hours?|degrees?|°[fc]|mb|hpa|pa|kj)\b/gi;

const QUALITATIVE_TERMS = [
  "clean",
  "fair",
  "choppy",
  "offshore",
  "onshore",
  "cross-shore",
  "rising",
  "falling",
  "steady",
  "fresh",
  "stale",
  "missing",
  "short-period",
  "medium-period",
  "long-period",
  "low confidence",
  "medium confidence",
  "high confidence"
] as const;

const LESSON_TOPICS_BY_FACT_KIND = {
  spot: "Spot context",
  recommendation: "Recommendation",
  condition: "Surface condition",
  wave: "Modeled wave state",
  wind: "Wind relationship",
  tide: "Tide trend",
  confidence: "Confidence",
  source: "Source freshness",
  hazard: "Forecast hazard",
  observation: "Buoy observation",
  caveat: "Forecast caveat"
} as const;

type ReferencedText = {
  path: string;
  text: string;
  factRefs: string[];
  windowId: string | null;
  requireWindowEvidence: boolean;
};

export class ForecastBriefPolicyError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Forecast brief failed policy validation: ${issues.join("; ")}`);
    this.name = "ForecastBriefPolicyError";
    this.issues = issues;
  }
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function numericTokens(value: string): string[] {
  return [...value.matchAll(NUMBER_PATTERN)].map((match) => normalized(match[0]));
}

function unitClaims(value: string): string[] {
  return [...value.matchAll(UNIT_PATTERN)].map((match) => normalized(match[0]));
}

function sentences(value: string): string[] {
  return value
    .split(/[.!?]+/)
    .map(normalized)
    .filter((sentence) => sentence.length > 0);
}

function textWithReferences(draft: ForecastBriefDraft): ReferencedText[] {
  return [
    ...draft.picks.flatMap((pick, index) => [
      {
        path: `picks[${index}].why`,
        text: pick.why,
        factRefs: pick.factRefs,
        windowId: pick.windowId,
        requireWindowEvidence: true
      },
      {
        path: `picks[${index}].tradeoff`,
        text: pick.tradeoff,
        factRefs: pick.factRefs,
        windowId: pick.windowId,
        requireWindowEvidence: true
      }
    ]),
    ...draft.bustFactors.map((factor, index) => ({
      path: `bustFactors[${index}]`,
      text: factor.text,
      factRefs: factor.factRefs,
      windowId: null,
      requireWindowEvidence: false
    })),
    {
      path: "lesson.text",
      text: draft.lesson.text,
      factRefs: draft.lesson.factRefs,
      windowId: null,
      requireWindowEvidence: false
    }
  ];
}

function validateProhibitedText(path: string, value: string, issues: string[]): void {
  if (LINK_PATTERN.test(value)) issues.push(`${path} contains a link`);
  if (HTML_PATTERN.test(value)) issues.push(`${path} contains HTML`);
  if (IMPERATIVE_SAFETY_PATTERN.test(value)) issues.push(`${path} contains a safety directive or assurance`);
  for (const sentence of sentences(value)) {
    if (
      /\b(?:observed|breaking[- ]wave\s+face\s+height)\b/i.test(sentence) &&
      sentence !== "this is not an observed breaking-wave face height"
    ) {
      issues.push(`${path} reverses or weakens the modeled-wave semantics caveat`);
    }
  }
}

export function validateForecastBriefDraft(
  value: unknown,
  bundle: ForecastFactBundle,
  now = new Date()
): { draft: ForecastBriefDraft; validation: ForecastBriefValidation } {
  const parsed = ForecastBriefDraftSchema.safeParse(value);
  if (!parsed.success) {
    throw new ForecastBriefPolicyError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "draft"}: ${issue.message}`)
    );
  }
  const draft = parsed.data;
  const issues: string[] = [];
  const facts = new Map(bundle.facts.map((fact) => [fact.id, fact]));
  const frame = forecastBriefFrame(bundle);

  validateProhibitedText("headline", draft.headline, issues);
  validateProhibitedText("setup", draft.setup, issues);
  if (draft.headline !== frame.headline) issues.push("headline differs from the deterministic frame");
  if (draft.setup !== frame.setup) issues.push("setup differs from the deterministic frame");

  const expectedWindowIds = bundle.input.recommendationWindowIds;
  const actualWindowIds = draft.picks.map((pick) => pick.windowId);
  if (JSON.stringify(actualWindowIds) !== JSON.stringify(expectedWindowIds)) {
    issues.push("pick window IDs or order differ from the deterministic recommendations");
  }
  draft.picks.forEach((pick, index) => {
    const expected = expectedWindowIds[index];
    if (expected && pick.label !== forecastBriefWindowLabel(bundle, expected)) {
      issues.push(`picks[${index}].label differs from the deterministic window label`);
    }
  });

  const referencedIds = new Set<string>();
  for (const claim of textWithReferences(draft)) {
    validateProhibitedText(claim.path, claim.text, issues);
    const uniqueRefs = new Set(claim.factRefs);
    if (uniqueRefs.size !== claim.factRefs.length) issues.push(`${claim.path} repeats a fact reference`);
    const referencedFacts = claim.factRefs.flatMap((factId) => {
      const fact = facts.get(factId);
      if (!fact) {
        issues.push(`${claim.path} references unknown fact ${factId}`);
        return [];
      }
      referencedIds.add(factId);
      return [fact];
    });
    if (claim.windowId !== null) {
      const wrongWindow = referencedFacts.find(
        (fact) => fact.windowId !== null && fact.windowId !== claim.windowId
      );
      if (wrongWindow) {
        issues.push(`${claim.path} cites evidence from a different recommendation window`);
      }
      if (
        claim.requireWindowEvidence &&
        !referencedFacts.some((fact) => fact.windowId === claim.windowId)
      ) {
        issues.push(`${claim.path} lacks evidence for its recommendation window`);
      }
    }
    const evidence = normalized(referencedFacts.map((fact) => fact.statement).join(" "));
    const allowlistedSentences = new Set(
      referencedFacts.flatMap((fact) => sentences(fact.statement))
    );
    for (const token of numericTokens(claim.text)) {
      const evidenceTokens = new Set(numericTokens(evidence));
      if (!evidenceTokens.has(token)) {
        issues.push(`${claim.path} contains novel numeric token ${token}`);
      }
    }
    for (const unitClaim of unitClaims(claim.text)) {
      if (!evidence.includes(unitClaim)) {
        issues.push(`${claim.path} contains novel measurement ${unitClaim}`);
      }
    }
    const normalizedClaim = normalized(claim.text);
    for (const term of QUALITATIVE_TERMS) {
      if (normalizedClaim.includes(term) && !evidence.includes(term)) {
        issues.push(`${claim.path} contains unsupported qualitative claim ${term}`);
      }
    }
    for (const sentence of sentences(claim.text)) {
      if (!allowlistedSentences.has(sentence)) {
        issues.push(`${claim.path} contains prose that is not an exact allowlisted fact sentence`);
      }
    }
    if (claim.path === "lesson.text") {
      const allowedTopics = new Set<string>(
        referencedFacts.map((fact) => LESSON_TOPICS_BY_FACT_KIND[fact.kind])
      );
      if (!allowedTopics.has(draft.lesson.topic)) {
        issues.push("lesson.topic does not match the cited fact kind");
      }
    }
  }

  if (issues.length > 0) throw new ForecastBriefPolicyError(issues);
  return {
    draft,
    validation: {
      valid: true,
      checkedAt: now.toISOString(),
      referencedFactIds: [...referencedIds].sort()
    }
  };
}
