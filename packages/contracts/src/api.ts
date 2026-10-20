import { z } from 'zod';
import {
  BasketInputSchema,
  BasketStatusSchema,
  ItemStatusSchema,
  PreferencesSchema,
  ProductOfferSchema,
  ProviderIdSchema,
  ReasonSourceSchema,
  UnitSchema,
} from './domain.ts';
import { JobErrorSchema } from './errors.ts';
import { JobKindSchema, JobProgressSchema, JobStatusSchema } from './jobs.ts';

/* Backend API used by the UI. Auth: `Authorization: Bearer <device token>` except POST /v1/pair. */

export const UserSchema = z.strictObject({ id: z.string(), name: z.string(), isAdmin: z.boolean() });
export type User = z.infer<typeof UserSchema>;

export const PairRequestSchema = z.strictObject({
  code: z.string().trim().min(6).max(32),
  label: z.string().trim().min(1).max(100),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.strictObject({ token: z.string(), user: UserSchema });
export type PairResponse = z.infer<typeof PairResponseSchema>;

/** POST /v1/me/pairing-codes: one-time code to pair another device of the same user. */
export const PairingCodeResponseSchema = z.strictObject({ code: z.string(), expiresAt: z.int() });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;

export const DeviceSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  createdAt: z.int(),
  lastSeenAt: z.int().nullable(),
  /** The device making the request. */
  current: z.boolean(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceListResponseSchema = z.strictObject({ devices: z.array(DeviceSchema) });
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;

/** POST /v1/admin/users (admin only). */
export const CreateUserRequestSchema = z.strictObject({ name: z.string().trim().min(1).max(100) });
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const CreateUserResponseSchema = z.strictObject({ user: UserSchema, code: z.string(), expiresAt: z.int() });
export type CreateUserResponse = z.infer<typeof CreateUserResponseSchema>;

export const MeResponseSchema = z.strictObject({ user: UserSchema, preferences: PreferencesSchema });
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const CreateBasketRequestSchema = z.strictObject({
  inputs: z.array(BasketInputSchema).min(1).max(10),
  /** People to cook for: used to expand dishes ("de quoi faire des lasagnes") and recipes without their own yield. */
  servings: z.int().min(1).max(20).optional(),
});
export type CreateBasketRequest = z.infer<typeof CreateBasketRequestSchema>;

export const BasketItemSchema = z.strictObject({
  id: z.string(),
  position: z.int().nonnegative(),
  ingredientKey: z.string(),
  label: z.string(),
  quantity: z.number().nonnegative(),
  unit: UnitSchema,
  status: ItemStatusSchema,
  productRef: z.string().nullable(),
  /** Number of sellable items to put in the cart. */
  packs: z.int().nonnegative().nullable(),
  candidates: z.array(ProductOfferSchema),
  reason: z.string().nullable(),
  reasonSource: ReasonSourceSchema.nullable(),
});
export type BasketItem = z.infer<typeof BasketItemSchema>;

export const JobSummarySchema = z.strictObject({
  id: z.string(),
  kind: JobKindSchema,
  status: JobStatusSchema,
  progress: JobProgressSchema.nullable(),
  error: JobErrorSchema.nullable(),
  /** Cart sync only: per-line outcome once done. */
  result: z.unknown().nullable(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const BasketSchema = z.strictObject({
  id: z.string(),
  provider: ProviderIdSchema,
  status: BasketStatusSchema,
  storeRef: z.string().nullable(),
  createdAt: z.int(),
  updatedAt: z.int(),
  items: z.array(BasketItemSchema),
  /** Sum of chosen offers × packs, for items with status 'proposed'. */
  totalCents: z.int().nonnegative(),
  /** Latest job of this basket (search or cart sync), if any. */
  job: JobSummarySchema.nullable(),
  error: z.string().nullable(),
});
export type Basket = z.infer<typeof BasketSchema>;

export const BasketSummarySchema = BasketSchema.pick({
  id: true,
  status: true,
  createdAt: true,
  totalCents: true,
}).extend({ itemCount: z.int().nonnegative() });
export type BasketSummary = z.infer<typeof BasketSummarySchema>;

export const PatchItemRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('choose'), ref: z.string().min(1) }),
  z.strictObject({ op: z.literal('packs'), packs: z.int().min(1).max(50) }),
  z.strictObject({ op: z.literal('remove') }),
  z.strictObject({ op: z.literal('restore') }),
]);
export type PatchItemRequest = z.infer<typeof PatchItemRequestSchema>;

/** POST /v1/baskets/:id/items/:itemId/search: manual search to replace one item's product. */
export const SearchItemRequestSchema = z.strictObject({ query: z.string().trim().min(1).max(200) });
export type SearchItemRequest = z.infer<typeof SearchItemRequestSchema>;

/** Free-text change to an existing basket: "ajoute de la mayo, enlève les oignons, j'ai déjà du sel". */
export const AmendBasketRequestSchema = z.strictObject({ text: z.string().trim().min(1).max(2_000) });
export type AmendBasketRequest = z.infer<typeof AmendBasketRequestSchema>;

export const PushResponseSchema = z.strictObject({ jobId: z.string() });
export type PushResponse = z.infer<typeof PushResponseSchema>;
