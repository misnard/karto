import { type ProductOffer, ProductOfferSchema } from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { type Product, ProductSchema, toProductOffer } from './product.ts';

const EAN = '3000000000001';

function offer(overrides: Record<string, unknown> = {}) {
  return {
    attributes: {
      price: { price: 1.5, perUnit: 3, unitOfMeasure: 'KG' },
      availability: { purchasable: true, stopped: false, suspended: false },
      ordering: { min: 1, step: 1, max: 20 },
      variableWeight: false,
      ...overrides,
    },
  };
}

function product(attributes: Record<string, unknown> = {}): Product {
  return ProductSchema.parse({
    attributes: {
      ean: EAN,
      title: 'Produit',
      brand: 'MARQUE',
      offerServiceId: 'svc-a',
      topCategoryName: 'Epicerie salée',
      flags: [],
      offers: { [EAN]: { 'svc-a': offer() } },
      ...attributes,
    },
  });
}

describe('toProductOffer', () => {
  it.each<[string, Product, string | undefined, Partial<ProductOffer>]>([
    ['empty brand is omitted', product({ brand: '' }), undefined, { brand: undefined, isPrivateLabel: false }],
    ['null brand is omitted', product({ brand: null }), undefined, { brand: undefined, isPrivateLabel: false }],
    [
      'CARREFOUR prefix is private label',
      product({ brand: "Carrefour Classic'" }),
      undefined,
      { isPrivateLabel: true },
    ],
    [
      'FILIERE QUALITE CARREFOUR is private label',
      product({ brand: 'FILIERE QUALITE CARREFOUR' }),
      undefined,
      {
        isPrivateLabel: true,
      },
    ],
    ['other brand is not private label', product({ brand: 'BJORG' }), undefined, { isPrivateLabel: false }],
    ['organic flag', product({ flags: ['flag.common.organic'] }), undefined, { isOrganic: true }],
    ['no flags', product(), undefined, { isOrganic: false, noAddedSugar: false }],
    ['added sugar free flag', product({ flags: ['flag.common.addedsugarfree'] }), undefined, { noAddedSugar: true }],
    ['nutriscore', product({ nutriscore: { value: 'C', source: '' } }), undefined, { nutriscore: 'C' }],
    ['lower-case nutriscore', product({ nutriscore: { value: ' b ' } }), undefined, { nutriscore: 'B' }],
    ['nutriscore outside A-E', product({ nutriscore: { value: 'O' } }), undefined, { nutriscore: undefined }],
    ['null nutriscore', product({ nutriscore: null }), undefined, { nutriscore: undefined }],
    ['unexpected nutriscore shape', product({ nutriscore: 'A' }), undefined, { nutriscore: undefined }],
    ['empty category is omitted', product({ topCategoryName: '' }), undefined, { category: undefined }],
    [
      'no offer: unavailable, no price',
      product({ offers: [] }),
      undefined,
      { available: false, priceCents: undefined, unitPrice: undefined, maxQuantity: undefined },
    ],
    [
      'store offer missing: unavailable, even if another store has one',
      product(),
      'svc-b',
      { available: false, priceCents: undefined },
    ],
    [
      'session store offer wins over offerServiceId',
      product({ offers: { [EAN]: { 'svc-a': offer(), 'svc-b': offer({ price: { price: 2, perUnit: null } }) } } }),
      'svc-b',
      { priceCents: 200, unitPrice: undefined },
    ],
    [
      'falls back to the first offer',
      product({ offerServiceId: null, offers: { [EAN]: { 'svc-z': offer() } } }),
      undefined,
      { available: true, priceCents: 150, unitPrice: { cents: 300, per: 'kg' }, maxQuantity: 20 },
    ],
    [
      'U unit price is per piece',
      product({ offers: { [EAN]: { 'svc-a': offer({ price: { price: 2.99, perUnit: 0.6, unitOfMeasure: 'U' } }) } } }),
      undefined,
      { priceCents: 299, unitPrice: { cents: 60, per: 'piece' } },
    ],
    [
      'unknown unit: no unit price',
      product({ offers: { [EAN]: { 'svc-a': offer({ price: { price: 1, perUnit: 1, unitOfMeasure: 'M' } }) } } }),
      undefined,
      { unitPrice: undefined },
    ],
    [
      'stopped is unavailable',
      product({
        offers: {
          [EAN]: { 'svc-a': offer({ availability: { purchasable: true, stopped: true, suspended: false } }) },
        },
      }),
      undefined,
      { available: false, priceCents: 150 },
    ],
    [
      'suspended is unavailable',
      product({
        offers: {
          [EAN]: { 'svc-a': offer({ availability: { purchasable: true, stopped: false, suspended: true } }) },
        },
      }),
      undefined,
      { available: false },
    ],
    [
      'variable weight, no max',
      product({ offers: { [EAN]: { 'svc-a': offer({ variableWeight: true, ordering: null }) } } }),
      undefined,
      { variableWeight: true, maxQuantity: undefined },
    ],
    ['missing images: no imageUrl', product({ images: null }), undefined, { imageUrl: undefined }],
    ['unexpected images shape: no imageUrl', product({ images: { foo: 1 } }), undefined, { imageUrl: undefined }],
  ])('%s', (_name, input, facilityServiceId, expected) => {
    const result = toProductOffer(input, facilityServiceId);
    expect(result).toMatchObject(expected);
    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined) expect(result[key as keyof ProductOffer]).toBeUndefined();
    }
    expect(() => ProductOfferSchema.parse(result)).not.toThrow();
  });

  it('derives the image URL from the format pattern', () => {
    const images = {
      withFormats: [
        { pattern: 'https://media.example/p_FORMAT/a.jpg', formats: { '200x200': '200x200', largest: '1500x1500' } },
      ],
    };
    expect(toProductOffer(product({ images }), undefined).imageUrl).toBe('https://media.example/p_200x200/a.jpg');
  });
});
