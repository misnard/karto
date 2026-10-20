import { env } from 'cloudflare:workers';
import { type Basket, BasketSchema, LlmPayloadSchema, type ProductOffer } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import * as pick from '../llm/prompts/pick.ts';
import { MEMORY_UNAVAILABLE } from '../pipeline/memory.ts';
import {
  call,
  claimProviderJob,
  completeSearch,
  expectNoContent,
  llmResult,
  offer,
  parsedBasket,
  parseLine,
  readJson,
  relayClaim,
  relayComplete,
  seedUser,
} from '../test/helpers.ts';

const LAIT: ProductOffer[] = [
  { ...offer('L1', 99), name: 'Lait demi-écrémé' },
  { ...offer('L2', 120), name: 'Lait demi-écrémé bio' },
];
const OEUF: ProductOffer[] = [offer('O1', 250)];
const PAIN: ProductOffer[] = [offer('P1', 90), offer('P2', 130)];
const LINES = [parseLine('lait', { unit: 'ml', quantity: 1000 }), parseLine('oeuf')];

async function getBasket(token: string, id: string): Promise<Basket> {
  return readJson(await call('GET', `/v1/baskets/${id}`, { token }), BasketSchema);
}

function byLabel(basket: Basket) {
  return Object.fromEntries(basket.items.map((item) => [item.label, item]));
}

async function jobCounts(basketId: string): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare('SELECT kind, COUNT(*) AS n FROM jobs WHERE basket_id = ? GROUP BY kind')
    .bind(basketId)
    .all<{ kind: string; n: number }>();
  return Object.fromEntries(results.map((row) => [row.kind, row.n]));
}

async function choices(userId: string) {
  const { results } = await env.DB.prepare(
    'SELECT ingredient_key, product_ref, product_label, source, use_count FROM choices WHERE user_id = ? ORDER BY 1',
  )
    .bind(userId)
    .all();
  return results;
}

/** Pushes the basket, then plays the executor: every line set. */
async function pushAndSync(token: string, basketId: string): Promise<void> {
  expect((await call('POST', `/v1/baskets/${basketId}/push`, { token })).status).toBe(200);
  const sync = await claimProviderJob(token);
  if (sync.kind !== 'provider.cart_sync') throw new Error(`unexpected job ${sync.kind}`);
  const lines = sync.payload.lines.map(({ ref, quantity }) => ({ ref, outcome: 'set', before: 0, after: quantity }));
  const result = { context: { provider: 'carrefour', storeRef: 'store-1' }, lines };
  await expectNoContent(await call('POST', `/v1/jobs/${sync.id}/complete`, { token, body: { result } }));
}

/** Claims the next search and completes it: offers per item label, `byRef` for the refreshed refs. */
async function completeRefresh(
  token: string,
  basket: Basket,
  byRef: ProductOffer[],
  offersByLabel: Record<string, ProductOffer[]> = {},
) {
  const search = await claimProviderJob(token);
  if (search.kind !== 'provider.search') throw new Error(`unexpected job ${search.kind}`);
  const labels = new Map(basket.items.map((item) => [item.id, item.label]));
  const byItem = search.payload.items.map(({ itemId }) => ({
    itemId,
    offers: offersByLabel[labels.get(itemId) ?? ''] ?? [],
  }));
  const result = { context: { provider: 'carrefour', storeRef: 'store-1' }, byItem, byRef };
  await expectNoContent(await call('POST', `/v1/jobs/${search.id}/complete`, { token, body: { result } }));
  return search.payload;
}

/** Plays the relay on the pending pick of a matching basket. */
async function completePick(token: string, basketId: string, choose: (itemId: string) => string) {
  const matching = await getBasket(token, basketId);
  expect(matching).toMatchObject({ status: 'matching', job: { kind: 'llm' } });
  const job = await relayClaim(matching.job?.id ?? '');
  const given = pick.givenLines(LlmPayloadSchema.parse(job.payload).user);
  const picks = given.map(({ itemId }) => ({ itemId, ref: choose(itemId), alternatives: [], reason: 'Bon choix' }));
  await expectNoContent(await relayComplete(job.id, llmResult({ picks })));
  return given.map((line) => line.itemId);
}

