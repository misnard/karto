/**
 * The Worker's own llm job runner (LLM_RUNTIME=api). It claims, runs and finishes llm jobs through the same db
 * functions and advanceBasket path as the relay's /v1/jobs routes, so both runtimes behave the same: zod
 * validation, one retry on invalid output or failed call, usage summed on the job.
 */
import { env, waitUntil } from 'cloudflare:workers';
import { JOB_LEASE_MS, type JobStatus, LlmPayloadSchema } from '@karto/contracts';
import { claimJob, type JobRow, updateClaimedJob, whileClaimed } from '../db/jobs.ts';
import { advanceBasket, type JobOutcome } from '../pipeline/advance-basket.ts';
import { anthropicClient } from './anthropic.ts';
import type { LlmClient } from './client.ts';

declare global {
  namespace Cloudflare {
    interface Env {
      /** Secret (wrangler secret put ANTHROPIC_API_KEY), needed when LLM_RUNTIME is 'api'. */
      ANTHROPIC_API_KEY: string;
    }
  }
}

/** `claimed_by` of the jobs this runner takes (device ids are UUIDs, the relay is 'relay'). */
const RUNNER = 'runner';

/** The Anthropic client in the api runtime; null in the cli runtime, where the relay runs llm jobs. */
function runtimeClient(): LlmClient | null {
  return env.LLM_RUNTIME === 'api' ? anthropicClient(env.ANTHROPIC_API_KEY) : null;
}

async function runJob(client: LlmClient, job: JobRow): Promise<void> {
  let outcome: JobOutcome;
  try {
    const result = await client.complete(LlmPayloadSchema.parse(JSON.parse(job.payload)));
    outcome = { status: 'done', result };
  } catch (err) {
    const message = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    console.error('llm job failed', { jobId: job.id, basketId: job.basket_id, error: message });
    outcome = { status: 'failed', error: { code: 'internal', message, retryable: true } };
  }
  // Same transaction as finish() in routes/jobs.ts: the basket moves only if the job is still ours.
  const from: JobStatus[] = ['running'];
  const guard = whileClaimed(job.user_id, RUNNER, job.id, from);
  const { patch, statements } = await advanceBasket(job.user_id, job, outcome, guard);
  if (!(await updateClaimedJob(job.user_id, RUNNER, job.id, from, patch, statements))) {
    console.warn('llm job changed while running', { jobId: job.id, basketId: job.basket_id });
  }
}

/**
 * Runs pending llm jobs of every user, one at a time, until none is left. Also reclaims running jobs whose lease
 * expired (attempts < 3, see claimJob), e.g. after a waitUntil cut short. Does nothing in the cli runtime.
 * For the cron, and for wakeLlmRunner. `client` exists for tests.
 */
export async function runPendingLlmJobs(client: LlmClient | null = runtimeClient()): Promise<void> {
  if (!client) return;
  for (;;) {
    const job = await claimJob(null, RUNNER, ['llm'], Date.now() + JOB_LEASE_MS);
    if (!job) return;
    await runJob(client, job);
  }
}

/** Call after creating an llm job: in the api runtime, its basket advances once the response is sent. */
export function wakeLlmRunner(): void {
  waitUntil(
    runPendingLlmJobs().catch((err: unknown) => {
      console.error('llm runner failed', { error: err instanceof Error ? err.message : String(err) });
    }),
  );
}
