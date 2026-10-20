import { type PauseRequest, ProviderError, type ProviderSession } from '@karto/contracts';
import { JobFailure } from './runner.ts';
import { focusTab } from './tab.ts';

/* Provider session during a job: silent refresh, then pause while the user logs in or passes an anti-bot check. */

export type PauseReason = PauseRequest['reason'];

/** Same limit as the backend, which fails a job paused for longer (login_timeout). */
const USER_WAIT_MS = 20 * 60_000;
const REFRESH_WAIT_MS = 15_000;
/** Bounds the loop when the user keeps coming back to the site without logging in. */
const MAX_PAUSES = 3;
/** Any extension API call resets the MV3 service worker idle timer (30 s): one now and then keeps it alive. */
const KEEP_ALIVE_MS = 20_000;

export interface SessionControl {
  /** Silent refresh. True when the tab came back on the site (session renewed, if the SSO session was alive). */
  refresh(): Promise<boolean>;
  /** Tells the backend (and the panel) that the job waits for the user. */
  pause(reason: PauseReason): Promise<void>;
  /**
   * Shows the tab (login page for login_required) and waits until it is back on the site. False on timeout, or
   * once the job is no longer paused on the backend (cancelled, timed out).
   */
  waitForUser(reason: PauseReason): Promise<boolean>;
  resume(): Promise<void>;
}

function pauseReason(err: unknown): PauseReason | null {
  if (!(err instanceof ProviderError)) return null;
  if (err.code === 'auth_required') return 'login_required';
  return err.code === 'challenge' ? 'challenge' : null;
}

/**
 * Runs the whole job with `attempt`. On auth_required (anonymous session, 401, 403 without Cloudflare): one silent
 * refresh then one more attempt. If that is not enough, or on a challenge: pause, wait for the user, resume, and
 * start the job again from scratch. Replaying is safe: cart sync diffs absolute quantities, nothing is added twice.
 */
export async function runWithSession<T>(attempt: () => Promise<T>, control: SessionControl): Promise<T> {
  let refreshed = false;
  let pauses = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const reason = pauseReason(err);
      if (!reason) throw err;
      if (reason === 'login_required' && !refreshed) {
        refreshed = true;
        console.info('[karto] session expired, silent refresh');
        if (await control.refresh()) continue;
      }
      if (pauses >= MAX_PAUSES) throw err;
      pauses += 1;
      console.info('[karto] job paused', { reason });
      await control.pause(reason);
      if (!(await control.waitForUser(reason))) {
        throw new JobFailure({
          code: 'login_timeout',
          message: 'La connexion au site du magasin n’a pas été faite à temps',
          retryable: true,
        });
      }
      await control.resume();
    }
  }
}

/**
 * Starts `navigate`, then resolves true on the next load of the tab that completes on the site (outside login
 * pages), false after `timeoutMs`, when the tab is closed, or when `stillWanted` (checked now and then) says no.
 */
function waitForSite(
  tabId: number,
  session: ProviderSession,
  timeoutMs: number,
  navigate: () => Promise<unknown>,
  stillWanted: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const done = (outcome: boolean | Error) => {
      clearTimeout(timer);
      clearInterval(keepAlive);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const onUpdated = (id: number, info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === 'complete' && tab.url && session.isOnSite(tab.url)) done(true);
    };
    const onRemoved = (id: number) => {
      if (id === tabId) done(false);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const keepAlive = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch((err: unknown) => console.warn('[karto] keep-alive failed', { err }));
      stillWanted().then(
        (wanted) => wanted || done(false),
        (err: unknown) => console.warn('[karto] could not check the paused job', { err }),
      );
    }, KEEP_ALIVE_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    navigate().catch((err: unknown) =>
      done(new ProviderError('network', `Could not show the provider tab: ${String(err)}`, true)),
    );
  });
}

/** The backend side of a pause: report it, check it still holds (not cancelled), resume. */
export interface PausedJob extends Pick<SessionControl, 'pause' | 'resume'> {
  isPaused(): Promise<boolean>;
}

/** SessionControl over the provider tab. */
export function tabSession(tabId: number, session: ProviderSession, job: PausedJob): SessionControl {
  return {
    pause: job.pause,
    resume: job.resume,
    refresh: () =>
      waitForSite(tabId, session, REFRESH_WAIT_MS, () => chrome.tabs.update(tabId, { url: session.refreshUrl })),
    waitForUser: (reason) =>
      waitForSite(
        tabId,
        session,
        USER_WAIT_MS,
        async () => {
          if (reason === 'login_required') await chrome.tabs.update(tabId, { url: session.loginUrl });
          await focusTab(tabId);
        },
        job.isPaused,
      ),
  };
}
