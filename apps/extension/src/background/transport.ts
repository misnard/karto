import { type HttpRequest, type HttpResponse, ProviderError, type Transport } from '@karto/contracts';
import { isAllowedRequest, REQUEST_DELAY_MS } from '@karto/provider-carrefour';
import { z } from 'zod';
import { reloadTab } from './tab.ts';

/**
 * Runs in the provider tab's MAIN world, so the request carries the user's cookies and passes Cloudflare.
 * Serialized by chrome.scripting.executeScript: it must stay self-contained (no imports, no outer references).
 */
export async function mainWorldFetch(req: HttpRequest): Promise<HttpResponse & { error?: string }> {
  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      credentials: 'include',
    });
    return {
      status: response.status,
      cfMitigated: response.headers.get('cf-mitigated') === 'challenge',
      contentType: response.headers.get('content-type'),
      body: await response.text(),
    };
  } catch (err) {
    // e.g. a redirect to another origin (anti-bot page) makes fetch reject: report it instead of returning nothing.
    return { status: 0, cfMitigated: false, contentType: null, body: '', error: String(err) };
  }
}

// The page could tamper with fetch: treat what comes back from the MAIN world as untrusted.
const HttpResponseSchema = z.strictObject({
  status: z.int(),
  cfMitigated: z.boolean(),
  contentType: z.string().nullable(),
  body: z.string(),
  error: z.string().max(500).optional(),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const INJECTION_TIMEOUT_MS = 15_000;

const between = (min: number, max: number) => min + Math.random() * (max - min);

/** Gap before the next Carrefour call: one request at a time, at a human pace, with an occasional longer pause. */
function humanDelay(): number {
  const { min, max, pauseChance, pauseMin, pauseMax } = REQUEST_DELAY_MS;
  return Math.random() < pauseChance ? between(pauseMin, pauseMax) : between(min, max);
}

/**
 * Rejects when the injection takes too long, e.g. in a frozen background tab. The abandoned injection may still run
 * once the tab wakes up: harmless, since every write is an absolute quantity, so replaying it changes nothing.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError('network', 'Provider tab did not respond', true)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface TransportOptions {
  injectionTimeoutMs?: number;
  /** Reloads the provider tab so the site renews its anti-bot cookies. */
  reload?: (tabId: number) => Promise<void>;
}

/**
 * Transport that sends each request from the provider tab. Requests outside the provider's allow-list are refused
 * before anything is injected. Calls are sequential, with a random delay between two calls.
 */
export function createMainWorldTransport(tabId: number, opts: TransportOptions = {}): Transport {
  const { injectionTimeoutMs = INJECTION_TIMEOUT_MS, reload = reloadTab } = opts;
  let queue: Promise<unknown> = Promise.resolve();
  let lastCallEnd = 0;

  async function call(req: HttpRequest, afterReload = false): Promise<HttpResponse> {
    // Method and path only: never the query, headers or bodies.
    const path = `${req.method} ${new URL(req.url).pathname}`;
    if (!isAllowedRequest(req)) {
      console.error('[karto] request refused by the allow-list', { path });
      throw new ProviderError('http', 'Request refused by the provider allow-list', false);
    }
    if (lastCallEnd > 0) {
      const delay = humanDelay();
      await sleep(lastCallEnd + delay - Date.now());
    }
    try {
      const [injection] = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: mainWorldFetch, args: [req] }),
        injectionTimeoutMs,
      );
      const parsed = HttpResponseSchema.safeParse(injection?.result);
      if (!parsed.success) throw new ProviderError('network', 'No valid response from the provider tab', true);
      const { error, ...response } = parsed.data;
      if (error !== undefined) {
        console.warn('[karto] fetch failed in the provider page', { path, error });
        throw new ProviderError('network', `Fetch failed in the provider page: ${error}`, true);
      }
      console.info('[karto] provider request', { path, status: response.status });
      if (response.cfMitigated && !afterReload) {
        // Cloudflare challenges background requests once its short-lived bot cookie has expired (e.g. the tab sat
        // idle). A page load renews it: reload once and replay. A second challenge is left to the user.
        console.info('[karto] challenge: reloading the provider tab', { path });
        await reload(tabId);
        return await call(req, true);
      }
      return response;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      // Chrome's own message (no page content): e.g. the tab is closed or shows an error page.
      console.warn('[karto] injection failed', { path, error: String(err) });
      throw new ProviderError('network', `Could not run the request in the provider tab: ${String(err)}`, true);
    } finally {
      lastCallEnd = Date.now();
    }
  }

  return (req) => {
    const result = queue.then(() => call(req));

    // The caller gets the error through `result`; the queue only needs to know the call is over.
    queue = result.catch(() => undefined);
    return result;
  };
}
