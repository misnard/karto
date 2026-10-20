import { env } from 'cloudflare:workers';
import { JobSchema, JobSummarySchema, ResumeResponseSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import {
  agent,
  call,
  expectError,
  expectNoContent,
  parsedBasket,
  parseLine,
  readJson,
  seedDevice,
  seedUser,
} from '../test/helpers.ts';

const kinds = ['provider.search', 'provider.cart_sync'];
const context = { provider: 'carrefour', storeRef: 'store-1' };

/** User A with a parsed basket whose search job is claimed by A's device. */
async function claimedSearch() {
  const a = await seedUser('A');
  const basket = await parsedBasket(a.token, [parseLine('lait')]);
  const job = await readJson(
    await call('POST', '/v1/jobs/claim', { token: a.token, body: { kinds, agent } }),
    JobSchema,
  );
  return { a, basket, job };
}

describe('executor protocol', () => {
  it('keeps users isolated', async () => {
    const b = await seedUser('B');
    const a = await seedUser('A');
    const basket = await parsedBasket(a.token, [parseLine('lait')]);

    await expectNoContent(await call('POST', '/v1/jobs/claim', { token: b.token, body: { kinds, agent } }));
    const job = await readJson(
      await call('POST', '/v1/jobs/claim', { token: a.token, body: { kinds, agent } }),
      JobSchema,
    );

    const token = b.token;
    await expectError(await call('GET', `/v1/baskets/${basket.id}`, { token }), 404, 'not_found');
    await expectError(await call('POST', `/v1/baskets/${basket.id}/push`, { token }), 404, 'not_found');
    await expectError(await call('GET', `/v1/jobs/${job.id}`, { token }), 404, 'not_found');
    const progress = { done: 0, total: 1 };
    await expectError(await call('POST', `/v1/jobs/${job.id}/progress`, { token, body: progress }), 404, 'not_found');
    const result = { context, byItem: [], byRef: [] };
    await expectError(await call('POST', `/v1/jobs/${job.id}/complete`, { token, body: { result } }), 404, 'not_found');
    const error = { code: 'http', message: 'x', retryable: false };
    await expectError(await call('POST', `/v1/jobs/${job.id}/fail`, { token, body: { error } }), 404, 'not_found');
    const list = await call('GET', '/v1/baskets', { token });
    expect(await list.json()).toEqual([]);

    const summary = await readJson(await call('GET', `/v1/jobs/${job.id}`, { token: a.token }), JobSummarySchema);
    expect(summary.status).toBe('running');
  });

  it('forbids devices to claim llm jobs', async () => {
    const { token } = await seedUser();
    const body = { kinds: ['provider.search', 'llm'], agent };
    await expectError(await call('POST', '/v1/jobs/claim', { token, body }), 403, 'forbidden');
  });

  it('only lets the claiming device update a job', async () => {
    const { a, job } = await claimedSearch();
    const otherDevice = await seedDevice(a.userId);
    const body = { done: 0, total: 1 };
    await expectError(await call('POST', `/v1/jobs/${job.id}/progress`, { token: otherDevice, body }), 409, 'conflict');
  });

  it('rejects a result with unknown fields and leaves the job running', async () => {
    const { a, job } = await claimedSearch();
    const result = { context, byItem: [], byRef: [], cookies: 'session=secret' };
    await expectError(
      await call('POST', `/v1/jobs/${job.id}/complete`, { token: a.token, body: { result } }),
      400,
      'invalid_request',
    );
    const nested = { context: { ...context, headers: { cookie: 'x' } }, byItem: [], byRef: [] };
    await expectError(
      await call('POST', `/v1/jobs/${job.id}/complete`, { token: a.token, body: { result: nested } }),
      400,
      'invalid_request',
    );

    const summary = await readJson(await call('GET', `/v1/jobs/${job.id}`, { token: a.token }), JobSummarySchema);
    expect(summary).toMatchObject({ status: 'running', result: null });
  });

  it('pauses and resumes a job', async () => {
    const { a, job } = await claimedSearch();
    const token = a.token;

    await expectNoContent(await call('POST', `/v1/jobs/${job.id}/pause`, { token, body: { reason: 'challenge' } }));
    const paused = await readJson(await call('GET', `/v1/jobs/${job.id}`, { token }), JobSummarySchema);
    expect(paused).toMatchObject({ status: 'paused', error: { code: 'challenge', retryable: true } });
    await expectError(
      await call('POST', `/v1/jobs/${job.id}/progress`, { token, body: { done: 0, total: 1 } }),
      409,
      'conflict',
    );

    const resumed = await readJson(await call('POST', `/v1/jobs/${job.id}/resume`, { token }), ResumeResponseSchema);
    expect(resumed.leaseUntil).toBeGreaterThan(Date.now());
    const running = await readJson(await call('GET', `/v1/jobs/${job.id}`, { token }), JobSummarySchema);
    expect(running).toMatchObject({ status: 'running', error: null });
    await expectError(await call('POST', `/v1/jobs/${job.id}/resume`, { token }), 409, 'conflict');
  });

  it('does not claim a running job whose lease is still valid', async () => {
    const { a } = await claimedSearch();
    const otherDevice = await seedDevice(a.userId);
    await expectNoContent(await call('POST', '/v1/jobs/claim', { token: a.token, body: { kinds, agent } }));
    await expectNoContent(await call('POST', '/v1/jobs/claim', { token: otherDevice, body: { kinds, agent } }));
  });

  it('reclaims a running job whose lease expired', async () => {
    const { a, job } = await claimedSearch();
    const progress = { done: 1, total: 1 };
    await call('POST', `/v1/jobs/${job.id}/progress`, { token: a.token, body: progress });
    await setJob(job.id, 'running', Date.now() - 1, 1);

    const otherDevice = await seedDevice(a.userId);
    const reclaimed = await readJson(
      await call('POST', '/v1/jobs/claim', { token: otherDevice, body: { kinds, agent } }),
      JobSchema,
    );
    expect(reclaimed).toMatchObject({ id: job.id, status: 'running', attempts: 2 });
    expect(reclaimed.leaseUntil).toBeGreaterThan(Date.now());
    const summary = await readJson(await call('GET', `/v1/jobs/${job.id}`, { token: a.token }), JobSummarySchema);
    expect(summary.progress).toBeNull();

    // The previous claimer comes back: rejected.
    await expectError(
      await call('POST', `/v1/jobs/${job.id}/progress`, { token: a.token, body: progress }),
      409,
      'conflict',
    );
    const result = { context, byItem: [], byRef: [] };
    await expectError(
      await call('POST', `/v1/jobs/${job.id}/complete`, { token: a.token, body: { result } }),
      409,
      'conflict',
    );
  });

  it.each([
    ['running at max attempts', 'running', 3],
    ['paused', 'paused', 1],
  ] as const)('does not reclaim an expired job %s', async (_, status, attempts) => {
    const { a, job } = await claimedSearch();
    await setJob(job.id, status, Date.now() - 1, attempts);
    await expectNoContent(await call('POST', '/v1/jobs/claim', { token: a.token, body: { kinds, agent } }));
  });
});

async function setJob(jobId: string, status: string, leaseUntil: number, attempts: number): Promise<void> {
  await env.DB.prepare('UPDATE jobs SET status = ?, lease_until = ?, attempts = ? WHERE id = ?')
    .bind(status, leaseUntil, attempts, jobId)
    .run();
}
