import { describe, expect, it } from 'vitest';
import { formatQuantity, toBasketInputs } from './ui.ts';

describe('toBasketInputs', () => {
  it.each([
    ['lait, oeufs', [{ kind: 'text', text: 'lait, oeufs' }]],
    [
      'lait\nhttps://www.marmiton.org/recettes/lasagnes.aspx\n  shampoing ',
      [
        { kind: 'text', text: 'lait\nshampoing' },
        { kind: 'recipe_url', url: 'https://www.marmiton.org/recettes/lasagnes.aspx' },
      ],
    ],
    [
      'https://a.example/r1\nhttps://a.example/r2',
      [
        { kind: 'recipe_url', url: 'https://a.example/r1' },
        { kind: 'recipe_url', url: 'https://a.example/r2' },
      ],
    ],
    // A URL inside a sentence stays text: only URL-only lines are recipes.
    ['voir https://a.example/r1 pour 4', [{ kind: 'text', text: 'voir https://a.example/r1 pour 4' }]],
    ['  \n ', []],
  ])('%j', (text, expected) => {
    expect(toBasketInputs(text)).toEqual(expected);
  });
});

describe('formatQuantity', () => {
  it.each([
    [1, 'piece', null],
    [6, 'piece', '× 6'],
    [500, 'g', '500 g'],
    [1500, 'g', '1,5 kg'],
    [30, 'ml', '30 ml'],
    [250, 'ml', '25 cl'],
    [1000, 'ml', '1 L'],
  ] as const)('%d %s', (quantity, unit, expected) => {
    expect(formatQuantity(quantity, unit)).toBe(expected);
  });
});
