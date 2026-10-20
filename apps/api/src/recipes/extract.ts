/**
 * Extracts a schema.org `Recipe` from the JSON-LD blocks of an HTML page. Workers have no DOM, so this is plain
 * string and regex work: find the `<script type="application/ld+json">` blocks, parse them, walk the JSON.
 */

export type RecipeExtract = {
  title: string | null;
  ingredients: string[];
  /** Integer in 1..100 read from `recipeYield`, or null when absent or unreadable. */
  servings: number | null;
};

type JsonObject = Record<string, unknown>;

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LD_JSON_TYPE = /\btype\s*=\s*["']?\s*application\/ld\+json\b/i;
const MAX_SERVINGS = 100;

export function extractRecipe(html: string): RecipeExtract | null {
  for (const block of ldJsonBlocks(html)) {
    for (const recipe of findRecipes(block)) {
      const ingredients = readIngredients(recipe);
      if (ingredients.length === 0) continue;
      return { title: readTitle(recipe), ingredients, servings: readServings(recipe.recipeYield) };
    }
  }
  return null;
}

/** Parsed content of every JSON-LD script block, in document order. Blocks that are not valid JSON are skipped. */
function ldJsonBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const [, attributes = '', content = ''] of html.matchAll(SCRIPT_TAG)) {
    if (!LD_JSON_TYPE.test(attributes)) continue;
    const parsed = parseJson(content);
    if (parsed !== undefined) blocks.push(parsed);
  }
  return blocks;
}

function parseJson(content: string): unknown {
  const text = content
    .trim()
    .replace(/^(?:\/\/\s*)?(?:<!--|<!\[CDATA\[)/, '')
    .replace(/(?:\/\/\s*)?(?:-->|\]\]>)$/, '');
  try {
    return JSON.parse(text);
  } catch {
    // Raw newlines or tabs inside strings are the most common breakage in real pages: retry without control chars.
  }
  try {
    return JSON.parse(text.replace(/\p{Cc}/gu, ' '));
  } catch {
    return undefined;
  }
}

/** Recipe nodes reachable from top-level objects, arrays, `@graph` and `mainEntity`, depth first. */
function findRecipes(node: unknown): JsonObject[] {
  if (Array.isArray(node)) return node.flatMap(findRecipes);
  if (!isObject(node)) return [];
  if (isRecipeType(node['@type'])) return [node];
  return [...findRecipes(node['@graph']), ...findRecipes(node.mainEntity)];
}

function isRecipeType(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  // Accept prefixed forms too ("schema:Recipe", "https://schema.org/Recipe").
  return types.some((t) => typeof t === 'string' && t.replace(/^.*[/:]/, '') === 'Recipe');
}

function readTitle(recipe: JsonObject): string | null {
  return typeof recipe.name === 'string' ? cleanText(recipe.name) || null : null;
}

function readIngredients(recipe: JsonObject): string[] {
  const raw = recipe.recipeIngredient ?? recipe.ingredients;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const text = cleanText(item);
    return text ? [text] : [];
  });
}

/** `recipeYield` as a number, a string ("4 personnes", "Pour 6", "4-6 servings": first number) or an array. */
export function readServings(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const servings = readServings(item);
      if (servings !== null) return servings;
    }
    return null;
  }
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const match = /\d+(?:[.,]\d+)?/.exec(cleanText(value));
    if (!match) return null;
    n = Number(match[0].replace(',', '.'));
  } else return null;
  return Number.isInteger(n) && n >= 1 && n <= MAX_SERVINGS ? n : null;
}

/** Decodes entities (twice, for double-encoded pages), strips tags, collapses whitespace. */
export function cleanText(text: string): string {
  return decodeEntities(decodeEntities(text))
    .replace(/<\/?[a-z][^<>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  thinsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  middot: '·',
  deg: '°',
  times: '×',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  euro: '€',
  agrave: 'à',
  acirc: 'â',
  auml: 'ä',
  ccedil: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  icirc: 'î',
  iuml: 'ï',
  ocirc: 'ô',
  ouml: 'ö',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  yuml: 'ÿ',
  oelig: 'œ',
  aelig: 'æ',
  Agrave: 'À',
  Acirc: 'Â',
  Ccedil: 'Ç',
  Eacute: 'É',
  Egrave: 'È',
  Ecirc: 'Ê',
  Icirc: 'Î',
  Ocirc: 'Ô',
  Ugrave: 'Ù',
  Ucirc: 'Û',
  OElig: 'Œ',
  AElig: 'Æ',
};

/** Numeric, hex and common named entities. Unknown or invalid entities are left as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,7}));/gi, (entity, dec, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? entity;
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
