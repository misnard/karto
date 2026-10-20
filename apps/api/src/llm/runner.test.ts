import { env } from 'cloudflare:workers';
import { type Basket, BasketSchema } from '@karto/contracts';
import { describe, expect, it, vi } from 'vitest';
import { call, createBasket, llmResult, parseLine, readJson, seedUser } from '../test/helpers.ts';
import type { LlmClient } from './client.ts';
import { runPendingLlmJobs } from './runner.ts';

const lines = [parseLine('lait', { unit: 'ml', quantity: 1000 }), parseLine('oeuf', { quantity: 6 })];

function fakeClient() {
  return { complete: vi.fn<LlmClient['complete']>() };
}

async function getBasket(token: string, id: string): Promise<Basket> {
  return readJson(await call('GET', `/v1/baskets/${id}`, { token }), BasketSchema);
}

async function jobRow(id: string | undefined) {
  return env.DB.prepare('SELECT status, claimed_by, attempts, usage, error FROM jobs WHERE id = ?').bind(id).first();
}

// LLM_RUNTIME is 'cli' in tests: baskets keep their llm job pending until a test runs it with a fake client.
describe('runPendingLlmJobs', () => {
  it('does nothing in the cli runtime, where the relay runs llm jobs', async () => {
    const { token } = await seedUser();
    const basket = await createBasket(token, 'lait');
    await runPendingLlmJobs();
    expect((await getBasket(token, basket.id)).job).toMatchObject({ kind: 'llm', status: 'pending' });
    // Drained, so the next tests start with an empty queue.
    const client = fakeClient();
    client.complete.mockResolvedValue(llmResult({ lines }));
    await runPendingLlmJobs(client);
  });

  it('runs a parse job like the relay: items written, search queued, usage stored', async () => {
    const { token } = await seedUser();
    const basket = await createBasket(token, 'lait, 6 oeufs', 4);
    const client = fakeClient();
    client.complete.mockResolvedValue(llmResult({ lines }));

    await runPendingLlmJobs(client);

    expect(client.complete).toHaveBeenCalledOnce();
    expect(client.complete.mock.calls[0]?.[0]).toMatchObject({
      purpose: 'parse',
      model: 'test-model',
      user: 'Nombre de personnes : 4\n\n[0] Liste :\nlait, 6 oeufs',
    });
    const searching = await getBasket(token, basket.id);
    expect(searching.status).toBe('searching');
    expect(searching.job).toMatchObject({ kind: 'provider.search', status: 'pending' });
    expect(searching.items.map((item) => [item.label, item.quantity, item.unit])).toEqual([
      ['lait', 1000, 'ml'],
      ['oeuf', 6, 'piece'],
    ]);
    expect(await jobRow(basket.job?.id)).toMatchObject({
      status: 'done',
      claimed_by: 'runner',
      attempts: 1,
      usage: '{"inputTokens":1000,"outputTokens":200}',
    });
  });

  it('retries once on invalid output and sums the usage of both calls', async () => {
    const { token } = await seedUser();
    const basket = await createBasket(token, 'lait, 6 oeufs');
    const client = fakeClient();
    client.complete.mockResolvedValueOnce(llmResult('not json')).mockResolvedValueOnce(llmResult({ lines }));

    await runPendingLlmJobs(client);

    expect(client.complete).toHaveBeenCalledTimes(2);
    expect((await getBasket(token, basket.id)).status).toBe('searching');
    expect(await jobRow(basket.job?.id)).toMatchObject({
      status: 'done',
      attempts: 2,
      usage: '{"inputTokens":2000,"outputTokens":400}',
    });
  });

  it('fails the job and its basket after two failed calls', async () => {
    const { token } = await seedUser();
    const basket = await createBasket(token, 'lait');
    const client = fakeClient();
    client.complete.mockRejectedValue(new Error('529 overloaded'));

    await runPendingLlmJobs(client);

    expect(client.complete).toHaveBeenCalledTimes(2);
    expect(await getBasket(token, basket.id)).toMatchObject({
      status: 'failed',
      error: "L'analyse de la liste a échoué. Réessaie dans un moment.",
    });
    expect(await jobRow(basket.job?.id)).toMatchObject({
      status: 'failed',
      attempts: 2,
      error: JSON.stringify({ code: 'internal', message: 'LLM call failed: 529 overloaded', retryable: true }),
    });
  });

  it('reclaims a job whose lease expired (cut-short run), but not after 3 attempts', async () => {
    const { token } = await seedUser();
    const [expired, exhausted] = [await createBasket(token, 'lait'), await createBasket(token, 'pain')];
    const expire = 'UPDATE jobs SET status = ?, claimed_by = ?, lease_until = 0, attempts = ? WHERE id = ?';
    await env.DB.batch([
      env.DB.prepare(expire).bind('running', 'runner', 1, expired.job?.id),
      env.DB.prepare(expire).bind('running', 'runner', 3, exhausted.job?.id),
    ]);
    const client = fakeClient();
    client.complete.mockResolvedValue(llmResult({ lines }));

    await runPendingLlmJobs(client);

    expect(client.complete).toHaveBeenCalledOnce();
    expect(await jobRow(expired.job?.id)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await jobRow(exhausted.job?.id)).toMatchObject({ status: 'running', attempts: 3 });
  });
});
