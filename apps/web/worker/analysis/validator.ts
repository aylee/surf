import {
  SurfAnalysisPlanV5Schema,
  SurfAnalysisValidationSchema,
  type SurfAnalysisCardPlacement,
  type SurfAnalysisEditorialCard,
  type SurfAnalysisPlanV5,
  type SurfAnalysisValidation,
  type SurfAnalysisValidationSnapshot,
  type SurfAnalysisValueSlot
} from "./types";
import type { ForecastFact } from "../brief/types";

const SLOT_PATTERN = /\{\{([a-z][a-z_]*)\}\}/g;

function renderTemplate(
  template: string,
  slots: Map<string, SurfAnalysisValueSlot>
): string {
  const rendered = template.replace(SLOT_PATTERN, (_token, id: string) => {
    const value = slots.get(id)?.value;
    if (!value) throw new Error(`Analysis card references unknown value slot ${id}`);
    return value;
  });
  if (/[{}]/.test(rendered)) throw new Error("Analysis card contains a malformed value slot");
  return rendered.replace(/\s+/g, " ").trim();
}

function slotIds(template: string): string[] {
  return [...template.matchAll(SLOT_PATTERN)].map((match) => match[1]!);
}

function assertCardFactAllowed(options: {
  card: SurfAnalysisEditorialCard;
  fact: ForecastFact;
  slots: Map<string, SurfAnalysisValueSlot>;
  primaryId: string;
  backupId: string | undefined;
}): void {
  const { card, fact, slots, primaryId, backupId } = options;
  const fail = (): never => {
    throw new Error(`Analysis card ${card.id} has provenance outside its placement`);
  };

  if (card.placement === "outlook") {
    if (fact.windowId === null) fail();
    const matchesDomain =
      (fact.kind === "wave" && card.domains.includes("wave")) ||
      (fact.kind === "condition" && card.domains.includes("surface")) ||
      (fact.kind === "wind" && card.domains.includes("wind"));
    if (!matchesDomain) fail();
    return;
  }

  if (card.placement === "primary_support") {
    if (fact.windowId !== primaryId) fail();
    if (card.semanticKey === "primary:surface") {
      if (
        fact.kind !== "condition" ||
        slots.get("primary_surface_condition")?.value !== "clean"
      ) fail();
      return;
    }
    if (card.semanticKey === "primary:wind") {
      if (fact.kind !== "wind" || fact.role !== "support") fail();
      return;
    }
    if (card.semanticKey === "primary:ranking") {
      if (fact.kind !== "recommendation" || fact.role !== "support") fail();
      return;
    }
    fail();
  }

  if (card.placement === "primary_tradeoff") {
    if (fact.windowId !== primaryId) fail();
    if (card.semanticKey === "primary:surface") {
      if (
        fact.kind !== "condition" ||
        slots.get("primary_surface_condition")?.value !== "choppy"
      ) fail();
      return;
    }
    if (card.semanticKey === "primary:wind") {
      if (fact.kind !== "wind" || fact.role !== "tradeoff") fail();
      return;
    }
    fail();
  }

  if (card.placement === "alternate") {
    if (
      fact.windowId === backupId &&
      ["recommendation", "wave", "wind", "condition"].includes(fact.kind)
    ) return;
    if (
      fact.windowId === primaryId &&
      ((card.id === "alternate:size-contrast" && fact.kind === "wave") ||
        (card.id === "alternate:surface-contrast" && fact.kind === "condition"))
    ) return;
    fail();
  }

  if (fact.id === "uncertainty:modeled_breaking_calibration") return;
  if (
    fact.windowId === primaryId &&
    fact.role === "tradeoff" &&
    (fact.kind === "source" || fact.kind === "caveat")
  ) return;
  fail();
}

