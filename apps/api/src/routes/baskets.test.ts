import { env } from 'cloudflare:workers';
import {
  type Basket,
  BasketSchema,
  BasketSummarySchema,
  type CartSyncResult,
  type Job,
  JobSchema,
  JobSummarySchema,
  LlmPayloadSchema,
  ProgressResponseSchema,
  PushResponseSchema,
  type SearchResult,
} from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchema, system } from '../llm/prompts/parse.ts';
import {
  agent,
  call,
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
  relayToken,
  seedUser,
} from '../test/helpers.ts';

async function getBasket(token: string, id: string): Promise<Basket> {
  return readJson(await call('GET', `/v1/baskets/${id}`, { token }), BasketSchema);
}

async function claim(token: string): Promise<Job> {
  const body = { kinds: ['provider.search', 'provider.cart_sync'], agent };
  return readJson(await call('POST', '/v1/jobs/claim', { token, body }), JobSchema);
}

async function complete(token: string, jobId: string, result: SearchResult | CartSyncResult): Promise<void> {
  await expectNoContent(await call('POST', `/v1/jobs/${jobId}/complete`, { token, body: { result } }));
}

const context = { provider: 'carrefour', storeRef: 'store-1' } as const;
const lines = [
  parseLine('lait', { unit: 'ml', quantity: 1000, excludeTerms: ['coco'] }),
  parseLine('oeuf', { quantity: 6 }),
  parseLine('pâtes', { unit: 'g', quantity: 500 }),
];

/** Parsed and searched: lait → 112 (cheapest once coco is excluded), oeuf → 222 (first unavailable), pâtes → none. */
async function readyBasket(token: string): Promise<Basket> {
  const basket = await parsedBasket(token, lines);
  const search = await claim(token);
  const [lait, oeuf] = basket.items;
  if (!lait || !oeuf) throw new Error('missing items');
  await complete(token, search.id, {
    context,
    byItem: [
      {
        itemId: lait.id,
        offers: [{ ...offer('110', 150), name: 'Lait de COCO' }, offer('111', 120), offer('112', 99)],
      },
      { itemId: oeuf.id, offers: [offer('221', 300, false), offer('222', 250)] },
    ],
    byRef: [],
  });
  return getBasket(token, basket.id);
}

describe('POST /v1/baskets', () => {
  it('creates a parsing basket with one llm parse job', async () => {
    const { token } = await seedUser();
    const basket = await createBasket(token, 'lait, 6 oeufs', 6);

    expect(basket).toMatchObject({ status: 'parsing', items: [], totalCents: 0, error: null });
    expect(basket.job).toMatchObject({ kind: 'llm', status: 'pending', result: null });

    const stored = await env.DB.prepare('SELECT inputs FROM baskets WHERE id = ?').bind(basket.id).first('inputs');
    expect(stored).toBe('{"inputs":[{"kind":"text","text":"lait, 6 oeufs"}],"servings":6}');
    const unsized = await createBasket(token, 'pain');
    const bare = await env.DB.prepare('SELECT inputs FROM baskets WHERE id = ?').bind(unsized.id).first('inputs');
    expect(bare).toBe('{"inputs":[{"kind":"text","text":"pain"}]}');

    const job = await relayClaim(basket.job?.id ?? '');
    const payload = LlmPayloadSchema.parse(job.payload);
    expect(payload).toEqual({
      purpose: 'parse',
      model: 'test-model',
      system,
      user: 'Nombre de personnes : 6\n\n[0] Liste :\nlait, 6 oeufs',
      jsonSchema,
    });
  });

  it('accepts recipe text and rejects recipe urls and empty input', async () => {
    const { token } = await seedUser();
    const recipe = { inputs: [{ kind: 'recipe_text', text: '200 g de farine' }] };
    await readJson(await call('POST', '/v1/baskets', { token, body: recipe }), BasketSchema, 202);
    const url = { inputs: [{ kind: 'recipe_url', url: 'https://example.com/recette' }] };
    await expectError(await call('POST', '/v1/baskets', { token, body: url }), 400, 'invalid_request');
    await expectError(await call('POST', '/v1/baskets', { token, body: { inputs: [] } }), 400, 'invalid_request');
    const tooMany = { inputs: [{ kind: 'text', text: 'lait' }], servings: 21 };
    await expectError(await call('POST', '/v1/baskets', { token, body: tooMany }), 400, 'invalid_request');
  });
});

