import { ProviderError } from '@karto/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CONTEXT, fakeProvider, offer } from './fake-provider.test-util.ts';
import { inFrontTab, JobFailure, runSearch, stateAfter, toJobError } from './runner.ts';

const payload = (queries: string[], refs: string[] = []) => ({
  provider: 'carrefour' as const,
  items: queries.map((query, i) => ({ itemId: `item-${i}`, query })),
  refs,
  max: 5,
});

describe('runSearch', () => {
  it('gives no offers to an item that fails and still completes', async () => {
    const fake = fakeProvider({
      failures: { oeufs: new ProviderError('http', 'HTTP 500', true, 500) },
      loggedIn: false,
    });

    const result = await runSearch(payload(['lait', 'oeufs', 'pates']), fake.ctx);

    expect(result).toEqual({
      context: CONTEXT,
      byItem: [
        { itemId: 'item-0', offers: [offer('lait-1')] },
        { itemId: 'item-1', offers: [] },
        { itemId: 'item-2', offers: [offer('pates-1')] },
      ],
      byRef: [],
    });
    expect(fake.client.getOffers).not.toHaveBeenCalled();
    expect(fake.ctx.progress).toHaveBeenCalledTimes(3);
    expect(fake.ctx.progress).toHaveBeenLastCalledWith({
      done: 3,
      total: 3,
      lines: [
        { key: 'item-0', status: 'ok' },
        { key: 'item-1', status: 'failed', label: 'http (500)' },
        { key: 'item-2', status: 'ok' },
      ],
    });
  });

  it('refreshes known refs in one call', async () => {
    const fake = fakeProvider();

    const result = await runSearch(payload(['lait'], ['111', '222']), fake.ctx);

    expect(fake.client.getOffers).toHaveBeenCalledWith(['111', '222']);
    expect(result.byRef).toEqual([offer('111'), offer('222')]);
  });

  it('fails the job when every search fails (provider unreachable, not missing products)', async () => {
    const down = new ProviderError('network', 'Fetch failed in the provider page: TypeError: Failed to fetch', true);
    const fake = fakeProvider({ failures: { lait: down, oeufs: down } });

    const error = await runSearch(payload(['lait', 'oeufs']), fake.ctx).catch(toJobError);

    expect(error).toMatchObject({ code: 'network', retryable: true });
    expect(fake.ctx.progress).toHaveBeenCalledTimes(2);
  });

  it('fails the job on an auth error', async () => {
    const fake = fakeProvider({ failures: { oeufs: new ProviderError('auth_required', 'HTTP 401', false, 401) } });

    const error = await runSearch(payload(['lait', 'oeufs', 'pates']), fake.ctx).catch(toJobError);

    expect(error).toMatchObject({ code: 'auth_required', retryable: true });
    expect(fake.ctx.progress).toHaveBeenCalledTimes(1);
  });
});

describe('toJobError / stateAfter', () => {
  it.each([
    [new ProviderError('challenge', 'cf'), 'challenge', 'challenge'],
    [new ProviderError('no_store', 'no store'), 'no_store', 'no_store'],
    [new ProviderError('network', 'down', true), 'network', 'idle'],
    [new JobFailure({ code: 'cancelled', message: 'Annulé', retryable: false }), 'cancelled', 'idle'],
    [new SyntaxError('Unexpected token < in "<html>…"'), 'internal', 'idle'],
  ])('%s → %s', (err, code, state) => {
    const error = toJobError(err);
    expect(error.code).toBe(code);
    expect(stateAfter(error)).toBe(state);
  });

  it('never forwards the message of an unknown error', () => {
    expect(toJobError(new Error('<html>raw page</html>')).message).not.toContain('html');
  });
});

describe('inFrontTab', () => {
  it.each<[string, () => Promise<string>, boolean]>([
    ['success', async () => 'ok', true],
    ['line-level provider error', () => Promise.reject(new ProviderError('http', 'HTTP 500', true, 500)), true],
    [
      'cancelled',
      () => Promise.reject(new JobFailure({ code: 'cancelled', message: 'Annulé', retryable: false })),
      true,
    ],
    ['auth_required', () => Promise.reject(new ProviderError('auth_required', 'anonymous')), false],
    ['challenge', () => Promise.reject(new ProviderError('challenge', 'cf', false, 403)), false],
    ['no_store', () => Promise.reject(new ProviderError('no_store', 'no store')), false],
  ])('%s → restores the previous tab: %s', async (_name, work, restored) => {
    const tab = { id: 2, restore: vi.fn(async () => undefined) };
    await inFrontTab(tab, work).catch(() => undefined);
    expect(tab.restore).toHaveBeenCalledTimes(restored ? 1 : 0);
  });
});
