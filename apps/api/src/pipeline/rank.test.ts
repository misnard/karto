import { type Preferences, PreferencesSchema, type ProductOffer } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { type Need, packsNeeded, rank } from './rank.ts';

const offer = (ref: string, fields: Partial<ProductOffer> = {}): ProductOffer => ({
  provider: 'carrefour',
  ref,
  name: `Produit ${ref}`,
  available: true,
  priceCents: 100,
  ...fields,
});
const prefs = (fields: Partial<Preferences> = {}): Preferences => PreferencesSchema.parse(fields);
const g500: Need = { quantity: 500, unit: 'g' };

describe('packsNeeded', () => {
  it.each<[string, Need, ProductOffer['pack'], number | undefined, number]>([
    ['1 000 ml, 1 L brick', { quantity: 1000, unit: 'ml' }, { amount: 1000, unit: 'ml' }, undefined, 1],
    ['1 040 ml, 1 L brick: within 5 %', { quantity: 1040, unit: 'ml' }, { amount: 1000, unit: 'ml' }, undefined, 1],
    ['1 100 ml, 1 L brick', { quantity: 1100, unit: 'ml' }, { amount: 1000, unit: 'ml' }, undefined, 2],
    ['300 g, 250 g pack', { quantity: 300, unit: 'g' }, { amount: 250, unit: 'g' }, undefined, 2],
    ['6 eggs, box of 12', { quantity: 6, unit: 'piece' }, { amount: 12, unit: 'piece' }, undefined, 1],
    ['12 eggs, box of 6', { quantity: 12, unit: 'piece' }, { amount: 6, unit: 'piece' }, undefined, 2],
    ['500 g, 125 g pots', g500, { amount: 125, unit: 'g' }, undefined, 4],
    ['capped by maxQuantity', { quantity: 2000, unit: 'g' }, { amount: 500, unit: 'g' }, 3, 3],
    ['unknown pack', g500, undefined, undefined, 1],
    ['incompatible units', g500, { amount: 1000, unit: 'ml' }, undefined, 1],
    ['tiny need', { quantity: 0.5, unit: 'piece' }, { amount: 1, unit: 'piece' }, undefined, 1],
  ])('%s', (_, need, pack, maxQuantity, expected) => {
    expect(packsNeeded(need, pack, maxQuantity)).toBe(expected);
  });
});

