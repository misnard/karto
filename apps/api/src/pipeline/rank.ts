/** Rule-based choice of one offer for a basket line. Pure: no I/O. */
import type { Preferences, ProductOffer, Unit } from '@karto/contracts';

export interface Need {
  quantity: number;
  unit: Unit;
}

export type Ranked = { ref: string; packs: number; reason: string } | { ref: null; reason: string };

/** Buying up to 5 % less than the need is fine: 1 050 ml is one 1 L pack. */
const TOLERANCE = 0.05;
/** Only the most relevant remaining offers compete on price. */
const WINDOW = 4;
const MULTIPLIER = { favorite: 0.85, organic: 0.9, privateLabel: 0.9, avoidedPrivateLabel: 1.1, waste: 1.2 };
const PER_LABEL = { kg: 'au kg', l: 'au litre', piece: 'à la pièce' } as const;

type Goal = Preferences['goals'][number];
/** Applied only when the user has nutrition goals. Missing Nutri-Score: neutral. */
const NUTRISCORE = { A: 0.88, B: 0.94, C: 1, D: 1.06, E: 1.12 } as const;
const GOAL_MULTIPLIER = 0.85;
/** Generic French words marking a product that fits a goal, accent- and case-insensitive, at a word start. */
const LIGHT = ['0%', 'allégé', 'light', 'maigre', 'léger', '5% m.g.', '5% mg'];
const GOAL_WORDS: Record<Goal, string[]> = {
  high_protein: ['protéine', 'protéiné', 'hyperprotéiné', 'skyr'],
  low_calorie: LIGHT,
  low_fat: LIGHT,
  low_sugar: ['sans sucres ajoutés', 'sans sucre'],
  low_salt: ['sans sel', 'réduit en sel', 'sel réduit'],
};
/** In the order they are given as the reason. */
const GOAL_REASONS: [Goal, string][] = [
  ['high_protein', 'Riche en protéines'],
  ['low_calorie', 'Allégé'],
  ['low_fat', 'Allégé'],
  ['low_sugar', 'Sans sucres ajoutés'],
  ['low_salt', 'Réduit en sel'],
];

