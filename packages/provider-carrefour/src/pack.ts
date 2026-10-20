import type { ProductOffer } from '@karto/contracts';

type Pack = NonNullable<ProductOffer['pack']>;

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(kg|g|cl|ml|l)\b`;
const TO_BASE: Record<string, { factor: number; unit: Pack['unit'] }> = {
  kg: { factor: 1000, unit: 'g' },
  g: { factor: 1, unit: 'g' },
  l: { factor: 1000, unit: 'ml' },
  cl: { factor: 10, unit: 'ml' },
  ml: { factor: 1, unit: 'ml' },
};

/** "6x1l", "2x250g". */
const MULTI = new RegExp(String.raw`(\d+)\s*x\s*${NUM}\s*${UNIT}`);
/** "le pack de 6 briques d'1l", "les 4 pots de 100g". */
const MULTI_WORDS = new RegExp(String.raw`(\d+)\s+\D+?\s(?:de\s+|d['’]\s*)${NUM}\s*${UNIT}`);
/** "1,5kg", "50cl", "270g - env. 1 pièce", "le pain de 500g". */
const SINGLE = new RegExp(`${NUM}\\s*${UNIT}`);

/**
 * Total content of one sellable item, from Carrefour's `format` then `packaging`.
 * Undefined when neither reads unambiguously: never a guess.
 */
export function parsePack(format: string | null | undefined, packaging: string | null | undefined): Pack | undefined {
  const f = normalize(format);
  const p = normalize(packaging);
  // Sold by the piece ("la pièce", "270g - env. 1 pièce"): the cart counter counts pieces, so the pack must too,
  // whatever weight the format or packaging mentions.
  if (/^la pi[eè]ce$/.test(f)) return { amount: 1, unit: 'piece' };
  return (
    pieces(f, /\benv\.?\s*(\d+)\s*pi[eè]ces?/) ??
    measure(f, true) ??
    pieces(f, /^x\s*(\d+)$|^(\d+)\s*pi[eè]ces?$/) ??
    fromPackaging(p)
  );
}

function fromPackaging(p: string): Pack | undefined {
  if (p === 'le kilo') return { amount: 1000, unit: 'g' };
  return measure(p, false) ?? pieces(p, /^les\s+(\d+)\s+\S+$/);
}

/** Weight or volume, multiplied out for multipacks. `anchored`: the quantity must start the text. */
function measure(text: string, anchored: boolean): Pack | undefined {
  const at = (re: RegExp) => (anchored ? new RegExp(`^${re.source}`) : re);
  const multi = at(MULTI).exec(text) ?? (anchored ? null : MULTI_WORDS.exec(text));
  if (multi) return toPack(Number(multi[1]) * toNumber(multi[2]), multi[3]);
  const single = at(SINGLE).exec(text);
  return single ? toPack(toNumber(single[1]), single[2]) : undefined;
}

function pieces(text: string, re: RegExp): Pack | undefined {
  const match = re.exec(text);
  const count = Number(match?.slice(1).find((g) => g !== undefined));
  return Number.isInteger(count) && count > 0 ? { amount: count, unit: 'piece' } : undefined;
}

function toPack(amount: number, unit: string | undefined): Pack | undefined {
  const base = unit ? TO_BASE[unit] : undefined;
  const value = Math.round(amount * (base?.factor ?? 0) * 1000) / 1000; // drops float noise (0.33 l → 330 ml)
  return base && value > 0 ? { amount: value, unit: base.unit } : undefined;
}

const toNumber = (text: string | undefined) => Number(text?.replace(',', '.'));
const normalize = (text: string | null | undefined) => (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