describe('memory', () => {
  it('memorizes a push, then replays the same list with one refresh, no search query and no pick', async () => {
    const { userId, token } = await seedUser();
    const first = await parsedBasket(token, LINES);
    // The rules choose L1 (cheapest), the pick fails so they stay; the user replaces it with L2.
    const ready = await completeSearch(token, first.id, { lait: LAIT, oeuf: OEUF });
    const lait = byLabel(ready).lait;
    expect(lait).toMatchObject({ productRef: 'L1', reasonSource: 'rules' });
    const choose = { op: 'choose', ref: 'L2' };
    expect((await call('PATCH', `/v1/baskets/${first.id}/items/${lait?.id}`, { token, body: choose })).status).toBe(
      200,
    );
    await pushAndSync(token, first.id);
    expect(await choices(userId)).toEqual([
      {
        ingredient_key: 'lait',
        product_ref: 'L2',
        product_label: 'Lait demi-écrémé bio',
        source: 'replaced',
        use_count: 1,
      },
      { ingredient_key: 'oeuf', product_ref: 'O1', product_label: 'Product O1', source: 'validated', use_count: 1 },
    ]);

    const second = await parsedBasket(token, LINES);
    const payload = await completeRefresh(token, second, [LAIT[1], ...OEUF] as ProductOffer[]);
    expect(payload).toMatchObject({ items: [], refs: ['L2', 'O1'] });
    const replayed = await getBasket(token, second.id);
    expect(replayed.status).toBe('ready');
    expect(await jobCounts(second.id)).toEqual({ llm: 1, 'provider.search': 1 });
    expect(byLabel(replayed).lait).toMatchObject({
      status: 'proposed',
      productRef: 'L2',
      packs: 1,
      reasonSource: 'memory',
      reason: expect.stringMatching(/^Ton choix du \d{1,2} \S+$/),
    });
    expect(byLabel(replayed).oeuf).toMatchObject({ productRef: 'O1', reasonSource: 'memory' });
    expect(replayed.totalCents).toBe(120 + 250);

    await pushAndSync(token, second.id);
    const counts = (await choices(userId)).map((row) => [row.ingredient_key, row.source, row.use_count]);
    expect(counts).toEqual([
      ['lait', 'replaced', 2],
      ['oeuf', 'validated', 2],
    ]);

    // Another user's memory is never used.
    const other = await seedUser('Other');
    const theirs = await parsedBasket(other.token, LINES);
    expect(await completeRefresh(other.token, theirs, [], { lait: LAIT, oeuf: OEUF })).toMatchObject({ refs: [] });
  });

  it('searches again and picks a line whose memorized product is unavailable, with a note', async () => {
    const { userId, token } = await seedUser();
    const now = Date.now();
    for (const [key, ref] of [
      ['lait', 'L9'],
      ['oeuf', 'O1'],
    ]) {
      await env.DB.prepare(
        `INSERT INTO choices (user_id, provider, ingredient_key, product_ref, product_label, source, updated_at)
         VALUES (?, 'carrefour', ?, ?, ?, 'validated', ?)`,
      )
        .bind(userId, key, ref, ref, now)
        .run();
    }
    const parsed = await parsedBasket(token, [...LINES, parseLine('pain')]);
    const unavailable = { ...offer('L9', 110), available: false };
    const first = await completeRefresh(token, parsed, [unavailable, ...OEUF], { pain: PAIN });
    expect(first).toMatchObject({ items: [{ query: 'pain' }], refs: ['L9', 'O1'] });

    // The milk is searched again; the pick waits for it.
    const searching = await getBasket(token, parsed.id);
    expect(searching).toMatchObject({ status: 'searching', job: { kind: 'provider.search', status: 'pending' } });
    expect(byLabel(searching).lait).toMatchObject({ status: 'pending', reason: MEMORY_UNAVAILABLE });
    expect(byLabel(searching).oeuf).toMatchObject({ status: 'proposed', reasonSource: 'memory' });
    const second = await completeRefresh(token, searching, [], { lait: LAIT });
    expect(second).toMatchObject({ items: [{ query: 'lait' }], refs: [] });

    const picked = await completePick(token, parsed.id, (itemId) =>
      itemId === byLabel(parsed).lait?.id ? 'L2' : 'P2',
    );
    expect(picked.sort()).toEqual([byLabel(parsed).lait?.id, byLabel(parsed).pain?.id].sort());
    const ready = await getBasket(token, parsed.id);
    expect(ready.status).toBe('ready');
    expect(byLabel(ready).lait).toMatchObject({
      productRef: 'L2',
      reasonSource: 'llm',
      reason: `${MEMORY_UNAVAILABLE} · Bon choix`,
    });
    expect(byLabel(ready).pain).toMatchObject({ productRef: 'P2', reason: 'Bon choix' });
    expect(await jobCounts(parsed.id)).toEqual({ llm: 2, 'provider.search': 2 });
  });

  it('fails the basket when the refresh of memorized products fails', async () => {
    const { userId, token } = await seedUser();
    await env.DB.prepare(
      `INSERT INTO choices (user_id, provider, ingredient_key, product_ref, product_label, source, updated_at)
       VALUES (?, 'carrefour', 'oeuf', 'O1', 'Oeufs', 'validated', ?)`,
    )
      .bind(userId, Date.now())
      .run();
    const parsed = await parsedBasket(token, [parseLine('oeuf')]);
    const search = await claimProviderJob(token);
    expect(search.payload).toMatchObject({ items: [], refs: ['O1'] });
    const body = { error: { code: 'network', message: 'tab gone', retryable: true } };
    await expectNoContent(await call('POST', `/v1/jobs/${search.id}/fail`, { token, body }));
    expect(await getBasket(token, parsed.id)).toMatchObject({ status: 'failed' });
  });
});
