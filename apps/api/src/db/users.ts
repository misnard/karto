import { env } from 'cloudflare:workers';
import { type Device, type MeResponse, type Preferences, PreferencesSchema, type User } from '@karto/contracts';

export async function getMe(userId: string): Promise<MeResponse | null> {
  const row = await env.DB.prepare('SELECT id, name, is_admin, preferences FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; name: string; is_admin: number; preferences: string }>();
  if (!row) return null;
  return {
    user: { id: row.id, name: row.name, isAdmin: row.is_admin === 1 },
    preferences: PreferencesSchema.parse(JSON.parse(row.preferences)),
  };
}

export async function getPreferences(userId: string): Promise<Preferences> {
  const preferences = await env.DB.prepare('SELECT preferences FROM users WHERE id = ?')
    .bind(userId)
    .first<string>('preferences');
  return PreferencesSchema.parse(JSON.parse(preferences ?? '{}'));
}

export async function setPreferences(userId: string, preferences: Preferences): Promise<void> {
  await env.DB.prepare('UPDATE users SET preferences = ? WHERE id = ?').bind(JSON.stringify(preferences), userId).run();
}

export async function createDevice(userId: string, label: string, tokenHash: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO devices (id, user_id, label, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), userId, label, tokenHash, now, now)
    .run();
}

function insertPairingCode(userId: string, codeHash: string, expiresAt: number): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(
    codeHash,
    userId,
    expiresAt,
  );
}

/** A pairing code for another device of `userId`. */
export async function createPairingCode(userId: string, codeHash: string, expiresAt: number): Promise<void> {
  await insertPairingCode(userId, codeHash, expiresAt).run();
}

/** Admin only (checked by the route): a new non-admin user and their first pairing code, atomically. */
export async function createUser(name: string, codeHash: string, expiresAt: number): Promise<User> {
  const user = { id: crypto.randomUUID(), name, isAdmin: false };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').bind(user.id, name, Date.now()),
    insertPairingCode(user.id, codeHash, expiresAt),
  ]);
  return user;
}

/** Non-revoked devices of `userId`, oldest first. */
export async function listDevices(userId: string, currentDeviceId: string): Promise<Device[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, label, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices
     WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid`,
  )
    .bind(userId)
    .all<Omit<Device, 'current'>>();
  return results.map((device) => ({ ...device, current: device.id === currentDeviceId }));
}

/** Revokes a device of `userId`: its token gets 401 from then on. False if unknown, another user's or revoked. */
export async function revokeDevice(userId: string, deviceId: string): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    'UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
  )
    .bind(Date.now(), deviceId, userId)
    .run();
  return meta.changes === 1;
}

/** Pre-auth (no userId yet): marks an unused, unexpired code as used, atomically. Returns its user id. */
export async function consumePairingCode(codeHash: string): Promise<string | null> {
  return env.DB.prepare(
    'UPDATE pairing_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING user_id',
  )
    .bind(Date.now(), codeHash)
    .first<string>('user_id');
}

/** Pre-auth (no userId yet): resolves a non-revoked device by token hash and records the access. */
export async function touchDevice(tokenHash: string): Promise<{ id: string; userId: string } | null> {
  return env.DB.prepare(
    'UPDATE devices SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL RETURNING id, user_id AS userId',
  )
    .bind(Date.now(), tokenHash)
    .first<{ id: string; userId: string }>();
}