describe('rank', () => {
  it.each<[string, ProductOffer[], string[], Partial<Preferences>, string | null, string]>([
    ['nothing available', [offer('1', { available: false })], [], {}, null, 'Aucun produit disponible'],
    ['unavailable skipped', [offer('1', { available: false }), offer('2')], [], {}, '2', 'Seul produit correspondant'],
    [
      'cheapest of the window',
      [offer('1', { priceCents: 200 }), offer('2', { priceCents: 150 }), offer('3', { priceCents: 180 })],
      [],
      {},
      '2',
      'Le moins cher pour 500 g',
    ],
    ['ties keep search order', [offer('1'), offer('2')], [], {}, '1', 'Le moins cher pour 500 g'],
    [
      'only the first 4 compete',
      [offer('1'), offer('2'), offer('3'), offer('4'), offer('5', { priceCents: 10 })],
      [],
      {},
      '1',
      'Le moins cher pour 500 g',
    ],
    [
      'missing price comes last',
      [offer('1', { priceCents: undefined }), offer('2', { priceCents: 300 })],
      [],
      {},
      '2',
      'Le moins cher pour 500 g',
    ],
    [
      'no price at all: search order',
      [offer('1', { priceCents: undefined }), offer('2', { priceCents: undefined })],
      [],
      {},
      '1',
      'Premier résultat disponible',
    ],
    [
      'cost counts the packs needed',
      [
        offer('1', { priceCents: 150, pack: { amount: 250, unit: 'g' } }),
        offer('2', { priceCents: 280, pack: { amount: 500, unit: 'g' } }),
      ],
      [],
      {},
      '2',
      'Le moins cher pour 500 g',
    ],
    [
      'banned brand skipped, case, accents and prefix',
      [offer('1', { brand: 'Lústucru Sélection', priceCents: 50 }), offer('2', { brand: 'Panzani' })],
      [],
      { bannedBrands: ['LUSTUCRU'] },
      '2',
      'Seul produit correspondant',
    ],
    [
      'a brand merely starting like a banned one is allowed',
      [offer('1', { brand: 'Lustucrucru', priceCents: 50 }), offer('2')],
      [],
      { bannedBrands: ['Lustucru'] },
      '1',
      'Le moins cher pour 500 g',
    ],
    [
      'banned brands are never relaxed',
      [offer('1', { brand: 'Panzani' }), offer('2', { brand: 'panzani bio' })],
      [],
      { bannedBrands: ['Panzani'], favoriteBrands: ['Panzani'], organic: 'require' },
      null,
      'Uniquement des marques bannies',
    ],
    [
      'excluded names skipped',
      [offer('1', { name: 'Lait de COCO', priceCents: 50 }), offer('2', { name: 'Lait demi-écrémé' })],
      ['coco'],
      {},
      '2',
      'Seul produit correspondant',
    ],
    [
      'every name excluded: approximated, still the cheapest',
      [offer('1', { name: 'Crème brûlée', priceCents: 300 }), offer('2', { name: 'Crème brulée vanille' })],
      ['brulee'],
      {},
      '2',
      'Produit approchant',
    ],
    [
      'organic required',
      [
        offer('1', { priceCents: 50 }),
        offer('2', { isOrganic: true, priceCents: 200 }),
        offer('3', { isOrganic: true }),
      ],
      [],
      { organic: 'require' },
      '3',
      'Le moins cher pour 500 g',
    ],
    [
      'organic required but none: relaxed',
      [offer('1', { priceCents: 150 }), offer('2')],
      [],
      { organic: 'require' },
      '2',
      'Pas de version bio disponible',
    ],
    [
      'favorite brand ×0.85 wins',
      [offer('1'), offer('2', { brand: 'Panzani', priceCents: 115 })],
      [],
      { favoriteBrands: ['panzani'] },
      '2',
      'Ta marque préférée',
    ],
    [
      'favorite brand ×0.85 not enough',
      [offer('1'), offer('2', { brand: 'Panzani', priceCents: 120 })],
      [],
      { favoriteBrands: ['Panzani'] },
      '1',
      'Le moins cher pour 500 g',
    ],
    [
      'organic preferred ×0.9',
      [offer('1'), offer('2', { isOrganic: true, priceCents: 110 })],
      [],
      { organic: 'prefer' },
      '2',
      'Bio',
    ],
    [
      'private label preferred ×0.9',
      [offer('1'), offer('2', { isPrivateLabel: true, priceCents: 110 })],
      [],
      { privateLabel: 'prefer' },
      '2',
      'Marque distributeur',
    ],
    [
      'private label avoided ×1.1',
      [offer('1', { isPrivateLabel: true }), offer('2', { priceCents: 105 })],
      [],
      { privateLabel: 'avoid' },
      '2',
      'Hors marque distributeur',
    ],
    [
      'cheapest private label, neutral',
      [offer('1', { priceCents: 120 }), offer('2', { isPrivateLabel: true })],
      [],
      {},
      '2',
      'Marque distributeur, moins chère',
    ],
    [
      'value: unit price when every offer has one',
      [
        offer('1', { priceCents: 200, pack: { amount: 500, unit: 'g' }, unitPrice: { cents: 400, per: 'kg' } }),
        offer('2', { priceCents: 300, pack: { amount: 1000, unit: 'g' }, unitPrice: { cents: 300, per: 'kg' } }),
      ],
      [],
      { packSize: 'value' },
      '2',
      'Le moins cher au kg',
    ],
    [
      'value: cost when a unit price is missing',
      [
        offer('1', { priceCents: 200, pack: { amount: 500, unit: 'g' }, unitPrice: { cents: 400, per: 'kg' } }),
        offer('2', { priceCents: 300, pack: { amount: 1000, unit: 'g' } }),
      ],
      [],
      { packSize: 'value' },
      '1',
      'Le moins cher pour 500 g',
    ],
    [
      'small: waste ×1.2',
      [
        offer('1', { priceCents: 300, pack: { amount: 1000, unit: 'g' } }),
        offer('2', { priceCents: 330, pack: { amount: 500, unit: 'g' } }),
      ],
      [],
      { packSize: 'small' },
      '2',
      'Format adapté à ta quantité',
    ],
  ])('%s', (_, offers, excludeTerms, fields, ref, reason) => {
    const ranked = rank(offers, g500, excludeTerms, prefs(fields));
    expect(ranked).toMatchObject({ ref, reason });
  });

  it('returns the packs of the chosen offer', () => {
    const offers = [offer('1', { pack: { amount: 250, unit: 'g' }, maxQuantity: 10 })];
    expect(rank(offers, { quantity: 1000, unit: 'g' }, [], prefs())).toEqual({
      ref: '1',
      packs: 4,
      reason: 'Seul produit correspondant',
    });
  });

  it.each<[Need, string]>([
    [{ quantity: 1500, unit: 'g' }, 'Le moins cher pour 1,5 kg'],
    [{ quantity: 750, unit: 'ml' }, 'Le moins cher pour 750 ml'],
    [{ quantity: 2000, unit: 'ml' }, 'Le moins cher pour 2 L'],
    [{ quantity: 6, unit: 'piece' }, 'Le moins cher pour 6 pièces'],
    [{ quantity: 1, unit: 'piece' }, 'Le moins cher pour 1 pièce'],
  ])('names the need: %j', (need, reason) => {
    expect(rank([offer('1'), offer('2', { priceCents: 200 })], need, [], prefs()).reason).toBe(reason);
  });
});

