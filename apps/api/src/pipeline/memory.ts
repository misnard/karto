/** Memory: the product a user pushed for an ingredient comes back in the next baskets. Pure: no I/O. */
import type { BasketItem, Preferences, ProductOffer } from '@karto/contracts';
import type { ItemNeed, ItemOutcome, NewItem } from '../db/baskets.ts';
import type { Choice } from '../db/choices.ts';
import { hardFilters, packsNeeded } from './rank.ts';

/**
 * Reason of a pending item whose memorized product is unavailable: it is searched again, and the note stays at the
 * start of the reason the rules or the pick give it.
 */
export const MEMORY_UNAVAILABLE = 'Ton choix habituel est indisponible';

/** « Ton choix du 12 oct. »: the day the product was last pushed. */
export function memoryReason(updatedAt: number): string {
  const day = new Date(updatedAt).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Paris',
  });
  return `Ton choix du ${day}`;
}

/** `reason`, after the memory note when `previous` carries it. */
export function withMemoryNote(previous: string | null, reason: string): string {
  return previous?.startsWith(MEMORY_UNAVAILABLE) ? `${MEMORY_UNAVAILABLE} · ${reason}` : reason;
}

/** What a push memorizes: the product of every pushed line, 'replaced' when the user changed it. Last line wins. */
export function pushedChoices(items: BasketItem[]): Choice[] {
  const byKey = new Map<string, Choice>();
  for (const item of items) {
    if (item.status !== 'proposed' || !item.productRef || !item.packs) continue;
    byKey.set(item.ingredientKey, {
      ingredientKey: item.ingredientKey,
      productRef: item.productRef,
      productLabel: item.candidates.find((offer) => offer.ref === item.productRef)?.name ?? item.label,
      source: item.reasonSource === 'user' ? 'replaced' : 'validated',
    });
  }
  return [...byKey.values()];
}

/**
 * Pending items waiting for their memorized product (reason_source 'memory', ref among the refreshed `refs`):
 * chosen directly when the product is still available and not banned, else to search again.
 */
export function resolveMemory(
  needs: Map<string, ItemNeed>,
  refs: string[],
  byRef: ProductOffer[],
  preferences: Preferences,
): { outcomes: ItemOutcome[]; unavailable: Pick<NewItem, 'id' | 'searchQuery'>[] } {
  const outcomes: ItemOutcome[] = [];
  const unavailable: Pick<NewItem, 'id' | 'searchQuery'>[] = [];
  for (const [id, need] of needs) {
    const ref = need.productRef;
    if (need.status !== 'pending' || need.reasonSource !== 'memory' || !ref || !refs.includes(ref)) continue;
    const offer = byRef.find((candidate) => candidate.ref === ref);
    // No exclude terms: the user chose this product for this ingredient.
    if (!offer || hardFilters([offer], [], preferences).pool.length === 0) {
      unavailable.push({ id, searchQuery: need.searchQuery });
      continue;
    }
    outcomes.push({
      id,
      status: 'proposed',
      productRef: ref,
      packs: packsNeeded(need, offer.pack, offer.maxQuantity),
      candidates: [offer],
      reason: need.reason ?? memoryReason(Date.now()),
      reasonSource: 'memory',
    });
  }
  return { outcomes, unavailable };
}
