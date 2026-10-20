import { env } from 'cloudflare:workers';
import { type Basket, BasketSchema, LlmPayloadSchema, type ProductOffer, PushResponseSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import * as pick from '../llm/prompts/pick.ts';
import {
  call,
  claimProviderJob,
  completeSearch,
  createBasket,
  expectError,
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

async function getBasket(token: string, id: string): Promise<Basket> {
  return readJson(await call('GET', `/v1/baskets/${id}`, { token }), BasketSchema);
}

async function countJobs(basketId: string, kind: string): Promise<unknown> {
  return env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE basket_id = ? AND kind = ?')
    .bind(basketId, kind)
    .first('n');
}

function byLabel(basket: Basket) {
  return Object.fromEntries(basket.items.map((item) => [item.label, item]));
}

/** Claims the user's next search and completes it with `offers` per item id. */
async function completeSearchById(token: string, offers: (itemId: string) => ProductOffer[]): Promise<void> {
  const search = await claimProviderJob(token);
  if (search.kind !== 'provider.search') throw new Error(`unexpected job ${search.kind}`);
  const byItem = search.payload.items.map(({ itemId }) => ({ itemId, offers: offers(itemId) }));
  const result = { context: { provider: 'carrefour', storeRef: 'store-1' }, byItem, byRef: [] };
  await expectNoContent(await call('POST', `/v1/jobs/${search.id}/complete`, { token, body: { result } }));
}

const LAIT: ProductOffer[] = [
  { ...offer('L1', 99), name: 'Lait de coco' },
  { ...offer('L2', 120), name: 'Lait demi-écrémé' },
  { ...offer('L3', 105), name: 'Lait entier' },
  { ...offer('L4', 150), name: 'Lait demi-écrémé bio' },
];
const OEUF: ProductOffer[] = [offer('O1', 250)];

describe('grouped pick', () => {
  it('makes a 30-line basket with 2 llm jobs: parse, then one pick for the lines with a choice to make', async () => {
    const { token } = await seedUser();
    const lines = Array.from({ length: 30 }, (_, i) => parseLine(`article ${i + 1}`));
    const parsed = await parsedBasket(token, lines);
    const single = parsed.items[29]?.id;
    // Three offers per line, except the last one: a single offer leaves nothing to choose.
    await completeSearchById(token, (itemId) =>
      itemId === single ? [offer(`${itemId}-a`, 100)] : ['a', 'b', 'c'].map((s, i) => offer(`${itemId}-${s}`, 100 + i)),
    );

    const matching = await getBasket(token, parsed.id);
    expect(matching).toMatchObject({ status: 'matching', job: { kind: 'llm', status: 'pending' } });
    // The rules already chose: they stay if the pick fails.
    expect(matching.items.every((item) => item.status === 'proposed' && item.reasonSource === 'rules')).toBe(true);
    const job = await relayClaim(matching.job?.id ?? '');
    const payload = LlmPayloadSchema.parse(job.payload);
    expect(payload).toMatchObject({
      purpose: 'pick',
      model: 'test-model',
      system: pick.system,
      jsonSchema: pick.jsonSchema,
    });
    const given = pick.givenLines(payload.user);
    expect(given.map((line) => line.itemId)).toEqual(parsed.items.slice(0, 29).map((item) => item.id));
    expect(given.every((line) => line.candidates.length === 3)).toBe(true);

    // The LLM takes the second offer of every line, the first one as its alternative.
    const picks = given.map(({ itemId }) => ({
      itemId,
      ref: `${itemId}-b`,
      alternatives: [`${itemId}-a`],
      reason: 'Meilleur choix',
    }));
    await expectNoContent(await relayComplete(job.id, llmResult({ picks })));

    const ready = await getBasket(token, parsed.id);
    expect(ready.status).toBe('ready');
    expect(await countJobs(parsed.id, 'llm')).toBe(2);
    const proposed = ready.items.filter((item) => item.status === 'proposed');
    expect(proposed).toHaveLength(30);
    expect(proposed.every((item) => item.reason && item.reasonSource)).toBe(true);
    const first = ready.items[0];
    expect(first).toMatchObject({
      productRef: `${first?.id}-b`,
      packs: 1,
      reason: 'Meilleur choix',
      reasonSource: 'llm',
    });
    expect(first?.candidates.map((c) => c.ref)).toEqual(['b', 'a', 'c'].map((s) => `${first?.id}-${s}`));
    expect(ready.items[29]).toMatchObject({ productRef: `${single}-a`, reasonSource: 'rules' });
    expect(ready.totalCents).toBe(29 * 101 + 100);
  });

  it('retries an output that picks a ref it was not given, then keeps the rules choices', async () => {
    const { token } = await seedUser();
    const parsed = await parsedBasket(token, [parseLine('lait', { excludeTerms: ['coco'] }), parseLine('oeuf')]);
    const { lait, oeuf } = byLabel(parsed);
    await completeSearchById(token, (itemId) => (itemId === lait?.id ? LAIT : OEUF));
    const job = await relayClaim((await getBasket(token, parsed.id)).job?.id ?? '');
    // The excluded coco milk was not given (hard filters), the eggs had a single offer. The rules' choice comes first.
    expect(pick.givenLines(LlmPayloadSchema.parse(job.payload).user)).toEqual([
      { itemId: lait?.id, candidates: [{ ref: 'L3' }, { ref: 'L2' }, { ref: 'L4' }] },
    ]);

    const coco = { picks: [{ itemId: lait?.id, ref: 'L1', alternatives: [], reason: 'Le moins cher' }] };
    await expectNoContent(await relayComplete(job.id, llmResult(coco)));
    expect(await getBasket(token, parsed.id)).toMatchObject({ status: 'matching' });
    await relayClaim(job.id);
    const eggs = { picks: [{ itemId: oeuf?.id, ref: 'O1', alternatives: [], reason: 'Seul choix' }] };
    await expectNoContent(await relayComplete(job.id, llmResult(eggs)));

    const ready = await getBasket(token, parsed.id);
    expect(ready).toMatchObject({ status: 'ready', error: null });
    expect(byLabel(ready).lait).toMatchObject({
      productRef: 'L3',
      reasonSource: 'rules',
      reason: 'Le moins cher pour 1 pièce',
    });
    const row = await env.DB.prepare('SELECT status, attempts, usage FROM jobs WHERE id = ?').bind(job.id).first();
    expect(row).toEqual({ status: 'failed', attempts: 2, usage: '{"inputTokens":2000,"outputTokens":400}' });
  });

  it('updates the total when an alternative replaces the product', async () => {
    const { token } = await seedUser();
    const parsed = await parsedBasket(token, [parseLine('lait', { excludeTerms: ['coco'] }), parseLine('oeuf')]);
    const itemId = byLabel(parsed).lait?.id ?? '';
    const answer = { picks: [{ itemId, ref: 'L2', alternatives: ['L4', 'L3'], reason: 'Le demi-écrémé demandé' }] };
    const ready = await completeSearch(token, parsed.id, { lait: LAIT, oeuf: OEUF }, answer);
    expect(byLabel(ready).lait?.candidates.map((c) => c.ref)).toEqual(['L2', 'L4', 'L3', 'L1']);
    expect(ready.totalCents).toBe(120 + 250);

    const res = await call('PATCH', `/v1/baskets/${ready.id}/items/${itemId}`, {
      token,
      body: { op: 'choose', ref: 'L4' },
    });
    const chosen = await readJson(res, BasketSchema);
    expect(byLabel(chosen).lait).toMatchObject({ productRef: 'L4', reasonSource: 'user', reason: 'Ton choix' });
    expect(chosen.totalCents).toBe(150 + 250);
  });
});

describe('POST /v1/baskets/:id/items/:itemId/search', () => {
  const search = (token: string, basket: Basket, itemId: string | undefined, query: unknown) =>
    call('POST', `/v1/baskets/${basket.id}/items/${itemId}/search`, { token, body: { query } });

  /** lait → L3 (rules: cheapest without coco), oeuf → O1. */
  async function readyBasket(token: string): Promise<Basket> {
    const parsed = await parsedBasket(token, [parseLine('lait', { excludeTerms: ['coco'] }), parseLine('oeuf')]);
    return completeSearch(token, parsed.id, { lait: LAIT, oeuf: OEUF });
  }

  it("searches one line only, takes the user's query as is and leaves the other lines alone", async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    const { lait, oeuf } = byLabel(ready);
    expect(lait).toMatchObject({ productRef: 'L3', reasonSource: 'rules' });

    const searching = await readJson(await search(token, ready, lait?.id, ' lait de coco '), BasketSchema, 202);
    expect(searching).toMatchObject({ status: 'searching', job: { kind: 'provider.search', status: 'pending' } });
    expect(searching.items).toEqual(ready.items);
    const job = await claimProviderJob(token);
    expect(job.payload).toEqual({
      provider: 'carrefour',
      items: [{ itemId: lait?.id, query: 'lait de coco' }],
      refs: [],
      max: 10,
    });

    // The line's exclude terms (coco) no longer apply: the user asked for it.
    const coco = [
      { ...offer('C1', 180), name: 'Lait de coco' },
      { ...offer('C2', 170), name: 'Lait de coco bio' },
    ];
    const result = {
      context: { provider: 'carrefour', storeRef: 'store-1' },
      byItem: [{ itemId: lait?.id, offers: coco }],
      byRef: [],
    };
    await expectNoContent(await call('POST', `/v1/jobs/${job.id}/complete`, { token, body: { result } }));

    const done = await getBasket(token, ready.id);
    expect(done).toMatchObject({ status: 'ready', totalCents: 170 + 250 });
    expect(byLabel(done).lait).toMatchObject({
      productRef: 'C2',
      reasonSource: 'rules',
      candidates: [coco[1], coco[0]],
    });
    expect(byLabel(done).oeuf).toEqual(oeuf);
    // No LLM for a manual search.
    expect(await countJobs(ready.id, 'llm')).toBe(2);
  });

  it('leaves the basket reviewable when the manual search fails', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    await readJson(await search(token, ready, byLabel(ready).oeuf?.id, 'oeufs bio'), BasketSchema, 202);
    const job = await claimProviderJob(token);
    const error = { code: 'network', message: 'Tab closed', retryable: true };
    await expectNoContent(await call('POST', `/v1/jobs/${job.id}/fail`, { token, body: { error } }));
    const after = await getBasket(token, ready.id);
    expect(after).toMatchObject({ status: 'ready', error: 'Tab closed', items: ready.items });
  });

  it('refuses removed items, busy baskets, bad queries and other users', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    const { lait, oeuf } = byLabel(ready);
    await call('PATCH', `/v1/baskets/${ready.id}/items/${oeuf?.id}`, { token, body: { op: 'remove' } });
    await expectError(await search(token, ready, oeuf?.id, 'oeufs'), 409, 'conflict');
    await expectError(await search(token, ready, lait?.id, ' '), 400, 'invalid_request');
    await expectError(await search(token, ready, lait?.id, 'x'.repeat(201)), 400, 'invalid_request');
    await expectError(await search(token, ready, crypto.randomUUID(), 'lait'), 404, 'not_found');
    const other = await seedUser();
    await expectError(await search(other.token, ready, lait?.id, 'lait'), 404, 'not_found');

    await readJson(await call('POST', `/v1/baskets/${ready.id}/push`, { token }), PushResponseSchema);
    await expectError(await search(token, ready, lait?.id, 'lait'), 409, 'conflict');
    const parsing = await createBasket(token);
    await expectError(await search(token, parsing, crypto.randomUUID(), 'lait'), 409, 'conflict');
  });
});
