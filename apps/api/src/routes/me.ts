import {
  type MeResponse,
  PairRequestSchema,
  type PairResponse,
  type Preferences,
  PreferencesSchema,
} from '@karto/contracts';
import { Hono } from 'hono';
import { type AppEnv, newDeviceToken, sha256Hex } from '../auth.ts';
import { consumePairingCode, createDevice, getMe, setPreferences } from '../db/users.ts';
import { AppError, readBody } from '../errors.ts';

/** POST /v1/pair, public: exchanges a one-time pairing code for a device token. */
export const pair = new Hono<AppEnv>().post('/', async (c) => {
  const { code, label } = await readBody(c, PairRequestSchema);
  // Codes are printed upper case; tolerate lower case, spaces and dashes when typed.
  const userId = await consumePairingCode(await sha256Hex(code.toUpperCase().replace(/[\s-]/g, '')));
  const me = userId ? await getMe(userId) : null;
  if (!me) throw new AppError('invalid_pairing_code', 401, 'Invalid, used or expired pairing code');
  const token = newDeviceToken();
  await createDevice(me.user.id, label, await sha256Hex(token));
  return c.json({ token, user: me.user } satisfies PairResponse);
});

export const me = new Hono<AppEnv>()
  .get('/', async (c) => {
    const me = await getMe(c.var.userId);
    if (!me) throw new AppError('unauthorized', 401, 'Unknown user');
    return c.json(me satisfies MeResponse);
  })
  .put('/preferences', async (c) => {
    // Defaults are applied: what is stored is always a complete Preferences.
    const preferences = await readBody(c, PreferencesSchema);
    await setPreferences(c.var.userId, preferences);
    return c.json(preferences satisfies Preferences);
  });
