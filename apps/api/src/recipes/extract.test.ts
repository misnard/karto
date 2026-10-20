/*
 * Fixtures: the original `<script type="application/ld+json">` blocks of real pages, fetched once with curl on
 * 2026-10-19 (everything else in the page dropped, author names replaced by "REDACTED"):
 *   marmiton-lasagnes.html        https://www.marmiton.org/recettes/recette_lasagnes-a-la-bolognaise_18215.aspx
 *   750g-lasagnes.html            https://www.750g.com/lasagnes-a-la-bolognaise-r27259.htm
 *   cuisineaz-salade-mangue.html  https://www.cuisineaz.com/recettes/salade-de-mangue-et-son-coulis-56205.aspx
 *   journaldesfemmes-crepes.html  https://cuisine.journaldesfemmes.fr/recette/333415-recette-de-crepes-la-meilleure-recette-rapide
 *   hervecuisine-lasagnes.html    https://www.hervecuisine.com/recette/lasagnes-a-la-bolognaise/
 */
import { describe, expect, it } from 'vitest';
import { cleanText, decodeEntities, extractRecipe, type RecipeExtract, readServings } from './extract.ts';
import sevenFiftyLasagnes from './fixtures/750g-lasagnes.html?raw';
import cuisineazSalade from './fixtures/cuisineaz-salade-mangue.html?raw';
import herveLasagnes from './fixtures/hervecuisine-lasagnes.html?raw';
import jdfCrepes from './fixtures/journaldesfemmes-crepes.html?raw';
import marmitonLasagnes from './fixtures/marmiton-lasagnes.html?raw';

describe('extractRecipe on real pages', () => {
  it.each<[string, string, RecipeExtract]>([
    [
      'Marmiton (Recipe last in a @graph)',
      marmitonLasagnes,
      {
        title: 'Lasagnes à la bolognaise : la meilleure recette',
        servings: 8,
        ingredients: [
          '1 paquet de lasagnes',
          '3 oignons jaunes',
          "2 gousses d'ail",
          '1 branche de céleri',
          '1 carotte',
          '600 g de boeuf haché',
          '800 g de purée de tomate',
          "15 cl d'eau",
          '20 cl de vin rouge',
          '2 feuilles de laurier',
          'thym',
          'basilic',
          '3 pincées de muscade râpée',
          '70 g de fromage râpé',
          '125 g de parmesan',
          'sel',
          'poivre',
          '100 g de farine',
          '125 g de beurre',
          '1 l de lait',
        ],
      },
    ],
    [
      '750g (top-level Recipe)',
      sevenFiftyLasagnes,
      {
        title: 'Lasagnes à la bolognaise gratinées au parmesan',
        servings: 8,
        ingredients: [
          '1 verre à moutarde de vin rouge',
          "1 verre d'eau",
          '2 feuilles de laurier',
          'thym',
          'basilic',
          '800 g purée de tomates',
          '600 g viande de bœuf haché',
          '3 oignons',
          "2 gousses d'ail",
          '1 branche de céleri',
          '1 carotte',
          '1 paquet de pâtes à lasagnes',
          '3 pincées de noix de muscade râpée',
          '1l de lait',
          '100 g beurre',
          '100 g farine',
          'beurre',
          '125 g de parmesan',
          '70 g de fromage râpé',
        ],
      },
    ],
    [
      // The site lists the section header "Préparation" as an ingredient: kept, the parse step deals with it.
      'CuisineAZ (Recipe second in a @graph, yield as a bare string)',
      cuisineazSalade,
      {
        title: 'Salade de mangue et son coulis',
        servings: 4,
        ingredients: ['Préparation', '2 Mangue(s)', '200 g Fraise(s)', '2 Orange(s)', 'Quelques feuilles Menthe'],
      },
    ],
    [
      'Journal des Femmes (top-level array, two blocks)',
      jdfCrepes,
      {
        title: 'Crêpes : la meilleure recette rapide',
        servings: 4,
        ingredients: ['250 g farine', '4 oeuf', '½ litre lait', '1 pincée sel', '2 c à s sucre', '50 g beurre fondu'],
      },
    ],
    [
      'Hervé Cuisine blog (Recipe in the third block, numeric yield)',
      herveLasagnes,
      {
        title: 'Lasagnes à la Bolognaise maison faciles et moelleuses',
        servings: 6,
        ingredients: [
          'Pâtes pour lasagnes (500g)',
          '1 oignon',
          '100 g de gruyère râpé',
          '400 g de viande hachée',
          'Herbes de Provence',
          'Pulpe de tomate et du concentré de tomates',
          "Huile d'olive",
          "1 gousse d'ail émincée",
          '30 g de beurre',
          '1 grosse c. à soupe de maizéna ou de farine',
          '1/2 litre de lait',
        ],
      },
    ],
  ])('%s', (_, html, expected) => {
    expect(extractRecipe(html)).toEqual(expected);
  });
});

