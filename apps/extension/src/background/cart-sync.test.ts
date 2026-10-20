import { type CartLine, ProviderError } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { type CartOp, diffCart, runCartSync } from './cart-sync.ts';
import { CONTEXT, fakeProvider } from './fake-provider.test-util.ts';
import { BACKOFF_MS, toJobError, withRetry } from './runner.ts';

const line = (ref: string, quantity: number) => ({ ref, quantity, label: ref });
const cartLine = (ref: string, quantity: number): CartLine => ({ ref, quantity });

describe('diffCart', () => {
  it.each<[string, CartLine[], ReturnType<typeof line>[], CartOp[]]>([
    ['unchanged', [cartLine('A', 1)], [line('A', 1)], [{ ref: 'A', before: 1, target: 1, write: false }]],
    ['set from absent', [], [line('A', 2)], [{ ref: 'A', before: 0, target: 2, write: true }]],
    [
      'set from another quantity',
      [cartLine('A', 3)],
      [line('A', 1)],
      [{ ref: 'A', before: 3, target: 1, write: true }],
    ],
    ['to 0 removes', [cartLine('A', 2)], [line('A', 0)], [{ ref: 'A', before: 2, target: 0, write: true }]],
    ['to 0 when absent is a no-op', [], [line('A', 0)], [{ ref: 'A', before: 0, target: 0, write: false }]],
    [
      'refs not in the target are untouched',
      [cartLine('A', 1), cartLine('MINE', 4)],
      [line('A', 2)],
      [{ ref: 'A', before: 1, target: 2, write: true }],
    ],
    [
      'duplicate target refs are summed',
      [cartLine('A', 1)],
      [line('A', 1), line('B', 1), line('A', 2)],
      [
        { ref: 'A', before: 1, target: 3, write: true },
        { ref: 'B', before: 0, target: 1, write: true },
      ],
    ],
  ])('%s', (_name, current, target, expected) => {
    expect(diffCart(current, target)).toEqual(expected);
  });
});

describe('runCartSync', () => {
  it('reports one outcome per line and never touches items added by hand', async () => {
    const fake = fakeProvider({
      cart: [cartLine('KEEP', 1), cartLine('MINE', 2), cartLine('DROP', 3)],
      unavailable: ['GONE'],
    });

    const result = await runCartSync(
      { provider: 'carrefour', lines: [line('KEEP', 1), line('NEW', 2), line('GONE', 1), line('DROP', 0)] },
      fake.ctx,
    );

    expect(result).toEqual({
      context: CONTEXT,
      lines: [
        { ref: 'KEEP', outcome: 'unchanged', before: 1, after: 1 },
        { ref: 'NEW', outcome: 'set', before: 0, after: 2 },
        { ref: 'GONE', outcome: 'unavailable', before: 0, after: 0 },
        { ref: 'DROP', outcome: 'set', before: 3, after: 0 },
      ],
    });
    expect(fake.writes).toEqual([
      ['NEW', 2],
      ['GONE', 1],
      ['DROP', 0],
    ]);
    expect(fake.cart.get('MINE')).toBe(2);
    expect(fake.ctx.progress).toHaveBeenLastCalledWith({
      done: 4,
      total: 4,
      lines: [
        { key: 'KEEP', status: 'skipped' },
        { key: 'NEW', status: 'ok' },
        { key: 'GONE', status: 'ok' },
        { key: 'DROP', status: 'ok' },
      ],
    });
  });

  it('writes nothing when the same basket is pushed again', async () => {
    const fake = fakeProvider({ cart: [cartLine('MINE', 1)] });
    const payload = { provider: 'carrefour' as const, lines: [line('A', 1), line('B', 1), line('C', 2)] };

    await runCartSync(payload, fake.ctx);
    fake.writes.length = 0;
    const second = await runCartSync(payload, fake.ctx);

    expect(fake.writes).toEqual([]);
    expect(second.lines.map((l) => l.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(fake.cart.get('MINE')).toBe(1);
  });

  it('fails with auth_required and writes nothing when the session is anonymous', async () => {
    const fake = fakeProvider({ cart: [cartLine('MINE', 1)], loggedIn: false });

    const error = await runCartSync({ provider: 'carrefour', lines: [line('A', 1)] }, fake.ctx).catch(toJobError);

    expect(error).toEqual({
      code: 'auth_required',
      message: 'Connecte-toi sur le site du magasin puis relance l’envoi',
      retryable: true,
    });
    expect(fake.writes).toEqual([]);
  });

  it('fails with auth_required when the session dies during the push', async () => {
    const fake = fakeProvider();
    const setQuantity = fake.client.setQuantity;
    fake.client.setQuantity = async (ref, quantity) => {
      await setQuantity(ref, quantity);
      fake.state.loggedIn = false;
    };

    const error = await runCartSync({ provider: 'carrefour', lines: [line('A', 1)] }, fake.ctx).catch(toJobError);

    expect(error).toMatchObject({ code: 'auth_required' });
  });

  it('marks a line failed when its write is refused and goes on with the others', async () => {
    const fake = fakeProvider({ failures: { BAD: new ProviderError('http', 'HTTP 400', false, 400) } });

    const result = await runCartSync({ provider: 'carrefour', lines: [line('BAD', 1), line('OK', 1)] }, fake.ctx);

    expect(result.lines).toEqual([
      { ref: 'BAD', outcome: 'failed', before: 0, after: 0, error: 'http (400)' },
      { ref: 'OK', outcome: 'set', before: 0, after: 1 },
    ]);
  });

  it('aborts the job on a challenge', async () => {
    const fake = fakeProvider({ failures: { A: new ProviderError('challenge', 'Cloudflare', false, 403) } });

    const error = await runCartSync({ provider: 'carrefour', lines: [line('A', 1), line('B', 1)] }, fake.ctx).catch(
      toJobError,
    );

    expect(error).toMatchObject({ code: 'challenge' });
    expect(fake.writes).toEqual([['A', 1]]);
  });
});

describe('runCartSync with retries (429, 5xx, network)', () => {
  /** setQuantity answers each status in turn, then 200. */
  function flaky(statuses: number[]) {
    const fake = fakeProvider();
    const setQuantity = fake.client.setQuantity;
    fake.client.setQuantity = async (ref, quantity) => {
      const status = statuses.shift();
      if (status === 429) throw new ProviderError('rate_limited', 'HTTP 429', true, 429);
      if (status !== undefined) throw new ProviderError('http', `HTTP ${status}`, true, status);
      await setQuantity(ref, quantity);
    };
    const waits: number[] = [];
    const ctx = { ...fake.ctx, client: withRetry(fake.client, async (ms) => waits.push(ms)) };
    return { fake, ctx, waits };
  }

  it('sets the line after a 429 then a 200', async () => {
    const { ctx, waits } = flaky([429]);

    const result = await runCartSync({ provider: 'carrefour', lines: [line('A', 2)] }, ctx);

    expect(result.lines).toEqual([{ ref: 'A', outcome: 'set', before: 0, after: 2 }]);
    expect(waits).toEqual([BACKOFF_MS[0]]);
  });

  it('fails the job, retryable, when the 500s outlast the backoff', async () => {
    const { fake, ctx, waits } = flaky([500, 500, 500, 500]);

    const error = await runCartSync({ provider: 'carrefour', lines: [line('A', 1), line('B', 1)] }, ctx).catch(
      toJobError,
    );

    expect(error).toMatchObject({ code: 'http', retryable: true });
    expect(waits).toEqual([2_000, 5_000, 15_000]);
    expect(fake.writes).toEqual([]);
  });
});