describe('rank with nutrition goals', () => {
  type Goals = Preferences['goals'];
  const plain = offer('1', { name: 'Produit de base' });
  const named = (name: string, priceCents = 115, fields: Partial<ProductOffer> = {}) =>
    offer('2', { name, priceCents, ...fields });

  it.each<[string, ProductOffer, Goals, string | null]>([
    ['protéines', named('Yaourt riche en Protéines'), ['high_protein'], 'Riche en protéines'],
    ['protéiné', named('Fromage blanc protéiné'), ['high_protein'], 'Riche en protéines'],
    ['hyperprotéiné', named('Dessert HYPERPROTÉINÉ'), ['high_protein'], 'Riche en protéines'],
    ['skyr', named('Skyr nature'), ['high_protein'], 'Riche en protéines'],
    ['0%', named('Fromage blanc 0%'), ['low_calorie'], 'Allégé'],
    ['0 % with a space', named('Yaourt 0 % MG'), ['low_fat'], 'Allégé'],
    ['allégée', named('Crème allégée'), ['low_calorie'], 'Allégé'],
    ['light', named('Mayonnaise Light'), ['low_calorie'], 'Allégé'],
    ['maigre', named('Jambon maigre'), ['low_fat'], 'Allégé'],
    ['légère', named('Crème légère'), ['low_fat'], 'Allégé'],
    ['5% M.G.', named('Steak haché 5% M.G.'), ['low_fat'], 'Allégé'],
    ['5% MG', named('Steak haché 5% MG'), ['low_calorie'], 'Allégé'],
    ['sans sucres ajoutés', named('Compote sans sucres ajoutés'), ['low_sugar'], 'Sans sucres ajoutés'],
    ['sans sucre', named('Soda sans sucre'), ['low_sugar'], 'Sans sucres ajoutés'],
    ['noAddedSugar flag', named('Compote pomme', 115, { noAddedSugar: true }), ['low_sugar'], 'Sans sucres ajoutés'],
    ['sans sel', named('Beurre doux sans sel'), ['low_salt'], 'Réduit en sel'],
    ['réduit en sel', named('Jambon réduit en sel'), ['low_salt'], 'Réduit en sel'],
    ['sel réduit', named('Bouillon sel réduit'), ['low_salt'], 'Réduit en sel'],
    ['30% is not 0%', named('Crème 30% MG'), ['low_fat'], null],
    ['delight is not light', named('Biscuit Delight'), ['low_calorie'], null],
    ['word of another goal', named('Skyr nature'), ['low_salt'], null],
    ['no goals: no effect', named('Skyr nature'), [], null],
  ])('%s', (_, product, goals, reason) => {
    const ranked = rank([plain, product], g500, [], prefs({ goals }));
    expect(ranked).toMatchObject(reason ? { ref: '2', reason } : { ref: '1', reason: 'Le moins cher pour 500 g' });
  });

  it('×0.85 per matched goal, only up to the threshold', () => {
    const goals: Goals = ['high_protein', 'low_fat'];
    expect(rank([plain, named('Skyr', 120)], g500, [], prefs({ goals })).ref).toBe('1');
    expect(rank([plain, named('Skyr 0%', 135)], g500, [], prefs({ goals }))).toMatchObject({
      ref: '2',
      reason: 'Riche en protéines',
    });
    expect(rank([plain, named('Skyr', 135)], g500, [], prefs({ goals })).ref).toBe('1');
  });

  it.each<[string, ProductOffer[], Goals, string, string]>([
    [
      'best Nutri-Score at equal price',
      ['E', 'C', 'B', 'D'].map((n, i) => offer(String(i), { nutriscore: n as ProductOffer['nutriscore'] })),
      ['low_salt'],
      '2',
      'Meilleur Nutri-Score',
    ],
    [
      'A before B',
      [offer('1', { nutriscore: 'B' }), offer('2', { nutriscore: 'A' })],
      ['low_sugar'],
      '2',
      'Meilleur Nutri-Score',
    ],
    [
      'missing is neutral, better than D',
      [offer('1', { nutriscore: 'D' }), offer('2')],
      ['high_protein'],
      '2',
      'Meilleur Nutri-Score',
    ],
    [
      'A ×0.88 wins up to 13 % dearer',
      [offer('1', { nutriscore: 'C' }), offer('2', { nutriscore: 'A', priceCents: 113 })],
      ['low_fat'],
      '2',
      'Meilleur Nutri-Score',
    ],
    [
      'A ×0.88 loses at 14 % dearer',
      [offer('1', { nutriscore: 'C' }), offer('2', { nutriscore: 'A', priceCents: 114 })],
      ['low_fat'],
      '1',
      'Le moins cher pour 500 g',
    ],
    [
      'no goals: Nutri-Score ignored',
      [offer('1', { nutriscore: 'E' }), offer('2', { nutriscore: 'A', priceCents: 101 })],
      [],
      '1',
      'Le moins cher pour 500 g',
    ],
  ])('%s', (_, offers, goals, ref, reason) => {
    expect(rank(offers, g500, [], prefs({ goals }))).toMatchObject({ ref, reason });
  });

  it('names the favorite brand first, then the goal', () => {
    const offers = [plain, named('Skyr', 100, { brand: 'Siggi' })];
    const both = prefs({ goals: ['high_protein'], favoriteBrands: ['Siggi'] });
    expect(rank(offers, g500, [], both).reason).toBe('Ta marque préférée');
    const goalAndOrganic = prefs({ goals: ['high_protein'], organic: 'prefer' });
    expect(rank([plain, named('Skyr bio', 100, { isOrganic: true })], g500, [], goalAndOrganic).reason).toBe(
      'Riche en protéines',
    );
  });
});