function assertSlotFactAllowed(options: {
  slot: SurfAnalysisValueSlot;
  fact: ForecastFact;
  primaryId: string;
  backupId: string | undefined;
}): void {
  const { slot, fact, primaryId, backupId } = options;
  const fail = (): never => {
    throw new Error(`Analysis slot ${slot.id} has provenance outside its rendered frame`);
  };
  if (slot.id === "headline_call") {
    if (
      (fact.kind === "spot" && fact.windowId === null) ||
      (fact.kind === "recommendation" && fact.windowId === primaryId)
    ) return;
    fail();
  }
  if (slot.id === "day_surf_evolution" || slot.id === "day_swell_evolution") {
    if (fact.kind === "wave" && fact.windowId !== null) return;
    fail();
  }
  if (slot.id === "day_surface_evolution") {
    if ((fact.kind === "condition" || fact.kind === "wind") && fact.windowId !== null) return;
    fail();
  }
  if (slot.id === "confidence_sentence") {
    if (fact.kind === "confidence" && fact.windowId === primaryId) return;
    fail();
  }
  if (slot.id === "primary_tide_sentence") {
    if (fact.kind === "tide" && (fact.windowId === primaryId || fact.windowId === null)) return;
    fail();
  }

  const isPrimary = slot.id.startsWith("primary_");
  const isBackup = slot.id.startsWith("backup_");
  const windowId = isPrimary ? primaryId : isBackup ? backupId : undefined;
  if (!windowId || fact.windowId !== windowId) fail();
  if (slot.id.endsWith("_session") && fact.kind === "recommendation") return;
  if (
    (slot.id.endsWith("_surf_size") || slot.id.endsWith("_swell")) &&
    fact.kind === "wave"
  ) return;
  if (
    slot.id.endsWith("_wind_surface") &&
    (fact.kind === "wind" || fact.kind === "condition")
  ) return;
  if (slot.id.endsWith("_surface_condition") && fact.kind === "condition") return;
  fail();
}

