import {
  type JobError,
  type JobErrorCode,
  type JobProgress,
  type ProductOffer,
  type ProviderClient,
  ProviderError,
  type SearchPayload,
  type SearchResult,
} from '@karto/contracts';
import type { ExecutorState } from '../state.ts';
import type { FrontTab } from './tab.ts';

/* What job runners share: their context, the errors that abort a job, and how errors are reported. */

export interface RunContext {
  client: ProviderClient;
  /** Reports progress (extends the lease). Throws JobFailure 'cancelled' when the user cancelled the job. */
  progress(progress: JobProgress): Promise<void>;
}

/** Ends the job with this exact error. */
export class JobFailure extends Error {
  override readonly name = 'JobFailure';

  constructor(readonly error: JobError) {
    super(error.message);
  }
}

const USER_ACTION: Partial<Record<JobErrorCode, { message: string; state: ExecutorState['state'] }>> = {
  auth_required: { message: 'Connecte-toi sur le site du magasin puis relance l’envoi', state: 'login_required' },
  challenge: { message: 'Vérification anti-robot à faire dans l’onglet du magasin', state: 'challenge' },
  no_store: { message: 'Choisis ton magasin Drive sur le site', state: 'no_store' },
};

/** Errors that only the user can fix in the provider tab: they abort the whole job instead of one line. */
export function needsUser(err: unknown): boolean {
  return err instanceof ProviderError && USER_ACTION[err.code] !== undefined;
}

/** Error sent to the backend. Unknown errors are not forwarded: their message could quote a raw provider response. */
export function toJobError(err: unknown): JobError {
  if (err instanceof JobFailure) return err.error;
  if (err instanceof ProviderError) {
    const action = USER_ACTION[err.code];
    if (action) return { code: err.code, message: action.message, retryable: true };
    return { code: err.code, message: err.message.slice(0, 500), retryable: err.retryable };
  }
  return { code: 'internal', message: 'Erreur interne de l’extension', retryable: false };
}

/** Executor state to show once a job ended with this error. */
export function stateAfter(error: JobError | null): ExecutorState['state'] {
  return (error && USER_ACTION[error.code]?.state) ?? 'idle';
}

/**
 * Runs a job in the provider tab brought to front, then gives the front back to the previous tab, except when the
 * user has to act in the provider tab (login, anti-bot check, store choice): it then stays in front.
 */
export async function inFrontTab<T>(tab: FrontTab, work: () => Promise<T>): Promise<T> {
  const restore = () =>
    tab.restore().catch((err: unknown) => console.warn('[karto] could not restore the previous tab', { err }));
  try {
    const result = await work();
    await restore();
    return result;
  } catch (err) {
    if (!needsUser(err)) await restore();
    throw err;
  }
}

/** Short, safe text for a per-line failure. */
export function lineError(err: ProviderError): string {
  return `${err.code}${err.status ? ` (${err.status})` : ''}`;
}

/** Searches each item (anonymous session is fine). A failing item gets no offers; the job goes on. */
export async function runSearch(payload: SearchPayload, { client, progress }: RunContext): Promise<SearchResult> {
  const context = await client.getContext();
  const total = payload.items.length + (payload.refs.length > 0 ? 1 : 0);
  const lines: NonNullable<JobProgress['lines']> = payload.items.map((item) => ({
    key: item.itemId,
    status: 'pending',
  }));
  const byItem: SearchResult['byItem'] = [];
  let lastFailure: ProviderError | null = null;

  for (const [index, item] of payload.items.entries()) {
    let offers: ProductOffer[] = [];
    try {
      offers = await client.search(item.query, payload.max);
      lines[index] = { key: item.itemId, status: 'ok' };
    } catch (err) {
      if (!(err instanceof ProviderError) || needsUser(err)) throw err;
      console.warn('[karto] search failed for one item', { itemId: item.itemId, code: err.code });
      lines[index] = { key: item.itemId, status: 'failed', label: lineError(err) };
      lastFailure = err;
    }
    byItem.push({ itemId: item.itemId, offers });
    await progress({ done: index + 1, total, lines });
  }

  // Every search failed: the provider is unreachable, not the products. Fail the job so the user can retry it.
  if (lastFailure && lines.every((line) => line.status === 'failed')) throw lastFailure;
  const byRef = payload.refs.length > 0 ? await client.getOffers(payload.refs) : [];
  return { context, byItem, byRef };
}