describe('rank never chooses a banned brand', () => {
  /** Deterministic pseudo-random numbers (mulberry32). */
  function random(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const normalize = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim();
  const isBanned = (brand: string | undefined, banned: string[]) =>
    brand !== undefined &&
    banned.some((b) => normalize(brand) === normalize(b) || normalize(brand).startsWith(`${normalize(b)} `));

  it('over 2 000 random baskets and preferences', () => {
    const next = random(42);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const brands = ['Lustucru', 'lustucru sélection', 'LÚSTUCRU', 'Lustucrucru', 'Panzani', 'Panzani Bio', 'Barilla'];
    for (let run = 0; run < 2000; run++) {
      const bannedBrands = ['Lustucru', 'panzani', 'BARILLA'].filter(() => next() < 0.5);
      const preferences = prefs({
        bannedBrands,
        favoriteBrands: brands.filter(() => next() < 0.3),
        organic: pick(['no', 'prefer', 'require'] as const),
        privateLabel: pick(['prefer', 'neutral', 'avoid'] as const),
        packSize: pick(['small', 'neutral', 'value'] as const),
      });
      const offers = Array.from({ length: 1 + Math.floor(next() * 10) }, (_, i) =>
        offer(String(i), {
          name: pick(['Pâtes', 'Pâtes bio', 'Lait de coco']),
          brand: next() < 0.9 ? pick(brands) : undefined,
          available: next() < 0.8,
          priceCents: next() < 0.9 ? Math.floor(next() * 500) : undefined,
          isOrganic: next() < 0.3,
          isPrivateLabel: next() < 0.3,
          pack: next() < 0.7 ? { amount: pick([125, 250, 500, 1000]), unit: 'g' } : undefined,
          unitPrice: next() < 0.5 ? { cents: Math.floor(next() * 1000), per: 'kg' } : undefined,
        }),
      );
      const ranked = rank(offers, g500, next() < 0.5 ? ['coco'] : [], preferences);
      const allowed = offers.filter((o) => o.available && !isBanned(o.brand, bannedBrands));
      const chosen = offers.find((o) => o.ref === ranked.ref);
      expect(ranked.ref === null).toBe(allowed.length === 0);
      if (chosen) expect(allowed).toContain(chosen);
    }
  });
});
