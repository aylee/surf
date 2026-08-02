import { forecastBriefLockedFacts } from "./facts";
import {
  unsupportedForecastBriefRelations,
  unsupportedForecastBriefWords
} from "./language-policy";
import { evaluateForecastBriefQuality } from "./quality";
import {
  ForecastBriefDraftSchema,
  type ForecastBriefDraft,
  type ForecastBriefValidation,
  type ForecastFact,
  type ForecastFactBundle
} from "./types";

const LINK_PATTERN = /https?:\/\/|www\.|\[[^\]]+\]\s*\(/i;
const HTML_PATTERN = /<\/?[a-z][^>]*>/i;
const IMPERATIVE_SAFETY_PATTERN =
  /\b(?:you\s+should|you\s+must|must|never|always|safe|unsafe|dangerous|do\s+not|don't|avoid|stay\s+out|paddle\s+out|go\s+surf|head\s+into\s+the\s+water|enter\s+the\s+water|low\s+risk|high\s+risk|risk[- ]free)\b/i;
const NUMBER_PATTERN = /\b\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\b/i;
const NUMBER_WORD_PATTERN =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|first|second|third|fourth|fifth)\b/i;
const UNIT_PATTERN =
  /(?:%|°|\b(?:ft|feet|foot|meters?|yards?|kt|kts|knots?|mph|mps|sec|secs|seconds?|minutes?|hours?|degrees?|fahrenheit|celsius|mb|hpa|pa|kj)\b)/i;
const IMPLEMENTATION_JARGON_PATTERN =
  /\b(?:deterministic|window\s+id|required[- ]source|source\s+status|input\s+is\s+(?:available|unavailable)|semantics|calibration\s+status|quality\s+band|confidence\s+band|fact\s+id|provider|schema|fallback)\b/i;
const ROBOTIC_AVAILABILITY_PATTERN =
  /\b(?:input|data|value|observation)\s+(?:is|are)\s+(?:available|unavailable)\b/i;
const MODEL_OWNED_SEMANTICS_PATTERN =
  /\b(?:observed|breaking[- ]wave|wave[- ]face|surf[- ]face|surf\s+height)\b/i;
const UNSUPPORTED_SURF_PATTERN =
  /\b(?:glassy|crumbly|punchy|hollow|mushy|closeouts?|organized|consistent|surfable|powerful|gutless|weak|peaky|walled|lined[- ]up)\b/i;
const TIDE_CAUSAL_PATTERN =
  /\b(?:tide|rising|falling)\b[^.!?]*\b(?:push|shape|quality|improv|worsen|clean|power|energy|break|hold|drain|fill)\w*/i;

const QUALITATIVE_TERMS = [
  "clean",
  "fair",
  "choppy",
  "poor",
  "fun",
  "good",
  "excellent",
  "offshore",
  "onshore",
  "cross-shore",
  "variable",
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
  "high confidence",
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
  "leading"
] as const;

const DOMAIN_ASSERTION_TERMS = [
  "limiter",
  "strengthen",
  "uncertainty",
  "confidence",
  "leading",
  "worth a look"
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

type ClaimRole = "summary" | "why" | "tradeoff" | "bust" | "lesson";

type ReferencedText = {
  path: string;
  text: string;
  factRefs: string[];
  windowId: string | null;
  role: ClaimRole;
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

function sentences(value: string): string[] {
  return value
    .split(/[.!?]+/)
    .map(normalized)
    .filter((sentence) => sentence.length > 0);
}

function textWithReferences(draft: ForecastBriefDraft): ReferencedText[] {
  return [
    {
      path: "summary",
      text: draft.summary.text,
      factRefs: draft.summary.factRefs,
      windowId: null,
      role: "summary"
    },
    ...draft.picks.flatMap((pick, index) => [
      {
        path: `picks[${index}].why`,
        text: pick.why.text,
        factRefs: pick.why.factRefs,
        windowId: pick.windowId,
        role: "why" as const
      },
      {
        path: `picks[${index}].tradeoff`,
        text: pick.tradeoff.text,
        factRefs: pick.tradeoff.factRefs,
        windowId: pick.windowId,
        role: "tradeoff" as const
      }
    ]),
    ...draft.bustFactors.map((factor, index) => ({
      path: `bustFactors[${index}]`,
      text: factor.text,
      factRefs: factor.factRefs,
      windowId: null,
      role: "bust" as const
    })),
    {
      path: "lesson.text",
      text: draft.lesson.text,
      factRefs: draft.lesson.factRefs,
      windowId: null,
      role: "lesson"
    }
  ];
}

function validateProhibitedText(path: string, value: string, issues: string[]): void {
  if (LINK_PATTERN.test(value)) issues.push(`${path} contains a link`);
  if (HTML_PATTERN.test(value)) issues.push(`${path} contains HTML`);
  if (IMPERATIVE_SAFETY_PATTERN.test(value)) {
    issues.push(`${path} contains a safety directive or assurance`);
  }
  if (NUMBER_PATTERN.test(value) || NUMBER_WORD_PATTERN.test(value)) {
    issues.push(`${path} contains a model-authored number`);
  }
  if (UNIT_PATTERN.test(value)) issues.push(`${path} contains a model-authored measurement unit`);
  if (IMPLEMENTATION_JARGON_PATTERN.test(value) || ROBOTIC_AVAILABILITY_PATTERN.test(value)) {
    issues.push(`${path} contains implementation or availability jargon`);
  }
  if (MODEL_OWNED_SEMANTICS_PATTERN.test(value)) {
    issues.push(`${path} attempts to author a code-owned measurement caveat`);
  }
  if (UNSUPPORTED_SURF_PATTERN.test(value)) {
    issues.push(`${path} contains an unsupported surf descriptor`);
  }
  if (TIDE_CAUSAL_PATTERN.test(value)) {
    issues.push(`${path} invents an unsupported tide effect`);
  }
  if (sentences(value).length > 1) issues.push(`${path} must contain exactly one cited sentence`);
}

function relevantTradeoffFacts(bundle: ForecastFactBundle, windowId: string | null): ForecastFact[] {
  return bundle.facts.filter(
    (fact) =>
      fact.role === "tradeoff" &&
      (windowId === null
        ? fact.windowId === null || bundle.input.recommendationWindowIds.includes(fact.windowId)
        : fact.windowId === windowId)
  );
}

function validateRoleEvidence(
  claim: ReferencedText,
  facts: ForecastFact[],
  bundle: ForecastFactBundle,
  lessonTopic: string,
  issues: string[]
): void {
  if (facts.some((fact) => fact.role === "locked")) {
    issues.push(`${claim.path} cites a code-owned locked caveat`);
  }
  if (claim.role === "why") {
    const availableSubstantiveSupport = bundle.facts.some(
      (fact) =>
        fact.role === "support" &&
        fact.windowId === claim.windowId &&
        ["condition", "wave", "wind", "confidence"].includes(fact.kind)
    );
    const hasRelevantSupport = facts.some(
      (fact) =>
        fact.role === "support" &&
        fact.windowId === claim.windowId &&
        (availableSubstantiveSupport
          ? ["condition", "wave", "wind", "confidence"].includes(fact.kind)
          : fact.kind === "recommendation")
    );
    const hasSubstantiveContext = facts.some(
      (fact) =>
        fact.windowId === claim.windowId &&
        !["spot", "recommendation"].includes(fact.kind)
    );
    if (!hasRelevantSupport || (!availableSubstantiveSupport && !hasSubstantiveContext)) {
      issues.push(`${claim.path} lacks a relevant supporting forecast fact`);
    }
  }
  if (claim.role === "tradeoff" || claim.role === "bust") {
    const availableTradeoffs = relevantTradeoffFacts(bundle, claim.windowId);
    const requiredRole = availableTradeoffs.length > 0 ? "tradeoff" : "context";
    if (!facts.some((fact) => fact.role === requiredRole)) {
      issues.push(`${claim.path} lacks an eligible ${requiredRole} fact`);
    }
  }
  if (claim.role === "lesson") {
    const allowedTopics = new Set<string>(
      facts
        .filter((fact) => fact.role !== "locked")
        .map((fact) => LESSON_TOPICS_BY_FACT_KIND[fact.kind])
    );
    if (!allowedTopics.has(lessonTopic)) {
      issues.push("lesson.topic does not match the cited fact kind");
    }
  }
}

function validateStructuredClaims(
  claim: ReferencedText,
  facts: ForecastFact[],
  bundle: ForecastFactBundle,
  issues: string[]
): void {
  const windows = [
    ...new Set(
      facts
        .map((fact) => fact.windowId)
        .filter((windowId): windowId is string => windowId !== null)
    )
  ].flatMap((windowId) => {
    const window = bundle.input.windows.find((candidate) => candidate.windowId === windowId);
    return window ? [window] : [];
  });
  const text = normalized(claim.text);
  const checks: Array<{
    pattern: RegExp;
    values: string[];
    label: string;
  }> = [
    {
      pattern: /\bsurface conditions? (?:are|is) ([a-z-]+)/i,
      values: windows.map((window) => window.surfaceCondition),
      label: "surface condition"
    },
    {
      pattern: /\b(?:overall )?quality (?:read )?(?:is|of) ([a-z-]+)/i,
      values: windows.map((window) => window.qualityLabel),
      label: "quality"
    },
    {
      pattern: /\bconfidence (?:is|remains) ([a-z-]+)/i,
      values: windows.map((window) => window.confidenceBand),
      label: "confidence"
    },
    {
      pattern: /\b(?:wind is|wind remains) ([a-z-]+)/i,
      values: windows.map((window) => window.windRelation),
      label: "wind relationship"
    },
    {
      pattern: /\btide is ([a-z-]+)/i,
      values: windows.map((window) => window.tideTrend ?? "unknown"),
      label: "tide trend"
    }
  ];
  for (const check of checks) {
    const value = check.pattern.exec(text)?.[1];
    if (value && check.values.length > 0 && !check.values.includes(value)) {
      issues.push(`${claim.path} swaps or invents the ${check.label} value ${value}`);
    }
  }
  if (/\b(?:without|no) tide\b/i.test(text) && windows.some((window) => window.tideFt !== null)) {
    issues.push(`${claim.path} contradicts the available tide context`);
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
  const factsById = new Map(bundle.facts.map((fact) => [fact.id, fact]));
  const referencedIds = new Set<string>();
  const claims = textWithReferences(draft);

  const expectedWindowIds = bundle.input.recommendationWindowIds;
  const actualWindowIds = draft.picks.map((pick) => pick.windowId);
  if (JSON.stringify(actualWindowIds) !== JSON.stringify(expectedWindowIds)) {
    issues.push("pick window IDs or order differ from the deterministic recommendations");
  }

  for (const claim of claims) {
    validateProhibitedText(claim.path, claim.text, issues);
    const uniqueRefs = new Set(claim.factRefs);
    if (uniqueRefs.size !== claim.factRefs.length) issues.push(`${claim.path} repeats a fact reference`);
    const referencedFacts = claim.factRefs.flatMap((factId) => {
      const fact = factsById.get(factId);
      if (!fact) {
        issues.push(`${claim.path} references unknown fact ${factId}`);
        return [];
      }
      referencedIds.add(factId);
      return [fact];
    });

    if (claim.windowId !== null) {
      if (
        referencedFacts.some(
          (fact) => fact.windowId !== null && fact.windowId !== claim.windowId
        )
      ) {
        issues.push(`${claim.path} cites evidence from a different recommendation window`);
      }
      if (!referencedFacts.some((fact) => fact.windowId === claim.windowId)) {
        issues.push(`${claim.path} lacks evidence for its recommendation window`);
      }
    } else if (
      referencedFacts.some(
        (fact) =>
          fact.windowId !== null &&
          !bundle.input.recommendationWindowIds.includes(fact.windowId)
      )
    ) {
      issues.push(`${claim.path} cites a non-recommended forecast window`);
    }

    validateRoleEvidence(claim, referencedFacts, bundle, draft.lesson.topic, issues);
    validateStructuredClaims(claim, referencedFacts, bundle, issues);
    const unsupportedWords = unsupportedForecastBriefWords(
      claim.text,
      referencedFacts.map((fact) => fact.statement)
    );
    if (unsupportedWords.length > 0) {
      issues.push(
        `${claim.path} contains words unsupported by its cited facts: ${unsupportedWords.join(", ")}`
      );
    }
    for (const relationIssue of unsupportedForecastBriefRelations(
      claim.text,
      referencedFacts
    )) {
      issues.push(`${claim.path} ${relationIssue}`);
    }
    const evidence = normalized(referencedFacts.map((fact) => fact.statement).join(" "));
    const normalizedClaim = normalized(claim.text);
    for (const term of QUALITATIVE_TERMS) {
      if (normalizedClaim.includes(term) && !evidence.includes(term)) {
        issues.push(`${claim.path} contains unsupported qualitative claim ${term}`);
      }
    }
    for (const term of DOMAIN_ASSERTION_TERMS) {
      if (normalizedClaim.includes(term) && !evidence.includes(term)) {
        issues.push(`${claim.path} contains unsupported domain claim ${term}`);
      }
    }
  }

  const lockedFacts = forecastBriefLockedFacts(bundle);
  for (const fact of lockedFacts) referencedIds.add(fact.id);
  const quality = evaluateForecastBriefQuality(draft, bundle);
  if (!quality.passed) issues.push(...quality.issues);
  if (issues.length > 0) throw new ForecastBriefPolicyError(issues);
  return {
    draft,
    validation: {
      valid: true,
      checkedAt: now.toISOString(),
      referencedFactIds: [...referencedIds].sort(),
      claimRefs: [
        ...claims.map((claim) => ({
          path: claim.path,
          factRefs: [...claim.factRefs]
        })),
        ...(lockedFacts.length > 0
          ? [{ path: "codeOwned.lockedCaveats", factRefs: lockedFacts.map((fact) => fact.id) }]
          : [])
      ]
    }
  };
}