const ld = (data: unknown, attributes = 'type="application/ld+json"') =>
  `<script ${attributes}>${JSON.stringify(data)}</script>`;
const recipe = (extra: Record<string, unknown> = {}) => ({
  '@type': 'Recipe',
  name: 'Gratin',
  recipeIngredient: ['1 kg de pommes de terre', '50 cl de crème'],
  recipeYield: '4 personnes',
  ...extra,
});
const gratin: RecipeExtract = {
  title: 'Gratin',
  ingredients: ['1 kg de pommes de terre', '50 cl de crème'],
  servings: 4,
};

describe('extractRecipe structure', () => {
  it.each<[string, string]>([
    ['top-level object', ld({ '@context': 'https://schema.org', ...recipe() })],
    ['top-level array', ld([{ '@type': 'WebSite' }, recipe()])],
    ['@graph', ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, recipe()] })],
    ['@type array', ld(recipe({ '@type': ['NewsArticle', 'Recipe'] }))],
    ['prefixed @type', ld(recipe({ '@type': 'https://schema.org/Recipe' }))],
    ['mainEntity', ld({ '@type': 'WebPage', mainEntity: recipe() })],
    ['mainEntity inside @graph', ld({ '@graph': [{ '@type': 'WebPage', mainEntity: [recipe()] }] })],
    ['Recipe in the second block', ld({ '@type': 'WebSite', name: 'Site' }) + ld({ '@graph': [recipe()] })],
    ['invalid JSON block skipped', `<script type="application/ld+json">{"@type": "Recipe",</script>${ld(recipe())}`],
    ['single quotes and extra attributes', ld(recipe(), `id="schema" type='application/ld+json' class="yoast"`)],
    ['unquoted type', ld(recipe(), 'type=application/ld+json')],
    ['type with parameters', ld(recipe(), 'type="application/ld+json; charset=utf-8"')],
    [
      'uppercase tag, attributes on several lines',
      `<SCRIPT\n  data-x="1"\n  TYPE="application/LD+JSON" >${JSON.stringify(recipe())}</SCRIPT >`,
    ],
    ['HTML comment wrapper', `<script type="application/ld+json"><!--\n${JSON.stringify(recipe())}\n--></script>`],
    ['raw newline inside a string', ld(recipe()).replace('"Gratin"', '"Gratin\n"')],
    [
      'first Recipe without ingredients skipped',
      ld([recipe({ name: 'Vide', recipeIngredient: [] }), recipe({ recipeIngredient: undefined })]) + ld(recipe()),
    ],
    ['ingredients fallback', ld(recipe({ recipeIngredient: undefined, ingredients: gratin.ingredients }))],
  ])('%s', (_, html) => {
    expect(extractRecipe(`<html><head>${html}</head><body></body></html>`)).toEqual(gratin);
  });

  it('ignores scripts that are not JSON-LD', () => {
    const html = `<script type="text/javascript">${JSON.stringify(recipe())}</script><script>${JSON.stringify(recipe())}</script>`;
    expect(extractRecipe(html)).toBeNull();
  });

  it.each<[string, string]>([
    ['empty page', ''],
    ['no JSON-LD', '<html><body><h1>Gratin</h1></body></html>'],
    ['JSON-LD without Recipe', ld({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'BreadcrumbList' }] })],
    ['Recipe without ingredients', ld(recipe({ recipeIngredient: [] }))],
    ['Recipe with only blank or non-string ingredients', ld(recipe({ recipeIngredient: [' ', '&nbsp;', 3, null] }))],
    ['Recipe nested under another key', ld({ '@type': 'ItemList', itemListElement: [recipe()] })],
    ['only invalid JSON', '<script type="application/ld+json">{nope}</script>'],
  ])('returns null: %s', (_, html) => {
    expect(extractRecipe(html)).toBeNull();
  });

  it('cleans ingredients and title', () => {
    const html = ld(
      recipe({
        name: '  Gratin &amp; cr&egrave;me <em>fra&icirc;che</em> ',
        recipeIngredient: [
          '200 g de cr&egrave;me fra&icirc;che',
          '1 c. &agrave; soupe d&#039;huile d&#x27;olive',
          '3 &#x153;ufs',
          'sel&nbsp;&amp;&nbsp;poivre',
          '<b>50 g</b> de\n\tbeurre   doux',
          'p&amp;acirc;tes',
          '1 &frac12; litre de lait',
          42,
          '',
          '   ',
        ],
      }),
    );
    expect(extractRecipe(html)).toEqual({
      title: 'Gratin & crème fraîche',
      ingredients: [
        '200 g de crème fraîche',
        "1 c. à soupe d'huile d'olive",
        '3 œufs',
        'sel & poivre',
        '50 g de beurre doux',
        'pâtes',
        '1 ½ litre de lait',
      ],
      servings: 4,
    });
  });

  it.each<[string, unknown]>([
    ['missing', undefined],
    ['not a string', { '@value': 'Gratin' }],
    ['blank', ' &nbsp; '],
  ])('title is null when %s', (_, name) => {
    expect(extractRecipe(ld(recipe({ name })))?.title).toBeNull();
  });
});

