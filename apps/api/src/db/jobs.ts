import { env } from 'cloudflare:workers';
import {
  CartSyncResultSchema,
  type Job,
  JobErrorSchema,
  type JobKind,
  JobProgressSchema,
  JobSchema,
  type JobStatus,
  type JobSummary,
} from '@karto/contracts';
import type { z } from 'zod';

export interface JobRow {
  id: string;
  user_id: string;
  basket_id: string | null;
  kind: JobKind;
  status: JobStatus;
  payload: string;
  progress: string | null;
  result: string | null;
  error: string | null;
  usage: string | null;
  attempts: number;
  claimed_by: string | null;
  lease_until: number | null;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
}

export interface NewJob {
  id: string;
  basketId: string;
  kind: JobKind;
  payload: unknown;
}

/** Parses a nullable JSON column with `schema`. */
export function parseJsonColumn<T extends z.ZodType>(schema: T, text: string | null): z.output<T> | null {
  return text === null ? null : schema.parse(JSON.parse(text));
}

/** Inserts a pending job, only while `guard` holds when one is given. */
export function insertJobStatement(userId: string, job: NewJob, now: number, guard?: SqlGuard): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO jobs (id, user_id, basket_id, kind, status, payload, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'pending', ?, ?, ? WHERE ${guard?.sql ?? '1'}`,
  ).bind(job.id, userId, job.basketId, job.kind, JSON.stringify(job.payload), now, now, ...(guard?.params ?? []));
}

export async function getJob(userId: string, jobId: string): Promise<JobRow | null> {
  return env.DB.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').bind(jobId, userId).first<JobRow>();
}

/** The relay works for every user: it may read any llm job, and only those. */
export async function getJobForRelay(jobId: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND kind = 'llm'").bind(jobId).first<JobRow>();
}

export async function getLatestBasketJob(userId: string, basketId: string): Promise<JobRow | null> {
  return env.DB.prepare(
    'SELECT * FROM jobs WHERE basket_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  )
    .bind(basketId, userId)
    .first<JobRow>();
}

/** Attempts after which an expired job is no longer reclaimed. */
export const MAX_ATTEMPTS = 3;

/**
 * Atomically claims the oldest claimable job of `kinds` for this user (`null`: any user, for the LLM relay):
 * pending, or running with an expired lease (its executor disappeared). The job gets `claimedBy`, a fresh lease,
 * one more attempt and no progress. The previous claimer then fails the claimed_by guard (409). If the same
 * executor reclaims its own job, an old in-flight request still passes the guard: rare (one job at a time per
 * executor) and harmless, since replaying a job is safe (search only reads, cart sync sets absolute quantities).
 * Paused jobs wait for login and are not reclaimed. Expired jobs at MAX_ATTEMPTS stay running: the step 2 cron
 * fails them and their basket.
 */
export async function claimJob(
  userId: string | null,
  claimedBy: string,
  kinds: JobKind[],
  leaseUntil: number,
): Promise<JobRow | null> {
  const claimable = `(status = 'pending' OR (status = 'running' AND lease_until < ?3 AND attempts < ${MAX_ATTEMPTS}))`;
  return env.DB.prepare(
    `UPDATE jobs
     SET status = 'running', claimed_by = ?1, lease_until = ?2, attempts = attempts + 1, progress = NULL, updated_at = ?3
     WHERE id = (
       SELECT id FROM jobs
       WHERE (?4 IS NULL OR user_id = ?4) AND kind IN (SELECT value FROM json_each(?5)) AND ${claimable}
       ORDER BY created_at, rowid LIMIT 1
     ) AND ${claimable}
     RETURNING *`,
  )
    .bind(claimedBy, leaseUntil, Date.now(), userId, JSON.stringify(kinds))
    .first<JobRow>();
}

export type JobPatch = Partial<
  Pick<JobRow, 'status' | 'progress' | 'result' | 'error' | 'usage' | 'claimed_by' | 'lease_until'>
>;

/** A SQL condition and its parameters, appended to the WHERE clause of a guarded statement. */
export interface SqlGuard {
  sql: string;
  params: unknown[];
}

/** The job is claimed by `claimedBy` and its status is in `from`. Shared by whileClaimed and updateClaimedJob. */
const CLAIMED = 'id = ? AND user_id = ? AND claimed_by = ? AND status IN (SELECT value FROM json_each(?))';

export function whileClaimed(userId: string, claimedBy: string, jobId: string, from: JobStatus[]): SqlGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM jobs WHERE ${CLAIMED})`,
    params: [jobId, userId, claimedBy, JSON.stringify(from)],
  };
}

