import { z } from 'zod';

/* State shared by the side panel and the service worker through chrome.storage, plus the panel → SW messages. */

const TOKEN_KEY = 'deviceToken';
export const EXECUTOR_KEY = 'executor';

export const ExecutorStateSchema = z.object({
  state: z.enum(['unpaired', 'idle', 'busy', 'login_required', 'challenge', 'no_store']),
  jobId: z.string().optional(),
  detail: z.string().optional(),
});
export type ExecutorState = z.infer<typeof ExecutorStateSchema>;

export const MessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wake') }),
  z.object({ type: z.literal('paired') }),
  z.object({ type: z.literal('focusCarrefour') }),
  /** Dev builds only. The service worker answers with ContractCheckResponse. */
  z.object({ type: z.literal('checkContract') }),
]);
export type Message = z.infer<typeof MessageSchema>;

export const ContractCheckResponseSchema = z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }));
export type ContractCheckResponse = z.infer<typeof ContractCheckResponseSchema>;

export async function getToken(): Promise<string | null> {
  const value = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function setToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}

export function parseExecutorState(value: unknown): ExecutorState | null {
  const parsed = ExecutorStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getExecutorState(): Promise<ExecutorState | null> {
  return parseExecutorState((await chrome.storage.session.get(EXECUTOR_KEY))[EXECUTOR_KEY]);
}

export async function setExecutorState(state: ExecutorState): Promise<void> {
  await chrome.storage.session.set({ [EXECUTOR_KEY]: state });
}
