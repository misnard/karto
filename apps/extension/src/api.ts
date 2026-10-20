import {
  type AmendBasketRequest,
  ApiErrorBodySchema,
  type Basket,
  BasketSchema,
  type BasketSummary,
  BasketSummarySchema,
  type ClaimRequest,
  type CreateBasketRequest,
  type CreateUserRequest,
  type CreateUserResponse,
  CreateUserResponseSchema,
  type Device,
  DeviceListResponseSchema,
  type Job,
  type JobError,
  type JobProgress,
  JobSchema,
  type JobSummary,
  JobSummarySchema,
  type MeResponse,
  MeResponseSchema,
  type PairingCodeResponse,
  PairingCodeResponseSchema,
  type PairResponse,
  PairResponseSchema,
  type PatchItemRequest,
  type PauseRequest,
  type Preferences,
  PreferencesSchema,
  type ProgressResponse,
  ProgressResponseSchema,
  PushResponseSchema,
  ResumeResponseSchema,
  type SearchItemRequest,
} from '@karto/contracts';
import { z } from 'zod';

/* Karto backend client, shared by the side panel and the executor. Every response is validated. */

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

const AGENT: ClaimRequest['agent'] = { name: 'karto-extension', version: '0.1.0' };

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function send(path: string, token: string | null, method = 'GET', body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = ApiErrorBodySchema.safeParse(await res.json().catch(() => null));
    const error = parsed.success ? parsed.data.error : { code: 'internal', message: `HTTP ${res.status}` };
    throw new ApiError(res.status, error.code, error.message);
  }
  return res;
}

async function json<S extends z.ZodType>(schema: S, res: Response): Promise<z.infer<S>> {
  return schema.parse(await res.json());
}

// --- Side panel ---

export async function pair(code: string, label: string): Promise<PairResponse> {
  return json(PairResponseSchema, await send('/v1/pair', null, 'POST', { code, label }));
}

export async function createBasket(token: string, request: CreateBasketRequest): Promise<Basket> {
  return json(BasketSchema, await send('/v1/baskets', token, 'POST', request));
}

export async function getMe(token: string): Promise<MeResponse> {
  return json(MeResponseSchema, await send('/v1/me', token));
}

export async function savePreferences(token: string, preferences: Preferences): Promise<Preferences> {
  return json(PreferencesSchema, await send('/v1/me/preferences', token, 'PUT', preferences));
}

export async function listBaskets(token: string, limit: number): Promise<BasketSummary[]> {
  return json(z.array(BasketSummarySchema), await send(`/v1/baskets?limit=${limit}`, token));
}

export async function getBasket(token: string, id: string): Promise<Basket> {
  return json(BasketSchema, await send(`/v1/baskets/${encodeURIComponent(id)}`, token));
}

export async function retryBasket(token: string, id: string): Promise<Basket> {
  return json(BasketSchema, await send(`/v1/baskets/${encodeURIComponent(id)}/retry`, token, 'POST'));
}

export async function amendBasket(token: string, id: string, text: string): Promise<Basket> {
  const body: AmendBasketRequest = { text };
  return json(BasketSchema, await send(`/v1/baskets/${encodeURIComponent(id)}/amend`, token, 'POST', body));
}

export async function patchItem(
  token: string,
  basketId: string,
  itemId: string,
  request: PatchItemRequest,
): Promise<Basket> {
  const path = `/v1/baskets/${encodeURIComponent(basketId)}/items/${encodeURIComponent(itemId)}`;
  return json(BasketSchema, await send(path, token, 'PATCH', request));
}

/** Manual search for one item: queues a search job, the basket is searching until the executor completes it. */
export async function searchItem(token: string, basketId: string, itemId: string, query: string): Promise<Basket> {
  const path = `/v1/baskets/${encodeURIComponent(basketId)}/items/${encodeURIComponent(itemId)}/search`;
  const body: SearchItemRequest = { query };
  return json(BasketSchema, await send(path, token, 'POST', body));
}

/** Stops the basket's search or push: at its next line if it runs, right away otherwise. */
export async function cancelBasket(token: string, id: string): Promise<Basket> {
  return json(BasketSchema, await send(`/v1/baskets/${encodeURIComponent(id)}/cancel`, token, 'POST'));
}

export async function pushBasket(token: string, id: string): Promise<string> {
  const res = await send(`/v1/baskets/${encodeURIComponent(id)}/push`, token, 'POST');
  return (await json(PushResponseSchema, res)).jobId;
}

// --- Devices and admin ---

export async function createPairingCode(token: string): Promise<PairingCodeResponse> {
  return json(PairingCodeResponseSchema, await send('/v1/me/pairing-codes', token, 'POST'));
}

export async function listDevices(token: string): Promise<Device[]> {
  return (await json(DeviceListResponseSchema, await send('/v1/me/devices', token))).devices;
}

export async function revokeDevice(token: string, id: string): Promise<void> {
  await send(`/v1/me/devices/${encodeURIComponent(id)}`, token, 'DELETE');
}

export async function createUser(token: string, name: string): Promise<CreateUserResponse> {
  const body: CreateUserRequest = { name };
  return json(CreateUserResponseSchema, await send('/v1/admin/users', token, 'POST', body));
}

// --- Executor (job protocol) ---

/** Null when there is nothing to do (204). */
export async function claimJob(token: string, kinds: ClaimRequest['kinds']): Promise<Job | null> {
  const res = await send('/v1/jobs/claim', token, 'POST', { kinds, agent: AGENT } satisfies ClaimRequest);
  return res.status === 204 ? null : json(JobSchema, res);
}

export async function reportProgress(token: string, jobId: string, progress: JobProgress): Promise<ProgressResponse> {
  return json(
    ProgressResponseSchema,
    await send(`/v1/jobs/${encodeURIComponent(jobId)}/progress`, token, 'POST', progress),
  );
}

export async function completeJob(token: string, jobId: string, result: unknown): Promise<void> {
  await send(`/v1/jobs/${encodeURIComponent(jobId)}/complete`, token, 'POST', { result });
}

export async function failJob(token: string, jobId: string, error: JobError): Promise<void> {
  await send(`/v1/jobs/${encodeURIComponent(jobId)}/fail`, token, 'POST', { error });
}

export async function getJob(token: string, jobId: string): Promise<JobSummary> {
  return json(JobSummarySchema, await send(`/v1/jobs/${encodeURIComponent(jobId)}`, token));
}

export async function pauseJob(token: string, jobId: string, reason: PauseRequest['reason']): Promise<void> {
  await send(`/v1/jobs/${encodeURIComponent(jobId)}/pause`, token, 'POST', { reason } satisfies PauseRequest);
}

export async function resumeJob(token: string, jobId: string): Promise<void> {
  await json(ResumeResponseSchema, await send(`/v1/jobs/${encodeURIComponent(jobId)}/resume`, token, 'POST', {}));
}
