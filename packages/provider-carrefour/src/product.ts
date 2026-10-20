import type { ProductOffer } from '@karto/contracts';
import { z } from 'zod';
import { parsePack } from './pack.ts';

// PHP backends encode an empty map as `[]`: accept it wherever a map is expected.
const emptyArrayAsMap = (value: unknown) => (Array.isArray(value) && value.length === 0 ? {} : value);

const OfferSchema = z.looseObject({
  attributes: z.looseObject({
    price: z.looseObject({
      price: z.number().nonnegative(),
      perUnit: z.number().nonnegative().nullish(),
      unitOfMeasure: z.string().nullish(),
    }),
    availability: z.looseObject({
      purchasable: z.boolean(),
      stopped: z.boolean().nullish(),
      suspended: z.boolean().nullish(),
    }),
    ordering: z.looseObject({ max: z.int().nullish() }).nullish(),
    variableWeight: z.boolean().nullish(),
  }),
});

// Images are cosmetic: a shape change must not fail the whole response.
const ImagesSchema = z
  .looseObject({
    withFormats: z.array(z.looseObject({ pattern: z.string(), formats: z.record(z.string(), z.string()) })),
  })
  .nullish()
  .catch(null);

/** A product as returned by search, product lookup and cart lines. */
export const ProductSchema = z.looseObject({
  attributes: z.looseObject({
    ean: z.string().min(1),
    title: z.string(),
    brand: z.string().nullish(),
    format: z.string().nullish(),
    packaging: z.string().nullish(),
    offerServiceId: z.string().nullish(),
    topCategoryName: z.string().nullish(),
    flags: z.array(z.string()).nullish(),
    images: ImagesSchema,
    // Only A to E: anything else (Carrefour also sends "O") or an unexpected shape means no grade.
    nutriscore: z
      .looseObject({
        value: z
          .string()
          .trim()
          .toUpperCase()
          .pipe(z.enum(['A', 'B', 'C', 'D', 'E'])),
      })
      .nullish()
      .catch(null),
    offers: z
      .preprocess(
        emptyArrayAsMap,
        z.record(z.string(), z.preprocess(emptyArrayAsMap, z.record(z.string(), OfferSchema))),
      )
      .nullish(),
  }),
});
export type Product = z.infer<typeof ProductSchema>;

/**
 * Drops products that do not match ProductSchema (e.g. an odd marketplace offer), so one item cannot fail a whole
 * response. A non-empty list where none matches is reported as the first product's issues: the API changed.
 */
export const ProductListSchema = z.array(z.unknown()).transform((items, ctx) => {
  const products: Product[] = [];
  let firstError: z.ZodError | undefined;
  for (const item of items) {
    const parsed = ProductSchema.safeParse(item);
    if (parsed.success) products.push(parsed.data);
    else firstError ??= parsed.error;
  }
  // None matched, so the first error is the first item's.
  const issue = products.length === 0 ? firstError?.issues[0] : undefined;
  if (issue) {
    ctx.issues.push({ code: 'custom', message: issue.code, input: items, path: [0, ...issue.path] });
    return z.NEVER;
  }
  return products;
});

const UNIT_PRICE_PER: Record<string, 'kg' | 'l' | 'piece'> = { KG: 'kg', L: 'l', U: 'piece' };
const PRIVATE_LABEL_BRANDS = ['SIMPL', 'FILIERE QUALITE CARREFOUR'];
const IMAGE_FORMAT = '200x200';

const toCents = (euros: number) => Math.round(euros * 100);

/**
 * Normalizes a product. `facilityServiceId` is the session's store when known: its offer is then the only valid one.
 * Without it, falls back to the product's own offer service, then to its first offer.
 */
export function toProductOffer(product: Product, facilityServiceId: string | undefined): ProductOffer {
  const a = product.attributes;
  const byService = a.offers?.[a.ean] ?? {};
  const offer = facilityServiceId
    ? byService[facilityServiceId]
    : ((a.offerServiceId ? byService[a.offerServiceId] : undefined) ?? Object.values(byService)[0]);
  const o = offer?.attributes;
  const brand = a.brand?.trim() || undefined;
  const per = o?.price.unitOfMeasure ? UNIT_PRICE_PER[o.price.unitOfMeasure.toUpperCase()] : undefined;
  const max = o?.ordering?.max;
  const upperBrand = brand?.toUpperCase();

  return {
    provider: 'carrefour',
    ref: a.ean,
    name: a.title,
    brand,
    pack: parsePack(a.format, a.packaging),
    priceCents: o ? toCents(o.price.price) : undefined,
    unitPrice: per && o?.price.perUnit != null ? { cents: toCents(o.price.perUnit), per } : undefined,
    available: o ? o.availability.purchasable && !o.availability.stopped && !o.availability.suspended : false,
    maxQuantity: max != null && max > 0 ? max : undefined,
    variableWeight: o?.variableWeight ?? undefined,
    category: a.topCategoryName || undefined,
    isOrganic: (a.flags ?? []).includes('flag.common.organic'),
    noAddedSugar: (a.flags ?? []).includes('flag.common.addedsugarfree'),
    nutriscore: a.nutriscore?.value,
    isPrivateLabel: upperBrand
      ? upperBrand.startsWith('CARREFOUR') || PRIVATE_LABEL_BRANDS.includes(upperBrand)
      : false,
    imageUrl: imageUrl(a.images),
  };
}

/** `pattern` carries a literal `FORMAT` placeholder, to replace by one of the listed formats. */
function imageUrl(images: z.infer<typeof ImagesSchema>): string | undefined {
  const first = images?.withFormats[0];
  const format = first?.formats[IMAGE_FORMAT];
  if (!first || !format || !first.pattern.startsWith('https://') || !first.pattern.includes('FORMAT')) return undefined;
  return first.pattern.replace('FORMAT', format);
}
