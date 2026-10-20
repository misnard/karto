import { env } from 'cloudflare:workers';
import { BasketSchema, DeviceListResponseSchema, JobSchema, MeResponseSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import {
  agent,
  call,
  claimProviderJob,
  expectError,
  expectNoContent,
  parsedBasket,
  parseLine,
  readJson,
  seedDevice,
  seedUser,
} from '../test/helpers.ts';

/* Step 8, criterion 1: users never see or change each other's data, and a revoked device is locked out. */

const kinds = ['provider.search', 'provider.cart_sync'];
const result = { context: { provider: 'carrefour', storeRef: 'store-1' }, byItem: [], byRef: [] };

describe('isolation between users', () => {
  it("A can neither read nor modify B's baskets (404)", async () => {
    const a = await seedUser('A');
    const b = await seedUser('B');
    const basket = await parsedBasket(b.token, [parseLine('lait'), parseLine('oeufs')]);
    const itemId = basket.items[0]?.id;
    const path = `/v1/baskets/${basket.id}`;

    const attempts: [string, string, unknown?][] = [
      ['GET', path],
      ['PATCH', `${path}/items/${itemId}`, { op: 'remove' }],
      ['POST', `${path}/push`],
      ['POST', `${path}/retry`],
      ['POST', `${path}/amend`, { text: 'enlève le lait' }],
      ['POST', `${path}/cancel`],
    ];
    for (const [method, url, body] of attempts) {
      await expectError(await call(method, url, { token: a.token, body }), 404, 'not_found');
    }
    expect(await (await call('GET', '/v1/baskets', { token: a.token })).json()).toEqual([]);

    expect(await readJson(await call('GET', path, { token: b.token }), BasketSchema)).toEqual(basket);
  });

  it("A's executor cannot claim or drive B's jobs", async () => {
    const a = await seedUser('A');
    const b = await seedUser('B');
    await parsedBasket(b.token, [parseLine('lait')]);

    await expectNoContent(await call('POST', '/v1/jobs/claim', { token: a.token, body: { kinds, agent } }));
    const job = await claimProviderJob(b.token);
    expect(job.kind).toBe('provider.search');

    const attempts: [string, string, unknown?][] = [
      ['GET', `/v1/jobs/${job.id}`],
      ['POST', `/v1/jobs/${job.id}/progress`, { done: 0, total: 1 }],
      ['POST', `/v1/jobs/${job.id}/pause`, { reason: 'login_required' }],
      ['POST', `/v1/jobs/${job.id}/resume`, {}],
      ['POST', `/v1/jobs/${job.id}/complete`, { result }],
      ['POST', `/v1/jobs/${job.id}/fail`, { error: { code: 'http', message: 'x', retryable: false } }],
    ];
    for (const [method, url, body] of attempts) {
      await expectError(await call(method, url, { token: a.token, body }), 404, 'not_found');
    }
    await expectNoContent(await call('POST', `/v1/jobs/${job.id}/complete`, { token: b.token, body: { result } }));
  });
});

describe('revoked device', () => {
  it('gets 401 everywhere, /v1/jobs included, while the other devices keep working', async () => {
    const a = await seedUser('A');
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(a.userId).run();
    const laptop = await seedDevice(a.userId);
    const basket = await parsedBasket(laptop, [parseLine('lait')]);
    const job = await readJson(
      await call('POST', '/v1/jobs/claim', { token: laptop, body: { kinds, agent } }),
      JobSchema,
    );

    const { devices } = await readJson(
      await call('GET', '/v1/me/devices', { token: a.token }),
      DeviceListResponseSchema,
    );
    const laptopId = devices.find((device) => !device.current)?.id;
    await expectNoContent(await call('DELETE', `/v1/me/devices/${laptopId}`, { token: a.token }));

    const attempts: [string, string, unknown?][] = [
      ['GET', '/v1/me'],
      ['PUT', '/v1/me/preferences', {}],
      ['GET', '/v1/me/devices'],
      ['POST', '/v1/me/pairing-codes'],
      ['DELETE', `/v1/me/devices/${laptopId}`],
      ['POST', '/v1/admin/users', { name: 'Eve' }],
      ['GET', '/v1/baskets'],
      ['POST', '/v1/baskets', { inputs: [{ kind: 'text', text: 'lait' }] }],
      ['GET', `/v1/baskets/${basket.id}`],
      ['POST', `/v1/baskets/${basket.id}/cancel`],
      ['POST', '/v1/jobs/claim', { kinds, agent }],
      ['GET', `/v1/jobs/${job.id}`],
      ['POST', `/v1/jobs/${job.id}/progress`, { done: 0, total: 1 }],
      ['POST', `/v1/jobs/${job.id}/complete`, { result }],
      ['POST', `/v1/jobs/${job.id}/fail`, { error: { code: 'http', message: 'x', retryable: false } }],
    ];
    for (const [method, url, body] of attempts) {
      await expectError(await call(method, url, { token: laptop, body }), 401, 'unauthorized');
    }

    const me = await readJson(await call('GET', '/v1/me', { token: a.token }), MeResponseSchema);
    expect(me.user.id).toBe(a.userId);
    await readJson(await call('GET', `/v1/baskets/${basket.id}`, { token: a.token }), BasketSchema);
  });
});