describe('basket flow with fake relay and executor', () => {
  it('parses, searches, proposes, pushes and allows a re-push', async () => {
    const { token } = await seedUser();
    const searching = await parsedBasket(token, lines);
    expect(searching.status).toBe('searching');
    expect(searching.job).toMatchObject({ kind: 'provider.search', status: 'pending' });

    const search = await claim(token);
    if (search.kind !== 'provider.search') throw new Error(`unexpected job ${search.kind}`);
    expect(search.payload.items).toEqual(searching.items.map((i) => ({ itemId: i.id, query: i.label })));
    const progress = await call('POST', `/v1/jobs/${search.id}/progress`, { token, body: { done: 1, total: 3 } });
    expect(await readJson(progress, ProgressResponseSchema)).toMatchObject({ cancel: false });
    expect((await getBasket(token, searching.id)).job?.progress).toEqual({ done: 1, total: 3 });

    const [lait, oeuf] = searching.items;
    if (!lait || !oeuf) throw new Error('missing items');
    await complete(token, search.id, {
      context,
      byItem: [
        { itemId: lait.id, offers: [{ ...offer('110', 150), name: 'Lait de coco' }, offer('111', 120)] },
        { itemId: oeuf.id, offers: [offer('221', 300, false), offer('222', 250)] },
      ],
      byRef: [],
    });

    const ready = await getBasket(token, searching.id);
    expect(ready).toMatchObject({ status: 'ready', storeRef: 'store-1', totalCents: 370, error: null });
    expect(ready.job).toMatchObject({ id: search.id, status: 'done', result: null });
    expect(ready.items.map((i) => [i.label, i.status, i.productRef, i.packs, i.reason, i.candidates.length])).toEqual([
      ['lait', 'proposed', '111', 1, 'Seul produit correspondant', 2],
      ['oeuf', 'proposed', '222', 1, 'Seul produit correspondant', 2],
      ['pâtes', 'unmatched', null, null, 'Aucun produit disponible', 0],
    ]);

    const list = await readJson(await call('GET', '/v1/baskets?limit=5', { token }), z.array(BasketSummarySchema));
    const summary = { id: ready.id, status: 'ready', createdAt: ready.createdAt, totalCents: 370, itemCount: 3 };
    expect(list).toEqual([summary]);

    const push = await readJson(await call('POST', `/v1/baskets/${ready.id}/push`, { token }), PushResponseSchema);
    expect((await getBasket(token, ready.id)).status).toBe('pushing');
    await expectError(await call('POST', `/v1/baskets/${ready.id}/push`, { token }), 409, 'conflict');

    const sync = await claim(token);
    expect(sync).toMatchObject({
      id: push.jobId,
      kind: 'provider.cart_sync',
      payload: {
        provider: 'carrefour',
        lines: [
          { ref: '111', quantity: 1, label: 'lait' },
          { ref: '222', quantity: 1, label: 'oeuf' },
        ],
      },
    });
    const syncResult: CartSyncResult = {
      context,
      lines: [
        { ref: '111', outcome: 'set', before: 0, after: 1 },
        { ref: '222', outcome: 'set', before: 0, after: 1 },
      ],
    };
    await complete(token, sync.id, syncResult);

    const pushed = await getBasket(token, ready.id);
    expect(pushed.status).toBe('pushed');
    expect(pushed.job).toMatchObject({ id: sync.id, kind: 'provider.cart_sync', status: 'done', result: syncResult });
    const job = await readJson(await call('GET', `/v1/jobs/${sync.id}`, { token }), JobSummarySchema);
    expect(job.result).toEqual(syncResult);

    const repush = await readJson(await call('POST', `/v1/baskets/${ready.id}/push`, { token }), PushResponseSchema);
    expect(repush.jobId).not.toBe(push.jobId);
    expect((await getBasket(token, ready.id)).status).toBe('pushing');
  });

  it('refuses to finish a job twice and does not reapply the pipeline', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    const jobId = ready.job?.id;

    const result = { context: { provider: 'carrefour', storeRef: 'store-2' }, byItem: [], byRef: [] };
    await expectError(await call('POST', `/v1/jobs/${jobId}/complete`, { token, body: { result } }), 409, 'conflict');
    const error = { code: 'http', message: 'late failure', retryable: false };
    await expectError(await call('POST', `/v1/jobs/${jobId}/fail`, { token, body: { error } }), 409, 'conflict');

    expect(await getBasket(token, ready.id)).toEqual(ready);
  });

  it('sends the basket back to ready when a push fails', async () => {
    const { token } = await seedUser();
    const basket = await readyBasket(token);
    await readJson(await call('POST', `/v1/baskets/${basket.id}/push`, { token }), PushResponseSchema);
    const sync = await claim(token);

    const error = { code: 'auth_required', message: 'Login required', retryable: true };
    await expectNoContent(await call('POST', `/v1/jobs/${sync.id}/fail`, { token, body: { error } }));

    const failed = await getBasket(token, basket.id);
    expect(failed).toMatchObject({ status: 'ready', error: 'Login required' });
    expect(failed.job).toMatchObject({ status: 'failed', error });
    await readJson(await call('POST', `/v1/baskets/${basket.id}/push`, { token }), PushResponseSchema);
  });

  it('fails the basket when its search fails', async () => {
    const { token } = await seedUser();
    const basket = await parsedBasket(token, lines);
    const search = await claim(token);

    const error = { code: 'no_store', message: 'No store selected', retryable: false };
    await expectNoContent(await call('POST', `/v1/jobs/${search.id}/fail`, { token, body: { error } }));

    expect(await getBasket(token, basket.id)).toMatchObject({ status: 'failed', error: 'No store selected' });
    await expectError(await call('POST', `/v1/baskets/${basket.id}/push`, { token }), 409, 'conflict');
  });

  it('refuses a push while another basket of the user is being pushed', async () => {
    const { token } = await seedUser();
    const first = await readyBasket(token);
    const second = await readyBasket(token);
    await readJson(await call('POST', `/v1/baskets/${first.id}/push`, { token }), PushResponseSchema);
    await expectError(await call('POST', `/v1/baskets/${second.id}/push`, { token }), 409, 'conflict');
    expect((await getBasket(token, second.id)).status).toBe('ready');
  });
});

