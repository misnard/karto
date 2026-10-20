/** Grouped LLM choice among the candidates that pass the hard filters. Pure: no I/O. */
import type { BasketItem, Preferences, ProductOffer } from '@karto/contracts';
import type { ItemPatch } from '../db/baskets.ts';
import type { GivenLine, PickCandidate, PickLine, PickOutput } from '../llm/prompts/pick.ts';
import { hardFilters, type Need, packsNeeded } from './rank.ts';

/** Candidates per line shown to the LLM. */
const PICK_CANDIDATES = 6;
const MAX_ALTERNATIVES = 3;
const MAX_REASON = 80;

export type PickableItem = Pick<BasketItem, 'id' | 'label' | 'quantity' | 'unit' | 'candidates'> & {
  excludeTerms: string[];
};

function toCandidate(offer: ProductOffer, need: Need): PickCandidate {
  const packs = packsNeeded(need, offer.pack, offer.maxQuantity);
  return {
    ref: offer.ref,
    name: offer.name,
    brand: offer.brand,
    pack: offer.pack,
    priceCents: offer.priceCents,
    unitPrice: offer.unitPrice,
    packs,
    totalCents: offer.priceCents === undefined ? undefined : offer.priceCents * packs,
    organic: offer.isOrganic || undefined,
    privateLabel: offer.isPrivateLabel || undefined,
    nutriscore: offer.nutriscore,
  };
}

/** The items worth an LLM choice (at least 2 candidates pass the hard filters), with their first 6 such candidates. */
export function pickLines(items: PickableItem[], preferences: Preferences): PickLine[] {
  return items.flatMap((item) => {
    const { pool } = hardFilters(item.candidates, item.excludeTerms, preferences);
    if (pool.length < 2) return [];
    const need = { quantity: item.quantity, unit: item.unit };
    const candidates = pool.slice(0, PICK_CANDIDATES).map((offer) => toCandidate(offer, need));
    return [{ itemId: item.id, label: item.label, need, candidates }];
  });
}

/** `first` refs in that order, then the other candidates in theirs: the UI shows the first ones as alternatives. */
export function orderCandidates(candidates: ProductOffer[], first: string[]): ProductOffer[] {
  const position = (offer: ProductOffer) => {
    const index = first.indexOf(offer.ref);
    return index === -1 ? first.length : index;
  };
  return [...candidates].sort((a, b) => position(a) - position(b));
}

/**
 * Item patches for a pick output, or why it is unusable: an itemId or a ref the LLM was not given. Lines it leaves
 * out keep the rules' choice. A null ref means no candidate fits: unmatched, the candidates stay for the user.
 */
export function applyPick(
  given: GivenLine[],
  output: PickOutput,
  items: BasketItem[],
): { itemId: string; patch: ItemPatch }[] | string {
  const refsByItem = new Map(given.map((line) => [line.itemId, new Set(line.candidates.map((c) => c.ref))]));
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const patches: { itemId: string; patch: ItemPatch }[] = [];
  for (const pick of output.picks) {
    const refs = refsByItem.get(pick.itemId);
    if (!refs) return `Pick for an item it was not given: ${pick.itemId}`;
    const chosen = pick.ref === null ? [] : [pick.ref];
    const unknown = [...chosen, ...pick.alternatives].find((ref) => !refs.has(ref));
    if (unknown !== undefined) return `Pick ref ${unknown} is not a candidate of item ${pick.itemId}`;

    const item = itemsById.get(pick.itemId);
    const offer = item?.candidates.find((candidate) => candidate.ref === pick.ref);
    if (!item || item.status === 'removed' || (pick.ref !== null && !offer)) continue;
    const alternatives = [...new Set(pick.alternatives)].filter((ref) => ref !== pick.ref).slice(0, MAX_ALTERNATIVES);
    const common = {
      candidates: JSON.stringify(orderCandidates(item.candidates, [...chosen, ...alternatives])),
      reason: pick.reason.slice(0, MAX_REASON),
      reason_source: 'llm',
    } as const;
    patches.push({
      itemId: item.id,
      patch: offer
        ? {
            status: 'proposed',
            product_ref: offer.ref,
            packs: packsNeeded(item, offer.pack, offer.maxQuantity),
            ...common,
          }
        : { status: 'unmatched', product_ref: null, packs: null, ...common },
    });
  }
  return patches;
}
