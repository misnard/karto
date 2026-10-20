import { describe, expect, it } from 'vitest';
import type { ParseLine } from '../llm/prompts/parse.ts';
import { parseLine as line } from '../test/helpers.ts';
import { type AggregatedLine, aggregate } from './aggregate.ts';

type Expected = Pick<AggregatedLine, 'key' | 'quantity' | 'unit'> & Partial<AggregatedLine>;

describe('aggregate', () => {
  it.each<[string, ParseLine[], Expected[]]>([
    ['single line', [line('oeuf', { quantity: 6 })], [{ key: 'oeuf', quantity: 6, unit: 'piece' }]],
    [
      'same key and unit: summed, sources merged',
      [
        line('lait', { unit: 'ml', quantity: 1000, sourceIndex: 1 }),
        line('Lait ', { unit: 'ml', quantity: 500, sourceIndex: 0 }),
      ],
      [{ key: 'lait', quantity: 1500, unit: 'ml', sources: [0, 1] }],
    ],
    [
      'pieces with a weight join grams of the same key',
      [
        line('oignon', { quantity: 2, pieceWeightG: 150 }),
        line('oignon', { unit: 'g', quantity: 200, sourceIndex: 1 }),
      ],
      [{ key: 'oignon', quantity: 500, unit: 'g', sources: [0, 1] }],
    ],
    [
      'pieces without a weight stay separate from grams',
      [line('ail', { quantity: 1 }), line('ail', { unit: 'g', quantity: 20 })],
      [
        { key: 'ail', quantity: 1, unit: 'piece' },
        { key: 'ail', quantity: 20, unit: 'g' },
      ],
    ],
    [
      'pieces stay pieces when the key has no grams',
      [line('citron', { quantity: 2, pieceWeightG: 100 }), line('citron', { quantity: 1, pieceWeightG: 100 })],
      [{ key: 'citron', quantity: 3, unit: 'piece' }],
    ],
    [
      'ml and g never merge',
      [line('crème', { unit: 'ml', quantity: 200 }), line('crème', { unit: 'g', quantity: 100 })],
      [
        { key: 'crème', quantity: 200, unit: 'ml' },
        { key: 'crème', quantity: 100, unit: 'g' },
      ],
    ],
    [
      'pieces rounded up, without float noise',
      [line('avocat', { quantity: 2.2 }), line('avocat', { quantity: 0.8 }), line('tomate', { quantity: 0.5 })],
      [
        { key: 'avocat', quantity: 3, unit: 'piece' },
        { key: 'tomate', quantity: 1, unit: 'piece' },
      ],
    ],
    [
      'grams rounded, at least 1',
      [line('sel', { unit: 'g', quantity: 0.3 }), line('farine', { unit: 'g', quantity: 252.6 })],
      [
        { key: 'sel', quantity: 1, unit: 'g' },
        { key: 'farine', quantity: 253, unit: 'g' },
      ],
    ],
    [
      'first label and query kept, exclude terms merged',
      [
        line('lait', { label: 'Lait', query: 'lait demi-écrémé', excludeTerms: ['coco', 'Soja'] }),
        line('lait', { label: 'Lait entier', query: 'lait entier', excludeTerms: ['soja', 'amande'] }),
      ],
      [
        {
          key: 'lait',
          quantity: 2,
          unit: 'piece',
          label: 'Lait',
          query: 'lait demi-écrémé',
          excludeTerms: ['coco', 'soja', 'amande'],
        },
      ],
    ],
    [
      'first-seen order of keys',
      [line('b'), line('a'), line('b')],
      [
        { key: 'b', quantity: 2, unit: 'piece' },
        { key: 'a', quantity: 1, unit: 'piece' },
      ],
    ],
  ])('%s', (_, lines, expected) => {
    const result = aggregate(lines);
    expect(result).toHaveLength(expected.length);
    expected.forEach((item, index) => {
      expect(result[index]).toMatchObject(item);
    });
  });
});
