import {
  type BasketItem,
  type CartSyncPayload,
  type JobError,
  LlmPayloadSchema,
  LlmResultSchema,
  type Preferences,
  type ProductOffer,
  type ProviderId,
  SearchPayloadSchema,
  SearchResultSchema,
} from '@karto/contracts';
import { z } from 'zod';
import {
  basketStatusStatement,
  getBasket,
  getItemNeeds,
  type ItemOutcome,
  insertItemStatements,
  itemUpdateStatement,
  type NewItem,
  searchOutcomeStatements,
} from '../db/baskets.ts';
import {
  insertJobStatement,
  type JobPatch,
  type JobRow,
  type NewJob,
  parseJsonColumn,
  type SqlGuard,
} from '../db/jobs.ts';
import { getPreferences } from '../db/users.ts';
import { AmendOutputSchema } from '../llm/prompts/amend.ts';
import { ParseOutputSchema } from '../llm/prompts/parse.ts';
import { type AggregatedLine, aggregate } from './aggregate.ts';
import { planAmend } from './amend.ts';
import { type Need, rank } from './rank.ts';

export const PROVIDER: ProviderId = 'carrefour';
const MAX_CANDIDATES = 8;
const SEARCH_MAX_OFFERS = 10;
/** An llm job is tried at most twice (attempts counts claims): one retry on invalid output or relay failure. */
const MAX_LLM_TRIES = 2;
const UsageSchema = LlmResultSchema.shape.usage;

/** What the executor reported for a job it ran. `result` is already validated against JobResultSchemas[kind]. */
export type JobOutcome = { status: 'done'; result: unknown } | { status: 'failed'; error: JobError };

/** How to finish a job: its patch, and the basket statements to commit with it (all guarded by the caller). */
export interface Advance {
  patch: JobPatch;
  statements: D1PreparedStatement[];
}

/** Keeps the first candidates and chooses among them with the ranking rules. */
export function chooseOffer(
  itemId: string,
  offers: ProductOffer[],
  need: Need & { excludeTerms: string[] },
  preferences: Preferences,
): ItemOutcome {
  const candidates = offers.slice(0, MAX_CANDIDATES);
  const ranked = rank(candidates, need, need.excludeTerms, preferences);
  const base = { id: itemId, candidates, reason: ranked.reason, reasonSource: 'rules' as const };
  return ranked.ref === null
    ? { ...base, status: 'unmatched', productRef: null, packs: null }
    : { ...base, status: 'proposed', productRef: ranked.ref, packs: ranked.packs };
}

/** Cart lines for the proposed items, quantities summed per ref. */
export function toCartLines(items: BasketItem[]): CartSyncPayload['lines'] {
  const lines = new Map<string, CartSyncPayload['lines'][number]>();
  for (const item of items) {
    if (item.status !== 'proposed' || !item.productRef || !item.packs) continue;
    const line = lines.get(item.productRef);
    if (line) line.quantity += item.packs;
    else lines.set(item.productRef, { ref: item.productRef, quantity: item.packs, label: item.label });
  }
  return [...lines.values()];
}

/** The LLM output, or why it is unusable. */
function readOutput<T extends z.ZodType>(schema: T, text: string): z.output<T> | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'LLM output is not JSON';
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : `Invalid LLM output: ${z.prettifyError(parsed.error).slice(0, 1000)}`;
}

/** Usage summed over every try, so jobs.usage is the real cost of the job. */
function addUsage(previous: string | null, usage: z.infer<typeof UsageSchema> | undefined): string | null {
  if (!usage) return previous;
  const total = parseJsonColumn(UsageSchema, previous);
  return JSON.stringify({
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
  });
}

/** Unusable output or relay failure: back in the queue once, then failed with the `fail` basket statements. */
function retryOrFail(
  job: JobRow,
  outcome: JobOutcome,
  invalid: string,
  usage: string | null,
  fail: (error: JobError) => D1PreparedStatement[],
): Advance {
  const error: JobError =
    outcome.status === 'failed' ? outcome.error : { code: 'invalid_result', message: invalid, retryable: true };
  if (error.retryable && job.attempts < MAX_LLM_TRIES) {
    // Back in the queue: the relay claims it again.
    const patch: JobPatch = { status: 'pending', claimed_by: null, lease_until: null, progress: null };
    return { patch: { ...patch, error: JSON.stringify(error), usage }, statements: [] };
  }
  return { patch: { status: 'failed', error: JSON.stringify(error), usage }, statements: fail(error) };
}

/** A search job for `items` only: its completion ranks just these items. */
export function searchJob(basketId: string, items: Pick<NewItem, 'id' | 'searchQuery'>[]): NewJob {
  const payload = SearchPayloadSchema.parse({
    provider: PROVIDER,
    items: items.map((item) => ({ itemId: item.id, query: item.searchQuery })),
    refs: [],
    max: SEARCH_MAX_OFFERS,
  });
  return { id: crypto.randomUUID(), basketId, kind: 'provider.search', payload };
}

function newItems(lines: AggregatedLine[], firstPosition: number, sources: boolean): NewItem[] {
  return lines.map((line, index) => ({
    id: crypto.randomUUID(),
    position: firstPosition + index,
    ingredientKey: line.key,
    label: line.label,
    quantity: line.quantity,
    unit: line.unit,
    searchQuery: line.query,
    excludeTerms: line.excludeTerms,
    // Amend lines do not come from the basket inputs.
    sources: sources ? line.sources : [],
  }));
}

