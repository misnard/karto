import { env } from 'cloudflare:workers';
import type { ProviderId } from '@karto/contracts';

export interface Choice {
  ingredientKey: string;
  productRef: string;
  productLabel: string;
  source: 'validated' | 'replaced';
}

/** The memorized product of this user for each of `keys` that has one, by ingredient key. */
export async function getChoices(
  userId: string,
  provider: ProviderId,
  keys: string[],
): Promise<Map<string, { productRef: string; updatedAt: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT ingredient_key, product_ref, updated_at FROM choices
     WHERE user_id = ? AND provider = ? AND ingredient_key IN (SELECT value FROM json_each(?))`,
  )
    .bind(userId, provider, JSON.stringify(keys))
    .all<{ ingredient_key: string; product_ref: string; updated_at: number }>();
  return new Map(
    results.map((row) => [row.ingredient_key, { productRef: row.product_ref, updatedAt: row.updated_at }]),
  );
}

/**
 * Upserts the choices of this user. Pushing the same product again counts one more use and keeps 'replaced';
 * another product starts over at 1.
 */
export function saveChoiceStatements(userId: string, provider: ProviderId, choices: Choice[]): D1PreparedStatement[] {
  const now = Date.now();
  return choices.map((choice) =>
    env.DB.prepare(
      `INSERT INTO choices (user_id, provider, ingredient_key, product_ref, product_label, source, use_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (user_id, provider, ingredient_key) DO UPDATE SET
         use_count = CASE WHEN product_ref = excluded.product_ref THEN use_count + 1 ELSE 1 END,
         source = CASE WHEN product_ref = excluded.product_ref AND source = 'replaced' THEN source
           ELSE excluded.source END,
         product_ref = excluded.product_ref,
         product_label = excluded.product_label,
         updated_at = excluded.updated_at`,
    ).bind(userId, provider, choice.ingredientKey, choice.productRef, choice.productLabel, choice.source, now),
  );
}
