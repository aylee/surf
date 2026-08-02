import type { ForecastFact } from "./types";

const FUNCTION_WORDS = [
  "a", "an", "and", "are", "as", "at", "be", "because", "been", "before", "both",
  "but", "by", "can", "could", "despite", "does", "during", "even", "for", "from", "has",
  "have", "here", "how", "if", "in", "into", "is", "it", "its", "may", "might", "more",
  "most", "not", "of", "on", "or", "rather", "so", "still", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "through", "to", "too", "toward", "under",
  "when", "while", "why", "with", "without", "yet", "your"
] as const;

const FORECAST_CONNECTIVES = [
  "actual", "advantage", "alternate", "appropriately", "beach", "call", "cautious", "change",
  "choice", "compare", "current", "day", "daylight", "describe", "develop", "differ", "earlier", "erase", "erode",
  "expect", "expected", "fade", "favor", "favorable", "help", "keep", "later", "lead", "leave", "likely",
  "local", "main", "make", "match", "meaningful", "meet", "miss", "option", "outlook", "possible",
  "promising", "read", "recommendation", "remain", "room", "separate", "separately", "session", "setup", "shape", "signal",
  "surface", "temper", "texture", "threat", "undercut", "uncertain", "uncertainty", "variation",
  "vulnerable", "weaken", "window", "worth"
] as const;

export const FORECAST_BRIEF_SAFE_NARRATION_WORDS = [
  ...FUNCTION_WORDS,
  ...FORECAST_CONNECTIVES
] as const;

const SAFE_WORDS = new Set<string>(FORECAST_BRIEF_SAFE_NARRATION_WORDS);

type ClaimDomain =
  | "wave"
  | "wind"
  | "surface"
  | "tide"
  | "confidence"
  | "source"
  | "recommendation";

type ClaimPolarity = "support" | "tradeoff";

type ClaimRelation = ClaimPolarity | "context";

type ClaimLicense = {
  factId: string;
  windowId: string | null;
  subject: ClaimDomain;
  relation: ClaimRelation;
  object: ClaimDomain;
};

type RelationIntent = {
  relation: ClaimRelation;
  subjects: Set<ClaimDomain>;
  objects: Set<ClaimDomain>;
};

const DOMAIN_PATTERNS: Record<ClaimDomain, RegExp> = {
  wave: /\b(?:modeled|wave|waves|swell|period)\b/i,
  wind: /\b(?:wind|winds|offshore|onshore|cross-shore)\b/i,
  surface: /\b(?:surface|conditions?|quality|texture|clean|cleaner|choppy|fair|poor|fun|good|excellent)\b/i,
  tide: /\b(?:tide|rising|falling|steady)\b/i,
  confidence: /\b(?:confidence|uncertain|uncertainty)\b/i,
  source: /\b(?:source|fresh|stale|missing|freshness)\b/i,
  recommendation: /\b(?:recommendation|window|option|daylight|leading|alternate|call)\b/i
};

const POLARITY_PATTERNS: Record<ClaimPolarity, RegExp> = {
  support:
    /\b(?:support|supports|favor|favors|strengthen|strengthens|advantage|favorable|help|helps|keep|keeps|make|makes|promising|lead|leads|leading|worth)\b/i,
  tradeoff:
    /\b(?:limit|limits|limiter|temper|tempers|threat|erode|erodes|erase|erases|weaken|weakens|undercut|vulnerable|fade|fades|uncertain|uncertainty|cautious)\b/i
};

const STATE_PATTERNS = [
  /\bclean(?:er)?\b/i,
  /\b(?:good|excellent|fun)\b/i,
  /\boffshore\b/i,
  /\bhigh confidence\b/i,
  /\bfresh\b/i,
  /\b(?:choppy|poor)\b/i,
  /\b(?:onshore|cross-shore)\b/i,
  /\b(?:low|medium) confidence\b/i,
  /\b(?:stale|missing)\b/i,
  /\b(?:uncertain|uncertainty)\b/i
] as const;

