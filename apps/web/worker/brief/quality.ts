import {
  FORECAST_BRIEF_QUALITY_POLICY_VERSION,
  type ForecastBriefDraft,
  type ForecastFact,
  type ForecastFactBundle
} from "./types";

export type ForecastBriefQualityCheck =
  | "citationRelevance"
  | "roleCoverage"
  | "evidenceDiversity"
  | "nonRepetition"
  | "noImplementationPlumbing"
  | "naturalness";

export type ForecastBriefQualityReport = {
  policyVersion: typeof FORECAST_BRIEF_QUALITY_POLICY_VERSION;
  passed: boolean;
  checks: Record<ForecastBriefQualityCheck, boolean>;
  issues: string[];
  metrics: {
    proseFields: number;
    referencedFacts: number;
    referencedFactKinds: number;
    uniqueProseRatio: number;
    exactFactCopies: number;
  };
};

type ClaimPurpose = "summary" | "why" | "tradeoff" | "bust" | "lesson";

type Claim = {
  path: string;
  purpose: ClaimPurpose;
  text: string;
  factRefs: string[];
  windowId: string | null;
};

const IMPLEMENTATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bdeterministic(?:\s+(?:recommendation|score|surface|window))?\b/i, label: "deterministic plumbing" },
  { pattern: /\b(?:quality|confidence)\s+band\b/i, label: "internal band label" },
  { pattern: /\binput\s+is\s+(?:un)?available\b/i, label: "input availability plumbing" },
  { pattern: /\brequired[- ]source\s+status\b/i, label: "source-status plumbing" },
  { pattern: /\b(?:window|fact|source[- ]run)\s+(?:id|identifier|reference)\b/i, label: "internal identifier" },
  { pattern: /\b(?:input|material|generation)\s+fingerprint\b/i, label: "fingerprint plumbing" },
  { pattern: /\b(?:schema|prompt|provider|model|policy)\s+version\b/i, label: "version plumbing" },
  { pattern: /\b(?:direct_nearshore|cove_proxy|nws_fallback|modeled_uncalibrated|proxy_uncalibrated|cold_start_uncalibrated)\b/i, label: "raw enum" },
  { pattern: /\b(?:support|tradeoff|context|locked)\s+role\b/i, label: "fact-role plumbing" }
];

const FACT_DUMP_PATTERN = /\b(?:wind|tide|wave|confidence|condition|source)\s*:\s*/i;
const LEADING_TIME_PATTERN = /^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*:/i;
const SUBSTANTIVE_KINDS = new Set<ForecastFact["kind"]>([
  "condition",
  "wave",
  "wind",
  "tide",
  "confidence",
  "source",
  "hazard",
  "observation",
  "caveat"
]);

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9%°' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceSkeleton(value: string): string {
  return normalized(value)
    .replace(/\b\d+(?::\d+)?\s*(?:am|pm)?\b/g, "<time>")
    .replace(/\b(?:earlier|later|first|second|leading)\b/g, "<position>");
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function claimsFor(draft: ForecastBriefDraft): Claim[] {
  return [
    {
      path: "summary",
      purpose: "summary",
      text: draft.summary.text,
      factRefs: draft.summary.factRefs,
      windowId: null
    },
    ...draft.picks.flatMap((pick, index) => [
      {
        path: `picks[${index}].why`,
        purpose: "why" as const,
        text: pick.why.text,
        factRefs: pick.why.factRefs,
        windowId: pick.windowId
      },
      {
        path: `picks[${index}].tradeoff`,
        purpose: "tradeoff" as const,
        text: pick.tradeoff.text,
        factRefs: pick.tradeoff.factRefs,
        windowId: pick.windowId
      }
    ]),
    ...draft.bustFactors.map((factor, index) => ({
      path: `bustFactors[${index}]`,
      purpose: "bust" as const,
      text: factor.text,
      factRefs: factor.factRefs,
      windowId: null
    })),
    {
      path: "lesson.text",
      purpose: "lesson",
      text: draft.lesson.text,
      factRefs: draft.lesson.factRefs,
      windowId: null
    }
  ];
}

function applicableFacts(bundle: ForecastFactBundle, windowId: string | null): ForecastFact[] {
  const recommended = new Set(bundle.input.recommendationWindowIds);
  return bundle.facts.filter(
    (fact) =>
      fact.role !== "locked" &&
      (windowId === null
        ? fact.windowId === null || (fact.windowId !== null && recommended.has(fact.windowId))
        : fact.windowId === windowId)
  );
}

function knownFacts(factRefs: string[], byId: Map<string, ForecastFact>): ForecastFact[] {
  return factRefs.flatMap((factId) => {
    const fact = byId.get(factId);
    return fact ? [fact] : [];
  });
}

function substantiveKinds(facts: ForecastFact[]): Set<ForecastFact["kind"]> {
  return new Set(facts.filter((fact) => SUBSTANTIVE_KINDS.has(fact.kind)).map((fact) => fact.kind));
}

function sameRefs(left: string[], right: string[]): boolean {
  const sortedLeft = [...new Set(left)].sort();
  const sortedRight = [...new Set(right)].sort();
  return JSON.stringify(sortedLeft) === JSON.stringify(sortedRight);
}