function validateCatalog(snapshot: SurfAnalysisValidationSnapshot): {
  cards: Map<string, SurfAnalysisEditorialCard>;
  slots: Map<string, SurfAnalysisValueSlot>;
} {
  const facts = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
  if (facts.size !== snapshot.facts.length) throw new Error("Analysis snapshot repeats a fact ID");
  const slots = new Map<string, SurfAnalysisValueSlot>();
  const primaryId = snapshot.recommendationWindowIds[0]!;
  const backupId = snapshot.recommendationWindowIds[1];
  for (const candidate of snapshot.slots) {
    if (slots.has(candidate.id)) throw new Error(`Analysis snapshot repeats slot ${candidate.id}`);
    slots.set(candidate.id, candidate);
    for (const factRef of candidate.factRefs) {
      const fact = facts.get(factRef);
      if (!fact) {
        throw new Error(`Analysis slot ${candidate.id} references unknown fact ${factRef}`);
      }
      assertSlotFactAllowed({ slot: candidate, fact, primaryId, backupId });
    }
  }

  const cards = new Map<string, SurfAnalysisEditorialCard>();
  const confidenceSlot = slots.get("confidence_sentence");
  const confidenceFact =
    confidenceSlot?.factRefs.length === 1
      ? facts.get(confidenceSlot.factRefs[0]!)
      : undefined;
  if (
    !confidenceSlot ||
    confidenceFact?.kind !== "confidence" ||
    confidenceFact.windowId !== primaryId
  ) {
    throw new Error("Analysis confidence sentence lacks exact primary confidence provenance");
  }
  const confidenceBand = confidenceFact.statement.match(/\b(low|medium|high)\b/i)?.[1]?.toLowerCase();
  if (
    !confidenceBand ||
    confidenceSlot.value !== `Confidence in this timing call is ${confidenceBand}.`
  ) {
    throw new Error("Analysis confidence sentence does not match its primary confidence fact");
  }
  for (const candidate of snapshot.cards) {
    if (cards.has(candidate.id)) throw new Error(`Analysis snapshot repeats card ${candidate.id}`);
    cards.set(candidate.id, candidate);
    if (renderTemplate(candidate.template, slots) !== candidate.preview) {
      throw new Error(`Analysis card ${candidate.id} preview does not match its code template`);
    }
    const templateSlots = slotIds(candidate.template).map((id) => {
      const referenced = slots.get(id);
      if (!referenced) throw new Error(`Analysis card ${candidate.id} references unknown slot ${id}`);
      return referenced;
    });
    const allowedClaims =
      candidate.placement === "outlook"
        ? new Set(["outlook_wave", "outlook_surface"])
        : candidate.placement === "alternate"
          ? new Set(["alternate"])
          : candidate.placement === "watch"
            ? new Set(["confidence"])
            : new Set(["primary"]);
    for (const referenced of templateSlots) {
      if (!allowedClaims.has(referenced.claim)) {
        throw new Error(`Analysis card ${candidate.id} references a slot outside its placement`);
      }
      for (const factRef of referenced.factRefs) {
        if (!candidate.factRefs.includes(factRef)) {
          throw new Error(`Analysis card ${candidate.id} omits provenance for slot ${referenced.id}`);
        }
      }
    }
    for (const factRef of candidate.factRefs) {
      const fact = facts.get(factRef);
      if (!fact) {
        throw new Error(`Analysis card ${candidate.id} references unknown fact ${factRef}`);
      }
      assertCardFactAllowed({ card: candidate, fact, slots, primaryId, backupId });
    }
    if (candidate.placement === "primary_support") {
      if (candidate.stance !== "support" || candidate.windowId !== primaryId) {
        throw new Error(`Analysis primary support card ${candidate.id} has invalid framing`);
      }
    } else if (candidate.placement === "primary_tradeoff") {
      if (candidate.stance !== "tradeoff" || candidate.windowId !== primaryId) {
        throw new Error(`Analysis primary tradeoff card ${candidate.id} has invalid framing`);
      }
    } else if (candidate.placement === "alternate") {
      if (!backupId || candidate.windowId !== backupId) {
        throw new Error(`Analysis alternate card ${candidate.id} is not tied to the backup`);
      }
    } else if (candidate.placement === "watch") {
      if (candidate.stance !== "tradeoff") {
        throw new Error(`Analysis watch card ${candidate.id} is not a tradeoff`);
      }
      if (candidate.windowId !== null && candidate.windowId !== primaryId) {
        throw new Error(`Analysis watch card ${candidate.id} is not tied to the primary call`);
      }
    } else if (candidate.stance !== "context" || candidate.windowId !== null) {
      throw new Error(`Analysis outlook card ${candidate.id} has invalid framing`);
    }
  }
  return { cards, slots };
}

function selectCard(options: {
  id: string;
  placement: SurfAnalysisCardPlacement;
  cards: Map<string, SurfAnalysisEditorialCard>;
  usedIds: Set<string>;
  semanticKeys: Set<string>;
}): SurfAnalysisEditorialCard {
  const card = options.cards.get(options.id);
  if (!card) throw new Error(`Analysis selected unknown card ${options.id}`);
  if (card.placement !== options.placement) {
    throw new Error(`Analysis card ${options.id} belongs in ${card.placement}`);
  }
  if (options.usedIds.has(card.id)) throw new Error(`Analysis repeats card ${card.id}`);
  if (options.semanticKeys.has(card.semanticKey)) {
    throw new Error(`Analysis repeats semantic point ${card.semanticKey}`);
  }
  options.usedIds.add(card.id);
  options.semanticKeys.add(card.semanticKey);
  return card;
}