const STATE_DOMAINS: Array<{ pattern: RegExp; domain: ClaimDomain }> = [
  { pattern: /\bclean(?:er)?\b/i, domain: "surface" },
  { pattern: /\b(?:good|excellent|fun|choppy|poor)\b/i, domain: "surface" },
  { pattern: /\b(?:offshore|onshore|cross-shore)\b/i, domain: "wind" },
  { pattern: /\b(?:low|medium|high) confidence\b/i, domain: "confidence" },
  { pattern: /\b(?:uncertain|uncertainty)\b/i, domain: "confidence" },
  { pattern: /\b(?:fresh|stale|missing)\b/i, domain: "source" }
];

const DIRECTED_RELATION_PATTERN =
  /\b(?:support(?:s|ed)?|favor(?:s|ed)?|strengthen(?:s|ed)?|help(?:s|ed)?|keep(?:s|ing)?|make(?:s|ing)?|lead(?:s|ing)?|leave(?:s|ing)?|limit(?:s|ed|ing)?|temper(?:s|ed|ing)?|threaten(?:s|ed|ing)?|erode(?:s|d|ing)?|erase(?:s|d|ing)?|weaken(?:s|ed|ing)?|undercut(?:s|ting)?|fade(?:s|d|ing)?|miss(?:es|ed|ing)?|match(?:es|ed|ing)?|shape(?:s|d|ing)?|describe(?:s|d|ing)?|meet(?:s|ing)?)\b/i;

const SUPPORT_VERB_PATTERN =
  /^(?:support|supports|supported|favor|favors|favored|strengthen|strengthens|strengthened|help|helps|helped|lead|leads|leading)$/i;
const TRADEOFF_VERB_PATTERN =
  /^(?:limit|limits|limited|limiting|temper|tempers|tempered|tempering|threaten|threatens|threatened|threatening|erode|erodes|eroded|eroding|erase|erases|erased|erasing|weaken|weakens|weakened|weakening|undercut|undercuts|undercutting|fade|fades|faded|fading|miss|misses|missed|missing)$/i;
const CONTEXT_VERB_PATTERN =
  /^(?:shape|shapes|shaped|shaping|describe|describes|described|describing|meet|meets|meeting)$/i;
const POSITIVE_OUTCOME_PATTERN =
  /\b(?:advantage|favorable|help|leading|promising|strength|worth|cleaner|clean|good|excellent|fun)\b/i;
const LIMITING_OUTCOME_PATTERN =
  /\b(?:cautious|differ|limiter|miss|poor|choppy|temper|threat|uncertain|uncertainty|vulnerable|weaken|undercut|erode|erase|fade)\b/i;
const PASSIVE_BY_PATTERN = /^\s+by\b/i;
const CONDITIONAL_CAUSE_PATTERN = /\b(?:if|when)\b/i;

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
}

function variants(value: string): string[] {
  const forms = new Set([value]);
  if (value === "uncertain") forms.add("uncertainty");
  if (value === "uncertainty") forms.add("uncertain");
  if (value.endsWith("ies") && value.length > 4) forms.add(`${value.slice(0, -3)}y`);
  if (value.endsWith("s") && !value.endsWith("ss") && value.length > 3) {
    forms.add(value.slice(0, -1));
  }
  for (const suffix of ["ing", "ed", "er", "ly"] as const) {
    if (value.endsWith(suffix) && value.length > suffix.length + 2) {
      const base = value.slice(0, -suffix.length);
      forms.add(base);
      if (suffix === "ing" || suffix === "ed") forms.add(`${base}e`);
    }
  }
  return [...forms];
}

function vocabulary(values: string[]): Set<string> {
  return new Set(values.flatMap(tokens).flatMap(variants));
}

