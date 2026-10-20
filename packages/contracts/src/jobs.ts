import { z } from 'zod';
import { ProductOfferSchema, ProviderIdSchema, StoreContextSchema } from './domain.ts';
import { JobErrorSchema } from './errors.ts';

/*
 * Executor protocol. Any executor (Chrome extension, LLM relay, a future desktop app) speaks this over HTTP:
 * claim a job, report progress (extends the lease), pause/resume, then complete or fail.
 * Payloads are typed intents, never raw HTTP requests. Results are strict: unknown fields are rejected,
 * so cookies, headers or raw provider responses can never reach the backend.
 */

export const JobKindSchema = z.enum(['provider.search', 'provider.cart_sync', 'llm']);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum(['pending', 'running', 'paused', 'done', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const SearchPayloadSchema = z.strictObject({
  provider: ProviderIdSchema,
  items: z.array(z.strictObject({ itemId: z.string().min(1), query: z.string().trim().min(1).max(200) })).max(100),
  /** Known refs (memory) to refresh in one request. */
  refs: z.array(z.string().min(1)).max(100),
  /** Max offers per query. */
  max: z.int().min(1).max(20),
});
export type SearchPayload = z.infer<typeof SearchPayloadSchema>;

export const SearchResultSchema = z.strictObject({
  context: StoreContextSchema,
  byItem: z.array(z.strictObject({ itemId: z.string().min(1), offers: z.array(ProductOfferSchema) })),
  byRef: z.array(ProductOfferSchema),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const CartSyncPayloadSchema = z.strictObject({
  provider: ProviderIdSchema,
  /** Target quantities for the refs Karto manages. Other cart items are never touched. */
  lines: z
    .array(z.strictObject({ ref: z.string().min(1), quantity: z.int().nonnegative(), label: z.string() }))
    .min(1)
    .max(200),
});
export type CartSyncPayload = z.infer<typeof CartSyncPayloadSchema>;

export const CartSyncOutcomeSchema = z.enum(['set', 'unchanged', 'unavailable', 'failed']);
export type CartSyncOutcome = z.infer<typeof CartSyncOutcomeSchema>;

export const CartSyncResultSchema = z.strictObject({
  context: StoreContextSchema,
  lines: z.array(
    z.strictObject({
      ref: z.string().min(1),
      outcome: CartSyncOutcomeSchema,
      before: z.int().nonnegative(),
      after: z.int().nonnegative(),
      error: z.string().max(500).optional(),
    }),
  ),
});
export type CartSyncResult = z.infer<typeof CartSyncResultSchema>;

export const LlmPayloadSchema = z.strictObject({
  purpose: z.enum(['parse', 'pick', 'amend']),
  model: z.string().min(1),
  system: z.string(),
  user: z.string(),
  jsonSchema: z.record(z.string(), z.unknown()),
});
export type LlmPayload = z.infer<typeof LlmPayloadSchema>;

export const LlmResultSchema = z.strictObject({
  text: z.string(),
  usage: z.strictObject({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }),
});
export type LlmResult = z.infer<typeof LlmResultSchema>;

export const JobProgressSchema = z.strictObject({
  done: z.int().nonnegative(),
  total: z.int().nonnegative(),
  label: z.string().max(200).optional(),
  /** Per-line status, keyed by itemId (search) or ref (cart sync). */
  lines: z
    .array(
      z.strictObject({
        key: z.string().min(1),
        status: z.enum(['pending', 'ok', 'failed', 'skipped']),
        label: z.string().max(200).optional(),
      }),
    )
    .max(200)
    .optional(),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

const jobBase = {
  id: z.string().min(1),
  status: JobStatusSchema,
  attempts: z.int().nonnegative(),
  /** Epoch ms. */
  leaseUntil: z.int().nullable(),
};

export const JobSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...jobBase, kind: z.literal('provider.search'), payload: SearchPayloadSchema }),
  z.strictObject({ ...jobBase, kind: z.literal('provider.cart_sync'), payload: CartSyncPayloadSchema }),
  z.strictObject({ ...jobBase, kind: z.literal('llm'), payload: LlmPayloadSchema }),
]);
export type Job = z.infer<typeof JobSchema>;

/** Result schema per kind, used by the backend to validate `complete`. */
export const JobResultSchemas = {
  'provider.search': SearchResultSchema,
  'provider.cart_sync': CartSyncResultSchema,
  llm: LlmResultSchema,
} as const satisfies Record<JobKind, z.ZodType>;

// --- HTTP protocol: POST /v1/jobs/* ---

export const ClaimRequestSchema = z.strictObject({
  kinds: z.array(JobKindSchema).min(1),
  agent: z.strictObject({ name: z.string().min(1).max(50), version: z.string().min(1).max(50) }),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;
/** Response: 200 Job, or 204 when nothing to do. */

export const ProgressRequestSchema = JobProgressSchema;
export type ProgressRequest = JobProgress;

export const ProgressResponseSchema = z.strictObject({
  leaseUntil: z.int(),
  /** True when the user cancelled: stop before the next line, then call fail with code 'cancelled'. */
  cancel: z.boolean(),
});
export type ProgressResponse = z.infer<typeof ProgressResponseSchema>;

export const PauseRequestSchema = z.strictObject({ reason: z.enum(['login_required', 'challenge']) });
export type PauseRequest = z.infer<typeof PauseRequestSchema>;

export const ResumeResponseSchema = z.strictObject({ leaseUntil: z.int() });
export type ResumeResponse = z.infer<typeof ResumeResponseSchema>;

/** `result` is validated server-side against JobResultSchemas[job.kind]. */
export const CompleteRequestSchema = z.strictObject({ result: z.unknown() });
export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;

export const FailRequestSchema = z.strictObject({ error: JobErrorSchema });
export type FailRequest = z.infer<typeof FailRequestSchema>;

/** Lease length granted on claim, progress and resume. */
export const JOB_LEASE_MS = 120_000;
