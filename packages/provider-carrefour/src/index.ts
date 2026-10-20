import type { HttpRequest } from '@karto/contracts';
import { ORIGIN } from './client.ts';

export { createCarrefourClient } from './client.ts';
export { parsePack } from './pack.ts';

/**
 * Pacing between two Carrefour calls, close to someone browsing: a random gap in [min, max], and now and then
 * (pauseChance) a longer pause in [pauseMin, pauseMax]. Calibration knob: the spike showed 1 req/s passes, this is
 * deliberately gentler. Raise it if challenges or failed searches come back.
 */
export const REQUEST_DELAY_MS = { min: 1500, max: 4000, pauseChance: 0.12, pauseMin: 5000, pauseMax: 9000 } as const;

/**
 * Closed list of (method, path) the transport may send. Anything else is refused before leaving the extension.
 * `path` is matched against pathname + query string. Changes require a human review.
 */
export const ALLOWED_ENDPOINTS: readonly { method: HttpRequest['method']; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/me$/ },
  { method: 'GET', path: /^\/api\/cart$/ },
  { method: 'GET', path: /^\/autocomplete\?q=[^&#]*&productCard=true&maxResults=\d{1,2}$/ },
  { method: 'POST', path: /^\/products$/ },
  { method: 'PATCH', path: /^\/api\/cart\?refresh=true$/ },
  { method: 'PATCH', path: /^\/api\/cart\/items$/ },
];

export function isAllowedRequest(req: HttpRequest): boolean {
  if (!URL.canParse(req.url)) return false;
  const url = new URL(req.url);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) return false;
  const target = url.pathname + url.search;
  return ALLOWED_ENDPOINTS.some((e) => e.method === req.method && e.path.test(target));
}