function domains(value: string): Set<ClaimDomain> {
  return new Set(
    (Object.entries(DOMAIN_PATTERNS) as Array<[ClaimDomain, RegExp]>).flatMap(
      ([domain, pattern]) => (pattern.test(value) ? [domain] : [])
    )
  );
}

function splitCompoundRelations(clause: string): string[] {
  for (const match of clause.matchAll(/\s+(?:,\s*)?and\s+/gi)) {
    if (match.index === undefined) continue;
    const left = clause.slice(0, match.index).trim();
    const right = clause.slice(match.index + match[0].length).trim();
    // Split only compound predicates. In "clean surface and offshore wind
    // make..." the left side has no relation and must remain a coordinated
    // subject. In "wind supports... and weakens..." both halves make claims
    // and each must earn its own license.
    if (DIRECTED_RELATION_PATTERN.test(left) && DIRECTED_RELATION_PATTERN.test(right)) {
      return [...splitCompoundRelations(left), ...splitCompoundRelations(right)];
    }
  }
  return [clause];
}

function semanticClauses(value: string): string[] {
  return value
    .split(/(?:[.;!?]+|,\s*(?:while|but|yet)\s+|\bwhile\b|\bwhereas\b|\bseparately from\b)/i)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .flatMap(splitCompoundRelations);
}

function factCoversDomains(fact: ForecastFact, required: Set<ClaimDomain>): boolean {
  const licensed = domains(fact.statement);
  return [...required].every((domain) => licensed.has(domain));
}

function stateTerms(value: string, domain?: ClaimDomain): string[] {
  return STATE_PATTERNS.flatMap((pattern) => {
    const state = value.match(pattern)?.[0].toLowerCase();
    if (!state) return [];
    if (domain && !STATE_DOMAINS.some((entry) => entry.domain === domain && entry.pattern.test(state))) {
      return [];
    }
    return [state];
  });
}

function factCoversStates(fact: ForecastFact, requiredStates: string[]): boolean {
  const evidence = vocabulary([fact.statement]);
  return requiredStates.every((state) =>
    tokens(state).every((token) => variants(token).some((variant) => evidence.has(variant)))
  );
}

function factSourceDomain(fact: ForecastFact): ClaimDomain | null {
  switch (fact.kind) {
    case "condition":
      return "surface";
    case "wave":
      return "wave";
    case "wind":
      return "wind";
    case "tide":
      return "tide";
    case "confidence":
      return "confidence";
    case "source":
      return "source";
    default:
      return null;
  }
}

function licensesForFact(fact: ForecastFact): ClaimLicense[] {
  const licenses: ClaimLicense[] = [];
  const add = (subject: ClaimDomain, relation: ClaimRelation, object: ClaimDomain) => {
    licenses.push({ factId: fact.id, windowId: fact.windowId, subject, relation, object });
  };
  const source = factSourceDomain(fact);
  if (source) {
    // Any source fact can describe its own relationship to the recommendation.
    // Evaluative support/tradeoff requires the deterministic fact role below.
    add(source, "context", "recommendation");
    if (source === "wind") add("wind", "context", "surface");
    if (fact.role === "support" || fact.role === "tradeoff") {
      add(source, fact.role, "recommendation");
      if (source === "wind") add("wind", fact.role, "surface");
      if (source === "source") add("source", fact.role, "confidence");
    }
  }

  if (fact.kind === "caveat" && fact.role !== "locked") {
    const factDomains = domains(fact.statement);
    const relation: ClaimRelation = fact.role === "tradeoff" ? "tradeoff" : "context";
    if (
      factDomains.has("wind") &&
      factDomains.has("surface") &&
      /\b(?:wind shift|shifting wind|wind change)\b/i.test(fact.statement)
    ) {
      add("wind", relation, "surface");
      add("wind", relation, "recommendation");
    } else if (factDomains.size === 1) {
      const subject = [...factDomains][0]!;
      if (subject !== "recommendation") add(subject, relation, "recommendation");
    }
  }
  return licenses;
}