/** Parse done: write the aggregated items, queue their search, basket → searching. Else retry once, then fail. */
function advanceParse(userId: string, basketId: string, job: JobRow, outcome: JobOutcome, guard: SqlGuard): Advance {
  const result = outcome.status === 'done' ? LlmResultSchema.parse(outcome.result) : null;
  const usage = addUsage(job.usage, result?.usage);
  const output = result ? readOutput(ParseOutputSchema, result.text) : 'No output';
  if (typeof output === 'string') {
    return retryOrFail(job, outcome, output, usage, (error) => {
      const message =
        error.code === 'invalid_result'
          ? 'Impossible de comprendre la liste. Reformule-la.'
          : "L'analyse de la liste a échoué. Réessaie dans un moment.";
      return [basketStatusStatement(userId, basketId, 'failed', { ...error, message }, guard)];
    });
  }
  const items = newItems(aggregate(output.lines), 0, true);
  return {
    patch: { status: 'done', result: JSON.stringify(result), usage },
    statements: [
      ...insertItemStatements(userId, basketId, items, guard),
      insertJobStatement(userId, searchJob(basketId, items), Date.now(), guard),
      basketStatusStatement(userId, basketId, 'searching', null, guard),
    ],
  };
}

/**
 * Amend done: remove, resize and merge items, add the new ones and search only those (→ searching), or → ready
 * when nothing new. Unusable output or failure: retry once, then the basket goes back to ready, unchanged.
 */
async function advanceAmend(
  userId: string,
  basketId: string,
  job: JobRow,
  outcome: JobOutcome,
  guard: SqlGuard,
): Promise<Advance> {
  const result = outcome.status === 'done' ? LlmResultSchema.parse(outcome.result) : null;
  const usage = addUsage(job.usage, result?.usage);
  const output = result ? readOutput(AmendOutputSchema, result.text) : 'No output';
  const [basket, needs, preferences] = await Promise.all([
    getBasket(userId, basketId),
    getItemNeeds(userId, basketId),
    getPreferences(userId),
  ]);
  const items = (basket?.items ?? []).map((item) => ({
    ...item,
    excludeTerms: needs.get(item.id)?.excludeTerms ?? [],
  }));
  const plan = typeof output === 'string' ? null : planAmend(items, output, preferences);
  if (!plan || (plan.patches.length === 0 && plan.additions.length === 0)) {
    const invalid = typeof output === 'string' ? output : 'Amend output changes nothing in this basket';
    return retryOrFail(job, outcome, invalid, usage, (error) => {
      const message =
        error.code === 'invalid_result'
          ? "Impossible d'appliquer la modification. Reformule-la."
          : 'La modification a échoué. Réessaie dans un moment.';
      return [basketStatusStatement(userId, basketId, 'ready', { ...error, message }, guard)];
    });
  }
  const added = newItems(plan.additions, Math.max(-1, ...items.map((item) => item.position)) + 1, false);
  const statements = [
    ...plan.patches.map(({ itemId, patch }) => itemUpdateStatement(userId, basketId, itemId, patch, guard)),
    ...insertItemStatements(userId, basketId, added, guard),
  ];
  if (added.length > 0) {
    statements.push(
      insertJobStatement(userId, searchJob(basketId, added), Date.now(), guard),
      basketStatusStatement(userId, basketId, 'searching', null, guard),
    );
  } else {
    statements.push(basketStatusStatement(userId, basketId, 'ready', null, guard));
  }
  return { patch: { status: 'done', result: JSON.stringify(result), usage }, statements };
}

/**
 * Finishes a job (done or failed) and moves its basket to the next state. The statements are committed in the
 * same transaction as the patch and must only apply while `guard` holds.
 */
export async function advanceBasket(
  userId: string,
  job: JobRow,
  outcome: JobOutcome,
  guard: SqlGuard,
): Promise<Advance> {
  const patch: JobPatch =
    outcome.status === 'done'
      ? { status: 'done', result: JSON.stringify(outcome.result) }
      : { status: 'failed', error: JSON.stringify(outcome.error) };
  const basketId = job.basket_id;
  if (!basketId) return { patch, statements: [] };

  switch (job.kind) {
    case 'llm': {
      // Step 6 adds 'pick'.
      const { purpose } = LlmPayloadSchema.parse(JSON.parse(job.payload));
      if (purpose === 'amend') return advanceAmend(userId, basketId, job, outcome, guard);
      return advanceParse(userId, basketId, job, outcome, guard);
    }
    case 'provider.search': {
      if (outcome.status === 'failed') {
        return { patch, statements: [basketStatusStatement(userId, basketId, 'failed', outcome.error, guard)] };
      }
      const result = SearchResultSchema.parse(outcome.result);
      const offersByItem = new Map(result.byItem.map((entry) => [entry.itemId, entry.offers]));
      const [needs, preferences] = await Promise.all([getItemNeeds(userId, basketId), getPreferences(userId)]);
      const { items } = SearchPayloadSchema.parse(JSON.parse(job.payload));
      const outcomes = items.map(({ itemId }) =>
        chooseOffer(
          itemId,
          offersByItem.get(itemId) ?? [],
          needs.get(itemId) ?? { quantity: 1, unit: 'piece', excludeTerms: [] },
          preferences,
        ),
      );
      return { patch, statements: searchOutcomeStatements(userId, basketId, result.context.storeRef, outcomes, guard) };
    }
    case 'provider.cart_sync': {
      // A failed push leaves the basket reviewable, so the user can push again.
      if (outcome.status === 'failed') {
        return { patch, statements: [basketStatusStatement(userId, basketId, 'ready', outcome.error, guard)] };
      }
      return { patch, statements: [basketStatusStatement(userId, basketId, 'pushed', null, guard)] };
    }
  }
}
