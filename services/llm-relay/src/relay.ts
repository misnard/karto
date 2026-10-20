import {
  ApiErrorBodySchema,
  type ClaimRequest,
  type CompleteRequest,
  type FailRequest,
  type Job,
  JobSchema,
  type LlmPayload,
  type LlmResult,
  LlmResultSchema,
} from '@karto/contracts';
import { z } from 'zod';

export const AGENT = { name: 'karto-llm-relay', version: '0.1.0' } as const;
export const IDLE_MS = 2_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
/** Shown to the user on the basket: the usual cause is a relay started before a contract change. */
export const UNREADABLE_JOB_MESSAGE = 'Le relais ne sait pas lire ce job : redémarre-le (pnpm relay).';

export interface RelayDeps {
  /** Without trailing slash. */
  apiUrl: string;
  token: string;
  fetch: typeof fetch;
  run: (payload: LlmPayload) => Promise<LlmResult>;
  /** Resolves early once `signal` is aborted. */
  sleep: (ms: number) => Promise<void>;
  /** Job ids, durations and token counts only: never prompts or outputs. */
  log: (line: string) => void;
  /** Aborting stops claiming. A job in flight finishes, or is abandoned to its lease if its run fails. */
  signal: AbortSignal;
}

/** The API refused the relay (bad token, or a token it does not take for the relay): retrying cannot help. */
export class RelayAuthError extends Error {
  override readonly name = 'RelayAuthError';
}

/** Claims and runs `llm` jobs one at a time until `signal` is aborted. */
export async function runRelay(deps: RelayDeps): Promise<void> {
  let backoff = BACKOFF_MIN_MS;
  while (!deps.signal.aborted) {
    let job: Job | null;
    try {
      job = await claim(deps);
      backoff = BACKOFF_MIN_MS;
    } catch (err) {
      if (deps.signal.aborted) break;
      if (err instanceof RelayAuthError) throw err;
      deps.log(`claim failed (${errorMessage(err)}), retrying in ${backoff / 1000} s`);
      await deps.sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }
    if (job) await handle(deps, job);
    else await deps.sleep(IDLE_MS);
  }
}

async function claim(deps: RelayDeps): Promise<Job | null> {
  const body: ClaimRequest = { kinds: ['llm'], agent: AGENT };
  const res = await post(deps, '/v1/jobs/claim', body, deps.signal);
  if (res.status === 204) return null;
  if (res.status === 401 || res.status === 403) {
    const reason = `HTTP ${res.status}${await apiError(res)}`;
    throw new RelayAuthError(`the API refused the relay (${reason}): check that it runs with the same RELAY_TOKEN`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}${await apiError(res)}`);
  const json: unknown = await res.json();
  const parsed = JobSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  const claimed = z.looseObject({ id: z.string().min(1) }).safeParse(json);
  if (!claimed.success) throw new Error('claim response is not a valid job');
  // The API now holds this job as ours: fail it, or it stays stuck until its lease expires and then comes back here.
  const { id } = claimed.data;
  const issue = parsed.error.issues[0];
  const where = `${issue?.code} at ${issue?.path.map(String).join('.') || '<root>'}`;
  deps.log(`job ${id}: unreadable by this relay (${where}), failing it. Restart the relay if the contracts changed.`);
  await report(deps, id, 'fail', { error: { code: 'internal', message: UNREADABLE_JOB_MESSAGE, retryable: false } });
  return null;
}

async function handle(deps: RelayDeps, job: Job): Promise<void> {
  if (job.kind !== 'llm') {
    const message = `the LLM relay cannot run ${job.kind} jobs`;
    await report(deps, job.id, 'fail', { error: { code: 'internal', message, retryable: false } });
    return;
  }

  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  let result: LlmResult;
  try {
    result = LlmResultSchema.parse(await deps.run(job.payload));
  } catch (err) {
    if (deps.signal.aborted) {
      deps.log(`job ${job.id} abandoned on shutdown, its lease will expire`);
      return;
    }
    const message = `claude -p failed: ${errorMessage(err)}`.slice(0, 500);
    deps.log(`job ${job.id} failed after ${elapsed()}: ${message}`);
    await report(deps, job.id, 'fail', { error: { code: 'internal', message, retryable: true } });
    return;
  }

  const { inputTokens, outputTokens } = result.usage;
  deps.log(
    `job ${job.id} (${job.payload.purpose}) done in ${elapsed()}, ${inputTokens} in / ${outputTokens} out tokens`,
  );
  await report(deps, job.id, 'complete', { result });
}

/** Errors are logged, not retried: the job's lease expires and the API hands it out again. */
async function report(
  deps: RelayDeps,
  jobId: string,
  action: 'complete' | 'fail',
  body: CompleteRequest | FailRequest,
): Promise<void> {
  try {
    const res = await post(deps, `/v1/jobs/${encodeURIComponent(jobId)}/${action}`, body);
    if (!res.ok) deps.log(`job ${jobId}: ${action} refused (HTTP ${res.status})`);
  } catch (err) {
    deps.log(`job ${jobId}: ${action} failed (${errorMessage(err)})`);
  }
}

function post(deps: RelayDeps, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return deps.fetch(`${deps.apiUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/** The API's `{error:{code,message}}` as a suffix, when the body has one. */
async function apiError(res: Response): Promise<string> {
  const parsed = ApiErrorBodySchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? `: ${parsed.data.error.code}, ${parsed.data.error.message}` : '';
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
