import { env } from 'cloudflare:workers';
import {
  type Basket,
  BasketSchema,
  LlmPayloadSchema,
  PreferencesSchema,
  type ProductOffer,
  PushResponseSchema,
} from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import * as amend from '../llm/prompts/amend.ts';
import {
  call,
  claimProviderJob,
  completeSearch,
  createBasket,
  expectError,
  expectNoContent,
  llmResult,
  parsedBasket,
  parseLine,
  readJson,
  relayClaim,
  relayComplete,
  seedUser,
} from '../test/helpers.ts';

const offer = (ref: string, priceCents: number, pack?: ProductOffer['pack'], maxQuantity?: number): ProductOffer => ({
  provider: 'carrefour',
  ref,
  name: `Produit ${ref}`,
  available: true,
  priceCents,
  pack,
  maxQuantity,
});
const OFFERS: Record<string, ProductOffer[]> = {
  lait: [offer('L1', 100, { amount: 1000, unit: 'ml' }, 3), offer('L2', 120, { amount: 500, unit: 'ml' })],
  tomate: [offer('T1', 200, { amount: 6, unit: 'piece' }), offer('T2', 50, { amount: 1, unit: 'piece' })],
  oignon: [offer('O1', 80)],
  'fromage râpé': [offer('F1', 150, { amount: 200, unit: 'g' }), offer('F2', 250, { amount: 400, unit: 'g' })],
};

/** lait L1 ×1, tomate T1 ×1 (tie with T2, search order), oignon O1, fromage F1: 530. */
async function readyBasket(token: string): Promise<Basket> {
  const parsed = await parsedBasket(token, [
    parseLine('lait', { unit: 'ml', quantity: 1000 }),
    parseLine('tomate', { quantity: 4 }),
    parseLine('oignon'),
    parseLine('fromage râpé', { unit: 'g', quantity: 200 }),
  ]);
  return completeSearch(token, parsed.id, OFFERS);
}

function byLabel(basket: Basket) {
  return Object.fromEntries(basket.items.map((item) => [item.label, item]));
}

const patchItem = (token: string, basket: Basket, label: string, body: unknown) =>
  call('PATCH', `/v1/baskets/${basket.id}/items/${byLabel(basket)[label]?.id}`, { token, body });

describe('PATCH /v1/baskets/:id/items/:itemId', () => {
  it('removes, restores, sets packs and chooses a candidate', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    expect(ready.totalCents).toBe(530);

    const removed = await readJson(await patchItem(token, ready, 'oignon', { op: 'remove' }), BasketSchema);
    expect(byLabel(removed).oignon).toMatchObject({ status: 'removed', reason: 'Retiré', reasonSource: 'user' });
    expect(removed).toMatchObject({ status: 'ready', totalCents: 450 });
    const restored = await readJson(await patchItem(token, ready, 'oignon', { op: 'restore' }), BasketSchema);
    expect(byLabel(restored).oignon).toMatchObject({
      status: 'proposed',
      productRef: 'O1',
      reason: 'Remis dans le panier',
    });

    const packs = await readJson(await patchItem(token, ready, 'lait', { op: 'packs', packs: 3 }), BasketSchema);
    expect(byLabel(packs).lait).toMatchObject({ packs: 3, productRef: 'L1' });
    expect(packs.totalCents).toBe(730);
    await expectError(await patchItem(token, ready, 'lait', { op: 'packs', packs: 4 }), 400, 'invalid_request');

    const chosen = await readJson(await patchItem(token, ready, 'lait', { op: 'choose', ref: 'L2' }), BasketSchema);
    expect(byLabel(chosen).lait).toMatchObject({
      productRef: 'L2',
      packs: 2,
      reason: 'Ton choix',
      reasonSource: 'user',
    });

    await expectError(await patchItem(token, ready, 'lait', { op: 'choose', ref: 'T1' }), 400, 'invalid_request');
    await expectError(await patchItem(token, ready, 'lait', { op: 'restore' }), 409, 'conflict');
    await expectError(await patchItem(token, ready, 'lait', { op: 'explode' }), 400, 'invalid_request');
  });

  it('sends a pushed basket back to ready, and refuses while it is busy', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    await readJson(await call('POST', `/v1/baskets/${ready.id}/push`, { token }), PushResponseSchema);
    await expectError(await patchItem(token, ready, 'oignon', { op: 'remove' }), 409, 'conflict');

    const sync = await claimProviderJob(token);
    const result = { context: { provider: 'carrefour', storeRef: 'store-1' }, lines: [] };
    await expectNoContent(await call('POST', `/v1/jobs/${sync.id}/complete`, { token, body: { result } }));
    const edited = await readJson(await patchItem(token, ready, 'oignon', { op: 'remove' }), BasketSchema);
    expect(edited.status).toBe('ready');

    const parsing = await createBasket(token);
    const fake = `/v1/baskets/${parsing.id}/items/${crypto.randomUUID()}`;
    await expectError(await call('PATCH', fake, { token, body: { op: 'remove' } }), 409, 'conflict');
  });

  it("only reaches items of the user's own baskets", async () => {
    const { token } = await seedUser();
    const other = await seedUser();
    const ready = await readyBasket(token);
    await expectError(await patchItem(other.token, ready, 'lait', { op: 'remove' }), 404, 'not_found');
    const unknown = `/v1/baskets/${ready.id}/items/${crypto.randomUUID()}`;
    await expectError(await call('PATCH', unknown, { token, body: { op: 'remove' } }), 404, 'not_found');
    expect(byLabel(await getBasket(token, ready.id)).lait?.status).toBe('proposed');
  });
});

