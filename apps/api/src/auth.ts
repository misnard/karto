import { env } from 'cloudflare:workers';
import type { Context, MiddlewareHandler } from 'hono';
import { touchDevice } from './db/users.ts';
import { AppError } from './errors.ts';

/** `claimed_by` of jobs taken by the LLM relay (device ids are UUIDs). */
export const RELAY = 'relay';

/** Who runs jobs: a paired device (its user's provider jobs) or the LLM relay (llm jobs of any user). */
export type Executor = { kind: 'device'; userId: string; deviceId: string } | { kind: 'relay' };

export type AppEnv = { Variables: { userId: string; deviceId: string } };
export type JobsEnv = { Variables: { executor: Executor } };

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

export async function sha256Hex(value: string): Promise<string> {
  return Array.from(new Uint8Array(await sha256(value)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random 256-bit device token, base64url without padding. */
export function newDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function bearerToken(c: Context): string | undefined {
  return /^Bearer (\S+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
}

/** Bearer device token → device. Only the token's SHA-256 is stored. */
async function requireDevice(c: Context): Promise<{ id: string; userId: string }> {
  const token = bearerToken(c);
  const device = token ? await touchDevice(await sha256Hex(token)) : null;
  if (!device) throw new AppError('unauthorized', 401, 'Missing, invalid or revoked device token');
  return device;
}

/** Constant-time comparison with the RELAY_TOKEN secret (hashed first so lengths match). */
async function isRelayToken(token: string): Promise<boolean> {
  if (!env.RELAY_TOKEN) return false;
  const [given, expected] = await Promise.all([sha256(token), sha256(env.RELAY_TOKEN)]);
  return crypto.subtle.timingSafeEqual(given, expected);
}

export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const device = await requireDevice(c);
  c.set('userId', device.userId);
  c.set('deviceId', device.id);
  await next();
};

/** Executor protocol (/v1/jobs): the relay token or a device token. */
export const executorAuth: MiddlewareHandler<JobsEnv> = async (c, next) => {
  const token = bearerToken(c);
  if (token && (await isRelayToken(token))) {
    c.set('executor', { kind: 'relay' });
  } else {
    const device = await requireDevice(c);
    c.set('executor', { kind: 'device', userId: device.userId, deviceId: device.id });
  }
  await next();
};
