import { env } from 'cloudflare:workers';
import { BasketSchema, CreateUserResponseSchema, MeResponseSchema, PairResponseSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { call, createBasket, expectError, readJson, relayToken, seedUser } from '../test/helpers.ts';

async function seedAdmin() {
  const admin = await seedUser('Admin');
  await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(admin.userId).run();
  return admin;
}

const createUser = (token: string, body: unknown) => call('POST', '/v1/admin/users', { token, body });

describe('POST /v1/admin/users', () => {
  it('creates a user whose code pairs a first device', async () => {
    const { token } = await seedAdmin();
    const created = await readJson(await createUser(token, { name: '  Bob ' }), CreateUserResponseSchema, 201);
    expect(created.user).toMatchObject({ name: 'Bob', isAdmin: false });
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);

    const paired = await readJson(
      await call('POST', '/v1/pair', { body: { code: created.code, label: 'Chrome' } }),
      PairResponseSchema,
    );
    expect(paired.user).toEqual(created.user);
    const me = await readJson(await call('GET', '/v1/me', { token: paired.token }), MeResponseSchema);
    expect(me.user.id).toBe(created.user.id);
  });

  it('is for admins only', async () => {
    const { token } = await seedUser();
    await expectError(await createUser(token, { name: 'Eve' }), 403, 'forbidden');
    await expectError(await createUser(relayToken, { name: 'Eve' }), 401, 'unauthorized');
    await expectError(await call('POST', '/v1/admin/users', { body: { name: 'Eve' } }), 401, 'unauthorized');
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Eve'").first<number>('n');
    expect(count).toBe(0);
  });

  it('rejects an invalid name', async () => {
    const { token } = await seedAdmin();
    for (const body of [{}, { name: '  ' }, { name: 'x'.repeat(101) }, { name: 'Bob', isAdmin: true }]) {
      await expectError(await createUser(token, body), 400, 'invalid_request');
    }
  });

  it("gives the admin no access to another user's baskets", async () => {
    const admin = await seedAdmin();
    const b = await seedUser('B');
    const basket = await createBasket(b.token);

    await expectError(await call('GET', `/v1/baskets/${basket.id}`, { token: admin.token }), 404, 'not_found');
    expect(await (await call('GET', '/v1/baskets', { token: admin.token })).json()).toEqual([]);
    await readJson(await call('GET', `/v1/baskets/${basket.id}`, { token: b.token }), BasketSchema);
  });
});
