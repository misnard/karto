import { z } from 'zod';

export const ApiErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'invalid_pairing_code',
  /** A recipe URL could not be read (site blocks us, no recipe found...): the user should paste the recipe text. */
  'recipe_unavailable',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorBodySchema = z.strictObject({
  error: z.strictObject({ code: ApiErrorCodeSchema, message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const ProviderErrorCodeSchema = z.enum([
  /** Not logged in (anonymous session) or 401/403 without a Cloudflare challenge. */
  'auth_required',
  /** Cloudflare challenge (403 + cf-mitigated). The user must solve it in the tab. */
  'challenge',
  'rate_limited',
  /** No drive store selected on the provider site. */
  'no_store',
  /** Response did not match the expected shape: the provider API probably changed. */
  'schema_mismatch',
  'http',
  'network',
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>;

// Explicit fields, not parameter properties: Node runs this file with type stripping (relay, eval scripts).
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, retryable = false, status?: number) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export const JobErrorCodeSchema = z.enum([
  ...ProviderErrorCodeSchema.options,
  'login_timeout',
  'lease_expired',
  'cancelled',
  'invalid_result',
  'internal',
]);
export type JobErrorCode = z.infer<typeof JobErrorCodeSchema>;

export const JobErrorSchema = z.strictObject({
  code: JobErrorCodeSchema,
  message: z.string().max(2_000),
  retryable: z.boolean(),
});
export type JobError = z.infer<typeof JobErrorSchema>;
