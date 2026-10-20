import { env } from 'cloudflare:workers';
import {
  DeviceListResponseSchema,
  MeResponseSchema,
  PairingCodeResponseSchema,
  PairResponseSchema,
  PreferencesSchema,
} from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import {
  call,
  expectError,
  expectNoContent,
  readJson,
  relayToken,
  seedDevice,
  seedPairingCode,
  seedUser,
} from '../test/helpers.ts';

describe('POST /v1/pair', () => {
  it('exchanges a valid code for a working device token', async () => {
    const { userId } = await seedUser('Alice');
    await seedPairingCode(userId, 'ABCDE12345', Date.now() + 60_000);

    const paired = await readJson(
      await call('POST', '/v1/pair', { body: { code: 'abcde-12345', label: 'Chrome' } }),
      PairResponseSchema,
    );
    expect(paired.user).toEqual({ id: userId, name: 'Alice', isAdmin: false });

    const me = await readJson(await call('GET', '/v1/me', { token: paired.token }), MeResponseSchema);
    expect(me.user.id).toBe(userId);
    expect(me.preferences).toMatchObject({ diet: [], organic: 'no', privateLabel: 'neutral' });
  });

  it('rejects a code that was already used', async () => {
    const { userId } = await seedUser();
    await seedPairingCode(userId, 'USED000001', Date.now() + 60_000);
    await readJson(await call('POST', '/v1/pair', { body: { code: 'USED000001', label: 'a' } }), PairResponseSchema);

    await expectError(
      await call('POST', '/v1/pair', { body: { code: 'USED000001', label: 'b' } }),
      401,
      'invalid_pairing_code',
    );
  });

  it('rejects an expired or unknown code', async () => {
    const { userId } = await seedUser();
    await seedPairingCode(userId, 'EXPIRED001', Date.now() - 1);

    await expectError(
      await call('POST', '/v1/pair', { body: { code: 'EXPIRED001', label: 'a' } }),
      401,
      'invalid_pairing_code',
    );
    await expectError(
      await call('POST', '/v1/pair', { body: { code: 'UNKNOWN001', label: 'a' } }),
      401,
      'invalid_pairing_code',
    );
  });

  it('rejects an invalid body', async () => {
    await expectError(await call('POST', '/v1/pair', { body: { code: 'ABCDE12345' } }), 400, 'invalid_request');
  });
});

describe('auth', () => {
  it('rejects a missing, invalid or revoked token', async () => {
    const { userId, token } = await seedUser();
    await readJson(await call('GET', '/v1/me', { token }), MeResponseSchema);

    await expectError(await call('GET', '/v1/me'), 401, 'unauthorized');
    await expectError(await call('GET', '/v1/me', { token: 'not-a-token' }), 401, 'unauthorized');

    await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ?').bind(Date.now(), userId).run();
    await expectError(await call('GET', '/v1/me', { token }), 401, 'unauthorized');
  });
});

describe('PUT /v1/me/preferences', () => {
  const put = (token: string, body: unknown) => call('PUT', '/v1/me/preferences', { token, body });
  const getPreferences = async (token: string) =>
    (await readJson(await call('GET', '/v1/me', { token }), MeResponseSchema)).preferences;

  it('stores complete preferences, defaults applied, and returns them', async () => {
    const { token } = await seedUser();
    const body = {
      diet: ['vegetarian'],
      organic: 'prefer',
      favoriteBrands: ['Panzani'],
      budgetCents: 8000,
      goals: ['high_protein', 'low_salt'],
    };
    const stored = await readJson(await put(token, body), PreferencesSchema);
    expect(stored).toEqual({
      budgetCents: 8000,
      diet: ['vegetarian'],
      allergies: [],
      organic: 'prefer',
      privateLabel: 'neutral',
      favoriteBrands: ['Panzani'],
      bannedBrands: [],
      packSize: 'neutral',
      goals: ['high_protein', 'low_salt'],
    });
    expect(await getPreferences(token)).toEqual(stored);

    const reset = await readJson(await put(token, {}), PreferencesSchema);
    expect(await getPreferences(token)).toEqual(reset);
    expect(reset).toEqual(PreferencesSchema.parse({}));
  });

  it('rejects invalid preferences and keeps the stored ones', async () => {
    const { token } = await seedUser();
    await readJson(await put(token, { packSize: 'value' }), PreferencesSchema);
    for (const body of [
      { organic: 'maybe' },
      { budgetCents: -1 },
      { diet: ['keto'] },
      { goals: ['bulk'] },
      { cookies: 'x' },
      [],
    ]) {
      await expectError(await put(token, body), 400, 'invalid_request');
    }
    expect((await getPreferences(token)).packSize).toBe('value');
  });

  it('only changes the caller and needs a device token', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await readJson(await put(a.token, { diet: ['vegan'] }), PreferencesSchema);
    expect((await getPreferences(b.token)).diet).toEqual([]);
    await expectError(await put(relayToken, { diet: ['vegan'] }), 401, 'unauthorized');
    await expectError(await call('PUT', '/v1/me/preferences', { body: {} }), 401, 'unauthorized');
  });
});

describe('POST /v1/me/pairing-codes', () => {
  it('pairs another device of the same user, once, for 15 minutes', async () => {
    const { userId, token } = await seedUser('Alice');
    const before = Date.now();
    const { code, expiresAt } = await readJson(
      await call('POST', '/v1/me/pairing-codes', { token }),
      PairingCodeResponseSchema,
      201,
    );
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const stored = await env.DB.prepare('SELECT code_hash FROM pairing_codes WHERE user_id = ?')
      .bind(userId)
      .first<string>('code_hash');
    expect(stored).toMatch(/^[0-9a-f]{64}$/); // only the hash

    const paired = await readJson(
      await call('POST', '/v1/pair', { body: { code, label: 'Laptop' } }),
      PairResponseSchema,
    );
    expect(paired.user.id).toBe(userId);
    await expectError(await call('POST', '/v1/pair', { body: { code, label: 'Again' } }), 401, 'invalid_pairing_code');
  });
});

describe('/v1/me/devices', () => {
  const list = async (token: string) =>
    (await readJson(await call('GET', '/v1/me/devices', { token }), DeviceListResponseSchema)).devices;

  it("lists the caller's devices and flags the current one", async () => {
    const a = await seedUser();
    const second = await seedDevice(a.userId);
    await seedUser(); // another user's device never shows

    const devices = await list(second);
    expect(devices.map((device) => device.current)).toEqual([false, true]);
    expect(devices[1]?.lastSeenAt).toEqual(expect.any(Number));
  });

  it('revokes a device of the caller: its token gets 401 and it leaves the list', async () => {
    const a = await seedUser();
    const second = await seedDevice(a.userId);
    const target = (await list(a.token)).find((device) => !device.current);

    await expectNoContent(await call('DELETE', `/v1/me/devices/${target?.id}`, { token: a.token }));
    await expectError(await call('GET', '/v1/me', { token: second }), 401, 'unauthorized');
    expect((await list(a.token)).map((device) => device.id)).not.toContain(target?.id);
    await expectError(await call('DELETE', `/v1/me/devices/${target?.id}`, { token: a.token }), 404, 'not_found');
  });

  it("cannot revoke another user's device", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const [bDevice] = await list(b.token);

    await expectError(await call('DELETE', `/v1/me/devices/${bDevice?.id}`, { token: a.token }), 404, 'not_found');
    expect(await list(b.token)).toHaveLength(1);
  });
});
