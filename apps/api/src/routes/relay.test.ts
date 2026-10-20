import { env } from 'cloudflare:workers';
import { BasketSchema, JobSchema, JobSummarySchema, ProgressResponseSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import {
  agent,
  call,
  createBasket,
  expectError,
  expectNoContent,
  llmResult,
  parseLine,
  readJson,
  relayClaim,
  relayComplete,
  relayToken,
  seedUser,
} from '../test/helpers.ts';

const token = relayToken;
const claimLlm = { kinds: ['llm'], agent };

async function getBasket(userToken: string, id: string) {
  return readJson(await call('GET', `/v1/baskets/${id}`, { token: userToken }), BasketSchema);
}

async function jobRow(jobId: string) {
  return env.DB.prepare('SELECT status, attempts, claimed_by, usage FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<{ status: string; attempts: number; claimed_by: string | null; usage: string | null }>();
}

/** A user with a basket whose parse job is claimed by the relay. */
async function claimedParse() {
  const user = await seedUser();
  const basket = await createBasket(user.token);
  const job = await relayClaim(basket.job?.id ?? '');
  return { user, basket, job };
}

describe('relay auth', () => {
  it('limits the relay token to llm jobs of the executor protocol', async () => {
    const { user, basket, job } = await claimedParse();

    await expectError(await call('GET', '/v1/me', { token }), 401, 'unauthorized');
    await expectError(await call('GET', `/v1/baskets/${basket.id}`, { token }), 401, 'unauthorized');
    await expectError(await call('POST', '/v1/jobs/claim', { token: 'wrong', body: claimLlm }), 401, 'unauthorized');
    const mixed = { kinds: ['llm', 'provider.search'], agent };
    await expectError(await call('POST', '/v1/jobs/claim', { token, body: mixed }), 403, 'forbidden');
    const search = { kinds: ['provider.search'], agent };
    await expectError(await call('POST', '/v1/jobs/claim', { token, body: search }), 403, 'forbidden');
    await expectError(await call('POST', '/v1/jobs/claim', { token: user.token, body: claimLlm }), 403, 'forbidden');

    await expectError(await call('GET', `/v1/jobs/${job.id}`, { token }), 403, 'forbidden');
    const pause = { reason: 'challenge' };
    await expectError(await call('POST', `/v1/jobs/${job.id}/pause`, { token, body: pause }), 403, 'forbidden');
    await expectError(await call('POST', `/v1/jobs/${job.id}/resume`, { token }), 403, 'forbidden');

    const progress = { done: 0, total: 1 };
    const res = await call('POST', `/v1/jobs/${job.id}/progress`, { token, body: progress });
    expect(await readJson(res, ProgressResponseSchema)).toMatchObject({ cancel: false });

    // The user's own device cannot finish the relay's job.
    const result = llmResult({ lines: [parseLine('lait')] });
    const byDevice = await call('POST', `/v1/jobs/${job.id}/complete`, { token: user.token, body: { result } });
    await expectError(byDevice, 409, 'conflict');
  });

  it('claims llm jobs of any user, and never sees provider jobs', async () => {
    const a = await seedUser('A');
    const basket = await createBasket(a.token);
    const job = await relayClaim(basket.job?.id ?? '');
    expect(job).toMatchObject({ kind: 'llm', status: 'running', attempts: 1 });
    expect((await jobRow(job.id))?.claimed_by).toBe('relay');

    await expectNoContent(await relayComplete(job.id, llmResult({ lines: [parseLine('lait')] })));
    const searchId = (await getBasket(a.token, basket.id)).job?.id;
    const progress = { done: 0, total: 1 };
    await expectError(await call('POST', `/v1/jobs/${searchId}/progress`, { token, body: progress }), 404, 'not_found');
  });

  it('cannot finish an llm job it has not claimed', async () => {
    const { basket } = { basket: await createBasket((await seedUser()).token) };
    await expectError(await relayComplete(basket.job?.id ?? '', llmResult({ lines: [] })), 409, 'conflict');
  });
});

describe('parse completion', () => {
  it('writes aggregated items, queues their search and stores the usage', async () => {
    const { user, basket, job } = await claimedParse();
    const lines = [
      parseLine('lait', { unit: 'ml', quantity: 1000, excludeTerms: ['coco'], label: 'Lait' }),
      parseLine('oignon', { quantity: 2, pieceWeightG: 150, sourceIndex: 1 }),
      parseLine('oignon', { unit: 'g', quantity: 100 }),
      parseLine('Lait', { unit: 'ml', quantity: 500, sourceIndex: 1 }),
    ];
    await expectNoContent(await relayComplete(job.id, llmResult({ lines }, { inputTokens: 1200, outputTokens: 300 })));

    const searching = await getBasket(user.token, basket.id);
    expect(searching.status).toBe('searching');
    expect(searching.items.map((i) => [i.position, i.ingredientKey, i.label, i.quantity, i.unit, i.status])).toEqual([
      [0, 'lait', 'Lait', 1500, 'ml', 'pending'],
      [1, 'oignon', 'oignon', 400, 'g', 'pending'],
    ]);
    expect(searching.job).toMatchObject({ kind: 'provider.search', status: 'pending' });

    const items = await env.DB.prepare('SELECT sources, exclude_terms FROM basket_items WHERE basket_id = ?')
      .bind(basket.id)
      .all();
    expect(items.results).toEqual([
      { sources: '[0,1]', exclude_terms: '["coco"]' },
      { sources: '[0,1]', exclude_terms: '[]' },
    ]);
    expect(await jobRow(job.id)).toMatchObject({
      status: 'done',
      usage: JSON.stringify({ inputTokens: 1200, outputTokens: 300 }),
    });

    const search = await readJson(
      await call('POST', '/v1/jobs/claim', { token: user.token, body: { kinds: ['provider.search'], agent } }),
      JobSchema,
    );
    expect(search.payload).toEqual({
      provider: 'carrefour',
      items: searching.items.map((i) => ({ itemId: i.id, query: i.ingredientKey })),
      refs: [],
      max: 10,
    });
    await expectError(await relayComplete(job.id, llmResult({ lines })), 409, 'conflict');
    expect((await getBasket(user.token, basket.id)).items).toHaveLength(2);
  });

  it('retries an invalid output once, then fails the basket', async () => {
    const { user, basket, job } = await claimedParse();
    await expectNoContent(await relayComplete(job.id, llmResult('not json')));

    expect(await jobRow(job.id)).toMatchObject({ status: 'pending', attempts: 1, claimed_by: null });
    const retrying = await getBasket(user.token, basket.id);
    expect(retrying.status).toBe('parsing');
    expect(retrying.job?.error).toMatchObject({ code: 'invalid_result', retryable: true });

    const again = await relayClaim(job.id);
    expect(again.attempts).toBe(2);
    await expectNoContent(await relayComplete(job.id, llmResult({ lines: [{ key: 'lait' }] })));

    const failed = await getBasket(user.token, basket.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'Impossible de comprendre la liste. Reformule-la.' });
    expect(failed.job).toMatchObject({ status: 'failed', error: { code: 'invalid_result' } });
    expect(await jobRow(job.id)).toMatchObject({ usage: JSON.stringify({ inputTokens: 2000, outputTokens: 400 }) });
  });

  it('accepts a valid output on the second try', async () => {
    const { user, basket, job } = await claimedParse();
    await expectNoContent(await relayComplete(job.id, llmResult({ lines: [] })));
    await relayClaim(job.id);
    await expectNoContent(await relayComplete(job.id, llmResult({ lines: [parseLine('lait')] })));
    expect((await getBasket(user.token, basket.id)).status).toBe('searching');
  });

  it('retries a retryable relay failure once, then fails the basket', async () => {
    const { user, basket, job } = await claimedParse();
    const error = { code: 'internal', message: 'claude exited with code 1', retryable: true };
    await expectNoContent(await call('POST', `/v1/jobs/${job.id}/fail`, { token, body: { error } }));
    expect(await jobRow(job.id)).toMatchObject({ status: 'pending', claimed_by: null });

    await relayClaim(job.id);
    await expectNoContent(await call('POST', `/v1/jobs/${job.id}/fail`, { token, body: { error } }));
    const failed = await getBasket(user.token, basket.id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: "L'analyse de la liste a échoué. Réessaie dans un moment.",
    });
    const summary = failed.job && JobSummarySchema.parse(failed.job);
    expect(summary).toMatchObject({ status: 'failed', error });
  });

  it('fails at once on a non-retryable relay failure', async () => {
    const { user, basket, job } = await claimedParse();
    const error = { code: 'internal', message: 'invalid payload', retryable: false };
    await expectNoContent(await call('POST', `/v1/jobs/${job.id}/fail`, { token, body: { error } }));
    expect((await getBasket(user.token, basket.id)).status).toBe('failed');
  });
});
