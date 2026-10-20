import type { CartLine, ProductOffer, ProviderId, StoreContext } from './domain.ts';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** True when the response carries a Cloudflare `cf-mitigated: challenge` header. */
  cfMitigated: boolean;
  contentType: string | null;
  body: string;
}

/** Sends one HTTP request from the user's real browser context. Injected into provider clients. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** What an executor needs to drive the provider's login, without knowing the provider. */
export interface ProviderSession {
  /** Home page, opened when no provider tab exists. */
  siteUrl: string;
  /** chrome.tabs.query URL pattern matching provider tabs. */
  tabUrlPattern: string;
  /** Navigating here renews the session silently while the SSO session is alive. */
  refreshUrl: string;
  loginUrl: string;
  /** True when a tab URL is back on the site and logged in (not on a login page). */
  isOnSite(url: string): boolean;
}

/**
 * One provider (store chain) as seen by an executor. Implementations are pure over their Transport.
 * Every method throws ProviderError on failure.
 */
export interface ProviderClient {
  readonly id: ProviderId;
  readonly session: ProviderSession;
  /** Current store. With requireLogin, throws 'auth_required' when the session is anonymous. */
  getContext(opts?: { requireLogin?: boolean }): Promise<StoreContext>;
  search(query: string, max: number): Promise<ProductOffer[]>;
  /** Offers for known refs, in one request. Unknown refs are omitted. */
  getOffers(refs: string[]): Promise<ProductOffer[]>;
  getCart(): Promise<CartLine[]>;
  /** Absolute quantity. 0 removes the item. Idempotent. */
  setQuantity(ref: string, quantity: number): Promise<void>;
}
