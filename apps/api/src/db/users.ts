import { env } from 'cloudflare:workers';
import { type MeResponse, type Preferences, PreferencesSchema } from '@karto/contracts';

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
