import { env } from 'cloudflare:workers';
import {
  type Basket,
  BasketInputSchema,
  type BasketItem,
  type BasketStatus,
  type BasketSummary,
  type ItemStatus,
  type JobError,
  JobErrorSchema,
  type ProductOffer,
  ProductOfferSchema,
  type ProviderId,
  type ReasonSource,
  type Unit,
} from '@karto/contracts';
import { z } from 'zod';
import {
  getLatestBasketJob,
  insertJobStatement,
  type NewJob,
  parseJsonColumn,
  type SqlGuard,
  toJobSummary,
} from './jobs.ts';

interface BasketRow {
  id: string;
  provider: ProviderId;
  store_ref: string | null;
  status: BasketStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  total_cents: number;
  item_count: number;
}

export interface ItemRow {
  id: string;
  position: number;
  ingredient_key: string;
  label: string;
  quantity: number;
  unit: Unit;
  status: ItemStatus;
  product_ref: string | null;
  packs: number | null;
  candidates: string;
  reason: string | null;
  reason_source: ReasonSource | null;
}

export interface NewItem {
  id: string;
  position: number;
  ingredientKey: string;
  label: string;
  quantity: number;
  unit: Unit;
  searchQuery: string;
  excludeTerms: string[];
  sources: number[];
  /** The memorized product: the item waits for its refresh instead of a search. */
  memory?: { productRef: string; reason: string };
}

export interface ItemOutcome {
  id: string;
  status: ItemStatus;
  productRef: string | null;
  packs: number | null;
  candidates: ProductOffer[];
  reason: string;
  reasonSource: ReasonSource;
}

const CandidatesSchema = z.array(ProductOfferSchema);
const TermsSchema = z.array(z.string());
/**
 * The inputs column: `{inputs, servings?, scales?}`, `scales[i]` multiplying the parsed quantities of input i
 * (fetched recipes). Rows written before servings was stored are a bare array.
 */
const StoredInputsSchema = z.union([
  z.strictObject({
    inputs: z.array(BasketInputSchema),
    servings: z.int().min(1).max(20).optional(),
    scales: z.array(z.number().positive()).optional(),
  }),
  z.array(BasketInputSchema).transform((inputs) => ({ inputs, servings: undefined, scales: undefined })),
]);
type StoredInputs = z.output<typeof StoredInputsSchema>;

/** Basket columns plus derived totals. Total = Σ over proposed items of (chosen candidate's priceCents ?? 0) × packs. */
const BASKET_SELECT = `
  SELECT b.id, b.provider, b.store_ref, b.status, b.error, b.created_at, b.updated_at,
    (SELECT COALESCE(SUM(i.packs * COALESCE((
        SELECT json_extract(c.value, '$.priceCents') FROM json_each(i.candidates) c
        WHERE json_extract(c.value, '$.ref') = i.product_ref LIMIT 1), 0)), 0)
      FROM basket_items i WHERE i.basket_id = b.id AND i.status = 'proposed') AS total_cents,
    (SELECT COUNT(*) FROM basket_items i WHERE i.basket_id = b.id AND i.status != 'removed') AS item_count
  FROM baskets b`;

