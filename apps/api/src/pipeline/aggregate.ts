/** Deterministic aggregation of LLM parse lines. Pure TypeScript: the eval script imports it from Node. */
import type { Unit } from '@karto/contracts';
import type { ParseLine } from '../llm/prompts/parse.ts';

export interface AggregatedLine {
  key: string;
  label: string;
  quantity: number;
  unit: Unit;
  query: string;
  excludeTerms: string[];
  /** Indexes of the inputs the line comes from. */
  sources: number[];
}

/**
 * Merges lines with the same key (case-insensitive). Same unit: quantities are summed. Pieces with a known
 * weight are converted to grams when the key also has grams. Other unit mixes stay separate lines.
 * First-seen order, label and query are kept. Pieces are rounded up, grams and millilitres to the unit.
 */
export function aggregate(lines: ParseLine[]): AggregatedLine[] {
  const groups = new Map<string, ParseLine[]>();
  for (const line of lines) {
    const key = line.key.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups].flatMap(([key, group]) => {
    const hasGrams = group.some((line) => line.unit === 'g');
    const byUnit = new Map<Unit, AggregatedLine>();
    for (const line of group) {
      const weight = hasGrams && line.unit === 'piece' ? line.pieceWeightG : null;
      const unit = weight ? 'g' : line.unit;
      const quantity = weight ? line.quantity * weight : line.quantity;
      const merged = byUnit.get(unit);
      if (merged) {
        merged.quantity += quantity;
        merged.excludeTerms.push(...line.excludeTerms);
        merged.sources.push(line.sourceIndex);
      } else {
        const { label, query, excludeTerms, sourceIndex } = line;
        byUnit.set(unit, {
          key,
          label,
          quantity,
          unit,
          query,
          excludeTerms: [...excludeTerms],
          sources: [sourceIndex],
        });
      }
    }
    return [...byUnit.values()].map((line) => ({
      ...line,
      // The epsilon keeps float sums like 2.2 + 0.8 from rounding up to 4.
      quantity: line.unit === 'piece' ? Math.ceil(line.quantity - 1e-9) : Math.max(1, Math.round(line.quantity)),
      excludeTerms: [...new Set(line.excludeTerms.map((term) => term.trim().toLowerCase()).filter(Boolean))].slice(
        0,
        8,
      ),
      sources: [...new Set(line.sources)].sort((a, b) => a - b),
    }));
  });
}
