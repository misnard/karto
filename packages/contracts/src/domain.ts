import { z } from 'zod';

export const ProviderIdSchema = z.enum(['carrefour']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const UnitSchema = z.enum(['g', 'ml', 'piece']);
export type Unit = z.infer<typeof UnitSchema>;

/** Provider-agnostic product + store-specific offer, as normalized by a provider module. */
export const ProductOfferSchema = z.strictObject({
  provider: ProviderIdSchema,
  /** EAN / GTIN. */
  ref: z.string().min(1),
  name: z.string(),
  brand: z.string().optional(),
  /** Content of one sellable item, e.g. { amount: 1000, unit: 'ml' } for a 1 L bottle. */
  pack: z.strictObject({ amount: z.number().positive(), unit: UnitSchema }).optional(),
  priceCents: z.int().nonnegative().optional(),
  unitPrice: z.strictObject({ cents: z.int().nonnegative(), per: z.enum(['kg', 'l', 'piece']) }).optional(),
  available: z.boolean(),
  /** Max quantity of this item per cart. */
  maxQuantity: z.int().positive().optional(),
  /** Sold by weight or estimated weight: quantities are approximate. */
  variableWeight: z.boolean().optional(),
  /** Top-level aisle, used to tell fresh produce from processed goods. */
  category: z.string().optional(),
  isOrganic: z.boolean().optional(),
  isPrivateLabel: z.boolean().optional(),
  nutriscore: z.enum(['A', 'B', 'C', 'D', 'E']).optional(),
  noAddedSugar: z.boolean().optional(),
  imageUrl: z.string().optional(),
});
export type ProductOffer = z.infer<typeof ProductOfferSchema>;

export const StoreContextSchema = z.strictObject({
  provider: ProviderIdSchema,
  storeRef: z.string().min(1),
  label: z.string().optional(),
});
export type StoreContext = z.infer<typeof StoreContextSchema>;

export const CartLineSchema = z.strictObject({
  ref: z.string().min(1),
  quantity: z.int().nonnegative(),
});
export type CartLine = z.infer<typeof CartLineSchema>;

export const BasketInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().trim().min(1).max(10_000) }),
  z.strictObject({ kind: z.literal('recipe_url'), url: z.url(), servings: z.int().positive().optional() }),
  z.strictObject({
    kind: z.literal('recipe_text'),
    text: z.string().trim().min(1).max(20_000),
    servings: z.int().positive().optional(),
  }),
]);
export type BasketInput = z.infer<typeof BasketInputSchema>;

export const BasketStatusSchema = z.enum(['parsing', 'searching', 'matching', 'ready', 'pushing', 'pushed', 'failed']);
export type BasketStatus = z.infer<typeof BasketStatusSchema>;

export const ItemStatusSchema = z.enum(['pending', 'proposed', 'unmatched', 'removed']);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const ReasonSourceSchema = z.enum(['memory', 'rules', 'llm', 'user']);
export type ReasonSource = z.infer<typeof ReasonSourceSchema>;

export const PreferencesSchema = z.strictObject({
  budgetCents: z.int().positive().optional(),
  /** Restrictions: what must not be in the basket. */
  diet: z.array(z.enum(['vegetarian', 'vegan', 'gluten_free', 'lactose_free', 'no_pork', 'halal'])).default([]),
  /** Nutrition goals: soft preferences (no nutrient values are available in search results). */
  goals: z.array(z.enum(['high_protein', 'low_calorie', 'low_sugar', 'low_fat', 'low_salt'])).default([]),
  allergies: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  organic: z.enum(['no', 'prefer', 'require']).default('no'),
  privateLabel: z.enum(['prefer', 'neutral', 'avoid']).default('neutral'),
  favoriteBrands: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  bannedBrands: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  packSize: z.enum(['small', 'neutral', 'value']).default('neutral'),
  notes: z.string().max(2_000).optional(),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