/** Creates a basket in 'parsing' with its parse job. Items are written once the parse is done. */
export async function createBasket(
  userId: string,
  basket: StoredInputs & { id: string; provider: ProviderId; job: NewJob },
): Promise<void> {
  const now = Date.now();
  const { inputs, servings, scales } = basket;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO baskets (id, user_id, provider, status, inputs, created_at, updated_at)
       VALUES (?, ?, ?, 'parsing', ?, ?, ?)`,
    ).bind(basket.id, userId, basket.provider, JSON.stringify({ inputs, servings, scales }), now, now),
    insertJobStatement(userId, basket.job, now),
  ]);
}

/** What the user typed to create a basket of this user, for how many people, and the scales of its recipes. */
export async function getBasketInputs(userId: string, basketId: string): Promise<StoredInputs | null> {
  const inputs = await env.DB.prepare('SELECT inputs FROM baskets WHERE id = ? AND user_id = ?')
    .bind(basketId, userId)
    .first<string>('inputs');
  return inputs === null ? null : StoredInputsSchema.parse(JSON.parse(inputs));
}

/** Inserts pending items into a basket of this user, while `guard` holds. A memorized item gets its product ref. */
export function insertItemStatements(
  userId: string,
  basketId: string,
  items: NewItem[],
  guard: SqlGuard,
): D1PreparedStatement[] {
  return items.map((item) =>
    env.DB.prepare(
      `INSERT INTO basket_items
         (id, basket_id, position, ingredient_key, label, quantity, unit, sources, search_query, exclude_terms, status,
          product_ref, reason, reason_source)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM baskets WHERE id = ? AND user_id = ?) AND ${guard.sql}`,
    ).bind(
      item.id,
      basketId,
      item.position,
      item.ingredientKey,
      item.label,
      item.quantity,
      item.unit,
      JSON.stringify(item.sources),
      item.searchQuery,
      JSON.stringify(item.excludeTerms),
      item.memory?.productRef ?? null,
      item.memory?.reason ?? null,
      item.memory ? 'memory' : null,
      basketId,
      userId,
      ...guard.params,
    ),
  );
}

export interface ItemNeed {
  label: string;
  status: ItemStatus;
  quantity: number;
  unit: Unit;
  searchQuery: string;
  excludeTerms: string[];
  productRef: string | null;
  reason: string | null;
  reasonSource: ReasonSource | null;
}

/** What each item of a basket of this user needs, by item id: quantity, unit, search query, exclude terms... */
export async function getItemNeeds(userId: string, basketId: string): Promise<Map<string, ItemNeed>> {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.label, i.status, i.quantity, i.unit, i.search_query, i.exclude_terms, i.product_ref, i.reason,
       i.reason_source
     FROM basket_items i JOIN baskets b ON b.id = i.basket_id WHERE i.basket_id = ? AND b.user_id = ?`,
  )
    .bind(basketId, userId)
    .all<
      Pick<ItemRow, 'id' | 'label' | 'status' | 'quantity' | 'unit' | 'product_ref' | 'reason' | 'reason_source'> & {
        search_query: string;
        exclude_terms: string;
      }
    >();
  return new Map(
    results.map((row) => [
      row.id,
      {
        label: row.label,
        status: row.status,
        quantity: row.quantity,
        unit: row.unit,
        searchQuery: row.search_query,
        excludeTerms: TermsSchema.parse(JSON.parse(row.exclude_terms)),
        productRef: row.product_ref,
        reason: row.reason,
        reasonSource: row.reason_source,
      },
    ]),
  );
}

export async function getBasket(userId: string, basketId: string): Promise<Basket | null> {
  const [row, items, job] = await Promise.all([
    env.DB.prepare(`${BASKET_SELECT} WHERE b.id = ? AND b.user_id = ?`).bind(basketId, userId).first<BasketRow>(),
    env.DB.prepare(
      `SELECT i.* FROM basket_items i JOIN baskets b ON b.id = i.basket_id
       WHERE i.basket_id = ? AND b.user_id = ? ORDER BY i.position`,
    )
      .bind(basketId, userId)
      .all<ItemRow>(),
    getLatestBasketJob(userId, basketId),
  ]);
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    storeRef: row.store_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.results.map(toBasketItem),
    totalCents: row.total_cents,
    job: job ? toJobSummary(job) : null,
    error: parseJsonColumn(JobErrorSchema, row.error)?.message ?? null,
  };
}

export async function listBaskets(userId: string, limit: number): Promise<BasketSummary[]> {
  const { results } = await env.DB.prepare(
    `${BASKET_SELECT} WHERE b.user_id = ? ORDER BY b.created_at DESC, b.rowid DESC LIMIT ?`,
  )
    .bind(userId, limit)
    .all<BasketRow>();
  return results.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    totalCents: row.total_cents,
    itemCount: row.item_count,
  }));
}

/** Stores the search outcome of every item and moves the basket to `status`, while `guard` holds. */
export function searchOutcomeStatements(
  userId: string,
  basketId: string,
  storeRef: string,
  outcomes: ItemOutcome[],
  status: 'searching' | 'matching' | 'ready',
  guard: SqlGuard,
): D1PreparedStatement[] {
  return [
    ...outcomes.map((o) =>
      env.DB.prepare(
        `UPDATE basket_items SET status = ?, product_ref = ?, packs = ?, candidates = ?, reason = ?, reason_source = ?
         WHERE id = ? AND basket_id = (SELECT id FROM baskets WHERE id = ? AND user_id = ?) AND ${guard.sql}`,
      ).bind(
        o.status,
        o.productRef,
        o.packs,
        JSON.stringify(o.candidates),
        o.reason,
        o.reasonSource,
        o.id,
        basketId,
        userId,
        ...guard.params,
      ),
    ),
    env.DB.prepare(
      `UPDATE baskets SET status = ?, store_ref = ?, error = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND ${guard.sql}`,
    ).bind(status, storeRef, Date.now(), basketId, userId, ...guard.params),
  ];
}

