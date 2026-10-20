import { env } from 'cloudflare:workers';
import {
  AmendBasketRequestSchema,
  type Basket,
  CartSyncPayloadSchema,
  CreateBasketRequestSchema,
  LlmPayloadSchema,
  PatchItemRequestSchema,
  type PushResponse,
} from '@karto/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth.ts';
import {
  createBasket,
  getBasket,
  getBasketInputs,
  getItemNeeds,
  itemUpdateStatement,
  listBaskets,
  retryBasket,
  startPush,
  transitionBasket,
} from '../db/baskets.ts';
import { getLatestBasketJob, insertJobStatement, toJob } from '../db/jobs.ts';
import { getPreferences } from '../db/users.ts';
import { AppError, readBody } from '../errors.ts';
import * as amend from '../llm/prompts/amend.ts';
import { buildUser, jsonSchema, system } from '../llm/prompts/parse.ts';
import { PROVIDER, searchJob, toCartLines } from '../pipeline/advance-basket.ts';
import { editItem } from '../pipeline/amend.ts';

const LimitSchema = z.coerce.number().int().min(1).max(50).default(20);
/** Failed steps that can be retried, and the basket status while they run again. */
const RETRY_STATUS = { llm: 'parsing', 'provider.search': 'searching' } as const;

async function requireBasket(userId: string, basketId: string) {
  const basket = await getBasket(userId, basketId);
  if (!basket) throw new AppError('not_found', 404, 'Basket not found');
  return basket;
}

/** Baskets the user can still change: reviewed, or already pushed (the cart then needs a new push). */
const EDITABLE = ['ready', 'pushed'] as const;

function requireEditable(basket: Basket): void {
  if (basket.status !== 'ready' && basket.status !== 'pushed') {
    throw new AppError('conflict', 409, `Basket is ${basket.status}, it cannot be changed now`);
  }
}

const changedConcurrently = () => new AppError('conflict', 409, 'Basket changed in the meantime');

