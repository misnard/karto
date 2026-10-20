import { z } from 'zod';

/* State shared by the side panel and the service worker through chrome.storage, plus the panel → SW messages. */

const TOKEN_KEY = 'deviceToken';
const SERVER_KEY = 'serverUrl';
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
]);
export type Message = z.infer<typeof MessageSchema>;

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

/**
 * Karto server address typed at pairing → base URL without trailing slash, or null when refused: https only,
 * except http on localhost or 127.0.0.1 (a server on this machine). No credentials, query or fragment.
 */
export function parseServerUrl(input: string): string | null {
  const url = URL.parse(input.trim());
  if (!url || url.username || url.password || url.search || url.hash) return null;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The server this browser was paired with (kept when unpaired, to prefill the next pairing). */
export async function getServerUrl(): Promise<string | null> {
  const value = (await chrome.storage.local.get(SERVER_KEY))[SERVER_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function setServerUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ [SERVER_KEY]: url });
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
