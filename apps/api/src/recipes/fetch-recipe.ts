import { extractRecipe, type RecipeExtract } from './extract.ts';

export type RecipeErrorCode = 'invalid_url' | 'unreachable' | 'blocked' | 'not_html' | 'too_large' | 'no_recipe';

/** Failure to turn a URL into a recipe. Messages are short English for logs; the caller shows French text. */
export class RecipeError extends Error {
  override readonly name = 'RecipeError';
  readonly code: RecipeErrorCode;

  constructor(code: RecipeErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

export const RECIPE_MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

/**
 * Fetches a public recipe page and extracts its JSON-LD Recipe. `fetchImpl` exists for tests.
 * Throws `RecipeError`; 'blocked' and 'no_recipe' mean the user should paste the recipe text instead.
 */
export async function fetchRecipe(
  url: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<RecipeExtract> {
  let target = parseRecipeUrl(url);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  // Redirects are followed by hand: each hop passes parseRecipeUrl, so a public page cannot bounce the server to
  // an IP literal (cloud metadata, 127.0.0.1...). ponytail: a domain resolving to a private IP still passes.
  for (let hops = 0; ; hops++) {
    try {
      res = await fetchImpl(target, { headers: HEADERS, redirect: 'manual', signal });
    } catch (err) {
      throw new RecipeError('unreachable', `fetch failed: ${errorMessage(err)}`);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location === null) break;
    await res.body?.cancel();
    if (hops >= MAX_REDIRECTS) throw new RecipeError('unreachable', 'too many redirects');
    target = parseRecipeUrl(new URL(location, target).href);
  }

  if (!res.ok) {
    await res.body?.cancel();
    const blocked = res.status === 403 || res.status === 429 || res.headers.has('cf-mitigated');
    throw new RecipeError(blocked ? 'blocked' : 'unreachable', `HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType && !/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    await res.body?.cancel();
    throw new RecipeError('not_html', `content type ${contentType.slice(0, 80)}`);
  }
  if (Number(res.headers.get('content-length') ?? 0) > RECIPE_MAX_BYTES) {
    await res.body?.cancel();
    throw new RecipeError('too_large', `content-length ${res.headers.get('content-length')}`);
  }

  const html = decode(await readCapped(res, RECIPE_MAX_BYTES), contentType);
  const recipe = extractRecipe(html);
  if (recipe) return recipe;
  if (isChallengePage(html)) throw new RecipeError('blocked', 'bot challenge page');
  throw new RecipeError('no_recipe', 'no JSON-LD Recipe with ingredients');
}

/** Only absolute http(s) URLs on a domain name: no credentials, no IP literal, no localhost. */
function parseRecipeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new RecipeError('invalid_url', 'unparsable URL');
  }
  const host = parsed.hostname;
  const ok =
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    !parsed.username &&
    !parsed.password &&
    host.includes('.') &&
    !host.startsWith('[') &&
    !/^[\d.]+$/.test(host) &&
    !host.endsWith('.localhost');
  if (!ok) throw new RecipeError('invalid_url', `rejected URL ${parsed.protocol}//${host}`);
  return parsed.href;
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RecipeError('too_large', `body over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof RecipeError) throw err;
    throw new RecipeError('unreachable', `body read failed: ${errorMessage(err)}`);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Decodes with the charset from the content type when the runtime knows it, UTF-8 otherwise. */
function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8, which is what nearly every recipe site serves.
    }
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Cloudflare "Just a moment..." / "Attention Required!" pages, served with a 200 by some setups. Matching the title
 * only: normal Cloudflare pages also load `/cdn-cgi/challenge-platform/` scripts.
 */
function isChallengePage(html: string): boolean {
  return /<title>\s*(?:Just a moment\.\.\.|Attention Required! \| Cloudflare)\s*<\/title>/i.test(html);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
