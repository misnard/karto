import {
  type CartLine,
  type HttpRequest,
  type HttpResponse,
  type ProviderClient,
  ProviderError,
  type ProviderSession,
  type StoreContext,
  type Transport,
} from '@karto/contracts';
import { z } from 'zod';
import { ProductListSchema, toProductOffer } from './product.ts';

export const ORIGIN = 'https://www.carrefour.fr';
const MAX_SEARCH_RESULTS = 20;
const TRACKING_REQUEST = { pageType: 'basket', pageId: 'basket' } as const;

const session: ProviderSession = {
  siteUrl: `${ORIGIN}/`,
  tabUrlPattern: `${ORIGIN}/*`,
  loginUrl: `${ORIGIN}/mon-compte/login`,
  refreshUrl:
    'https://moncompte.carrefour.fr/iam/oauth2/CarrefourConnect/authorize?client_id=carrefour_onecarrefour_web&redirect_uri=https://www.carrefour.fr/login/check&response_type=code&scope=openid%20iam',
  isOnSite(url) {
    if (!URL.canParse(url)) return false;
    const { hostname, pathname } = new URL(url);
    // /login/check is the SSO callback: still mid-redirect, not on the site yet.
    return (
      hostname === 'www.carrefour.fr' && !pathname.startsWith('/mon-compte/login') && !pathname.startsWith('/login/')
    );
  },
};

const IdentitySchema = z.looseObject({ userId: z.unknown().optional(), email: z.unknown().optional() });
type Identity = z.infer<typeof IdentitySchema>;
const isPresent = (value: unknown) => (typeof value === 'string' && value.trim() !== '') || typeof value === 'number';
const isIdentified = (ids: Identity) => isPresent(ids.userId) || isPresent(ids.email);

/** Reduced to a boolean inside the parser: the rest of /api/me (name, email, address) never leaves it. */
const LoggedInSchema = IdentitySchema.extend({ data: IdentitySchema.nullish().catch(null) }).transform(
  (me) => isIdentified(me) || (me.data != null && isIdentified(me.data)),
);

// Lines the user added by hand can be odd (variable weight, marketplace): skip them rather than fail the whole cart.
const CartLineSchema = z
  .looseObject({
    counter: z.number().nonnegative(),
    product: z.looseObject({ attributes: z.looseObject({ ean: z.string().min(1) }) }),
  })
  .transform((line): CartLine => ({ ref: line.product.attributes.ean, quantity: Math.round(line.counter) }))
  .nullable()
  .catch(null);

const CartResponseSchema = z.looseObject({
  cart: z.looseObject({
    facilityServiceId: z.string().nullish(),
    type: z.string().nullish(),
    storeRef: z.string().nullish(),
    items: z.array(z.looseObject({ products: z.array(CartLineSchema) }).catch({ products: [] })).nullish(),
  }),
});
type Cart = z.infer<typeof CartResponseSchema>['cart'];

const SearchResponseSchema = z.looseObject({ data: z.looseObject({ products: ProductListSchema }) });
const ProductsResponseSchema = z.looseObject({ data: ProductListSchema });

const JsonApiErrorSchema = z.looseObject({
  errors: z
    .array(
      z.looseObject({
        code: z.string().optional(),
        errors: z.array(z.looseObject({ code: z.string().optional() })).optional(),
      }),
    )
    .min(1),
});

/** The store basket every cart write must target. */
interface Basket {
  facilityServiceId: string;
  subBasketType: string;
}