async function getBasket(token: string, id: string): Promise<Basket> {
  return readJson(await call('GET', `/v1/baskets/${id}`, { token }), BasketSchema);
}

async function startAmend(token: string, basket: Basket, text: string) {
  const amending = await readJson(
    await call('POST', `/v1/baskets/${basket.id}/amend`, { token, body: { text } }),
    BasketSchema,
    202,
  );
  return { amending, job: await relayClaim(amending.job?.id ?? '') };
}

describe('POST /v1/baskets/:id/amend', () => {
  it('queues an llm amend job over the live items; the basket is parsing with its items', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    await patchItem(token, ready, 'oignon', { op: 'remove' });
    await call('PUT', '/v1/me/preferences', { token, body: { allergies: ['arachide'] } });

    const { amending, job } = await startAmend(token, ready, 'ajoute de la mayo');
    expect(amending).toMatchObject({ status: 'parsing', error: null });
    expect(amending.items).toHaveLength(4);
    expect(amending.job).toMatchObject({ kind: 'llm', status: 'pending' });

    const live = amending.items
      .filter((item) => item.status !== 'removed')
      .map((item) => ({
        itemId: item.id,
        label: item.label,
        key: item.ingredientKey,
        quantity: item.quantity,
        unit: item.unit,
      }));
    expect(LlmPayloadSchema.parse(job.payload)).toEqual({
      purpose: 'amend',
      model: 'test-model',
      system: amend.system,
      user: amend.buildUser(live, 'ajoute de la mayo', PreferencesSchema.parse({ allergies: ['arachide'] })),
      jsonSchema: amend.jsonSchema,
    });
    expect(LlmPayloadSchema.parse(job.payload).user).not.toContain('oignon');
    await expectError(
      await call('POST', `/v1/baskets/${ready.id}/amend`, { token, body: { text: 'x' } }),
      409,
      'conflict',
    );
  });

  it('gives the amend the servings stored on the basket, or none for older baskets', async () => {
    const { token } = await seedUser();
    const lines = [parseLine('lait'), parseLine('pain')];
    const sized = await completeSearch(token, (await parsedBasket(token, lines, 6)).id, OFFERS);
    const { job } = await startAmend(token, sized, 'ajoute du beurre');
    expect(LlmPayloadSchema.parse(job.payload).user).toMatch(/^Nombre de personnes : 6\n\nPanier :/);

    // Before servings were stored, the inputs column was a bare array.
    const legacy = await completeSearch(token, (await parsedBasket(token, lines)).id, OFFERS);
    await env.DB.prepare('UPDATE baskets SET inputs = ? WHERE id = ?')
      .bind(JSON.stringify([{ kind: 'text', text: 'lait, pain' }]), legacy.id)
      .run();
    const { job: legacyJob } = await startAmend(token, legacy, 'ajoute du beurre');
    expect(LlmPayloadSchema.parse(legacyJob.payload).user).toMatch(/^Nombre de personnes : non précisé\n\nPanier :/);
  });

  it('removes, resizes, merges and adds; searches only the new items', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    const items = byLabel(ready);
    const { job } = await startAmend(
      token,
      ready,
      "j'ai déjà un oignon, 8 tomates, double le fromage, ajoute mayo et basilic",
    );
    const output = {
      remove: [
        { itemId: items.oignon?.id, why: 'have_it' },
        { itemId: 'not-an-item', why: 'not_wanted' },
      ],
      update: [{ itemId: items.tomate?.id, quantity: 8, unit: 'piece' }],
      add: [
        parseLine('fromage râpé', { unit: 'g', quantity: 200 }),
        parseLine('mayonnaise'),
        parseLine('basilic', { query: 'basilic frais' }),
      ],
    };
    await expectNoContent(await relayComplete(job.id, llmResult(output)));

    const searching = await getBasket(token, ready.id);
    expect(searching.status).toBe('searching');
    const after = byLabel(searching);
    expect(after.oignon).toMatchObject({ status: 'removed', reason: 'Déjà à la maison', reasonSource: 'user' });
    expect(after.tomate).toMatchObject({ quantity: 8, productRef: 'T1', packs: 2, status: 'proposed' });
    expect(after['fromage râpé']).toMatchObject({ quantity: 400, productRef: 'F2', packs: 1 });
    expect(after.lait).toEqual(items.lait);
    expect(after.mayonnaise).toMatchObject({ status: 'pending', position: 4 });
    expect(after.basilic).toMatchObject({ status: 'pending', position: 5 });

    const search = await claimProviderJob(token);
    if (search.kind !== 'provider.search') throw new Error('expected a search');
    expect(search.payload.items).toEqual([
      { itemId: after.mayonnaise?.id, query: 'mayonnaise' },
      { itemId: after.basilic?.id, query: 'basilic frais' },
    ]);
    await call('POST', `/v1/jobs/${search.id}/fail`, {
      token,
      body: { error: { code: 'http', message: 'x', retryable: true } },
    });
    await call('POST', `/v1/baskets/${ready.id}/retry`, { token });
    const done = await completeSearch(token, ready.id, { mayonnaise: [offer('M1', 200)] });
    const final = byLabel(done);
    expect(done.status).toBe('ready');
    expect(final.mayonnaise).toMatchObject({ status: 'proposed', productRef: 'M1' });
    expect(final.basilic).toMatchObject({ status: 'unmatched' });
    expect(final.tomate).toEqual(after.tomate);
    expect(final.lait).toEqual(items.lait);
  });

  it('goes straight back to ready when nothing new must be searched, also from pushed', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    await readJson(await call('POST', `/v1/baskets/${ready.id}/push`, { token }), PushResponseSchema);
    const sync = await claimProviderJob(token);
    const result = { context: { provider: 'carrefour', storeRef: 'store-1' }, lines: [] };
    await expectNoContent(await call('POST', `/v1/jobs/${sync.id}/complete`, { token, body: { result } }));
    expect((await getBasket(token, ready.id)).status).toBe('pushed');

    const { job } = await startAmend(token, ready, "plus besoin d'oignon");
    const output = { add: [], update: [], remove: [{ itemId: byLabel(ready).oignon?.id, why: 'not_wanted' }] };
    await expectNoContent(await relayComplete(job.id, llmResult(output)));
    const after = await getBasket(token, ready.id);
    expect(after).toMatchObject({ status: 'ready', error: null, totalCents: 450 });
    expect(byLabel(after).oignon).toMatchObject({ status: 'removed', reason: 'Retiré' });
  });

  it('retries an unusable output once, then returns to ready unchanged with an error', async () => {
    const { token } = await seedUser();
    const ready = await readyBasket(token);
    const { job } = await startAmend(token, ready, 'fais un truc');
    await expectNoContent(await relayComplete(job.id, llmResult('not json')));
    const row = await env.DB.prepare('SELECT status, claimed_by FROM jobs WHERE id = ?').bind(job.id).first();
    expect(row).toEqual({ status: 'pending', claimed_by: null });
    expect((await getBasket(token, ready.id)).status).toBe('parsing');

    await relayClaim(job.id);
    // Valid shape, but only unknown items: nothing to apply.
    const nothing = { add: [], update: [], remove: [{ itemId: 'not-an-item', why: 'have_it' }] };
    await expectNoContent(await relayComplete(job.id, llmResult(nothing)));
    const after = await getBasket(token, ready.id);
    expect(after).toMatchObject({
      status: 'ready',
      error: "Impossible d'appliquer la modification. Reformule-la.",
      items: ready.items,
      totalCents: ready.totalCents,
    });
    expect(after.job).toMatchObject({ kind: 'llm', status: 'failed', error: { code: 'invalid_result' } });
  });

  it('refuses baskets that cannot change, and other users', async () => {
    const { token } = await seedUser();
    const parsing = await createBasket(token);
    const body = { text: 'ajoute du pain' };
    await expectError(await call('POST', `/v1/baskets/${parsing.id}/amend`, { token, body }), 409, 'conflict');
    const ready = await readyBasket(token);
    const other = await seedUser();
    await expectError(
      await call('POST', `/v1/baskets/${ready.id}/amend`, { token: other.token, body }),
      404,
      'not_found',
    );
    await expectError(
      await call('POST', `/v1/baskets/${ready.id}/amend`, { token, body: { text: ' ' } }),
      400,
      'invalid_request',
    );
  });
});