describe('POST /v1/baskets/:id/retry', () => {
  const retry = (token: string, id: string) => call('POST', `/v1/baskets/${id}/retry`, { token });
  const fatal = { code: 'internal', message: 'boom', retryable: false };

  it('retries a failed parse with the same payload', async () => {
    const { token } = await seedUser();
    const basket = await createBasket(token);
    const parse = await relayClaim(basket.job?.id ?? '');
    const body = { error: fatal };
    await expectNoContent(await call('POST', `/v1/jobs/${parse.id}/fail`, { token: relayToken, body }));
    expect((await getBasket(token, basket.id)).status).toBe('failed');

    const retried = await readJson(await retry(token, basket.id), BasketSchema, 202);
    expect(retried).toMatchObject({ status: 'parsing', error: null, items: [] });
    expect(retried.job).toMatchObject({ kind: 'llm', status: 'pending', error: null });
    expect(retried.job?.id).not.toBe(parse.id);

    const again = await relayClaim(retried.job?.id ?? '');
    expect(again).toMatchObject({ attempts: 1, payload: parse.payload });
    await expectNoContent(await relayComplete(again.id, llmResult({ lines: [parseLine('lait')] })));
    expect((await getBasket(token, basket.id)).status).toBe('searching');
  });

  it('retries a failed search with the same payload and items', async () => {
    const { token } = await seedUser();
    const parsed = await parsedBasket(token, lines);
    const search = await claim(token);
    await expectNoContent(await call('POST', `/v1/jobs/${search.id}/fail`, { token, body: { error: fatal } }));
    const failed = await getBasket(token, parsed.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'boom' });

    const retried = await readJson(await retry(token, parsed.id), BasketSchema, 202);
    expect(retried).toMatchObject({ status: 'searching', error: null, items: failed.items });
    expect(retried.items.map((i) => i.status)).toEqual(['pending', 'pending', 'pending']);
    expect(retried.job).toMatchObject({ kind: 'provider.search', status: 'pending' });

    const again = await claim(token);
    expect(again).toMatchObject({ id: retried.job?.id, attempts: 1, payload: search.payload });
    await expectError(await retry(token, parsed.id), 409, 'conflict');
  });

  it('applies only one of two concurrent retries', async () => {
    const { token } = await seedUser();
    const basket = await createBasket(token);
    const parse = await relayClaim(basket.job?.id ?? '');
    await expectNoContent(
      await call('POST', `/v1/jobs/${parse.id}/fail`, { token: relayToken, body: { error: fatal } }),
    );

    const statuses = (await Promise.all([retry(token, basket.id), retry(token, basket.id)])).map((r) => r.status);
    expect(statuses.sort()).toEqual([202, 409]);
    const jobs = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE basket_id = ?').bind(basket.id).first('n');
    expect(jobs).toBe(2);
  });

  it('searches only the unmatched items again, from ready or pushed', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    const [lait, oeuf, pates] = ready.items;
    expect(pates).toMatchObject({ status: 'unmatched' });
    await readJson(await call('POST', `/v1/baskets/${ready.id}/push`, { token }), PushResponseSchema);
    await complete(token, (await claim(token)).id, { context, lines: [] });
    expect((await getBasket(token, ready.id)).status).toBe('pushed');

    const retried = await readJson(await retry(token, ready.id), BasketSchema, 202);
    expect(retried).toMatchObject({ status: 'searching', error: null });
    expect(retried.items[2]).toMatchObject({
      status: 'pending',
      productRef: null,
      packs: null,
      candidates: [],
      reason: null,
      reasonSource: null,
    });
    expect(retried.items.slice(0, 2)).toEqual([lait, oeuf]);
    expect(retried.job).toMatchObject({ kind: 'provider.search', status: 'pending' });
    await expectError(await retry(token, ready.id), 409, 'conflict');

    const search = await claim(token);
    expect(search.payload).toEqual({
      provider: 'carrefour',
      items: [{ itemId: pates?.id, query: 'pâtes' }],
      refs: [],
      max: 10,
    });
    await complete(token, search.id, {
      context,
      byItem: [{ itemId: pates?.id ?? '', offers: [offer('333', 90)] }],
      byRef: [],
    });
    const found = await getBasket(token, ready.id);
    expect(found.status).toBe('ready');
    expect(found.items[2]).toMatchObject({ status: 'proposed', productRef: '333', packs: 1 });
    expect(found.items.slice(0, 2)).toEqual([lait, oeuf]);
  });

  it("refuses baskets that are not failed, and other users' baskets", async () => {
    const { token } = await seedUser();
    const parsing = await createBasket(token);
    await expectError(await retry(token, parsing.id), 409, 'conflict');
    // Ready, with nothing unmatched: nothing to search again.
    const ready = await completeSearch(token, (await parsedBasket(token, [parseLine('lait')])).id, {
      lait: [offer('1', 100)],
    });
    expect(ready.items.map((item) => item.status)).toEqual(['proposed']);
    await expectError(await retry(token, ready.id), 409, 'conflict');

    // Failed, but its latest job is a failed push: not a retryable step.
    await readJson(await call('POST', `/v1/baskets/${ready.id}/push`, { token }), PushResponseSchema);
    const sync = await claim(token);
    await expectNoContent(await call('POST', `/v1/jobs/${sync.id}/fail`, { token, body: { error: fatal } }));
    await env.DB.prepare("UPDATE baskets SET status = 'failed' WHERE id = ?").bind(ready.id).run();
    await expectError(await retry(token, ready.id), 409, 'conflict');

    const other = await seedUser();
    await expectError(await retry(other.token, ready.id), 404, 'not_found');
    await expectError(await retry(token, crypto.randomUUID()), 404, 'not_found');
  });
});