export function basketStatusStatement(
  userId: string,
  basketId: string,
  status: BasketStatus,
  error: JobError | null,
  guard: SqlGuard,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE baskets SET status = ?, error = ?, updated_at = ? WHERE id = ? AND user_id = ? AND ${guard.sql}`,
  ).bind(status, error && JSON.stringify(error), Date.now(), basketId, userId, ...guard.params);
}

/**
 * Moves a basket of this user from one of `from` to `to`, with `statements` in the same transaction. The
 * statements must carry `guard` (the basket is still in `from`): they run first, so either everything applies,
 * or nothing does and false is returned (a concurrent change won).
 */
export async function transitionBasket(
  userId: string,
  basketId: string,
  from: BasketStatus[],
  to: BasketStatus,
  statements: (guard: SqlGuard) => D1PreparedStatement[],
): Promise<boolean> {
  const inFrom = 'id = ? AND user_id = ? AND status IN (SELECT value FROM json_each(?))';
  const guard = {
    sql: `EXISTS (SELECT 1 FROM baskets WHERE ${inFrom})`,
    params: [basketId, userId, JSON.stringify(from)],
  };
  const results = await env.DB.batch([
    ...statements(guard),
    env.DB.prepare(`UPDATE baskets SET status = ?, error = NULL, updated_at = ? WHERE ${inFrom}`).bind(
      to,
      Date.now(),
      basketId,
      userId,
      JSON.stringify(from),
    ),
  ]);
  return results.at(-1)?.meta.changes === 1;
}

/** Retries the failed step of a basket: `job` is queued again and the basket leaves 'failed'. */
export async function retryBasket(userId: string, job: NewJob, status: 'parsing' | 'searching'): Promise<boolean> {
  return transitionBasket(userId, job.basketId, ['failed'], status, (guard) => [
    insertJobStatement(userId, job, Date.now(), guard),
  ]);
}

export type ItemPatch = Partial<
  Pick<ItemRow, 'status' | 'quantity' | 'unit' | 'product_ref' | 'packs' | 'candidates' | 'reason' | 'reason_source'>
>;

/** Updates one item of a basket of this user, while `guard` holds. */
export function itemUpdateStatement(
  userId: string,
  basketId: string,
  itemId: string,
  patch: ItemPatch,
  guard: SqlGuard,
): D1PreparedStatement {
  const entries = Object.entries(patch);
  return env.DB.prepare(
    `UPDATE basket_items SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
     WHERE id = ? AND basket_id = (SELECT id FROM baskets WHERE id = ? AND user_id = ?) AND ${guard.sql}`,
  ).bind(...entries.map(([, value]) => value), itemId, basketId, userId, ...guard.params);
}

/**
 * Creates the cart sync job and moves the basket to pushing, with `statements` in the same transaction. Returns
 * false, and applies nothing, when a push is already active.
 */
export async function startPush(userId: string, job: NewJob, statements: D1PreparedStatement[] = []): Promise<boolean> {
  const now = Date.now();
  try {
    await env.DB.batch([
      insertJobStatement(userId, job, now),
      env.DB.prepare(
        `UPDATE baskets SET status = 'pushing', error = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
      ).bind(now, job.basketId, userId),
      ...statements,
    ]);
    return true;
  } catch (err) {
    // jobs_one_active_cart_sync: at most one pending/running/paused cart sync per user.
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) return false;
    throw err;
  }
}

function toBasketItem(row: ItemRow): BasketItem {
  return {
    id: row.id,
    position: row.position,
    ingredientKey: row.ingredient_key,
    label: row.label,
    quantity: row.quantity,
    unit: row.unit,
    status: row.status,
    productRef: row.product_ref,
    packs: row.packs,
    candidates: CandidatesSchema.parse(JSON.parse(row.candidates)),
    reason: row.reason,
    reasonSource: row.reason_source,
  };
}
