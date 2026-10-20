import { readFileSync } from 'node:fs';
import {
  type HttpRequest,
  type HttpResponse,
  type ProductOffer,
  ProductOfferSchema,
  ProviderError,
  type Transport,
} from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { createCarrefourClient, isAllowedRequest } from './index.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (body: string, status = 200): HttpResponse => ({
  status,
  cfMitigated: false,
  contentType: 'application/json; charset=utf-8',
  body,
});

const BASE = 'https://www.carrefour.fr';
const CART = `GET ${BASE}/api/cart`;
const ME = `GET ${BASE}/api/me`;
const SEARCH_LAIT = `GET ${BASE}/autocomplete?q=lait&productCard=true&maxResults=10`;
const HEADERS = { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json, text/plain, */*' };
const JSON_HEADERS = { ...HEADERS, 'content-type': 'application/json' };

type Route = HttpResponse | (() => HttpResponse);

/** Routes are keyed by "METHOD url". Records every request and refuses any outside ALLOWED_ENDPOINTS. */
function fake(routes: Record<string, Route>) {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    requests.push(req);
    if (!isAllowedRequest(req)) throw new Error(`not allowed: ${req.method} ${req.url}`);
    const route = routes[`${req.method} ${req.url}`];
    if (!route) throw new Error(`no route: ${req.method} ${req.url}`);
    return typeof route === 'function' ? route() : route;
  };
  return { client: createCarrefourClient(transport), requests };
}

const byRef = (offers: ProductOffer[], ref: string) => offers.find((o) => o.ref === ref);

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

describe('search', () => {
  it('normalizes autocomplete products', async () => {
    const { client, requests } = fake({ [SEARCH_LAIT]: json(fixture('autocomplete-lait')) });
    const offers = await client.search('lait', 10);

    expect(requests).toEqual([{ method: 'GET', url: SEARCH_LAIT.slice(4), headers: HEADERS }]);
    expect(offers).toHaveLength(10);
    for (const offer of offers) expect(() => ProductOfferSchema.parse(offer)).not.toThrow();

    expect(byRef(offers, '3560071267964')).toEqual({
      provider: 'carrefour',
      ref: '3560071267964',
      name: 'Lait Demi-Ecrémé demi-écrémé SIMPL',
      brand: 'SIMPL',
      pack: { amount: 6000, unit: 'ml' },
      priceCents: 564,
      unitPrice: { cents: 94, per: 'l' },
      available: true,
      maxQuantity: 10,
      variableWeight: false,
      category: 'Crèmerie et Produits laitiers',
      isOrganic: false,
      noAddedSugar: false,
      nutriscore: 'A',
      isPrivateLabel: true,
      imageUrl: expect.stringMatching(/^https:\/\/media\.carrefour\.fr\/.*\/p_200x200\/.*3560071267964.*\.jpg$/),
    });
    expect(byRef(offers, '3560070435272')).toMatchObject({
      brand: 'CARREFOUR BIO',
      pack: { amount: 500, unit: 'ml' },
      isOrganic: true,
      isPrivateLabel: true,
      priceCents: 91,
      unitPrice: { cents: 182, per: 'l' },
      maxQuantity: 50,
    });
    expect(byRef(offers, '3229820181950')).toMatchObject({
      brand: 'BJORG',
      isOrganic: true,
      isPrivateLabel: false,
      category: 'Epicerie sucrée',
      unitPrice: { cents: 1311, per: 'kg' },
    });
  });

  it.each(['pain', 'riz', 'beurre', 'pomme'])('parses autocomplete-%s', async (name) => {
    const { client } = fake({
      [`GET ${BASE}/autocomplete?q=${name}&productCard=true&maxResults=5`]: json(fixture(`autocomplete-${name}`)),
    });
    const offers = await client.search(name, 5);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(() => ProductOfferSchema.parse(offer)).not.toThrow();
      expect(offer.pack, offer.ref).toBeDefined();
    }
  });

  it('omits an empty brand', async () => {
    const { client } = fake({
      [`GET ${BASE}/autocomplete?q=pain&productCard=true&maxResults=5`]: json(fixture('autocomplete-pain')),
    });
    const rustique = byRef(await client.search('pain', 5), '3276559526477');
    expect(rustique).toMatchObject({ name: 'Pain Rustique', isPrivateLabel: false });
    expect(rustique).not.toHaveProperty('brand', expect.anything());
  });

  it.each([
    [100, 20],
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
    [7.9, 7],
  ])('clamps max %d to %d and encodes the query', async (max, expected) => {
    const url = `${BASE}/autocomplete?q=lait%20demi-%C3%A9cr%C3%A9m%C3%A9%20%26%20bio&productCard=true&maxResults=${expected}`;
    const { client, requests } = fake({ [`GET ${url}`]: json('{"data":{"products":[]}}') });
    expect(await client.search('lait demi-écrémé & bio', max)).toEqual([]);
    expect(requests.map((r) => r.url)).toEqual([url]);
  });

  it.each<[string, string, Record<string, 'A' | 'B' | 'C' | 'D' | 'E' | undefined>]>([
    // "O" is a Carrefour value outside the A-E scale; null means no grade.
    ['beurre', 'beurre', { '3451790563256': 'D', '3245411900458': 'E', '3155251205500': undefined }],
    ['lait', 'lait', { '3270190021162': 'B', '3245414192508': 'A', '3560070435272': undefined }],
    ['riz', 'riz', { '3560070393619': 'B', '3560070837984': 'A', '3661945170202': undefined }],
  ])('maps the nutriscore of autocomplete-%s', async (name, query, expected) => {
    const max = name === 'lait' ? 10 : 5;
    const { client } = fake({
      [`GET ${BASE}/autocomplete?q=${query}&productCard=true&maxResults=${max}`]: json(fixture(`autocomplete-${name}`)),
    });
    const offers = await client.search(query, max);
    for (const [ref, grade] of Object.entries(expected)) expect(byRef(offers, ref)?.nutriscore, ref).toBe(grade);
  });

  it('maps the no-added-sugar flag', async () => {
    const { client } = fake({
      [`GET ${BASE}/autocomplete?q=pain&productCard=true&maxResults=5`]: json(fixture('autocomplete-pain')),
    });
    const offers = await client.search('pain', 5);
    expect(byRef(offers, '3760049798869')?.noAddedSugar).toBe(true);
    expect(byRef(offers, '3228857002221')?.noAddedSugar).toBe(true);
    expect(byRef(offers, '3560071010058')?.noAddedSugar).toBe(false);
  });
});