describe('preferences', () => {
  it('reach the parse prompt and the ranking', async () => {
    const { token } = await seedUser();
    const preferences = { diet: ['vegetarian'], bannedBrands: ['Marque A'], allergies: ['arachide'] };
    await call('PUT', '/v1/me/preferences', { token, body: preferences });

    const created = await createBasket(token, 'lait');
    const parse = await relayClaim(created.job?.id ?? '');
    expect(LlmPayloadSchema.parse(parse.payload).user).toBe(
      'Nombre de personnes : non précisé\nRégime : végétarien\nAllergies : arachide\n\n[0] Liste :\nlait',
    );
    const line = parseLine('lait', { unit: 'ml', quantity: 1000 });
    await expectNoContent(await relayComplete(parse.id, llmResult({ lines: [line] })));

    const search = await claim(token);
    const [item] = (await getBasket(token, created.id)).items;
    const pack = { amount: 500, unit: 'ml' as const };
    await complete(token, search.id, {
      context,
      byItem: [
        {
          itemId: item?.id ?? '',
          offers: [
            { ...offer('1', 100), brand: 'MARQUE A', pack: { amount: 1000, unit: 'ml' } },
            { ...offer('2', 90), brand: 'Marque B', pack },
          ],
        },
      ],
      byRef: [],
    });
    const ready = await getBasket(token, created.id);
    expect(ready.items[0]).toMatchObject({ productRef: '2', packs: 2, reason: 'Seul produit correspondant' });
    expect(ready.totalCents).toBe(180);
  });
});
