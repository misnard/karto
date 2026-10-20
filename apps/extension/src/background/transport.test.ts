import { type HttpRequest, type HttpResponse, ProviderError } from '@karto/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMainWorldTransport, mainWorldFetch } from './transport.ts';

const allowList = vi.hoisted(() => ({ allowed: true }));
vi.mock('@karto/provider-carrefour', () => ({
  isAllowedRequest: () => allowList.allowed,
  REQUEST_DELAY_MS: { min: 0, max: 0, pauseChance: 0, pauseMin: 0, pauseMax: 0 },
}));

const req: HttpRequest = {
  method: 'PATCH',
  url: 'https://shop.test/cart',
  headers: { 'content-type': 'application/json' },
  body: '{"q":1}',
};
const res: HttpResponse = { status: 200, cfMitigated: false, contentType: 'application/json', body: '{}' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mainWorldFetch', () => {
  it('is self-contained once serialized, like executeScript does', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response('blocked', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
        }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const serialized = new Function(`return (${mainWorldFetch.toString()})`)() as typeof mainWorldFetch;

    const result = await serialized(req);

    expect(result).toEqual({ status: 403, cfMitigated: true, contentType: 'text/html', body: 'blocked' });
    expect(fetchStub).toHaveBeenCalledWith(req.url, {
      method: 'PATCH',
      headers: req.headers,
      body: req.body,
      credentials: 'include',
    });
  });

  it('reports no challenge and a null content type when the headers are absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    expect(await mainWorldFetch({ method: 'GET', url: 'https://shop.test/', headers: {} })).toEqual({
      status: 204,
      cfMitigated: false,
      contentType: null,
      body: '',
    });
  });
});

describe('createMainWorldTransport', () => {
  const executeScript = vi.fn();
  const tabId = 7;

  beforeEach(() => {
    allowList.allowed = true;
    executeScript.mockReset();
    vi.stubGlobal('chrome', { scripting: { executeScript } });
  });

  it('refuses a request outside the allow-list without injecting anything', async () => {
    allowList.allowed = false;
    const transport = createMainWorldTransport(tabId);

    const error = await transport(req).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code: 'http',
      retryable: false,
      message: 'Request refused by the provider allow-list',
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('runs mainWorldFetch in the MAIN world of the provider tab', async () => {
    executeScript.mockResolvedValue([{ frameId: 0, documentId: 'd', result: res }]);
    const transport = createMainWorldTransport(tabId);

    expect(await transport(req)).toEqual(res);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      world: 'MAIN',
      func: mainWorldFetch,
      args: [req],
    });
  });

  it.each([
    ['no result', [{ frameId: 0, documentId: 'd' }]],
    ['a tampered result', [{ frameId: 0, documentId: 'd', result: { ...res, cookie: 'x' } }]],
  ])('turns %s into a retryable network error', async (_name, injection) => {
    executeScript.mockResolvedValue(injection);
    const error = await createMainWorldTransport(tabId)(req).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'network', retryable: true });
  });

  it('gives up on an injection that never returns (frozen background tab)', async () => {
    executeScript.mockReturnValue(new Promise(() => undefined));
    const error = await createMainWorldTransport(tabId, { injectionTimeoutMs: 10 })(req).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'network', retryable: true, message: 'Provider tab did not respond' });
  });

  it('turns an injection failure into a retryable network error', async () => {
    executeScript.mockRejectedValue(new Error('No tab with id: 7'));
    await expect(createMainWorldTransport(tabId)(req)).rejects.toMatchObject({ code: 'network', retryable: true });
  });

  it('reports a fetch that failed inside the page (e.g. cross-origin redirect) as a retryable network error', async () => {
    const failed = { status: 0, cfMitigated: false, contentType: null, body: '', error: 'TypeError: Failed to fetch' };
    executeScript.mockResolvedValue([{ frameId: 0, documentId: 'd', result: failed }]);
    const error = await createMainWorldTransport(tabId)(req).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'network', retryable: true });
    expect((error as Error).message).toContain('Failed to fetch');
  });

  it('reloads the tab once on a Cloudflare challenge, then replays the request', async () => {
    const challenged = { ...res, status: 403, cfMitigated: true, contentType: 'text/html' };
    executeScript
      .mockResolvedValueOnce([{ frameId: 0, documentId: 'd', result: challenged }])
      .mockResolvedValueOnce([{ frameId: 0, documentId: 'd', result: res }]);
    const reload = vi.fn(async () => undefined);

    expect(await createMainWorldTransport(tabId, { reload })(req)).toEqual(res);
    expect(reload).toHaveBeenCalledExactlyOnceWith(7);
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('returns a second challenge as is, for the user to solve', async () => {
    const challenged = { ...res, status: 403, cfMitigated: true, contentType: 'text/html' };
    executeScript.mockResolvedValue([{ frameId: 0, documentId: 'd', result: challenged }]);
    const reload = vi.fn(async () => undefined);

    expect(await createMainWorldTransport(tabId, { reload })(req)).toEqual(challenged);
    expect(reload).toHaveBeenCalledOnce();
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('sends requests one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    executeScript.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [{ frameId: 0, documentId: 'd', result: res }];
    });
    const transport = createMainWorldTransport(tabId);

    await Promise.all([transport(req), transport(req), transport(req)]);

    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });
});