function factorDomains(value: string): Set<ClaimDomain> {
  const result = domains(value);
  result.delete("recommendation");
  return result;
}

function relationForVerb(verb: string, remainder: string): ClaimRelation | null {
  if (/^help/i.test(verb) && /^\s+describe\b/i.test(remainder)) return "context";
  if (SUPPORT_VERB_PATTERN.test(verb)) return "support";
  if (TRADEOFF_VERB_PATTERN.test(verb)) return "tradeoff";
  if (CONTEXT_VERB_PATTERN.test(verb)) return "context";
  if (/^match/i.test(verb)) {
    return /\b(?:not|may|might|could)\b/i.test(remainder) ? "tradeoff" : "context";
  }
  if (/^leave/i.test(verb)) {
    return /\b(?:room|differ|miss|cautious|uncertain|uncertainty|vulnerable)\b/i.test(remainder)
      ? "tradeoff"
      : null;
  }
  if (/^(?:keep|keeps|keeping|make|makes|making)$/i.test(verb)) {
    if (LIMITING_OUTCOME_PATTERN.test(remainder)) return "tradeoff";
    if (POSITIVE_OUTCOME_PATTERN.test(remainder)) return "support";
    return null;
  }
  return null;
}

function relationIntents(clause: string): { intents: RelationIntent[]; ambiguous: boolean } {
  const match = DIRECTED_RELATION_PATTERN.exec(clause);
  if (match && match.index !== undefined) {
    const verb = match[0];
    const before = clause.slice(0, match.index);
    const after = clause.slice(match.index + verb.length);
    const negated =
      /\b(?:not|never)\b[^.!?]{0,24}$/i.test(before) ||
      /^\s*(?:not|never)\b/i.test(after);
    if (negated && !/^match/i.test(verb)) {
      return { intents: [], ambiguous: true };
    }
    const relation = negated && /^match/i.test(verb) ? "tradeoff" : relationForVerb(verb, after);
    if (!relation) return { intents: [], ambiguous: true };

    const passive = /(?:ed|d)$/i.test(verb) && PASSIVE_BY_PATTERN.test(after);
    const conditionalCause =
      relation === "tradeoff" && CONDITIONAL_CAUSE_PATTERN.test(after);
    const subjects = passive
      ? factorDomains(after.replace(PASSIVE_BY_PATTERN, ""))
      : conditionalCause
        ? factorDomains(after.split(CONDITIONAL_CAUSE_PATTERN).slice(1).join(" "))
        : factorDomains(before);
    const objects = passive
      ? domains(before)
      : conditionalCause
        ? domains(before)
        : domains(after);
    if (objects.size > 1) {
      for (const subject of subjects) objects.delete(subject);
    }
    if (objects.size === 0) objects.add("recommendation");
    return {
      intents: [{ relation, subjects, objects }],
      ambiguous: subjects.size === 0
    };
  }

  const clauseDomains = factorDomains(clause);
  const hasRecommendation = domains(clause).has("recommendation");
  const positive = POSITIVE_OUTCOME_PATTERN.test(clause);
  const limiting = LIMITING_OUTCOME_PATTERN.test(clause);
  if (clauseDomains.size > 0 && hasRecommendation && (positive || limiting)) {
    if (positive && limiting) return { intents: [], ambiguous: true };
    return {
      intents: [
        {
          relation: limiting ? "tradeoff" : "support",
          subjects: clauseDomains,
          objects: new Set<ClaimDomain>(["recommendation"])
        }
      ],
      ambiguous: false
    };
  }
  return { intents: [], ambiguous: false };
}

function statesForDomain(value: string, domain: ClaimDomain): string[] {
  return stateTerms(value, domain);
}

function licenseCoversIntent(
  license: ClaimLicense,
  intent: RelationIntent,
  clause: string,
  fact: ForecastFact
): boolean {
  if (license.relation !== intent.relation || !intent.subjects.has(license.subject)) return false;
  if (![...intent.objects].some((object) => license.object === object)) return false;
  const requiredStates = [
    ...statesForDomain(clause, license.subject),
    ...(license.object === "recommendation" ? [] : statesForDomain(clause, license.object))
  ];
  return factCoversStates(fact, requiredStates);
}

