import { env, exports } from 'cloudflare:workers';
import {
  ApiErrorBodySchema,
  type ApiErrorCode,
  type Basket,
  BasketSchema,
  type Job,
  JobSchema,
  type LlmResult,
  type ProductOffer,
} from '@karto/contracts';
import { expect } from 'vitest';
import type { z } from 'zod';
import { sha256Hex } from '../auth.ts';
import type { ParseLine } from '../llm/prompts/parse.ts';

export const agent = { name: 'test-executor', version: '0.0.0' };
/** Same value as the RELAY_TOKEN binding in vitest.config.ts. */
export const relayToken = 'test-relay-token';

/** Inserts a user with one paired device. */
export async function seedUser(name = 'Test'): Promise<{ userId: string; token: string }> {
  const userId = crypto.randomUUID();
  return { userId, token: await seedDevice(userId, name) };
}

/** Inserts a device for `userId` (creating the user unless it exists) and returns its token. */
export async function seedDevice(userId: string, name = 'Test'): Promise<string> {
  const token = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, ?)').bind(userId, name, now),
    env.DB.prepare('INSERT INTO devices (id, user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      crypto.randomUUID(),
      userId,
      'test',
      await sha256Hex(token),
      now,
    ),
  ]);
  return token;
}

export async function seedPairingCode(userId: string, code: string, expiresAt: number): Promise<void> {
  await env.DB.prepare('INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(code), userId, expiresAt)
    .run();
}

export function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return exports.default.fetch(`http://api.test${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

/** Asserts the status, then parses the body with the matching contract schema. */
export async function readJson<T extends z.ZodType>(res: Response, schema: T, status = 200): Promise<z.output<T>> {
  expect(res.status).toBe(status);
  return schema.parse(await res.json());
}

export async function expectError(res: Response, status: number, code: ApiErrorCode): Promise<void> {
  const body = await readJson(res, ApiErrorBodySchema, status);
  expect(body.error.code).toBe(code);
}

export async function expectNoContent(res: Response): Promise<void> {
  expect(res.status).toBe(204);
  expect(await res.text()).toBe('');
}

export function offer(ref: string, priceCents: number, available = true): ProductOffer {
  return { provider: 'carrefour', ref, name: `Product ${ref}`, priceCents, available };
}

/** A parse line as the LLM returns it. */
export function parseLine(key: string, overrides: Partial<ParseLine> = {}): ParseLine {
  return {
    sourceIndex: 0,
    key,
    label: key,
    quantity: 1,
    unit: 'piece',
    query: key,
    excludeTerms: [],
    approx: false,
    pieceWeightG: null,
    ...overrides,
  };
}

export function llmResult(output: unknown, usage = { inputTokens: 1000, outputTokens: 200 }): LlmResult {
  return { text: typeof output === 'string' ? output : JSON.stringify(output), usage };
}

export async function createBasket(token: string, text = 'lait, oeufs, pâtes', servings?: number): Promise<Basket> {
  const body = { inputs: [{ kind: 'text', text }], servings };
  return readJson(await call('POST', '/v1/baskets', { token, body }), BasketSchema, 202);
}

/**
 * Plays the LLM relay: claims llm jobs until it gets `jobId`. The relay works for every user, so llm jobs left
 * pending by earlier tests of the same file come first (storage is per test file).
 */
export async function relayClaim(jobId: string): Promise<Job> {
  for (let i = 0; i < 20; i++) {
    const res = await call('POST', '/v1/jobs/claim', { token: relayToken, body: { kinds: ['llm'], agent } });
    const job = await readJson(res, JobSchema);
    if (job.id === jobId) return job;
  }
  throw new Error(`llm job ${jobId} never claimed`);
}

export async function relayComplete(jobId: string, result: LlmResult): Promise<Response> {
  return call('POST', `/v1/jobs/${jobId}/complete`, { token: relayToken, body: { result } });
}

/** Creates a basket and plays the relay parse with `lines`: the basket is then searching. */
export async function parsedBasket(token: string, lines: ParseLine[], servings?: number): Promise<Basket> {
  const basket = await createBasket(token, lines.map((line) => line.key).join(', '), servings);
  const job = await relayClaim(basket.job?.id ?? '');
  await expectNoContent(await relayComplete(job.id, llmResult({ lines })));
  return readJson(await call('GET', `/v1/baskets/${basket.id}`, { token }), BasketSchema);
}

/** Plays the device executor: claims the user's next provider job. */
export async function claimProviderJob(token: string): Promise<Job> {
  const body = { kinds: ['provider.search', 'provider.cart_sync'], agent };
  return readJson(await call('POST', '/v1/jobs/claim', { token, body }), JobSchema);
}

/** Claims the next search and completes it with offers per item label (missing labels: no offer). */
export async function completeSearch(
  token: string,
  basketId: string,
  offersByLabel: Record<string, ProductOffer[]>,
): Promise<Basket> {
  const search = await claimProviderJob(token);
  if (search.kind !== 'provider.search') throw new Error(`unexpected job ${search.kind}`);
  const basket = await readJson(await call('GET', `/v1/baskets/${basketId}`, { token }), BasketSchema);
  const labels = new Map(basket.items.map((item) => [item.id, item.label]));
  const byItem = search.payload.items.map(({ itemId }) => ({
    itemId,
    offers: offersByLabel[labels.get(itemId) ?? ''] ?? [],
  }));
  const result = { context: { provider: 'carrefour', storeRef: 'store-1' }, byItem, byRef: [] };
  await expectNoContent(await call('POST', `/v1/jobs/${search.id}/complete`, { token, body: { result } }));
  return readJson(await call('GET', `/v1/baskets/${basketId}`, { token }), BasketSchema);
}
