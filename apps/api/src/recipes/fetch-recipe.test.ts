import { describe, expect, it, vi } from 'vitest';
import { fetchRecipe, RECIPE_MAX_BYTES, RecipeError, type RecipeErrorCode } from './fetch-recipe.ts';

const URL_OK = 'https://recettes.example.com/gratin';
const RECIPE_HTML = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'Recipe',
  name: 'Gratin',
  recipeIngredient: ['1 kg de pommes de terre'],
  recipeYield: 4,
})}</script></head></html>`;
const HTML = { 'content-type': 'text/html; charset=utf-8' };

/** A fetch double that answers every call with `response()` and records the calls. */
function fakeFetch(response: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => response());
}

function streamOf(chunkCount: number, chunkSize: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent++ >= chunkCount) controller.close();
      else controller.enqueue(new Uint8Array(chunkSize).fill(0x20));
    },
  });
}

async function expectCode(promise: Promise<unknown>, code: RecipeErrorCode) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RecipeError);
  expect(err).toMatchObject({ code });
}

describe('fetchRecipe', () => {
  it('fetches the page like a French browser and extracts the recipe', async () => {
    const fetchImpl = fakeFetch(() => new Response(RECIPE_HTML, { headers: HTML }));
    await expect(fetchRecipe(URL_OK, fetchImpl)).resolves.toEqual({
      title: 'Gratin',
      ingredients: ['1 kg de pommes de terre'],
      servings: 4,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(input).toBe(URL_OK);
    expect(init?.redirect).toBe('follow');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
    expect(headers.get('accept-language')).toBe('fr-FR,fr;q=0.9');
  });

  it('accepts a missing content type and decodes the declared charset', async () => {
    const latin1 = RECIPE_HTML.replace('Gratin', 'Gratin dauphinois à la crème');
    const bytes = Uint8Array.from(latin1, (c) => c.charCodeAt(0));
    // A byte body gets no default content type (a string body would be text/plain).
    const untyped = fakeFetch(() => new Response(new TextEncoder().encode(RECIPE_HTML)));
    await expect(fetchRecipe(URL_OK, untyped)).resolves.toMatchObject({ title: 'Gratin' });
    const typed = fakeFetch(
      () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=ISO-8859-1' } }),
    );
    await expect(fetchRecipe(URL_OK, typed)).resolves.toMatchObject({ title: 'Gratin dauphinois à la crème' });
  });

  it.each<[string, () => Response, RecipeErrorCode]>([
    ['403', () => new Response('Forbidden', { status: 403, headers: HTML }), 'blocked'],
    ['429', () => new Response('Too many', { status: 429 }), 'blocked'],
    [
      'Cloudflare challenge status',
      () => new Response('', { status: 503, headers: { 'cf-mitigated': 'challenge' } }),
      'blocked',
    ],
    [
      'Cloudflare challenge page served with 200',
      () => new Response('<html><head><title>Just a moment...</title></head></html>', { headers: HTML }),
      'blocked',
    ],
    ['404', () => new Response('Not found', { status: 404, headers: HTML }), 'unreachable'],
    ['500', () => new Response('Oops', { status: 500 }), 'unreachable'],
    ['JSON content type', () => Response.json({ '@type': 'Recipe' }), 'not_html'],
    ['PDF content type', () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }), 'not_html'],
    [
      'oversized content-length',
      () => new Response('<html></html>', { headers: { ...HTML, 'content-length': String(RECIPE_MAX_BYTES + 1) } }),
      'too_large',
    ],
    ['oversized streamed body', () => new Response(streamOf(4, 1024 * 1024), { headers: HTML }), 'too_large'],
    ['page without recipe', () => new Response('<html><body>Bonjour</body></html>', { headers: HTML }), 'no_recipe'],
  ])('%s', async (_, response, code) => {
    await expectCode(fetchRecipe(URL_OK, fakeFetch(response)), code);
  });

  it('reads a body just under the limit', async () => {
    const html = RECIPE_HTML.padEnd(RECIPE_MAX_BYTES, ' ');
    await expect(
      fetchRecipe(
        URL_OK,
        fakeFetch(() => new Response(html, { headers: HTML })),
      ),
    ).resolves.toMatchObject({
      title: 'Gratin',
    });
  });

  it.each<[string, unknown]>([
    ['network error', new TypeError('Network connection lost')],
    ['timeout', new DOMException('The operation timed out.', 'TimeoutError')],
  ])('maps a %s to unreachable', async (_, error) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw error;
    });
    await expectCode(fetchRecipe(URL_OK, fetchImpl), 'unreachable');
  });

  it.each([
    'not a url',
    '/recettes/gratin',
    'ftp://recettes.example.com/gratin',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://localhost:8787/v1/me',
    'http://api.localhost/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'https://user:secret@recettes.example.com/',
  ])('rejects %s as invalid_url without fetching', async (url) => {
    const fetchImpl = fakeFetch(() => new Response(RECIPE_HTML, { headers: HTML }));
    await expectCode(fetchRecipe(url, fetchImpl), 'invalid_url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the global fetch by default', async () => {
    const stub = fakeFetch(() => new Response(RECIPE_HTML, { headers: HTML }));
    vi.stubGlobal('fetch', stub);
    try {
      await expect(fetchRecipe(URL_OK)).resolves.toMatchObject({ title: 'Gratin' });
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
