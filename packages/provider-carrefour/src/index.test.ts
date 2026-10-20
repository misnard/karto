import type { HttpRequest } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { isAllowedRequest } from './index.ts';

// The cast allows testing methods outside the HttpRequest union (PUT, DELETE).
const req = (method: string, url: string): HttpRequest => ({ method, url, headers: {} }) as unknown as HttpRequest;

describe('isAllowedRequest', () => {
  it.each([
    ['GET', 'https://www.carrefour.fr/api/me'],
    ['GET', 'https://www.carrefour.fr/api/cart'],
    ['GET', 'https://www.carrefour.fr/autocomplete?q=lait%20demi-%C3%A9cr%C3%A9m%C3%A9&productCard=true&maxResults=10'],
    ['POST', 'https://www.carrefour.fr/products'],
    ['PATCH', 'https://www.carrefour.fr/api/cart?refresh=true'],
    ['PATCH', 'https://www.carrefour.fr/api/cart/items'],
  ])('allows %s %s', (method, url) => {
    expect(isAllowedRequest(req(method, url))).toBe(true);
  });

  it.each([
    ['POST', 'https://www.carrefour.fr/api/checkout/payment'],
    ['GET', 'https://www.carrefour.fr/api/checkout/summary'],
    ['PATCH', 'https://www.carrefour.fr/api/checkout/payment'],
    ['PUT', 'https://www.carrefour.fr/api/cart/slot'],
    ['PATCH', 'https://www.carrefour.fr/api/cart/slot'],
    ['PATCH', 'https://www.carrefour.fr/api/cart/attach-slot'],
    ['POST', 'https://www.carrefour.fr/api/cart/promo_code'],
    ['PATCH', 'https://www.carrefour.fr/api/cart?only-unavailable=1'],
    ['PATCH', 'https://www.carrefour.fr/api/cart'],
    ['PATCH', 'https://www.carrefour.fr/api/cart?refresh=true&only-unavailable=1'],
    ['PATCH', 'https://www.carrefour.fr/api/cart/items/../../checkout/payment'],
    ['GET', 'https://www.carrefour.fr/api/cart/items'],
    ['GET', 'https://www.carrefour.fr/api/cart?refresh=true'],
    ['GET', 'https://www.carrefour.fr/api/me/'],
    ['GET', 'https://www.carrefour.fr/autocomplete'],
    ['GET', 'https://www.carrefour.fr/autocomplete?q=lait&productCard=true&maxResults=10&x=1'],
    ['GET', 'https://www.carrefour.fr/products'],
    ['GET', 'https://moncompte.carrefour.fr/api/me'],
    ['GET', 'http://www.carrefour.fr/api/cart'],
    ['GET', 'https://www.carrefour.fr.evil.example/api/cart'],
    ['GET', 'https://user@www.carrefour.fr/api/cart'],
    ['GET', 'https://www.carrefour.fr:8443/api/cart'],
    ['GET', 'https://www.carrefour.fr/api/cart#x'],
    ['GET', '/api/cart'],
    ['GET', 'not a url'],
    ['DELETE', 'https://www.carrefour.fr/api/cart'],
    ['DELETE', 'https://www.carrefour.fr/api/cart/items'],
    ['PUT', 'https://www.carrefour.fr/api/cart'],
  ])('rejects %s %s', (method, url) => {
    expect(isAllowedRequest(req(method, url))).toBe(false);
  });
});