export function packsNeeded(need: Need, pack?: ProductOffer['pack'], maxQuantity?: number): number {
  if (!pack || pack.unit !== need.unit) return 1;
  const packs = Math.max(1, Math.ceil((need.quantity * (1 - TOLERANCE)) / pack.amount - 1e-9));
  return maxQuantity ? Math.min(packs, maxQuantity) : packs;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** "0 %" and "0%" alike; a word matches at a word start ("0%" not in "30%"), suffixes allowed ("allégée"). */
function hasWord(name: string, word: string): boolean {
  const text = normalize(name).replace(/\s+/g, ' ').replace(/ %/g, '%');
  const escaped = normalize(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, 'u').test(text);
}

function matchesGoal(offer: ProductOffer, goal: Goal): boolean {
  return (goal === 'low_sugar' && offer.noAddedSugar === true) || GOAL_WORDS[goal].some((w) => hasWord(offer.name, w));
}

/** Equal, or a longer name starting with it ("Panzani" matches "Panzani Bio"), ignoring case and accents. */
export function brandIn(brand: string | undefined, brands: string[]): boolean {
  if (!brand) return false;
  const name = normalize(brand);
  return brands.map(normalize).some((b) => b !== '' && (name === b || name.startsWith(`${b} `)));
}

function formatNeed({ quantity, unit }: Need): string {
  const n = (value: number) => String(Math.round(value * 10) / 10).replace('.', ',');
  if (unit === 'g') return quantity >= 1000 ? `${n(quantity / 1000)} kg` : `${n(quantity)} g`;
  if (unit === 'ml') return quantity >= 1000 ? `${n(quantity / 1000)} L` : `${n(quantity)} ml`;
  return `${n(quantity)} ${quantity > 1 ? 'pièces' : 'pièce'}`;
}

/** Offers that pass the hard filters, in search order, or why none does. */
export type Filtered = { pool: ProductOffer[]; relaxed?: string } | { pool: []; reason: string };

/**
 * Hard filters, in order: available; brand not banned (never relaxed); no exclude term in the name; organic when
 * required. The last two are relaxed when nothing passes, and `relaxed` says so.
 */
export function hardFilters(offers: ProductOffer[], excludeTerms: string[], prefs: Preferences): Filtered {
  const available = offers.filter((offer) => offer.available);
  if (available.length === 0) return { pool: [], reason: 'Aucun produit disponible' };
  let pool = available.filter((offer) => !brandIn(offer.brand, prefs.bannedBrands));
  if (pool.length === 0) return { pool: [], reason: 'Uniquement des marques bannies' };

  let relaxed: string | undefined;
  const terms = excludeTerms.map(normalize).filter(Boolean);
  const exact = pool.filter((offer) => !terms.some((term) => normalize(offer.name).includes(term)));
  if (exact.length > 0) pool = exact;
  else relaxed = 'Produit approchant';
  if (prefs.organic === 'require') {
    const organic = pool.filter((offer) => offer.isOrganic);
    if (organic.length > 0) pool = organic;
    else relaxed ??= 'Pas de version bio disponible';
  }
  return { pool, relaxed };
}

/**
 * The hard filters, then, among the first WINDOW offers in search order, the lowest cost (price × packs, or unit
 * price for packSize 'value' when every one has a comparable unit price) adjusted by the preferences. Ties keep
 * search order; offers without price come last.
 */
export function rank(offers: ProductOffer[], need: Need, excludeTerms: string[], prefs: Preferences): Ranked {
  const filtered = hardFilters(offers, excludeTerms, prefs);
  if ('reason' in filtered) return { ref: null, reason: filtered.reason };
  const { pool, relaxed } = filtered;

  const window = pool.slice(0, WINDOW).map((offer, index) => {
    const packs = packsNeeded(need, offer.pack, offer.maxQuantity);
    const bought = offer.pack?.unit === need.unit ? packs * offer.pack.amount : undefined;
    return {
      offer,
      index,
      packs,
      favorite: brandIn(offer.brand, prefs.favoriteBrands),
      organic: prefs.organic === 'prefer' && offer.isOrganic === true,
      privateLabel: prefs.privateLabel === 'prefer' && offer.isPrivateLabel === true,
      avoidedPrivateLabel: prefs.privateLabel === 'avoid' && offer.isPrivateLabel === true,
      waste: prefs.packSize === 'small' && bought !== undefined && bought >= 2 * need.quantity,
      goals: prefs.goals.filter((goal) => matchesGoal(offer, goal)),
      nutriscore: prefs.goals.length > 0 && offer.nutriscore ? NUTRISCORE[offer.nutriscore] : 1,
    };
  });
  const per = window[0]?.offer.unitPrice?.per;
  const byUnitPrice =
    prefs.packSize === 'value' && per !== undefined && window.every((c) => c.offer.unitPrice?.per === per);
  const scored = window.map((c) => {
    const price = c.offer.priceCents === undefined ? undefined : c.offer.priceCents * c.packs;
    const basis = byUnitPrice ? c.offer.unitPrice?.cents : price;
    const plain = basis ?? Number.POSITIVE_INFINITY;
    const factors = (['favorite', 'organic', 'privateLabel', 'avoidedPrivateLabel', 'waste'] as const).filter(
      (factor) => c[factor],
    );
    const preferred = factors.reduce((score, factor) => score * MULTIPLIER[factor], plain);
    return { ...c, plain, score: preferred * c.nutriscore * GOAL_MULTIPLIER ** c.goals.length };
  });
  const byScore = (key: 'plain' | 'score') => [...scored].sort((a, b) => a[key] - b[key] || a.index - b.index)[0];
  const chosen = byScore('score');
  const cheapest = byScore('plain');
  if (!chosen || !cheapest) return { ref: null, reason: 'Aucun produit disponible' };

  const reason = (): string => {
    if (relaxed) return relaxed;
    if (chosen.favorite) return 'Ta marque préférée';
    const goal = GOAL_REASONS.find(([g]) => chosen.goals.includes(g));
    if (goal) return goal[1];
    if (chosen !== cheapest && chosen.nutriscore < cheapest.nutriscore) return 'Meilleur Nutri-Score';
    if (chosen.organic) return 'Bio';
    if (scored.length === 1) return 'Seul produit correspondant';
    if (chosen.plain === Number.POSITIVE_INFINITY) return 'Premier résultat disponible';
    if (chosen !== cheapest) {
      if (chosen.privateLabel) return 'Marque distributeur';
      if (cheapest.avoidedPrivateLabel) return 'Hors marque distributeur';
      if (cheapest.waste) return 'Format adapté à ta quantité';
    }
    if (byUnitPrice && per) return `Le moins cher ${PER_LABEL[per]}`;
    if (chosen.offer.isPrivateLabel) return 'Marque distributeur, moins chère';
    return `Le moins cher pour ${formatNeed(need)}`;
  };
  return { ref: chosen.offer.ref, packs: chosen.packs, reason: reason() };
}
