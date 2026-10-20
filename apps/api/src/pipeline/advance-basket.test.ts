import { type BasketItem, PreferencesSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { offer } from '../test/helpers.ts';
import { chooseOffer, toCartLines } from './advance-basket.ts';

describe('chooseOffer', () => {
  const need = { quantity: 1000, unit: 'ml' as const, excludeTerms: ['coco'] };

  it('keeps the first 8 offers as candidates and maps the ranking', () => {
    const offers = [
      { ...offer('1', 100), name: 'Lait de coco' },
      { ...offer('2', 90), pack: { amount: 500, unit: 'ml' as const } },
      ...Array.from({ length: 8 }, (_, i) => offer(`x${i}`, 1)),
    ];
    const outcome = chooseOffer('item', offers, need, PreferencesSchema.parse({}));
    expect(outcome.candidates).toEqual(offers.slice(0, 8));
    expect(outcome).toMatchObject({
      id: 'item',
      status: 'proposed',
      productRef: 'x0',
      packs: 1,
      reason: 'Le moins cher pour 1 L',
      reasonSource: 'rules',
    });
  });

  it('maps no match to unmatched', () => {
    const outcome = chooseOffer('item', [offer('1', 100, false)], need, PreferencesSchema.parse({}));
    expect(outcome).toMatchObject({
      status: 'unmatched',
      productRef: null,
      packs: null,
      reason: 'Aucun produit disponible',
    });
  });
});

describe('toCartLines', () => {
  const item = (label: string, status: BasketItem['status'], productRef: string | null, packs: number | null) => ({
    id: label,
    position: 0,
    ingredientKey: label,
    label,
    quantity: 1,
    unit: 'piece' as const,
    status,
    productRef,
    packs,
    candidates: [],
    reason: null,
    reasonSource: null,
  });

  it('keeps proposed items and sums packs per ref', () => {
    const items = [
      item('lait', 'proposed', '1', 1),
      item('lait demi-écrémé', 'proposed', '1', 2),
      item('oeufs', 'proposed', '2', 1),
      item('pâtes', 'unmatched', null, null),
      item('beurre', 'removed', '3', 1),
    ];
    expect(toCartLines(items)).toEqual([
      { ref: '1', quantity: 3, label: 'lait' },
      { ref: '2', quantity: 1, label: 'oeufs' },
    ]);
  });
});
