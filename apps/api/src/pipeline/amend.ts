/** Changes to an existing basket: per-line edits and free-text amends. Pure: no I/O. */
import type { BasketItem, PatchItemRequest, Preferences, Unit } from '@karto/contracts';
import type { ItemPatch } from '../db/baskets.ts';
import { AppError } from '../errors.ts';
import type { AmendOutput } from '../llm/prompts/amend.ts';
import { type AggregatedLine, aggregate } from './aggregate.ts';
import { packsNeeded, rank } from './rank.ts';

export type AmendableItem = BasketItem & { excludeTerms: string[] };

export interface AmendPlan {
  patches: { itemId: string; patch: ItemPatch }[];
  /** New lines, to search. */
  additions: AggregatedLine[];
}

/** One PATCH /items/:itemId op. Throws 400 or 409 when it does not apply to this item. */
export function editItem(item: BasketItem, op: PatchItemRequest): ItemPatch {
  switch (op.op) {
    case 'remove':
      return { status: 'removed', reason: 'Retiré', reason_source: 'user' };
    case 'restore':
      if (item.status !== 'removed') throw new AppError('conflict', 409, 'Item is not removed');
      return {
        status: item.productRef ? 'proposed' : 'unmatched',
        reason: 'Remis dans le panier',
        reason_source: 'user',
      };
    case 'packs': {
      if (item.status !== 'proposed' || !item.productRef) throw new AppError('conflict', 409, 'Item has no product');
      const max = item.candidates.find((offer) => offer.ref === item.productRef)?.maxQuantity;
      if (max && op.packs > max) throw new AppError('invalid_request', 400, `At most ${max} for this product`);
      return { packs: op.packs };
    }
    case 'choose': {
      if (item.status === 'removed') throw new AppError('conflict', 409, 'Item is removed');
      const offer = item.candidates.find((candidate) => candidate.ref === op.ref);
      if (!offer) throw new AppError('invalid_request', 400, 'Not a candidate of this item');
      return {
        status: 'proposed',
        product_ref: offer.ref,
        packs: packsNeeded(item, offer.pack, offer.maxQuantity),
        reason: 'Ton choix',
        reason_source: 'user',
      };
    }
  }
}

/**
 * New need for an item, among its current candidates (no new search): a product chosen by the user, the LLM or the
 * memory is kept and only its packs change; a rules' choice is ranked again.
 */
function resize(item: AmendableItem, quantity: number, unit: Unit, preferences: Preferences): ItemPatch {
  const need = { quantity, unit };
  const chosen = item.candidates.find((offer) => offer.ref === item.productRef);
  if (item.reasonSource !== 'rules' && chosen) {
    return { quantity, unit, packs: packsNeeded(need, chosen.pack, chosen.maxQuantity) };
  }
  const ranked = rank(item.candidates, need, item.excludeTerms, preferences);
  const reason = { reason: ranked.reason, reason_source: 'rules' as const };
  return ranked.ref === null
    ? { quantity, unit, status: 'unmatched', product_ref: null, packs: null, ...reason }
    : { quantity, unit, status: 'proposed', product_ref: ranked.ref, packs: ranked.packs, ...reason };
}

/**
 * What an amend output changes. Unknown or removed itemIds are ignored. Added lines are aggregated, then merged
 * into a live item with the same key and unit (quantities summed); the others are new items.
 */
export function planAmend(items: AmendableItem[], output: AmendOutput, preferences: Preferences): AmendPlan {
  const live = new Map(items.filter((item) => item.status !== 'removed').map((item) => [item.id, item]));
  const patches = new Map<string, ItemPatch>();
  for (const { itemId, why } of output.remove) {
    if (!live.has(itemId)) continue;
    const reason = why === 'have_it' ? 'Déjà à la maison' : 'Retiré';
    patches.set(itemId, { status: 'removed', reason, reason_source: 'user' });
    live.delete(itemId);
  }
  for (const { itemId, quantity, unit } of output.update) {
    const item = live.get(itemId);
    if (item) patches.set(itemId, resize(item, quantity, unit, preferences));
  }
  const additions: AggregatedLine[] = [];
  for (const line of aggregate(output.add)) {
    const same = [...live.values()].find(
      (item) =>
        item.ingredientKey.trim().toLowerCase() === line.key && (patches.get(item.id)?.unit ?? item.unit) === line.unit,
    );
    if (!same) {
      additions.push(line);
      continue;
    }
    const current = patches.get(same.id)?.quantity ?? same.quantity;
    patches.set(same.id, resize(same, current + line.quantity, line.unit, preferences));
  }
  return { patches: [...patches].map(([itemId, patch]) => ({ itemId, patch })), additions };
}
