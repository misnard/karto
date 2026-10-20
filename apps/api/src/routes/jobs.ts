import {
  ClaimRequestSchema,
  CompleteRequestSchema,
  FailRequestSchema,
  JOB_LEASE_MS,
  type JobError,
  JobResultSchemas,
  type JobStatus,
  PauseRequestSchema,
  ProgressRequestSchema,
  type ProgressResponse,
  type ResumeResponse,
} from '@karto/contracts';
import { type Context, Hono } from 'hono';
import { type Executor, type JobsEnv, RELAY } from '../auth.ts';
import {
  claimJob,
  getJob,
  getJobForRelay,
  type JobPatch,
  type JobRow,
  toJob,
  toJobSummary,
  updateClaimedJob,
  whileClaimed,
} from '../db/jobs.ts';
import { AppError, readBody } from '../errors.ts';
import { wakeLlmRunner } from '../llm/runner.ts';
import { advanceBasket, type JobOutcome } from '../pipeline/advance-basket.ts';

function claimer(executor: Executor): string {
  return executor.kind === 'relay' ? RELAY : executor.deviceId;
}

/** A device's own job, or any llm job for the relay: 404 otherwise. */
async function requireJob(executor: Executor, jobId: string): Promise<JobRow> {
  const job = executor.kind === 'relay' ? await getJobForRelay(jobId) : await getJob(executor.userId, jobId);
  if (!job) throw new AppError('not_found', 404, 'Job not found');
  return job;
}

function requireDevice(c: Context<JobsEnv>): Extract<Executor, { kind: 'device' }> {
  const executor = c.var.executor;
  if (executor.kind !== 'device') throw new AppError('forbidden', 403, 'Device token required');
  return executor;
}

/**
 * Updates a job claimed by the calling executor whose status is in `from` (409 otherwise), with `guarded`
 * statements in the same transaction. Scoped by the job's user: the device's own, or the relay job's user.
 */
async function transition(
  c: Context<JobsEnv>,
  job: JobRow,
  from: JobStatus[],
  patch: JobPatch,
  guarded: D1PreparedStatement[] = [],
): Promise<JobRow> {
  const updated = await updateClaimedJob(job.user_id, claimer(c.var.executor), job.id, from, patch, guarded);
  if (!updated) throw new AppError('conflict', 409, `Job is not ${from.join(' or ')} or not claimed by this executor`);
  return updated;
}

/**
 * Finishes a running or paused job and moves its basket, in one transaction. The basket statements are guarded
 * by the same condition as the job update, so a second completion changes nothing and gets 409.
 */
async function finish(c: Context<JobsEnv>, job: JobRow, outcome: JobOutcome): Promise<void> {
  const from: JobStatus[] = ['running', 'paused'];
  const guard = whileClaimed(job.user_id, claimer(c.var.executor), job.id, from);
  const { patch, statements } = await advanceBasket(job.user_id, job, outcome, guard);
  await transition(c, job, from, patch, statements);
  // A completed search may have queued the pick.
  if (job.kind === 'provider.search') wakeLlmRunner();
}

export const jobs = new Hono<JobsEnv>()
  .post('/claim', async (c) => {
    const { kinds } = await readBody(c, ClaimRequestSchema);
    const executor = c.var.executor;
    // The relay only runs LLM jobs (any user); devices never see prompts.
    if (executor.kind === 'relay' && kinds.some((kind) => kind !== 'llm')) {
      throw new AppError('forbidden', 403, 'The relay can only claim llm jobs');
    }
    if (executor.kind === 'device' && kinds.includes('llm')) {
      throw new AppError('forbidden', 403, 'Devices cannot claim llm jobs');
    }
    const userId = executor.kind === 'relay' ? null : executor.userId;
    const job = await claimJob(userId, claimer(executor), kinds, Date.now() + JOB_LEASE_MS);
    return job ? c.json(toJob(job)) : c.body(null, 204);
  })
  .get('/:id', async (c) => {
    return c.json(toJobSummary(await requireJob(requireDevice(c), c.req.param('id'))));
  })
  .post('/:id/progress', async (c) => {
    const progress = await readBody(c, ProgressRequestSchema);
    const job = await requireJob(c.var.executor, c.req.param('id'));
    const leaseUntil = Date.now() + JOB_LEASE_MS;
    const updated = await transition(c, job, ['running'], {
      progress: JSON.stringify(progress),
      lease_until: leaseUntil,
    });
    return c.json({ leaseUntil, cancel: updated.cancel_requested === 1 } satisfies ProgressResponse);
  })
  .post('/:id/pause', async (c) => {
    const { reason } = await readBody(c, PauseRequestSchema);
    const job = await requireJob(requireDevice(c), c.req.param('id'));
    const error: JobError =
      reason === 'challenge'
        ? { code: 'challenge', message: 'Challenge to solve in the store tab', retryable: true }
        : { code: 'auth_required', message: 'Login required on the store site', retryable: true };
    await transition(c, job, ['running'], { status: 'paused', error: JSON.stringify(error), lease_until: null });
    return c.body(null, 204);
  })
  .post('/:id/resume', async (c) => {
    const job = await requireJob(requireDevice(c), c.req.param('id'));
    const leaseUntil = Date.now() + JOB_LEASE_MS;
    await transition(c, job, ['paused'], { status: 'running', error: null, lease_until: leaseUntil });
    return c.json({ leaseUntil } satisfies ResumeResponse);
  })
  .post('/:id/complete', async (c) => {
    const body = await readBody(c, CompleteRequestSchema);
    const job = await requireJob(c.var.executor, c.req.param('id'));
    // Strict schemas: unknown fields (cookies, headers, raw responses) are rejected before anything is stored.
    const result = JobResultSchemas[job.kind].parse(body.result);
    await finish(c, job, { status: 'done', result });
    return c.body(null, 204);
  })
  .post('/:id/fail', async (c) => {
    const { error } = await readBody(c, FailRequestSchema);
    const job = await requireJob(c.var.executor, c.req.param('id'));
    await finish(c, job, { status: 'failed', error });
    return c.body(null, 204);
  });
