import { type BasketItem, PreferencesSchema, type ProductOffer } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import type { PickOutput } from '../llm/prompts/pick.ts';
import { offer } from '../test/helpers.ts';
import { applyPick, orderCandidates, pickLines } from './pick.ts';

const prefs = PreferencesSchema.parse({ bannedBrands: ['Interdite'] });
const pack = (amount: number): ProductOffer['pack'] => ({ amount, unit: 'ml' });

const item = (id: string, candidates: ProductOffer[], fields: Partial<BasketItem> = {}): BasketItem => ({
  id,
  position: 0,
  ingredientKey: id,
  label: id,
  quantity: 1000,
  unit: 'ml',
  status: 'proposed',
  productRef: candidates[0]?.ref ?? null,
  packs: 1,
  candidates,
  reason: 'Le moins cher pour 1 L',
  reasonSource: 'rules',
  ...fields,
});

describe('pickLines', () => {
  it('sends the lines with at least 2 candidates left by the hard filters, 6 at most, with packs and total', () => {
    const lait = [
      { ...offer('coco', 50), name: 'Lait de coco' },
      { ...offer('banned', 60), brand: 'Interdite' },
      offer('gone', 70, false),
      { ...offer('L1', 99), pack: pack(500), isOrganic: true, isPrivateLabel: false },
      ...['L2', 'L3', 'L4', 'L5', 'L6', 'L7'].map((ref) => offer(ref, 100)),
    ];
    const lines = pickLines(
      [
        { ...item('lait', lait), excludeTerms: ['coco'] },
        { ...item('seul', [offer('S1', 10), offer('S2', 20, false)]), excludeTerms: [] },
        { ...item('rien', []), excludeTerms: [] },
      ],
      prefs,
    );
    expect(lines).toEqual([
      {
        itemId: 'lait',
        label: 'lait',
        need: { quantity: 1000, unit: 'ml' },
        candidates: [
          { ref: 'L1', name: 'Product L1', pack: pack(500), priceCents: 99, packs: 2, totalCents: 198, organic: true },
          ...['L2', 'L3', 'L4', 'L5', 'L6'].map((ref) => ({
            ref,
            name: `Product ${ref}`,
            priceCents: 100,
            packs: 1,
            totalCents: 100,
          })),
        ],
      },
    ]);
  });
});

describe('orderCandidates', () => {
  it('puts the given refs first in their order, the others after in theirs', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e'].map((ref) => offer(ref, 1));
    expect(orderCandidates(candidates, ['d', 'b']).map((c) => c.ref)).toEqual(['d', 'b', 'a', 'c', 'e']);
    expect(orderCandidates(candidates, []).map((c) => c.ref)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('applyPick', () => {
  const lait = [offer('L1', 100), { ...offer('L2', 150), pack: pack(500), maxQuantity: 1 }, offer('L3', 90)];
  const items = [
    item('lait', [...lait, offer('L4', 80)]),
    item('oeuf', [offer('O1', 200), offer('O2', 250)]),
    item('pain', [offer('P1', 100), offer('P2', 120)], { status: 'removed' }),
  ];
  const given = [
    { itemId: 'lait', candidates: lait.map(({ ref }) => ({ ref })) },
    { itemId: 'oeuf', candidates: [{ ref: 'O1' }, { ref: 'O2' }] },
    { itemId: 'pain', candidates: [{ ref: 'P1' }, { ref: 'P2' }] },
  ];
  const output = (...picks: PickOutput['picks']): PickOutput => ({ picks });
  const reason = 'Le bon produit';

  it('chooses, orders the alternatives after the choice and caps the reason', () => {
    const long = 'x'.repeat(100);
    const patches = applyPick(
      given,
      output(
        { itemId: 'lait', ref: 'L2', alternatives: ['L3', 'L2', 'L3', 'L1'], reason: long },
        { itemId: 'pain', ref: 'P2', alternatives: [], reason },
      ),
      items,
    );
    expect(patches).toEqual([
      {
        itemId: 'lait',
        patch: {
          status: 'proposed',
          product_ref: 'L2',
          packs: 1, // 2 × 500 ml needed, capped by maxQuantity
          candidates: JSON.stringify([lait[1], lait[2], lait[0], offer('L4', 80)]),
          reason: 'x'.repeat(80),
          reason_source: 'llm',
        },
      },
    ]);
  });

  it('marks the item unmatched when no candidate fits, alternatives first', () => {
    const patches = applyPick(given, output({ itemId: 'oeuf', ref: null, alternatives: ['O2'], reason }), items);
    expect(patches).toEqual([
      {
        itemId: 'oeuf',
        patch: {
          status: 'unmatched',
          product_ref: null,
          packs: null,
          candidates: JSON.stringify([offer('O2', 250), offer('O1', 200)]),
          reason,
          reason_source: 'llm',
        },
      },
    ]);
  });

  it.each<[string, PickOutput['picks'][number]]>([
    ['an item it was not given', { itemId: 'beurre', ref: 'L1', alternatives: [], reason }],
    ['a ref of another line', { itemId: 'oeuf', ref: 'L1', alternatives: [], reason }],
    ['a ref it was not shown', { itemId: 'lait', ref: 'L4', alternatives: [], reason }],
    ['an alternative it was not given', { itemId: 'lait', ref: 'L1', alternatives: ['999'], reason }],
  ])('rejects the whole output for %s', (_, pick) => {
    const valid = { itemId: 'oeuf', ref: 'O2', alternatives: [], reason };
    expect(applyPick(given, output(valid, pick), items)).toEqual(expect.any(String));
  });
});