describe('getOffers', () => {
  it('reads the store from the cart, then posts the gtins', async () => {
    const { client, requests } = fake({
      [CART]: json(fixture('cart')),
      [`POST ${BASE}/products`]: json(fixture('products-by-gtin')),
    });
    const offers = await client.getOffers(['3560071267964']);

    expect(offers).toEqual([expect.objectContaining({ ref: '3560071267964', priceCents: 564, available: true })]);
    expect(() => ProductOfferSchema.parse(offers[0])).not.toThrow();
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([CART, `POST ${BASE}/products`]);
    expect(requests[1]?.headers).toEqual(JSON_HEADERS);
    expect(requests[1]?.body).toBe('{"gtins":["3560071267964"],"facilityServiceId":"0046-150-112"}');
  });

  it('makes no request for no refs', async () => {
    const { client, requests } = fake({});
    expect(await client.getOffers([])).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('getCart', () => {
  it('returns one line per product', async () => {
    const { client } = fake({ [CART]: json(fixture('cart')) });
    expect(await client.getCart()).toEqual([
      { ref: '3560071267964', quantity: 1 },
      { ref: '3276554163158', quantity: 1 },
    ]);
  });

  it('rounds decimal counters and skips unusable lines added by hand', async () => {
    const cart = JSON.parse(fixture('cart'));
    const [first, second] = cart.cart.items[0].products;
    const productWithEan = (ean: string) => ({ ...second.product, attributes: { ...second.product.attributes, ean } });
    const foreign = (ean: string, counter: unknown) => ({ ...second, counter, product: productWithEan(ean) });
    cart.cart.items[0].products = [
      first,
      foreign('2000000000011', 0.7),
      foreign('2000000000028', 2.4),
      { ...second, product: { ...second.product, attributes: { title: 'Sans EAN' } } },
      foreign('2000000000035', undefined),
      foreign('2000000000042', -1),
    ];
    cart.cart.items.push({ category: 'Marketplace', products: null });
    const { client } = fake({ [CART]: json(JSON.stringify(cart)) });

    expect(await client.getCart()).toEqual([
      { ref: '3560071267964', quantity: 1 },
      { ref: '2000000000011', quantity: 1 },
      { ref: '2000000000028', quantity: 2 },
    ]);
  });

  it.each([
    ['items is not an array', (cart: { cart: Record<string, unknown> }) => Object.assign(cart.cart, { items: {} })],
    ['cart is missing', (cart: Record<string, unknown>) => Object.assign(cart, { cart: undefined })],
  ])('throws schema_mismatch when %s', async (_name, mutate) => {
    const cart = JSON.parse(fixture('cart'));
    mutate(cart);
    const { client } = fake({ [CART]: json(JSON.stringify(cart)) });
    expect((await providerError(client.getCart())).code).toBe('schema_mismatch');
  });
});

describe('malformed products', () => {
  type Offer = { attributes: { availability?: unknown } };
  const lait = () => JSON.parse(fixture('autocomplete-lait'));
  const breakAvailability = (product: {
    attributes: { ean: string; offers: Record<string, Record<string, Offer>> };
  }) => {
    for (const offer of Object.values(product.attributes.offers[product.attributes.ean] ?? {})) {
      delete offer.attributes.availability;
    }
  };

  it('drops one malformed product from search results', async () => {
    const response = lait();
    breakAvailability(response.data.products[2]);
    const { client } = fake({ [SEARCH_LAIT]: json(JSON.stringify(response)) });
    const offers = await client.search('lait', 10);
    expect(offers).toHaveLength(9);
    expect(byRef(offers, '3229820181950')).toBeUndefined();
    expect(byRef(offers, '3560071267964')).toMatchObject({ priceCents: 564 });
  });

  it('throws schema_mismatch when no search product parses', async () => {
    const response = lait();
    for (const product of response.data.products) breakAvailability(product);
    const { client } = fake({ [SEARCH_LAIT]: json(JSON.stringify(response)) });
    const err = await providerError(client.search('lait', 10));
    expect(err.code).toBe('schema_mismatch');
    expect(err.message).toMatch(
      /^GET \/autocomplete: .* at data\.products\.0\.attributes\.offers\..*\.availability\)$/,
    );
  });

  it('drops a malformed product from getOffers, and throws when none parses', async () => {
    const products = JSON.parse(fixture('products-by-gtin'));
    const valid = fake({
      [CART]: json(fixture('cart')),
      [`POST ${BASE}/products`]: json(JSON.stringify({ data: [{ attributes: { ean: '1' } }, ...products.data] })),
    });
    expect((await valid.client.getOffers(['1', '3560071267964'])).map((o) => o.ref)).toEqual(['3560071267964']);

    breakAvailability(products.data[0]);
    const broken = fake({ [CART]: json(fixture('cart')), [`POST ${BASE}/products`]: json(JSON.stringify(products)) });
    expect((await providerError(broken.client.getOffers(['3560071267964']))).code).toBe('schema_mismatch');
  });
});

describe('getContext', () => {
  it('returns the store without reading /api/me by default', async () => {
    const { client, requests } = fake({ [CART]: json(fixture('cart')) });
    expect(await client.getContext()).toEqual({ provider: 'carrefour', storeRef: '112' });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([CART]);
  });

  it('falls back to the last segment of facilityServiceId', async () => {
    const cart = JSON.parse(fixture('cart'));
    cart.cart.storeRef = null;
    cart.cart.facilityServiceId = '0678-150-7052';
    const { client } = fake({ [CART]: json(JSON.stringify(cart)) });
    expect(await client.getContext()).toEqual({ provider: 'carrefour', storeRef: '7052' });
  });

  it.each([
    ['me-logged-in', fixture('me-logged-in')],
    ['identity under data', '{"data":{"userId":"u-test","email":""}}'],
  ])('requireLogin passes when logged in (%s)', async (_name, me) => {
    const { client, requests } = fake({ [ME]: json(me), [CART]: json(fixture('cart')) });
    expect(await client.getContext({ requireLogin: true })).toEqual({ provider: 'carrefour', storeRef: '112' });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([ME, CART]);
  });

  it.each([
    ['me-anonymous', fixture('me-anonymous')],
    ['empty strings', '{"userId":"","email":" ","data":{"userId":null}}'],
    ['unrelated data', '{"data":[]}'],
  ])('requireLogin throws auth_required when anonymous (%s)', async (_name, me) => {
    const { client, requests } = fake({ [ME]: json(me), [CART]: json(fixture('cart')) });
    const err = await providerError(client.getContext({ requireLogin: true }));
    expect(err.code).toBe('auth_required');
    expect(err.message).not.toContain('test@example.com');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([ME]);
  });

  it.each([
    ['null', null],
    ['missing', undefined],
  ])('throws no_store when facilityServiceId is %s', async (_name, value) => {
    const cart = JSON.parse(fixture('cart'));
    cart.cart.facilityServiceId = value;
    const { client } = fake({ [CART]: json(JSON.stringify(cart)) });
    expect((await providerError(client.getContext())).code).toBe('no_store');
  });
});

describe('setQuantity', () => {
  it('sets an absolute quantity, then removes, reusing the cached basket', async () => {
    const { client, requests } = fake({
      [CART]: json(fixture('cart')),
      [`PATCH ${BASE}/api/cart?refresh=true`]: json(fixture('cart-patch-response')),
      [`PATCH ${BASE}/api/cart/items`]: json(fixture('cart')),
    });

    await client.setQuantity('3560071267964', 3);
    await client.setQuantity('3560071267964', 0);

    expect(requests.map((r) => ({ method: r.method, url: r.url, headers: r.headers }))).toEqual([
      { method: 'GET', url: `${BASE}/api/cart`, headers: HEADERS },
      { method: 'PATCH', url: `${BASE}/api/cart?refresh=true`, headers: JSON_HEADERS },
      { method: 'PATCH', url: `${BASE}/api/cart/items`, headers: JSON_HEADERS },
    ]);
    expect(requests[1]?.body).toBe(
      JSON.stringify({
        trackingRequest: { pageType: 'basket', pageId: 'basket' },
        items: [{ basketServiceId: '0046-150-112', counter: 3, ean: '3560071267964', subBasketType: 'drive_clcv' }],
      }),
    );
    expect(requests[2]?.body).toBe(
      JSON.stringify({
        trackingRequest: { pageType: 'basket', pageId: 'basket' },
        basketServiceId: '0046-150-112',
        ean: '3560071267964',
        subBasketType: 'drive_clcv',
      }),
    );
  });

  it('reuses the basket read by getContext', async () => {
    const { client, requests } = fake({
      [CART]: json(fixture('cart')),
      [`PATCH ${BASE}/api/cart?refresh=true`]: json(fixture('cart-patch-response')),
    });
    await client.getContext();
    await client.setQuantity('3276554163158', 1);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([CART, `PATCH ${BASE}/api/cart?refresh=true`]);
  });

  it('throws no_store without writing when no store is selected', async () => {
    const cart = JSON.parse(fixture('cart'));
    cart.cart.facilityServiceId = null;
    const { client, requests } = fake({ [CART]: json(JSON.stringify(cart)) });
    expect((await providerError(client.setQuantity('3560071267964', 1))).code).toBe('no_store');
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it.each([-1, 1.5, Number.NaN])('rejects quantity %d without any request', async (quantity) => {
    const { client, requests } = fake({});
    await expect(client.setQuantity('3560071267964', quantity)).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);
  });
});

describe('error mapping', () => {
  const html = (status: number, body = '<html>private page</html>'): HttpResponse => ({
    status,
    cfMitigated: false,
    contentType: 'text/html; charset=UTF-8',
    body,
  });

  it.each<[string, Route, { code: string; retryable: boolean; status?: number; message?: RegExp }]>([
    ['401', json('{}', 401), { code: 'auth_required', retryable: false, status: 401 }],
    ['403 + cf-mitigated', { ...html(403), cfMitigated: true }, { code: 'challenge', retryable: false, status: 403 }],
    ['403', json('{}', 403), { code: 'auth_required', retryable: false, status: 403 }],
    ['429', json('{}', 429), { code: 'rate_limited', retryable: true, status: 429 }],
    ['500', html(500), { code: 'http', retryable: true, status: 500 }],
    ['503', json('{}', 503), { code: 'http', retryable: true, status: 503 }],
    [
      '404 text/html',
      html(404),
      { code: 'schema_mismatch', retryable: false, status: 404, message: /x-requested-with/ },
    ],
    ['404 JSON', json('{}', 404), { code: 'http', retryable: false, status: 404, message: /HTTP 404$/ }],
    [
      '400 JSON:API error',
      json(fixture('error-invalid-gtin'), 400),
      { code: 'http', retryable: false, status: 400, message: /gtin_validation_exception/ },
    ],
    [
      'transport throws',
      () => {
        throw new TypeError('Failed to fetch');
      },
      { code: 'network', retryable: true, message: /Failed to fetch/ },
    ],
    ['200 non-JSON', html(200), { code: 'schema_mismatch', retryable: false, status: 200, message: /expected JSON/ }],
    [
      '200 invalid JSON',
      json('<html>private page</html>'),
      { code: 'schema_mismatch', retryable: false, status: 200, message: /invalid JSON/ },
    ],
    [
      '200 JSON without data.products',
      json('{"data":{"private":"page"}}'),
      { code: 'schema_mismatch', retryable: false, status: 200, message: /GET \/autocomplete: .*data\.products/ },
    ],
  ])('%s', async (_name, route, expected) => {
    const { client } = fake({ [SEARCH_LAIT]: route });
    const err = await providerError(client.search('lait', 10));
    expect(err).toMatchObject({ code: expected.code, retryable: expected.retryable, status: expected.status });
    if (expected.message) expect(err.message).toMatch(expected.message);
    expect(err.message).not.toContain('private');
    expect(err.message).not.toContain('lait');
  });

  it.each([
    new ProviderError('http', 'Request refused by the provider allow-list', false),
    new ProviderError('network', 'Provider tab did not respond', true),
  ])('rethrows a ProviderError from the transport unchanged ($code)', async (thrown) => {
    const { client } = fake({
      [SEARCH_LAIT]: () => {
        throw thrown;
      },
    });
    expect(await providerError(client.search('lait', 10))).toBe(thrown);
  });

  it('maps errors on writes too', async () => {
    const { client } = fake({
      [CART]: json(fixture('cart')),
      [`PATCH ${BASE}/api/cart?refresh=true`]: json(fixture('error-invalid-gtin'), 400),
    });
    const err = await providerError(client.setQuantity('123', 1));
    expect(err).toMatchObject({ code: 'http', status: 400, retryable: false });
    expect(err.message).toBe('PATCH /api/cart: HTTP 400 (gtin_validation_exception)');
  });
});

describe('session', () => {
  const { client } = fake({});

  it.each([
    ['https://www.carrefour.fr/', true],
    ['https://www.carrefour.fr/s?q=lait', true],
    ['https://www.carrefour.fr/mon-compte/login?redirect=x', false],
    ['https://www.carrefour.fr/login/check?code=abc', false],
    ['https://moncompte.carrefour.fr/iam/login', false],
    ['https://www.carrefour.fr.evil.example/', false],
    ['not a url', false],
  ])('isOnSite(%s) is %s', (url, expected) => {
    expect(client.session.isOnSite(url)).toBe(expected);
  });

  it('exposes the session URLs', () => {
    expect(client.id).toBe('carrefour');
    expect(client.session).toMatchObject({
      siteUrl: 'https://www.carrefour.fr/',
      tabUrlPattern: 'https://www.carrefour.fr/*',
      loginUrl: 'https://www.carrefour.fr/mon-compte/login',
      refreshUrl: expect.stringMatching(
        /^https:\/\/moncompte\.carrefour\.fr\/iam\/oauth2\/CarrefourConnect\/authorize\?/,
      ),
    });
  });
});