describe('readServings', () => {
  it.each<[unknown, number | null]>([
    [4, 4],
    ['4', 4],
    ['4 personnes', 4],
    ['Pour 6', 6],
    ['Pour&nbsp;6 personnes', 6],
    ['4-6', 4],
    ['4-6 servings', 4],
    ['4 à 6 parts', 4],
    [['6', '6 servings'], 6],
    [[null, 'beaucoup', '8 parts'], 8],
    ['L&#039;équivalent de 4 parts', 4],
    ['1 tarte', 1],
    [100, 100],
    [undefined, null],
    [null, null],
    ['', null],
    ['beaucoup', null],
    [[], null],
    [0, null],
    [101, null],
    ['250 personnes', null],
    [2.5, null],
    ['2,5 portions', null],
    [-4, null],
    [{ value: 4 }, null],
  ])('%j → %j', (value, expected) => {
    expect(readServings(value)).toBe(expected);
  });
});

describe('decodeEntities and cleanText', () => {
  it.each<[string, string]>([
    ['&amp;&lt;&gt;&quot;&apos;', `&<>"'`],
    ['&#233;&#xE9;&#XE9;', 'ééé'],
    ['&eacute;&Eacute;&oelig;&OElig;&ccedil;', 'éÉœŒç'],
    ['&rsquo;&hellip;&laquo;&nbsp;&raquo;', '’…« »'],
    ['&unknown; &#0; &#xD800; &#99999999;', '&unknown; &#0; &#xD800; &#99999999;'],
    ['AT&T & co', 'AT&T & co'],
  ])('decodeEntities(%j)', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it.each<[string, string]>([
    ['  a \n\t b  c  ', 'a b c'],
    ['<p>200 g</p><br/>de farine', '200 g de farine'],
    ['&lt;b&gt;sucre&lt;/b&gt;', 'sucre'],
    ['1 < 2 > 0', '1 < 2 > 0'],
    ['p&amp;acirc;tes', 'pâtes'],
  ])('cleanText(%j)', (input, expected) => {
    expect(cleanText(input)).toBe(expected);
  });
});