function intentIsLicensed(
  intent: RelationIntent,
  clause: string,
  citedFacts: ForecastFact[]
): boolean {
  const licenses = citedFacts.flatMap(licensesForFact);
  return [...intent.subjects].every((subject) =>
    [...intent.objects].every((object) => {
      const narrowed: RelationIntent = {
        ...intent,
        subjects: new Set([subject]),
        objects: new Set([object])
      };
      return licenses.some((license) => {
        const fact = citedFacts.find((candidate) => candidate.id === license.factId);
        return fact ? licenseCoversIntent(license, narrowed, clause, fact) : false;
      });
    })
  );
}

/**
 * A deterministic ClaimLicense boundary for natural model prose.
 *
 * Vocabulary membership alone is insufficient: true words from two facts can
 * be recombined into a false causal sentence. Each semantic clause must stay
 * within the domains of at least one cited fact. Relation-bearing clauses also
 * need one cited fact whose role, domains, and explicit state terms license the
 * asserted polarity.
 */
export function unsupportedForecastBriefRelations(
  prose: string,
  citedFacts: ForecastFact[]
): string[] {
  const issues: string[] = [];
  for (const clause of semanticClauses(prose)) {
    const clauseDomains = domains(clause);
    clauseDomains.delete("recommendation");
    if (
      clauseDomains.size > 1 &&
      !citedFacts.some((fact) => factCoversDomains(fact, clauseDomains))
    ) {
      issues.push("combines forecast domains without a cited relationship");
    }

    // Copular identity across forecast domains is never licensed. Facts may
    // describe a relationship, but wind is not wave state and surface is not
    // wind merely because both appear in true evidence.
    const copula = /\b(?:is|are|be|been)\b/i.exec(clause);
    if (copula?.index !== undefined) {
      const left = factorDomains(clause.slice(0, copula.index));
      const right = factorDomains(clause.slice(copula.index + copula[0].length));
      if (left.size > 0 && right.size > 0 && [...left].some((domain) => !right.has(domain))) {
        issues.push("asserts unlicensed identity relation");
      }
    }

    const parsed = relationIntents(clause);
    if (parsed.ambiguous) issues.push("uses an ambiguous forecast relation");
    for (const intent of parsed.intents) {
      if (!intentIsLicensed(intent, clause, citedFacts)) {
        issues.push(`asserts unlicensed ${intent.relation} relation`);
      }
    }

    // The directional parser owns any explicit relation. Do not reinterpret
    // incidental words such as "advantage" inside "could fade" as a second,
    // opposite-polarity claim.
    if (parsed.intents.length > 0 || parsed.ambiguous) continue;

    for (const [polarity, pattern] of Object.entries(POLARITY_PATTERNS) as Array<
      [ClaimPolarity, RegExp]
    >) {
      if (!pattern.test(clause)) continue;
      if (parsed.intents.some((intent) => intent.relation === polarity)) continue;
      const requiredStates = stateTerms(clause);
      const licensed = citedFacts.some(
        (fact) =>
          fact.role === polarity &&
          factCoversDomains(fact, clauseDomains) &&
          factCoversStates(fact, requiredStates)
      );
      if (!licensed) issues.push(`asserts unlicensed ${polarity} relation`);
    }
  }
  return [...new Set(issues)];
}

export function unsupportedForecastBriefWords(
  prose: string,
  evidenceStatements: string[]
): string[] {
  const evidence = vocabulary(evidenceStatements);
  return [
    ...new Set(
      tokens(prose).filter(
        (token) =>
          !variants(token).some((variant) => SAFE_WORDS.has(variant) || evidence.has(variant))
      )
    )
  ].sort();
}