export const baskets = new Hono<AppEnv>()
  .post('/', async (c) => {
    const { inputs, servings } = await readBody(c, CreateBasketRequestSchema);
    const texts = inputs.map((input) => {
      // Step 4 brings recipe URLs.
      if (input.kind === 'recipe_url') {
        throw new AppError('invalid_request', 400, 'Les liens de recettes ne sont pas encore pris en charge');
      }
      return input;
    });
    const basketId = crypto.randomUUID();
    const payload = LlmPayloadSchema.parse({
      purpose: 'parse',
      model: env.LLM_MODEL,
      system,
      user: buildUser(texts, servings, await getPreferences(c.var.userId)),
      jsonSchema,
    });
    await createBasket(c.var.userId, {
      id: basketId,
      provider: PROVIDER,
      inputs,
      servings,
      job: { id: crypto.randomUUID(), basketId, kind: 'llm', payload },
    });
    // LLM_RUNTIME 'cli' (the only one so far): the job waits for the relay. The 'api' runtime will run it here.
    return c.json(await requireBasket(c.var.userId, basketId), 202);
  })
  .get('/', async (c) => {
    return c.json(await listBaskets(c.var.userId, LimitSchema.parse(c.req.query('limit'))));
  })
  .get('/:id', async (c) => {
    return c.json(await requireBasket(c.var.userId, c.req.param('id')));
  })
  .post('/:id/push', async (c) => {
    const basket = await requireBasket(c.var.userId, c.req.param('id'));
    if (basket.status !== 'ready' && basket.status !== 'pushed') {
      throw new AppError('conflict', 409, `Basket is ${basket.status}, not ready to push`);
    }
    const lines = toCartLines(basket.items);
    if (lines.length === 0) throw new AppError('conflict', 409, 'No proposed product to push');
    const payload = CartSyncPayloadSchema.parse({ provider: basket.provider, lines });
    const jobId = crypto.randomUUID();
    const started = await startPush(c.var.userId, {
      id: jobId,
      basketId: basket.id,
      kind: 'provider.cart_sync',
      payload,
    });
    if (!started) throw new AppError('conflict', 409, 'Push already running');
    return c.json({ jobId } satisfies PushResponse);
  })
  .post('/:id/retry', async (c) => {
    const basket = await requireBasket(c.var.userId, c.req.param('id'));
    if (basket.status === 'ready' || basket.status === 'pushed') {
      // A usable basket: search its unmatched items again, and only them.
      const unmatched = basket.items.filter((item) => item.status === 'unmatched');
      if (unmatched.length === 0) throw new AppError('conflict', 409, 'No unmatched item to search again');
      const needs = await getItemNeeds(c.var.userId, basket.id);
      const search = searchJob(
        basket.id,
        unmatched.map((item) => ({ id: item.id, searchQuery: needs.get(item.id)?.searchQuery ?? item.label })),
      );
      const reset = {
        status: 'pending',
        product_ref: null,
        packs: null,
        candidates: '[]',
        reason: null,
        reason_source: null,
      } as const;
      const started = await transitionBasket(c.var.userId, basket.id, [...EDITABLE], 'searching', (guard) => [
        ...unmatched.map((item) => itemUpdateStatement(c.var.userId, basket.id, item.id, reset, guard)),
        insertJobStatement(c.var.userId, search, Date.now(), guard),
      ]);
      if (!started) throw changedConcurrently();
      return c.json(await requireBasket(c.var.userId, basket.id), 202);
    }
    const job = await getLatestBasketJob(c.var.userId, basket.id);
    // Only a failed parse (no items yet) or a failed search; a failed push already sends the basket back to ready.
    const status =
      basket.status === 'failed' && job?.status === 'failed' && job.kind !== 'provider.cart_sync'
        ? RETRY_STATUS[job.kind]
        : null;
    if (!job || !status || (job.kind === 'llm' && basket.items.length > 0)) {
      throw new AppError('conflict', 409, `Nothing to retry: basket is ${basket.status}`);
    }
    // Same payload, new job: attempts start again from zero.
    const { kind, payload } = toJob(job);
    const retried = await retryBasket(
      c.var.userId,
      { id: crypto.randomUUID(), basketId: basket.id, kind, payload },
      status,
    );
    if (!retried) throw new AppError('conflict', 409, 'Basket is no longer failed');
    return c.json(await requireBasket(c.var.userId, basket.id), 202);
  })
  .patch('/:id/items/:itemId', async (c) => {
    const op = await readBody(c, PatchItemRequestSchema);
    const basket = await requireBasket(c.var.userId, c.req.param('id'));
    requireEditable(basket);
    const item = basket.items.find((i) => i.id === c.req.param('itemId'));
    if (!item) throw new AppError('not_found', 404, 'Item not found');
    const patch = editItem(item, op);
    // Any edit makes a pushed basket ready again: the cart must be pushed again.
    const edited = await transitionBasket(c.var.userId, basket.id, [...EDITABLE], 'ready', (guard) => [
      itemUpdateStatement(c.var.userId, basket.id, item.id, patch, guard),
    ]);
    if (!edited) throw changedConcurrently();
    return c.json(await requireBasket(c.var.userId, basket.id));
  })
  .post('/:id/amend', async (c) => {
    const { text } = await readBody(c, AmendBasketRequestSchema);
    const basket = await requireBasket(c.var.userId, c.req.param('id'));
    requireEditable(basket);
    const items = basket.items
      .filter((item) => item.status !== 'removed')
      .map((item) => ({
        itemId: item.id,
        label: item.label,
        key: item.ingredientKey,
        quantity: item.quantity,
        unit: item.unit,
      }));
    const payload = LlmPayloadSchema.parse({
      purpose: 'amend',
      model: env.LLM_MODEL,
      system: amend.system,
      user: amend.buildUser(
        items,
        text,
        await getPreferences(c.var.userId),
        (await getBasketInputs(c.var.userId, basket.id))?.servings,
      ),
      jsonSchema: amend.jsonSchema,
    });
    const job = { id: crypto.randomUUID(), basketId: basket.id, kind: 'llm' as const, payload };
    // 'parsing' while the relay runs it; the items stay visible.
    const started = await transitionBasket(c.var.userId, basket.id, [...EDITABLE], 'parsing', (guard) => [
      insertJobStatement(c.var.userId, job, Date.now(), guard),
    ]);
    if (!started) throw changedConcurrently();
    return c.json(await requireBasket(c.var.userId, basket.id), 202);
  });