export function evaluateForecastBriefQuality(
  draft: ForecastBriefDraft,
  bundle: ForecastFactBundle
): ForecastBriefQualityReport {
  const issuesByCheck: Record<ForecastBriefQualityCheck, string[]> = {
    citationRelevance: [],
    roleCoverage: [],
    evidenceDiversity: [],
    nonRepetition: [],
    noImplementationPlumbing: [],
    naturalness: []
  };
  const addIssue = (check: ForecastBriefQualityCheck, path: string, message: string): void => {
    issuesByCheck[check].push(`[${check}] ${path}: ${message}`);
  };
  const byId = new Map(bundle.facts.map((fact) => [fact.id, fact]));
  const claims = claimsFor(draft);

  for (const claim of claims) {
    const facts = knownFacts(claim.factRefs, byId);
    const unknownRefs = claim.factRefs.filter((factId) => !byId.has(factId));
    unknownRefs.forEach((factId) =>
      addIssue("citationRelevance", claim.path, `references unknown fact ${factId}`)
    );
    if (facts.length === 0) {
      addIssue("citationRelevance", claim.path, "has no known supporting fact");
      continue;
    }
    if (facts.some((fact) => fact.role === "locked")) {
      addIssue("citationRelevance", claim.path, "cites a code-owned locked fact");
    }
    if (claim.windowId !== null) {
      if (facts.some((fact) => fact.windowId !== null && fact.windowId !== claim.windowId)) {
        addIssue("citationRelevance", claim.path, "cites evidence from another forecast window");
      }
      if (!facts.some((fact) => fact.windowId === claim.windowId)) {
        addIssue("citationRelevance", claim.path, "lacks evidence for its forecast window");
      }
    }
    if (!facts.some((fact) => SUBSTANTIVE_KINDS.has(fact.kind))) {
      addIssue(
        "citationRelevance",
        claim.path,
        "uses only spot identity or recommendation rank as evidence"
      );
    }
  }

  const summaryFacts = knownFacts(draft.summary.factRefs, byId).filter((fact) => fact.role !== "locked");
  const availableSummaryFacts = applicableFacts(bundle, null);
  const availableSummaryRoles = new Set(availableSummaryFacts.map((fact) => fact.role));
  const summaryRoles = new Set(summaryFacts.map((fact) => fact.role));
  if (availableSummaryRoles.has("support") && !summaryRoles.has("support")) {
    addIssue("roleCoverage", "summary", "does not cite a supporting forecast fact");
  }
  if (availableSummaryRoles.has("tradeoff") && !summaryRoles.has("tradeoff")) {
    addIssue("roleCoverage", "summary", "does not cite a meaningful tradeoff");
  }

  for (const [index, pick] of draft.picks.entries()) {
    const available = applicableFacts(bundle, pick.windowId);
    const whyFacts = knownFacts(pick.why.factRefs, byId).filter((fact) => fact.role !== "locked");
    const tradeoffFacts = knownFacts(pick.tradeoff.factRefs, byId).filter(
      (fact) => fact.role !== "locked"
    );
    const substantiveSupport = available.filter(
      (fact) => fact.role === "support" && fact.kind !== "recommendation"
    );
    if (substantiveSupport.length > 0) {
      if (!whyFacts.some((fact) => fact.role === "support" && fact.kind !== "recommendation")) {
        addIssue("roleCoverage", `picks[${index}].why`, "does not cite substantive support");
      }
    } else if (!whyFacts.some((fact) => fact.role === "support")) {
      addIssue("roleCoverage", `picks[${index}].why`, "does not cite the available support");
    }

    const availableTradeoffs = available.filter((fact) => fact.role === "tradeoff");
    if (availableTradeoffs.length > 0) {
      if (!tradeoffFacts.some((fact) => fact.role === "tradeoff")) {
        addIssue("roleCoverage", `picks[${index}].tradeoff`, "does not cite an available tradeoff");
      }
    } else if (!tradeoffFacts.some((fact) => fact.role === "context")) {
      addIssue(
        "roleCoverage",
        `picks[${index}].tradeoff`,
        "does not cite context when no explicit tradeoff is available"
      );
    }

    const availableKinds = substantiveKinds(available);
    const citedKinds = substantiveKinds([...whyFacts, ...tradeoffFacts]);
    const requiredKinds = Math.min(2, availableKinds.size);
    if (citedKinds.size < requiredKinds) {
      addIssue(
        "evidenceDiversity",
        `picks[${index}]`,
        `uses ${citedKinds.size} forecast dimension(s); ${requiredKinds} are available`
      );
    }
    if (sameRefs(pick.why.factRefs, pick.tradeoff.factRefs) && availableKinds.size > 1) {
      addIssue(
        "evidenceDiversity",
        `picks[${index}]`,
        "uses the same evidence for the reason and tradeoff"
      );
    }
  }

  const relevantGlobalFacts = applicableFacts(bundle, null);
  const availableBustTradeoffs = relevantGlobalFacts.filter((fact) => fact.role === "tradeoff");
  for (const [index, factor] of draft.bustFactors.entries()) {
    const facts = knownFacts(factor.factRefs, byId).filter((fact) => fact.role !== "locked");
    if (availableBustTradeoffs.length > 0) {
      if (!facts.some((fact) => fact.role === "tradeoff")) {
        addIssue("roleCoverage", `bustFactors[${index}]`, "does not cite an available tradeoff");
      }
    } else if (!facts.some((fact) => fact.role === "context")) {
      addIssue(
        "roleCoverage",
        `bustFactors[${index}]`,
        "does not cite context when no explicit tradeoff is available"
      );
    }
  }

  const allKnownReferencedFacts = knownFacts(
    [...new Set(claims.flatMap((claim) => claim.factRefs))],
    byId
  ).filter((fact) => fact.role !== "locked");
  const availableKinds = substantiveKinds(relevantGlobalFacts);
  const referencedKinds = substantiveKinds(allKnownReferencedFacts);
  const requiredOverallKinds = Math.min(3, availableKinds.size);
  if (referencedKinds.size < requiredOverallKinds) {
    addIssue(
      "evidenceDiversity",
      "brief",
      `uses ${referencedKinds.size} forecast dimension(s); ${requiredOverallKinds} are available`
    );
  }

  const lessonRefs = new Set(draft.lesson.factRefs);
  const bustRefs = new Set(draft.bustFactors.flatMap((factor) => factor.factRefs));
  if (
    lessonRefs.size > 0 &&
    [...lessonRefs].every((factId) => bustRefs.has(factId)) &&
    relevantGlobalFacts.some((fact) => !bustRefs.has(fact.id) && fact.role !== "locked")
  ) {
    addIssue("evidenceDiversity", "lesson.text", "repeats the bust-factor evidence instead of teaching a distinct concept");
  }

  const normalizedClaims = new Map<string, string[]>();
  for (const claim of claims) {
    const key = normalized(claim.text);
    const paths = normalizedClaims.get(key) ?? [];
    paths.push(claim.path);
    normalizedClaims.set(key, paths);
  }
  for (const paths of normalizedClaims.values()) {
    if (paths.length > 1) {
      paths.forEach((path) =>
        addIssue("nonRepetition", path, `duplicates prose also used in ${paths.filter((other) => other !== path).join(", ")}`)
      );
    }
  }

  for (const purpose of ["why", "tradeoff"] as const) {
    const comparable = claims.filter((claim) => claim.purpose === purpose);
    const bySkeleton = new Map<string, string[]>();
    for (const claim of comparable) {
      const key = sentenceSkeleton(claim.text);
      const paths = bySkeleton.get(key) ?? [];
      paths.push(claim.path);
      bySkeleton.set(key, paths);
    }
    for (const paths of bySkeleton.values()) {
      if (paths.length > 1) {
        paths.forEach((path) =>
          addIssue("nonRepetition", path, `reuses the same ${purpose} sentence pattern across picks`)
        );
      }
    }
  }

  let exactFactCopies = 0;
  for (const claim of claims) {
    for (const { pattern, label } of IMPLEMENTATION_PATTERNS) {
      if (pattern.test(claim.text)) {
        addIssue("noImplementationPlumbing", claim.path, `contains ${label}`);
      }
    }
    if (FACT_DUMP_PATTERN.test(claim.text) || LEADING_TIME_PATTERN.test(claim.text)) {
      addIssue("naturalness", claim.path, "reads like a labeled fact dump");
    }
    const words = wordCount(claim.text);
    if (words < 5) addIssue("naturalness", claim.path, "is too fragmentary to explain the call");
    if (words > 60) addIssue("naturalness", claim.path, "is too long for a concise daily outlook");
    if ((claim.text.match(/;/g) ?? []).length > 1) {
      addIssue("naturalness", claim.path, "chains too many semicolon-delimited facts");
    }
    const copied = knownFacts(claim.factRefs, byId).some(
      (fact) => normalized(fact.statement) === normalized(claim.text)
    );
    if (copied) {
      exactFactCopies += 1;
      addIssue("naturalness", claim.path, "copies a cited fact instead of synthesizing it");
    }
  }

  const checks = Object.fromEntries(
    (Object.keys(issuesByCheck) as ForecastBriefQualityCheck[]).map((check) => [
      check,
      issuesByCheck[check].length === 0
    ])
  ) as Record<ForecastBriefQualityCheck, boolean>;
  const uniqueProse = new Set(claims.map((claim) => normalized(claim.text))).size;
  const issues = (Object.keys(issuesByCheck) as ForecastBriefQualityCheck[]).flatMap(
    (check) => issuesByCheck[check]
  );
  return {
    policyVersion: FORECAST_BRIEF_QUALITY_POLICY_VERSION,
    passed: Object.values(checks).every(Boolean),
    checks,
    issues,
    metrics: {
      proseFields: claims.length,
      referencedFacts: new Set(allKnownReferencedFacts.map((fact) => fact.id)).size,
      referencedFactKinds: referencedKinds.size,
      uniqueProseRatio: claims.length === 0 ? 1 : uniqueProse / claims.length,
      exactFactCopies
    }
  };
}
