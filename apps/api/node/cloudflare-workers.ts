import { timingSafeEqual } from 'node:crypto';

/*
 * Stand-in for the `cloudflare:workers` module when the API runs on Node (server.ts maps the specifier here).
 * Only what src/ uses: `env` (bindings, filled by server.ts before the API is imported) and `waitUntil`.
 */

export const env: Record<string, unknown> = {};

/** Background tasks still running: server.ts waits for them on shutdown. */
export const pending = new Set<Promise<unknown>>();

export function waitUntil(promise: Promise<unknown>): void {
  const task = promise
    .catch((err: unknown) => console.error('waitUntil task failed', err))
    .finally(() => pending.delete(task));
  pending.add(task);
}

// Workers adds timingSafeEqual to SubtleCrypto (auth.ts uses it); Node has it in node:crypto, same semantics.
Object.assign(crypto.subtle, { timingSafeEqual });