export function validateSurfAnalysisDraft(
  value: unknown,
  snapshot: SurfAnalysisValidationSnapshot,
  now = new Date()
): { draft: SurfAnalysisPlanV5; validation: SurfAnalysisValidation } {
  const draft = SurfAnalysisPlanV5Schema.parse(value);
  const { cards, slots } = validateCatalog(snapshot);
  const usedIds = new Set<string>();
  const semanticKeys = new Set<string>();
  const selected: Array<{ path: string; card: SurfAnalysisEditorialCard }> = [];
  const add = (path: string, id: string, placement: SurfAnalysisCardPlacement) => {
    const card = selectCard({ id, placement, cards, usedIds, semanticKeys });
    selected.push({ path, card });
    return card;
  };

  const outlookLead = add("outlook.leadCardId", draft.outlook.leadCardId, "outlook");
  const outlookSupporting = add(
    "outlook.supportingCardId",
    draft.outlook.supportingCardId,
    "outlook"
  );
  const outlookDomains = new Set([
    ...outlookLead.domains,
    ...outlookSupporting.domains
  ]);
  if (
    !outlookDomains.has("wave") ||
    (!outlookDomains.has("surface") && !outlookDomains.has("wind"))
  ) {
    throw new Error("Analysis outlook must cover wave plus surface or wind context");
  }

  const supportCards = snapshot.cards.filter(
    ({ placement }) => placement === "primary_support"
  );
  if (supportCards.length > 0 && draft.call.primarySupportCardId === null) {
    throw new Error("Analysis omitted the required primary support selection");
  }
  if (draft.call.primarySupportCardId !== null) {
    add("call.primarySupportCardId", draft.call.primarySupportCardId, "primary_support");
  }

  const tradeoffCards = snapshot.cards.filter(
    ({ placement }) => placement === "primary_tradeoff"
  );
  if (tradeoffCards.length > 0 && draft.call.primaryTradeoffCardId === null) {
    throw new Error("Analysis omitted the required primary tradeoff selection");
  }
  if (tradeoffCards.length === 0 && draft.call.primaryTradeoffCardId !== null) {
    throw new Error("Analysis invented a primary tradeoff selection");
  }
  if (draft.call.primaryTradeoffCardId !== null) {
    add("call.primaryTradeoffCardId", draft.call.primaryTradeoffCardId, "primary_tradeoff");
  }

  if (snapshot.callMode === "primary_only" && draft.call.alternateCardId !== null) {
    throw new Error("Analysis invented an alternate when no backup recommendation exists");
  }
  if (draft.call.alternateCardId !== null) {
    add("call.alternateCardId", draft.call.alternateCardId, "alternate");
  }

  add("close.watchCardId", draft.close.watchCardId, "watch");

  const renderedSlotIds = new Set([
    "headline_call",
    "primary_session",
    "primary_surf_size",
    "primary_swell",
    "primary_wind_surface",
    "confidence_sentence"
  ]);
  if (slots.has("primary_tide_sentence")) renderedSlotIds.add("primary_tide_sentence");
  for (const { card } of selected) {
    slotIds(card.template).forEach((id) => renderedSlotIds.add(id));
  }
  for (const id of renderedSlotIds) {
    if (!slots.has(id)) throw new Error(`Analysis is missing rendered value slot ${id}`);
  }
  const frameClaimRefs = snapshot.slots
    .filter(({ id }) => renderedSlotIds.has(id))
    .map((candidate) => ({
      path: `codeOwned.${candidate.id}`,
      factRefs: [...candidate.factRefs]
    }));
  const selectedClaimRefs = selected.map(({ path, card }) => ({
    path,
    factRefs: [...card.factRefs]
  }));
  const claimRefs = [...frameClaimRefs, ...selectedClaimRefs];
  const referencedFactIds = [...new Set(claimRefs.flatMap(({ factRefs }) => factRefs))].sort();

  return {
    draft,
    validation: SurfAnalysisValidationSchema.parse({
      valid: true,
      checkedAt: now.toISOString(),
      referencedFactIds,
      usedCardIds: [...usedIds].sort(),
      claimRefs
    })
  };
}
