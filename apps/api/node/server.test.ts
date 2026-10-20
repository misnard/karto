import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BasketSchema, JobSchema, MeResponseSchema, PairResponseSchema } from '@karto/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from './cloudflare-workers.ts';
import { createD1, openDatabase } from './d1.ts';
import { applyMigrations } from './migrate.ts';
import { createHandler, MAX_BODY_BYTES, type Worker } from './server.ts';

// The real API (src/index.ts) behind the Node adapter, on an in-memory SQLite database.

const RELAY_TOKEN = 'node-test-relay-token';
const db = openDatabase(':memory:');
let server: Server;
let base: string;

beforeAll(async () => {
  applyMigrations(db);
  Object.assign(env, { DB: createD1(db), LLM_RUNTIME: 'cli', LLM_MODEL: 'test-model', RELAY_TOKEN });
  // Computed specifier: the Node typecheck must not follow it into src/ (Workers types).
  const entry = new URL('../src/index.ts', import.meta.url).pathname;
  const worker: Worker = (await import(entry)).default;
  server = createServer(createHandler(worker)).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function seedPairingCode(code: string): string {
  const userId = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').run(userId, 'Node', now);
  db.prepare('INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    createHash('sha256').update(code).digest('hex'),
    userId,
    now + 60_000,
  );
  return userId;
}

function post(path: string, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('Node server', () => {
  it('pairs, reads /v1/me, creates a basket whose llm job the relay can claim', async () => {
    const userId = seedPairingCode('NODE000001');

    const pairRes = await post('/v1/pair', null, { code: 'NODE000001', label: 'node' });
    expect(pairRes.status).toBe(200);
    const { token } = PairResponseSchema.parse(await pairRes.json());

    const meRes = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(MeResponseSchema.parse(await meRes.json()).user.id).toBe(userId);

    const basketRes = await post('/v1/baskets', token, { inputs: [{ kind: 'text', text: 'lait' }] });
    expect(basketRes.status).toBe(202);
    const basket = BasketSchema.parse(await basketRes.json());
    expect(basket.job).toMatchObject({ kind: 'llm', status: 'pending' });

    const claimRes = await post('/v1/jobs/claim', RELAY_TOKEN, { kinds: ['llm'], agent: { name: 't', version: '0' } });
    expect(claimRes.status).toBe(200);
    const job = JobSchema.parse(await claimRes.json());
    expect(job).toMatchObject({ id: basket.job?.id, kind: 'llm', status: 'running' });
  });

  it('answers API errors as JSON, with CORS headers for the extension', async () => {
    const res = await fetch(`${base}/v1/me`, { headers: { origin: 'chrome-extension://abc' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('chrome-extension://abc');
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });

  it('refuses a body over the limit, declared or streamed', async () => {
    const big = new Uint8Array(MAX_BODY_BYTES + 1);
    const declared = await fetch(`${base}/v1/pair`, { method: 'POST', body: big });
    expect(declared.status).toBe(413);

    // No Content-Length (chunked): cut while reading.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const streamed = await fetch(`${base}/v1/pair`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(streamed.status).toBe(413);
  });
});