export function createCarrefourClient(transport: Transport): ProviderClient {
  // From the latest /api/cart read: writes and offer lookups reuse it.
  let basket: Basket | undefined;

  async function send(method: HttpRequest['method'], path: string, body?: unknown): Promise<HttpResponse> {
    const label = labelOf(method, path);
    const req: HttpRequest = {
      method,
      url: `${ORIGIN}${path}`,
      headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json, text/plain, */*' },
    };
    if (body !== undefined) {
      req.headers['content-type'] = 'application/json';
      req.body = JSON.stringify(body);
    }

    let res: HttpResponse;
    try {
      res = await transport(req);
    } catch (err) {
      // The transport may already classify its own failures (allow-list refusal, unresponsive tab): keep them.
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('network', `${label}: ${err instanceof Error ? err.message : 'transport failed'}`, true);
    }

    const { status } = res;
    if (status >= 200 && status < 300) return res;
    if (res.cfMitigated) throw new ProviderError('challenge', `${label}: Cloudflare challenge`, false, status);
    if (status === 401 || status === 403) {
      throw new ProviderError('auth_required', `${label}: HTTP ${status}`, false, status);
    }
    if (status === 429) throw new ProviderError('rate_limited', `${label}: HTTP 429`, true, status);
    if (status >= 500) throw new ProviderError('http', `${label}: HTTP ${status}`, true, status);
    if (status === 404 && res.contentType?.includes('text/html')) {
      throw new ProviderError(
        'schema_mismatch',
        `${label}: 404 HTML instead of JSON (x-requested-with header missing, or the endpoint changed)`,
        false,
        status,
      );
    }
    const code = carrefourErrorCode(res.body);
    throw new ProviderError('http', `${label}: HTTP ${status}${code ? ` (${code})` : ''}`, false, status);
  }

  async function fetchJson<T>(
    method: HttpRequest['method'],
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const res = await send(method, path, body);
    const mismatch = (reason: string) =>
      new ProviderError('schema_mismatch', `${labelOf(method, path)}: ${reason}`, false, res.status);

    if (!res.contentType?.includes('json')) {
      throw mismatch(`expected JSON, got ${res.contentType ?? 'no content type'}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw mismatch('invalid JSON');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw mismatch(`unexpected response (${issue?.code} at ${issue?.path.map(String).join('.') || '<root>'})`);
    }
    return parsed.data;
  }

  async function readCart(): Promise<Cart> {
    const { cart } = await fetchJson('GET', '/api/cart', CartResponseSchema);
    basket =
      cart.facilityServiceId && cart.type
        ? { facilityServiceId: cart.facilityServiceId, subBasketType: cart.type }
        : undefined;
    return cart;
  }

  async function requireBasket(): Promise<Basket> {
    if (!basket) await readCart();
    if (!basket) throw noStore();
    return basket;
  }

  return {
    id: 'carrefour',
    session,

    async getContext(opts): Promise<StoreContext> {
      if (opts?.requireLogin && !(await fetchJson('GET', '/api/me', LoggedInSchema))) {
        throw new ProviderError('auth_required', 'Carrefour session is anonymous');
      }
      const cart = await readCart();
      if (!basket) throw noStore();
      const { facilityServiceId } = basket;
      return {
        provider: 'carrefour',
        storeRef: cart.storeRef || facilityServiceId.split('-').at(-1) || facilityServiceId,
      };
    },

    async search(query, max) {
      const n = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(max) || 1));
      const path = `/autocomplete?q=${encodeURIComponent(query)}&productCard=true&maxResults=${n}`;
      const { data } = await fetchJson('GET', path, SearchResponseSchema);
      return data.products.map((p) => toProductOffer(p, basket?.facilityServiceId));
    },

    async getOffers(refs) {
      if (refs.length === 0) return [];
      const { facilityServiceId } = await requireBasket();
      const body = { gtins: refs, facilityServiceId };
      const { data } = await fetchJson('POST', '/products', ProductsResponseSchema, body);
      return data.map((p) => toProductOffer(p, facilityServiceId));
    },

    async getCart(): Promise<CartLine[]> {
      const cart = await readCart();
      return (cart.items ?? []).flatMap((item) => item.products).filter((line) => line !== null);
    },

    async setQuantity(ref, quantity) {
      if (!Number.isInteger(quantity) || quantity < 0) {
        throw new RangeError(`quantity must be an integer >= 0, got ${quantity}`);
      }
      const { facilityServiceId, subBasketType } = await requireBasket();
      if (quantity === 0) {
        // Setting counter to 0 does not remove the line (Carrefour clamps it to 1): this dedicated call does.
        await send('PATCH', '/api/cart/items', {
          trackingRequest: TRACKING_REQUEST,
          basketServiceId: facilityServiceId,
          ean: ref,
          subBasketType,
        });
        return;
      }
      await send('PATCH', '/api/cart?refresh=true', {
        trackingRequest: TRACKING_REQUEST,
        items: [{ basketServiceId: facilityServiceId, counter: quantity, ean: ref, subBasketType }],
      });
    },
  };
}

const labelOf = (method: HttpRequest['method'], path: string) => `${method} ${path.split('?')[0]}`;
const noStore = () => new ProviderError('no_store', 'No drive store selected on carrefour.fr');

/** Carrefour's JSON:API error code (e.g. gtin_validation_exception), never any other part of the body. */
function carrefourErrorCode(body: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined; // Not JSON: the status alone describes the error.
  }
  const parsed = JsonApiErrorSchema.safeParse(json);
  const first = parsed.success ? parsed.data.errors[0] : undefined;
  const code = first?.errors?.[0]?.code ?? first?.code;
  return code && /^[\w.-]{1,64}$/.test(code) ? code : undefined;
}
