import { readdirSync, readFileSync } from 'node:fs';
import type { ProductOffer } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { parsePack } from './pack.ts';

type Case = [format: string | null, packaging: string | null, expected: ProductOffer['pack']];

const g = (amount: number) => ({ amount, unit: 'g' as const });
const ml = (amount: number) => ({ amount, unit: 'ml' as const });
const piece = (amount: number) => ({ amount, unit: 'piece' as const });

/** Every distinct (format, packaging) pair found in fixtures/*.json. */
const FIXTURE_CASES: Case[] = [
  ['1,5Kg', 'le filet de 1,5Kg', g(1500)],
  ['1kg', '1 kg e', g(1000)],
  ['1kg', "le paquet d'1Kg", g(1000)],
  ['1kg', 'le paquet de 1 kg', g(1000)],
  ['1kg', 'le sachet de 1kg', g(1000)],
  ['1L', 'la bouteille 1L', ml(1000)],
  ['1l', 'la brique de 1 L', ml(1000)],
  ['200g', '200g\u00a0', g(200)], // trailing non-breaking space, as in the fixture
  ['225g', 'Le paquet de 225g', g(225)],
  ['250g', 'la plaquette de 250 g', g(250)],
  ['250g', 'la plaquette de 250g', g(250)],
  ['2Kg', 'le filet de 2Kg', g(2000)],
  ['2x250g', 'les 2 plaquettes de 250g', g(500)],
  ['4x100g', 'les 4 gourdes de 100g', g(400)],
  ['4x100g', 'les 4 pots de 100g', g(400)],
  ['4x90g', 'les 4 gourdes de 90g', g(360)],
  ['500g', 'le paquet de 500g', g(500)],
  ['500g', 'le sachet de 500g', g(500)],
  ['50cl', 'la bouteille 50cL', ml(500)],
  ['50cL', 'la bouteille 50cL', ml(500)],
  ['550g', 'le sachet de 14 tranches', g(550)],
  ['6x1l', 'le pack de 6 bouteilles de 1L', ml(6000)],
  ['6x1L', 'le pack de 6 bouteilles de 1L', ml(6000)],
  ['6x1l', "le pack de 6 briques d'1L", ml(6000)],
  ['6x1L', "le pack de 6 briques d'1L", ml(6000)],
  ['6x50cl', 'le pack de 6 bouteilles de 50cL', ml(3000)],
  // Sold by the piece: the cart counter counts pieces, so the packaging weight is ignored.
  ['la pièce', 'le pain de 500g', piece(1)],
];

/** Formats seen during the spike or likely variants, beyond the fixtures. */
const OTHER_CASES: Case[] = [
  ['70cL', null, ml(700)],
  ['3x400g', null, g(1200)],
  ['130g', null, g(130)],
  ['0,33l', null, ml(330)],
  ['6 x 25 cl', null, ml(1500)],
  ['x5', 'les 5 fruits', piece(5)],
  ['5 pièces', 'les 5 fruits', piece(5)],
  ['1 pièce', null, piece(1)],
  ['la pièce', 'la pièce', piece(1)],
  ['la pièce', null, piece(1)],
  ['270g - env. 1 pièce', "l'unité", piece(1)],
  ['270g - env. 1 pièce', 'le pain de 500g', piece(1)],
  ['1kg - env. 6 pièces', null, piece(6)],
  ['env 2 pieces', null, piece(2)],
  ['env. 1 pièce', null, piece(1)],
  // Format missing or unusable: the packaging decides.
  [null, 'le kilo', g(1000)],
  ['', 'le pack de 6 briques d’1L', ml(6000)],
  [null, 'les 4 pots de 100g', g(400)],
  [null, 'les 5 fruits', piece(5)],
  ['en vrac', 'le pain de 500g', g(500)],
  [null, 'LE PACK DE 6 BOUTEILLES DE 50CL', ml(3000)],
];

const UNPARSABLE: Case[] = [
  [null, null, undefined],
  ['', '', undefined],
  [null, 'le sachet de 14 tranches', undefined],
  ['le lot', 'la barquette', undefined],
  ['0g', null, undefined],
  ['x0', null, undefined],
  ['6x', 'le pack', undefined],
  ['2 litres', null, undefined],
  ['env. 0 pièce', null, undefined],
  [null, 'la barquette de 6 oeufs', undefined],
  ['500 m', null, undefined],
];

describe('parsePack', () => {
  it.each([...FIXTURE_CASES, ...OTHER_CASES, ...UNPARSABLE])('%j + %j → %j', (format, packaging, expected) => {
    expect(parsePack(format, packaging)).toEqual(expected);
  });

  it('covers every format/packaging pair of the fixtures', () => {
    const dir = new URL('../fixtures/', import.meta.url);
    const pairs = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (typeof o.ean === 'string' && 'format' in o) pairs.add(JSON.stringify([o.format, o.packaging]));
        Object.values(o).forEach(visit);
      }
    };
    for (const file of readdirSync(dir)) visit(JSON.parse(readFileSync(new URL(file, dir), 'utf8')));

    const covered = new Set(FIXTURE_CASES.map(([f, p]) => JSON.stringify([f, p])));
    expect([...pairs].filter((pair) => !covered.has(pair))).toEqual([]);
    expect(pairs.size).toBe(FIXTURE_CASES.length);
  });
});
