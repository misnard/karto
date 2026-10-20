import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { BasketSchema, JobSummarySchema, ProgressResponseSchema, PushResponseSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import worker from '../index.ts';
import {
  call,
  claimProviderJob,
  completeSearch,
  expectError,
  expectNoContent,
  offer,
  parsedBasket,
  parseLine,
  readJson,
  seedUser,
} from '../test/helpers.ts';
import { expireLeases, PAUSE_TIMEOUT_MS } from './expire-jobs.ts';

/** A ready basket of one line, pushed: its cart sync job is pending, or claimed by the user's device. */
async function pushedBasket(claim = true) {
  const { token } = await seedUser();
  const basket = await parsedBasket(token, [parseLine('lait')]);
  await completeSearch(token, basket.id, { lait: [offer('111', 120)] });
  const { jobId } = await readJson(await call('POST', `/v1/baskets/${basket.id}/push`, { token }), PushResponseSchema);
  if (claim) expect((await claimProviderJob(token)).id).toBe(jobId);
  return { token, basketId: basket.id, jobId };
}

async function setJob(jobId: string, fields: { lease_until?: number; attempts?: number; updated_at?: number }) {
  const entries = Object.entries(fields);
  await env.DB.prepare(`UPDATE jobs SET ${entries.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`)
    .bind(...entries.map(([, value]) => value), jobId)
    .run();
}

async function state(token: string, basketId: string) {
  const basket = await readJson(await call('GET', `/v1/baskets/${basketId}`, { token }), BasketSchema);
  return { basket: basket.status, job: basket.job?.status, error: basket.job?.error?.code ?? null };
}

describe('expireLeases (cron)', () => {
  it('puts a running job whose lease expired back to pending', async () => {
    const { token, basketId, jobId } = await pushedBasket();
    await setJob(jobId, { lease_until: Date.now() - 1, attempts: 1 });

    await expireLeases();

    expect(await state(token, basketId)).toEqual({ basket: 'pushing', job: 'pending', error: null });
    expect((await claimProviderJob(token)).attempts).toBe(2);
  });

  it('fails a job after 3 expired leases and gives the basket back for review', async () => {
    const { token, basketId, jobId } = await pushedBasket();
    await setJob(jobId, { lease_until: Date.now() - 1, attempts: 3 });

    await expireLeases();

    expect(await state(token, basketId)).toEqual({ basket: 'ready', job: 'failed', error: 'lease_expired' });
  });

  it('fails a job paused for more than 20 minutes (login_timeout)', async () => {
    const { token, basketId, jobId } = await pushedBasket();
    await expectNoContent(await call('POST', `/v1/jobs/${jobId}/pause`, { token, body: { reason: 'login_required' } }));

    await expireLeases();
    expect(await state(token, basketId)).toMatchObject({ job: 'paused' });

    await setJob(jobId, { updated_at: Date.now() - PAUSE_TIMEOUT_MS - 1 });
    await expireLeases();
    expect(await state(token, basketId)).toEqual({ basket: 'ready', job: 'failed', error: 'login_timeout' });
    // The executor comes back too late.
    await expectError(await call('POST', `/v1/jobs/${jobId}/resume`, { token }), 409, 'conflict');
  });

  it('leaves a job with a valid lease alone', async () => {
    const { token, basketId } = await pushedBasket();
    await expireLeases();
    expect(await state(token, basketId)).toEqual({ basket: 'pushing', job: 'running', error: null });
  });

  it('runs from the Worker scheduled handler', async () => {
    const { token, basketId, jobId } = await pushedBasket();
    await setJob(jobId, { lease_until: Date.now() - 1, attempts: 3 });

    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await state(token, basketId)).toMatchObject({ job: 'failed', error: 'lease_expired' });
  });
});

describe('POST /v1/baskets/:id/cancel', () => {
  it('stops a running push at its next progress report', async () => {
    const { token, basketId, jobId } = await pushedBasket();

    await readJson(await call('POST', `/v1/baskets/${basketId}/cancel`, { token }), BasketSchema);
    const progress = await call('POST', `/v1/jobs/${jobId}/progress`, { token, body: { done: 0, total: 1 } });
    expect(await readJson(progress, ProgressResponseSchema)).toMatchObject({ cancel: true });

    const error = { code: 'cancelled', message: 'Annulé', retryable: false };
    await expectNoContent(await call('POST', `/v1/jobs/${jobId}/fail`, { token, body: { error } }));
    expect(await state(token, basketId)).toEqual({ basket: 'ready', job: 'failed', error: 'cancelled' });
  });

  it('ends a push nobody has claimed yet', async () => {
    const { token, basketId } = await pushedBasket(false);

    const basket = await readJson(await call('POST', `/v1/baskets/${basketId}/cancel`, { token }), BasketSchema);

    expect(basket.status).toBe('ready');
    expect(basket.job).toMatchObject({ status: 'failed', error: { code: 'cancelled' } });
    await expectNoContent(
      await call('POST', '/v1/jobs/claim', {
        token,
        body: { kinds: ['provider.cart_sync'], agent: { name: 't', version: '0' } },
      }),
    );
  });

  it('ends a paused push: the executor cannot resume it', async () => {
    const { token, basketId, jobId } = await pushedBasket();
    await expectNoContent(await call('POST', `/v1/jobs/${jobId}/pause`, { token, body: { reason: 'challenge' } }));

    await call('POST', `/v1/baskets/${basketId}/cancel`, { token });

    const job = await readJson(await call('GET', `/v1/jobs/${jobId}`, { token }), JobSummarySchema);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'cancelled' } });
    await expectError(await call('POST', `/v1/jobs/${jobId}/resume`, { token }), 409, 'conflict');
  });

  it('refuses when nothing runs', async () => {
    const { token, basketId, jobId } = await pushedBasket();
    await call('POST', `/v1/baskets/${basketId}/cancel`, { token });
    const error = { code: 'cancelled', message: 'Annulé', retryable: false };
    await call('POST', `/v1/jobs/${jobId}/fail`, { token, body: { error } });

    await expectError(await call('POST', `/v1/baskets/${basketId}/cancel`, { token }), 409, 'conflict');
  });
});
