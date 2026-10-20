import { type CartLine, type ProductOffer, type ProviderClient, ProviderError } from '@karto/contracts';
import { vi } from 'vitest';
import type { RunContext } from './runner.ts';

export const CONTEXT = { provider: 'carrefour', storeRef: '112' } as const;

export function offer(ref: string): ProductOffer {
  return { provider: 'carrefour', ref, name: `Product ${ref}`, available: true, priceCents: 100 };
}

interface FakeOptions {
  cart?: CartLine[];
  loggedIn?: boolean;
  /** Refs the store does not sell: setQuantity succeeds but nothing lands in the cart. */
  unavailable?: string[];
  /** Errors thrown by setQuantity / search, by ref or query. */
  failures?: Record<string, ProviderError>;
}

/** In-memory provider: a cart, a login flag, and a log of every write. */
export function fakeProvider(options: FakeOptions = {}) {
  const cart = new Map((options.cart ?? []).map((line) => [line.ref, line.quantity]));
  const state = { loggedIn: options.loggedIn ?? true };
  const writes: [string, number][] = [];
  const failures = options.failures ?? {};

  const client: ProviderClient = {
    id: 'carrefour',
    session: {
      siteUrl: 'https://shop.test/',
      tabUrlPattern: 'https://shop.test/*',
      refreshUrl: 'https://shop.test/refresh',
      loginUrl: 'https://shop.test/login',
      isOnSite: () => true,
    },
    async getContext(opts) {
      if (opts?.requireLogin && !state.loggedIn) throw new ProviderError('auth_required', 'Anonymous session');
      return { ...CONTEXT };
    },
    async search(query) {
      const failure = failures[query];
      if (failure) throw failure;
      return [offer(`${query}-1`)];
    },
    getOffers: vi.fn(async (refs: string[]) => refs.map(offer)),
    async getCart() {
      return [...cart].map(([ref, quantity]) => ({ ref, quantity }));
    },
    async setQuantity(ref, quantity) {
      writes.push([ref, quantity]);
      const failure = failures[ref];
      if (failure) throw failure;
      if (options.unavailable?.includes(ref)) return;
      if (quantity === 0) cart.delete(ref);
      else cart.set(ref, quantity);
    },
  };

  const ctx: RunContext = { client, progress: vi.fn(async () => undefined) };
  return { client, ctx, cart, state, writes };
}
