import { ProviderError } from '@karto/contracts';
import { describe, expect, it, vi } from 'vitest';
import { toJobError } from './runner.ts';
import { runWithSession, type SessionControl } from './session.ts';

const anonymous = () => new ProviderError('auth_required', 'Anonymous session');
const challenge = () => new ProviderError('challenge', 'Cloudflare challenge', false, 403);

/** A job that throws `errors` in turn, then succeeds. */
function job(...errors: ProviderError[]) {
  return vi.fn(async () => {
    const error = errors.shift();
    if (error) throw error;
    return 'done';
  });
}

function control(refreshes: boolean, userComesBack = true) {
  return {
    refresh: vi.fn(async () => refreshes),
    pause: vi.fn(async () => undefined),
    waitForUser: vi.fn(async () => userComesBack),
    resume: vi.fn(async () => undefined),
  } satisfies SessionControl;
}

describe('runWithSession', () => {
  it('retries once after a silent refresh', async () => {
    const attempt = job(anonymous());
    const ctl = control(true);

    expect(await runWithSession(attempt, ctl)).toBe('done');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(ctl.pause).not.toHaveBeenCalled();
  });

  it('pauses for login when the refresh fails, then restarts the job after the login', async () => {
    const attempt = job(anonymous());
    const ctl = control(false);

    expect(await runWithSession(attempt, ctl)).toBe('done');
    expect(ctl.pause).toHaveBeenCalledExactlyOnceWith('login_required');
    expect(ctl.waitForUser).toHaveBeenCalledExactlyOnceWith('login_required');
    expect(ctl.resume).toHaveBeenCalledOnce();
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('pauses without refresh on a challenge', async () => {
    const ctl = control(true);

    expect(await runWithSession(job(challenge()), ctl)).toBe('done');
    expect(ctl.refresh).not.toHaveBeenCalled();
    expect(ctl.pause).toHaveBeenCalledExactlyOnceWith('challenge');
  });

  it('fails with login_timeout when the user does not come back in time', async () => {
    const ctl = control(false, false);

    const error = await runWithSession(job(anonymous()), ctl).catch(toJobError);

    expect(error).toMatchObject({ code: 'login_timeout', retryable: true });
    expect(ctl.resume).not.toHaveBeenCalled();
  });

  it('gives up after 3 pauses', async () => {
    const ctl = control(false);

    const error = await runWithSession(job(anonymous(), anonymous(), anonymous(), anonymous()), ctl).catch(toJobError);

    expect(error).toMatchObject({ code: 'auth_required' });
    expect(ctl.refresh).toHaveBeenCalledOnce();
    expect(ctl.pause).toHaveBeenCalledTimes(3);
  });

  it('lets other errors through untouched', async () => {
    const ctl = control(true);
    const down = new ProviderError('http', 'HTTP 500', true, 500);

    await expect(runWithSession(job(down), ctl)).rejects.toBe(down);
    expect(ctl.refresh).not.toHaveBeenCalled();
  });
});
