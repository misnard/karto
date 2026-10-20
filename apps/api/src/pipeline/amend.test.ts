import { type PatchItemRequest, PreferencesSchema, type ProductOffer } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { parseLine } from '../test/helpers.ts';
import { type AmendableItem, editItem, planAmend } from './amend.ts';

const offer = (ref: string, priceCents: number, pack?: ProductOffer['pack'], maxQuantity?: number): ProductOffer => ({
  provider: 'carrefour',
  ref,
  name: `Produit ${ref}`,
  available: true,
  priceCents,
  pack,
  maxQuantity,
});
const item = (id: string, fields: Partial<AmendableItem> = {}): AmendableItem => ({
  id,
  position: 0,
  ingredientKey: id,
  label: id,
  quantity: 200,
  unit: 'g',
  status: 'proposed',
  productRef: 'small',
  packs: 1,
  candidates: [offer('small', 150, { amount: 200, unit: 'g' }, 3), offer('big', 250, { amount: 400, unit: 'g' })],
  reason: 'Le moins cher pour 200 g',
  reasonSource: 'rules',
  excludeTerms: [],
  ...fields,
});
const prefs = PreferencesSchema.parse({});
const output = (fields: Partial<Parameters<typeof planAmend>[1]>) => ({ add: [], remove: [], update: [], ...fields });

describe('editItem', () => {
  it.each<[string, Partial<AmendableItem>, PatchItemRequest, object]>([
    ['remove', {}, { op: 'remove' }, { status: 'removed', reason: 'Retiré', reason_source: 'user' }],
    [
      'restore a removed product',
      { status: 'removed' },
      { op: 'restore' },
      { status: 'proposed', reason: 'Remis dans le panier', reason_source: 'user' },
    ],
    ['restore without product', { status: 'removed', productRef: null }, { op: 'restore' }, { status: 'unmatched' }],
    ['packs', {}, { op: 'packs', packs: 3 }, { packs: 3 }],
    [
      'choose another candidate: packs recomputed',
      {},
      { op: 'choose', ref: 'big' },
      { status: 'proposed', product_ref: 'big', packs: 1, reason: 'Ton choix', reason_source: 'user' },
    ],
    [
      'choose for an unmatched item',
      { status: 'unmatched', productRef: null, packs: null, quantity: 1000 },
      { op: 'choose', ref: 'small' },
      { status: 'proposed', product_ref: 'small', packs: 3 },
    ],
  ])('%s', (_, fields, op, patch) => {
    expect(editItem(item('x', fields), op)).toMatchObject(patch);
  });

  it.each<[string, Partial<AmendableItem>, PatchItemRequest, number]>([
    ['restore a live item', {}, { op: 'restore' }, 409],
    ['packs above maxQuantity', {}, { op: 'packs', packs: 4 }, 400],
    ['packs without product', { status: 'unmatched', productRef: null }, { op: 'packs', packs: 2 }, 409],
    ['choose a non-candidate', {}, { op: 'choose', ref: 'other' }, 400],
    ['choose on a removed item', { status: 'removed' }, { op: 'choose', ref: 'big' }, 409],
  ])('rejects: %s', (_, fields, op, status) => {
    expect(() => editItem(item('x', fields), op)).toThrow(expect.objectContaining({ status }));
  });
});

describe('planAmend', () => {
  it('removes with the reason, ignoring unknown and removed items', () => {
    const items = [item('sel'), item('huile'), item('gone', { status: 'removed' })];
    const plan = planAmend(
      items,
      output({
        remove: [
          { itemId: 'sel', why: 'have_it' },
          { itemId: 'huile', why: 'not_wanted' },
          { itemId: 'nope', why: 'have_it' },
          { itemId: 'gone', why: 'have_it' },
        ],
      }),
      prefs,
    );
    expect(plan).toEqual({
      patches: [
        { itemId: 'sel', patch: { status: 'removed', reason: 'Déjà à la maison', reason_source: 'user' } },
        { itemId: 'huile', patch: { status: 'removed', reason: 'Retiré', reason_source: 'user' } },
      ],
      additions: [],
    });
  });

  it('resizes by ranking the existing candidates again', () => {
    const plan = planAmend(
      [item('fromage')],
      output({ update: [{ itemId: 'fromage', quantity: 400, unit: 'g' }] }),
      prefs,
    );
    expect(plan.patches).toEqual([
      {
        itemId: 'fromage',
        patch: {
          quantity: 400,
          unit: 'g',
          status: 'proposed',
          product_ref: 'big',
          packs: 1,
          reason: 'Le moins cher pour 400 g',
          reason_source: 'rules',
        },
      },
    ]);
  });

  it.each(['user', 'llm'] as const)('keeps a %s choice and only recomputes its packs', (reasonSource) => {
    const chosen = item('fromage', { reasonSource, reason: 'Ton choix' });
    const plan = planAmend([chosen], output({ update: [{ itemId: 'fromage', quantity: 600, unit: 'g' }] }), prefs);
    expect(plan.patches).toEqual([{ itemId: 'fromage', patch: { quantity: 600, unit: 'g', packs: 3 } }]);
  });

  it('merges added lines into a live item with the same key and unit, adds the others', () => {
    const items = [
      item('fromage râpé'),
      item('tomate', { unit: 'piece', quantity: 4 }),
      item('sel', { status: 'removed' }),
    ];
    const plan = planAmend(
      items,
      output({
        add: [
          parseLine('Fromage râpé', { unit: 'g', quantity: 200 }),
          parseLine('tomate', { unit: 'g', quantity: 300 }),
          parseLine('sel', { unit: 'g', quantity: 250 }),
          parseLine('mayonnaise'),
          parseLine('mayonnaise'),
        ],
      }),
      prefs,
    );
    expect(plan.patches).toEqual([
      { itemId: 'fromage râpé', patch: expect.objectContaining({ quantity: 400, product_ref: 'big', packs: 1 }) },
    ]);
    expect(plan.additions.map((line) => [line.key, line.quantity, line.unit])).toEqual([
      ['tomate', 300, 'g'],
      ['sel', 250, 'g'],
      ['mayonnaise', 2, 'piece'],
    ]);
  });

  it('merges into the updated quantity, never into a line removed by the same amend', () => {
    const items = [item('fromage'), item('sel')];
    const plan = planAmend(
      items,
      output({
        update: [{ itemId: 'fromage', quantity: 300, unit: 'g' }],
        remove: [{ itemId: 'sel', why: 'not_wanted' }],
        add: [parseLine('fromage', { unit: 'g', quantity: 100 }), parseLine('sel', { unit: 'g', quantity: 200 })],
      }),
      prefs,
    );
    expect(plan.patches.find((p) => p.itemId === 'fromage')?.patch).toMatchObject({ quantity: 400 });
    expect(plan.additions.map((line) => line.key)).toEqual(['sel']);
  });
});
