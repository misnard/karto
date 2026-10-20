import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pending, waitUntil } from './cloudflare-workers.ts';
import { createD1, openDatabase } from './d1.ts';
import { applyMigrations } from './migrate.ts';

/*
 * The Karto API on Node, to self-host it (e.g. on a VPS): the Worker's own fetch handler behind node:http, with D1
 * over node:sqlite. src/ is not changed: its `cloudflare:workers` import resolves to ./cloudflare-workers.ts.
 *
 * Environment: HOST (127.0.0.1), PORT (8787), KARTO_DB (apps/api/data/karto.sqlite), LLM_RUNTIME, LLM_MODEL,
 * ANTHROPIC_API_KEY, RELAY_TOKEN. Every variable is passed to the API as a binding.
 */

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const CRON_INTERVAL_MS = 60_000;
/** Same defaults as the `vars` of wrangler.jsonc. */
const DEFAULT_VARS = { LLM_RUNTIME: 'cli', LLM_MODEL: 'claude-haiku-5-5' };

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, never>;
}

/** The default export of src/index.ts: a Hono app, or a handler object once it has `scheduled`. */
export interface Worker {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(
    controller: { scheduledTime: number; cron: string; noRetry(): void },
    env: unknown,
    ctx: ExecutionContext,
  ): unknown;
}

const ctx: ExecutionContext = { waitUntil, passThroughOnException() {}, props: {} };

class BodyTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function sendTooLarge(res: ServerResponse): void {
  const error = { code: 'invalid_request', message: 'Request body too large' };
  // No `connection: close`: closing while the client still uploads resets the socket before it reads the 413.
  // node:http discards the unread rest of the body (never buffered), bounded by the server's requestTimeout.
  sendJson(res, 413, { error });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Also covers bodies without Content-Length (chunked): never buffered past the limit.
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** node:http → Fetch Request → worker.fetch → node:http. Responses are small JSON: no streaming. */
export function createHandler(worker: Worker) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return sendTooLarge(res);
      const method = req.method ?? 'GET';
      const headers = new Headers();
      for (const [name, values] of Object.entries(req.headersDistinct)) {
        for (const value of values ?? []) headers.append(name, value);
      }
      const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
      // Routes only use the path: a fixed origin avoids trusting the Host header.
      const request = new Request(new URL(req.url ?? '/', 'http://localhost'), { method, headers, body });
      const response = await worker.fetch(request, env, ctx);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendTooLarge(res);
      console.error('request failed', { method: req.method, url: req.url, error: err });
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'Internal error' } });
      else res.destroy();
    }
  };
}

async function main(): Promise<void> {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const dbPath = resolve(process.env.KARTO_DB || fileURLToPath(new URL('../data/karto.sqlite', import.meta.url)));

  const db = openDatabase(dbPath);
  for (const name of applyMigrations(db)) console.log(`migration applied: ${name}`);
  const vars = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value));
  Object.assign(env, DEFAULT_VARS, vars, { DB: createD1(db) });

  const shim = new URL('./cloudflare-workers.ts', import.meta.url).href;
  registerHooks({
    resolve: (specifier, context, nextResolve) =>
      specifier === 'cloudflare:workers' ? { url: shim, shortCircuit: true } : nextResolve(specifier, context),
  });
  // Computed specifier: the Node typecheck does not follow it into src/ (Workers types).
  const entry = new URL('../src/index.ts', import.meta.url).href;
  const worker: Worker = (await import(entry)).default;

  const server = createServer(createHandler(worker)).listen(port, host, () => {
    console.log(`Karto API listening on http://${host}:${port} (database ${dbPath})`);
  });

  // Same role as the Workers cron trigger, when src/index.ts exports a scheduled handler.
  const scheduled = worker.scheduled?.bind(worker);
  const cron =
    scheduled &&
    setInterval(() => {
      const controller = { scheduledTime: Date.now(), cron: '* * * * *', noRetry() {} };
      // Tracked like a waitUntil task: errors are logged and shutdown waits for it.
      waitUntil(Promise.resolve().then(() => scheduled(controller, env, ctx)));
    }, CRON_INTERVAL_MS);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log(`${signal}: finishing requests and background tasks`);
      clearInterval(cron);
      server.close(() => {
        Promise.allSettled(pending).then(() => db.close());
      });
    });
  }
}

if (import.meta.main) await main();
