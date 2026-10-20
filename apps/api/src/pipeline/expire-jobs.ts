import type { JobError } from '@karto/contracts';
import { type JobRow, listStaleJobs, MAX_ATTEMPTS, updateUnchangedJob, whileUnchanged } from '../db/jobs.ts';
import { advanceBasket, type JobOutcome } from './advance-basket.ts';

/* Jobs no executor reports on any more: lease expiry and pause timeout (cron), user cancel of an idle job. */

/** How long a job may wait for the user to log in or pass an anti-bot check. */
export const PAUSE_TIMEOUT_MS = 20 * 60_000;

const LEASE_EXPIRED: JobError = {
  code: 'lease_expired',
  message: 'L’extension s’est arrêtée trop de fois pendant la tâche',
  retryable: true,
};
const LOGIN_TIMEOUT: JobError = {
  code: 'login_timeout',
  message: 'La connexion au site du magasin n’a pas été faite à temps',
  retryable: true,
};

/**
 * Ends a job nobody is reporting on, and moves its basket like any finished job (advanceBasket), in one
 * transaction. False when the job changed meanwhile (claimed, progressed, resumed...): nothing is applied.
 */
export async function endJob(job: JobRow, outcome: JobOutcome): Promise<boolean> {
  const guard = whileUnchanged(job.user_id, job);
  const { patch, statements } = await advanceBasket(job.user_id, job, outcome, guard);
  return (await updateUnchangedJob(job.user_id, job, patch, statements)) !== null;
}

/**
 * Cron, once a minute. A running job whose lease expired goes back to pending while attempts < MAX_ATTEMPTS, and
 * fails (lease_expired) after that. A job paused for longer than PAUSE_TIMEOUT_MS fails (login_timeout).
 * Plain function: a runtime without Workers cron calls it on a timer.
 */
export async function expireLeases(now = Date.now()): Promise<void> {
  for (const job of await listStaleJobs(now, now - PAUSE_TIMEOUT_MS)) {
    try {
      if (job.status === 'running' && job.attempts < MAX_ATTEMPTS) {
        const requeue = { status: 'pending', claimed_by: null, lease_until: null, progress: null } as const;
        if (await updateUnchangedJob(job.user_id, job, requeue)) {
          console.info('[cron] lease expired, job requeued', { jobId: job.id, attempts: job.attempts });
        }
      } else if (
        await endJob(job, { status: 'failed', error: job.status === 'paused' ? LOGIN_TIMEOUT : LEASE_EXPIRED })
      ) {
        console.info('[cron] job failed', { jobId: job.id, basketId: job.basket_id, status: job.status });
      }
    } catch (err) {
      // One broken job must not block the others; the next run tries it again.
      console.error('[cron] could not expire job', { jobId: job.id, error: err instanceof Error ? err.message : err });
    }
  }
}
