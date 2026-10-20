import type { CartLine, CartSyncPayload, CartSyncResult, JobProgress } from '@karto/contracts';
import { isLineError, lineError, type RunContext } from './runner.ts';

export interface CartOp {
  ref: string;
  /** Quantity in the cart before the sync (0 if absent). */
  before: number;
  target: number;
  /** False when the cart already holds the target quantity. */
  write: boolean;
}

function totals(lines: readonly { ref: string; quantity: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line.ref, (map.get(line.ref) ?? 0) + line.quantity);
  return map;
}

/**
 * Absolute-quantity diff, limited to the refs Karto manages: refs absent from the target are never touched.
 * Target lines pointing to the same ref are summed.
 */
export function diffCart(current: readonly CartLine[], target: CartSyncPayload['lines']): CartOp[] {
  const have = totals(current);
  return [...totals(target)].map(([ref, quantity]) => {
    const before = have.get(ref) ?? 0;
    return { ref, before, target: quantity, write: before !== quantity };
  });
}

/** Pushes target quantities to the cart. Requires a logged-in session: an anonymous one fails before any write. */
export async function runCartSync(payload: CartSyncPayload, { client, progress }: RunContext): Promise<CartSyncResult> {
  const context = await client.getContext({ requireLogin: true });
  const current = await client.getCart();
  const ops = diffCart(current, payload.lines);
  const total = ops.length;
  const lines: NonNullable<JobProgress['lines']> = ops.map((op) => ({
    key: op.ref,
    status: op.write ? 'pending' : 'skipped',
  }));
  const errors = new Map<string, string>();
  let done = ops.filter((op) => !op.write).length;
  await progress({ done, total, lines });

  for (const [index, op] of ops.entries()) {
    if (!op.write) continue;
    try {
      await client.setQuantity(op.ref, op.target);
      lines[index] = { key: op.ref, status: 'ok' };
    } catch (err) {
      if (!isLineError(err)) throw err;
      console.warn('[karto] cart write failed for one line', { ref: op.ref, code: err.code });
      errors.set(op.ref, lineError(err));
      lines[index] = { key: op.ref, status: 'failed', label: lineError(err) };
    }
    done += 1;
    await progress({ done, total, lines });
  }

  // Nothing written: the cart read at the start is still the truth. Otherwise check the session survived the push
  // (an expired session silently writes into an anonymous cart) and read the cart back.
  let after = totals(current);
  if (ops.some((op) => op.write)) {
    await client.getContext({ requireLogin: true });
    after = totals(await client.getCart());
  }

  return {
    context,
    lines: ops.map(({ ref, before, target, write }) => {
      const quantity = after.get(ref) ?? 0;
      if (!write) return { ref, outcome: 'unchanged', before, after: quantity };
      if (quantity === target) return { ref, outcome: 'set', before, after: quantity };
      const error = errors.get(ref);
      if (error) return { ref, outcome: 'failed', before, after: quantity, error };
      if (target > 0 && quantity === 0) return { ref, outcome: 'unavailable', before, after: quantity };
      return { ref, outcome: 'failed', before, after: quantity, error: `Quantité ${quantity} au lieu de ${target}` };
    }),
  };
}
