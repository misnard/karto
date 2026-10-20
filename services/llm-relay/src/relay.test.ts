import {
  ClaimRequestSchema,
  CompleteRequestSchema,
  FailRequestSchema,
  type Job,
  type LlmPayload,
  type LlmResult,
  LlmResultSchema,
} from '@karto/contracts';
import { describe, expect, it } from 'vitest';
import { AGENT, IDLE_MS, RelayAuthError, type RelayDeps, runRelay, UNREADABLE_JOB_MESSAGE } from './relay.ts';

const API = 'http://api.test';
const payload: LlmPayload = {
  purpose: 'parse',
  model: 'claude-haiku-5-5',
  system: 'SECRET-SYSTEM',
  user: 'SECRET-PROMPT lait, oeufs',
  jsonSchema: { type: 'object' },
};
const job: Job = { id: 'job-1', kind: 'llm', status: 'running', attempts: 1, leaseUntil: 1_000, payload };
const result: LlmResult = { text: '{"items":["SECRET-OUTPUT"]}', usage: { inputTokens: 1256, outputTokens: 53 } };

type Reply = Response | Error;
interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Replies are consumed in order; once exhausted, every claim gets a 204.
 * The loop stops at the first sleep after `stopAfterSleeps` sleeps.
 */
function harness(replies: Reply[], run: RelayDeps['run'] = async () => result, stopAfterSleeps = 1) {
  const controller = new AbortController();
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const runs: LlmPayload[] = [];
  const deps: RelayDeps = {
    apiUrl: API,
    token: 'relay-test',
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      const reply = replies.shift() ?? new Response(null, { status: 204 });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    run: (p) => {
      runs.push(p);
      return run(p);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= stopAfterSleeps) controller.abort();
    },
    log: (line) => logs.push(line),
    signal: controller.signal,
  };
  return { deps, controller, calls, sleeps, logs, runs };
}

const jsonReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('runRelay', () => {
  it('claims a job, runs it and completes it', async () => {
    const h = harness([jsonReply(job), jsonReply({ ok: true })]);
    await runRelay(h.deps);

    expect(h.calls.map((c) => c.url)).toEqual([
      `${API}/v1/jobs/claim`,
      `${API}/v1/jobs/job-1/complete`,
      `${API}/v1/jobs/claim`,
    ]);
    for (const call of h.calls) {
      expect(call.headers).toEqual({ authorization: 'Bearer relay-test', 'content-type': 'application/json' });
    }
    expect(ClaimRequestSchema.parse(h.calls[0]?.body)).toEqual({ kinds: ['llm'], agent: AGENT });
    const complete = CompleteRequestSchema.parse(h.calls[1]?.body);
    expect(LlmResultSchema.parse(complete.result)).toEqual(result);
    expect(h.runs).toEqual([payload]);
    expect(h.sleeps).toEqual([IDLE_MS]);

    expect(h.logs.join('\n')).toMatch(/job job-1 \(parse\) done in .* 1256 in \/ 53 out tokens/);
    for (const secret of ['SECRET-PROMPT', 'SECRET-SYSTEM', 'SECRET-OUTPUT']) {
      expect(h.logs.join('\n')).not.toContain(secret);
    }
  });

  it('waits when there is nothing to do', async () => {
    const h = harness([], undefined, 2);
    await runRelay(h.deps);
    expect(h.calls.map((c) => c.url)).toEqual([`${API}/v1/jobs/claim`, `${API}/v1/jobs/claim`]);
    expect(h.sleeps).toEqual([IDLE_MS, IDLE_MS]);
    expect(h.runs).toEqual([]);
  });

  it('fails the job as retryable when claude fails, without the prompt', async () => {
    const h = harness([jsonReply(job), jsonReply({ ok: true })], async () => {
      throw new Error('claude exited with code 1 (subtype success, API status 404)');
    });
    await runRelay(h.deps);

    expect(h.calls[1]?.url).toBe(`${API}/v1/jobs/job-1/fail`);
    expect(FailRequestSchema.parse(h.calls[1]?.body)).toEqual({
      error: {
        code: 'internal',
        message: 'claude -p failed: claude exited with code 1 (subtype success, API status 404)',
        retryable: true,
      },
    });
    expect(JSON.stringify(h.calls)).not.toContain('SECRET-PROMPT');
  });

  it('fails the job when the runner returns an invalid result', async () => {
    const h = harness([jsonReply(job), jsonReply({ ok: true })], async () => ({ text: 1 }) as unknown as LlmResult);
    await runRelay(h.deps);
    expect(h.calls[1]?.url).toBe(`${API}/v1/jobs/job-1/fail`);
    expect(FailRequestSchema.parse(h.calls[1]?.body).error.retryable).toBe(true);
  });

  it('refuses non-llm jobs', async () => {
    const searchJob = {
      ...job,
      kind: 'provider.search',
      payload: { provider: 'carrefour', items: [], refs: [], max: 5 },
    };
    const h = harness([jsonReply(searchJob), jsonReply({ ok: true })]);
    await runRelay(h.deps);
    expect(h.runs).toEqual([]);
    expect(FailRequestSchema.parse(h.calls[1]?.body).error).toMatchObject({ code: 'internal', retryable: false });
  });

  it('backs off up to 15 s while the API is unreachable, then resets', async () => {
    const down = () => new TypeError('fetch failed');
    const h = harness(
      [down(), down(), down(), down(), down(), down(), jsonReply(job), jsonReply({}), down()],
      undefined,
      8,
    );
    await runRelay(h.deps);
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 1_000, IDLE_MS]);
    expect(h.runs).toHaveLength(1);
    expect(h.logs[0]).toBe('claim failed (fetch failed), retrying in 1 s');
  });

  it.each([
    [500, 'HTTP 500'],
    [503, 'HTTP 503: internal, down'],
    [200, 'claim response is not a valid job'],
  ])('retries after a bad claim response (%d)', async (status, reason) => {
    const body = status === 503 ? { error: { code: 'internal', message: 'down' } } : { nope: true };
    const h = harness([jsonReply(body, status)]);
    await runRelay(h.deps);
    expect(h.logs[0]).toBe(`claim failed (${reason}), retrying in 1 s`);
    expect(h.sleeps).toEqual([1_000]);
  });

  it('fails a claimed job it cannot read, then keeps polling', async () => {
    // e.g. a relay started before LlmPayload.purpose gained a new value
    const unknownJob = { ...job, id: 'job-9', payload: { ...payload, purpose: 'amend-v2' } };
    const h = harness([jsonReply(unknownJob), jsonReply({ ok: true })], undefined, 2);
    await runRelay(h.deps);

    expect(h.calls.map((c) => c.url)).toEqual([
      `${API}/v1/jobs/claim`,
      `${API}/v1/jobs/job-9/fail`,
      `${API}/v1/jobs/claim`,
    ]);
    expect(FailRequestSchema.parse(h.calls[1]?.body)).toEqual({
      error: {
        code: 'internal',
        message: 'Le relais ne sait pas lire ce job : redémarre-le (pnpm relay).',
        retryable: false,
      },
    });
    expect(UNREADABLE_JOB_MESSAGE).toBe('Le relais ne sait pas lire ce job : redémarre-le (pnpm relay).');
    expect(h.runs).toEqual([]);
    expect(h.sleeps).toEqual([IDLE_MS, IDLE_MS]);
    expect(h.logs).toEqual([
      'job job-9: unreadable by this relay (invalid_value at payload.purpose), failing it. Restart the relay if the contracts changed.',
    ]);
    expect(h.logs.join('\n')).not.toContain('SECRET');
  });

  it('stops with RelayAuthError when the token is refused', async () => {
    const h = harness([jsonReply({ error: { code: 'forbidden', message: 'Devices cannot claim llm jobs' } }, 403)]);
    const err = await runRelay(h.deps).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RelayAuthError);
    expect((err as Error).message).toBe(
      'the API refused the relay (HTTP 403: forbidden, Devices cannot claim llm jobs): check that it runs with the same RELAY_TOKEN',
    );
  });

  it('logs a refused or failed report and keeps going', async () => {
    const h = harness([jsonReply(job), jsonReply({ error: { code: 'conflict', message: 'lease lost' } }, 409)]);
    await runRelay(h.deps);
    expect(h.logs).toContain('job job-1: complete refused (HTTP 409)');
    expect(h.calls).toHaveLength(3);
  });

  it('abandons the job without failing it when stopped mid-run', async () => {
    const h = harness([jsonReply(job)], async () => {
      h.controller.abort();
      throw new Error('claude exited with signal SIGINT');
    });
    await runRelay(h.deps);
    expect(h.calls.map((c) => c.url)).toEqual([`${API}/v1/jobs/claim`]);
    expect(h.logs).toEqual(['job job-1 abandoned on shutdown, its lease will expire']);
  });

  it('completes a job that finishes after a stop request, then stops', async () => {
    const h = harness([jsonReply(job), jsonReply({})], async () => {
      h.controller.abort();
      return result;
    });
    await runRelay(h.deps);
    expect(h.calls.map((c) => c.url)).toEqual([`${API}/v1/jobs/claim`, `${API}/v1/jobs/job-1/complete`]);
  });
});