/**
 * Applies `patch` if the job is claimed by `claimedBy` and in one of `from`. Returns the updated row, or null.
 *
 * `guarded` statements commit in the same transaction (a D1 batch), before the job update. Each must carry
 * whileClaimed() with the same arguments: they all see the job as it was before the patch, so either every
 * statement applies, or none does and null is returned (job finished or reclaimed concurrently).
 */
export async function updateClaimedJob(
  userId: string,
  claimedBy: string,
  jobId: string,
  from: JobStatus[],
  patch: JobPatch,
  guarded: D1PreparedStatement[] = [],
): Promise<JobRow | null> {
  return updateJobWhere(CLAIMED, [jobId, userId, claimedBy, JSON.stringify(from)], patch, guarded);
}

/** The job has not changed since it was read: same status, no update (claim, progress, pause...) since. */
const UNCHANGED = 'id = ? AND user_id = ? AND status = ? AND updated_at = ?';

export function whileUnchanged(userId: string, job: JobRow): SqlGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM jobs WHERE ${UNCHANGED})`,
    params: [job.id, userId, job.status, job.updated_at],
  };
}

/**
 * Like updateClaimedJob, for a job no executor is reporting on (cron, cancel): applies `patch` while the job is
 * unchanged since read. `guarded` statements must carry whileUnchanged() with the same arguments.
 */
export async function updateUnchangedJob(
  userId: string,
  job: JobRow,
  patch: JobPatch,
  guarded: D1PreparedStatement[] = [],
): Promise<JobRow | null> {
  return updateJobWhere(UNCHANGED, [job.id, userId, job.status, job.updated_at], patch, guarded);
}

async function updateJobWhere(
  where: string,
  params: unknown[],
  patch: JobPatch,
  guarded: D1PreparedStatement[],
): Promise<JobRow | null> {
  const entries = Object.entries(patch);
  const update = env.DB.prepare(
    `UPDATE jobs SET ${entries.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ?
     WHERE ${where} RETURNING *`,
  ).bind(...entries.map(([, value]) => value), Date.now(), ...params);
  const results = await env.DB.batch<JobRow>([...guarded, update]);
  return results.at(-1)?.results[0] ?? null;
}

/**
 * Jobs of every user that the cron must requeue or end: running with an expired lease (executor gone), or paused
 * since before `pausedBefore` (pause updates updated_at, and nothing updates a paused job until it resumes).
 */
export async function listStaleJobs(now: number, pausedBefore: number): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM jobs WHERE (status = 'running' AND lease_until < ?) OR (status = 'paused' AND updated_at < ?)`,
  )
    .bind(now, pausedBefore)
    .all<JobRow>();
  return results;
}

/** Asks the executor to stop: the next progress answers cancel: true. updated_at is kept (it times pauses out). */
export async function requestCancel(userId: string, jobId: string): Promise<void> {
  await env.DB.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ? AND user_id = ?').bind(jobId, userId).run();
}

export function toJob(row: JobRow): Job {
  return JobSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    leaseUntil: row.lease_until,
    payload: JSON.parse(row.payload),
  });
}

export function toJobSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: parseJsonColumn(JobProgressSchema, row.progress),
    error: parseJsonColumn(JobErrorSchema, row.error),
    result: row.kind === 'provider.cart_sync' ? parseJsonColumn(CartSyncResultSchema, row.result) : null,
  };
}
