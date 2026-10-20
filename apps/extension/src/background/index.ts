import { type Job, JobResultSchemas, ProviderError, type ProviderSession } from '@karto/contracts';
import { createCarrefourClient } from '@karto/provider-carrefour';
import { ApiError, claimJob, completeJob, failJob, reportProgress } from '../api.ts';
import { clearToken, getToken, type Message, MessageSchema, setExecutorState } from '../state.ts';
import { runCartSync } from './cart-sync.ts';
import { inFrontTab, JobFailure, type RunContext, runSearch, stateAfter, toJobError } from './runner.ts';
import { bringProviderTabToFront, focusProviderTab } from './tab.ts';
import { createMainWorldTransport } from './transport.ts';

/* Service worker = executor: claims provider jobs and runs them in the provider tab. */

const POLL_ALARM = 'karto-poll';
const KINDS = ['provider.search', 'provider.cart_sync'] as const;

/** Static provider facts (site and tab URLs). A client sends nothing until asked, so this one never needs a tab. */
function providerSession(): ProviderSession {
  return createCarrefourClient(() => Promise.reject(new Error('No transport'))).session;
}

function execute(job: Job, ctx: RunContext): Promise<unknown> {
  switch (job.kind) {
    case 'provider.search':
      return runSearch(job.payload, ctx);
    case 'provider.cart_sync':
      return runCartSync(job.payload, ctx);
    default:
      throw new JobFailure({ code: 'internal', message: `Unsupported job kind ${job.kind}`, retryable: false });
  }
}

async function runJob(token: string, job: Job): Promise<void> {
  await setExecutorState({ state: 'busy', jobId: job.id });
  try {
    // Once per job: the tab stays in front until the job ends.
    const tab = await bringProviderTabToFront(providerSession());
    const result = await inFrontTab(tab, () =>
      execute(job, {
        client: createCarrefourClient(createMainWorldTransport(tab.id)),
        async progress(progress) {
          const { cancel } = await reportProgress(token, job.id, progress);
          if (cancel) throw new JobFailure({ code: 'cancelled', message: 'Annulé', retryable: false });
        },
      }),
    );
    // The backend validates too; checking here keeps anything unexpected from leaving the extension.
    if (!JobResultSchemas[job.kind].safeParse(result).success)
      throw new JobFailure({ code: 'invalid_result', message: 'Invalid job result', retryable: false });
    await completeJob(token, job.id, result);
    console.info('[karto] job done', { jobId: job.id, kind: job.kind });
    await setExecutorState({ state: 'idle' });
  } catch (err) {
    const error = toJobError(err);
    console.warn('[karto] job failed', { jobId: job.id, kind: job.kind, code: error.code, cause: errorName(err) });
    await failJob(token, job.id, error).catch((failErr: unknown) =>
      console.error('[karto] could not report job failure', { jobId: job.id, cause: errorName(failErr) }),
    );
    await setExecutorState({ state: stateAfter(error), jobId: job.id });
  }
}

/** Safe to log. Provider messages never quote a response; other messages could, so only their name is kept. */
function errorName(err: unknown): string {
  if (err instanceof ApiError) return `ApiError ${err.status} ${err.code}`;
  if (err instanceof ProviderError) return `ProviderError ${err.code}: ${err.message}`;
  return err instanceof Error ? err.name : 'unknown';
}

let idleClaims = 0;

/** Claims and runs jobs until there is nothing left. The poll alarm stops after two empty claims in a row. */
async function claimLoop(): Promise<void> {
  const token = await getToken();
  if (!token) {
    await setExecutorState({ state: 'unpaired' });
    await chrome.alarms.clear(POLL_ALARM);
    return;
  }
  try {
    for (let job = await claimJob(token, [...KINDS]); job; job = await claimJob(token, [...KINDS])) {
      idleClaims = 0;
      await runJob(token, job);
    }
    idleClaims += 1;
    if (idleClaims >= 2) await chrome.alarms.clear(POLL_ALARM);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.warn('[karto] device token rejected, back to pairing');
      await clearToken();
      await setExecutorState({ state: 'unpaired' });
      await chrome.alarms.clear(POLL_ALARM);
      return;
    }
    // API unreachable: the poll alarm retries later.
    console.warn('[karto] claim failed', { cause: errorName(err) });
  }
}

let loop: Promise<void> | null = null;

function wake(): Promise<void> {
  loop ??= claimLoop().finally(() => {
    loop = null;
  });
  return loop;
}

async function wakeAndPoll(): Promise<void> {
  idleClaims = 0;
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  await wake();
}

async function onStart(): Promise<void> {
  try {
    // The action click is handled by openPanel below, so Chrome must not open the side panel by itself.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {
    // No side panel support (e.g. Arc): openPanel falls back to a tab.
  }
  if (await getToken()) await wakeAndPoll();
  else await setExecutorState({ state: 'unpaired' });
}

/** Chrome: side panel. Chromium browsers without side panel support (e.g. Arc): the same page in a tab. */
async function openPanel(tab: chrome.tabs.Tab): Promise<void> {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
  }
}

function logError(context: string) {
  return (err: unknown) => console.error(`[karto] ${context}`, { cause: errorName(err) });
}

chrome.action.onClicked.addListener((tab) => {
  openPanel(tab).catch(logError('open panel'));
});

chrome.runtime.onInstalled.addListener(() => {
  onStart().catch(logError('install'));
});

chrome.runtime.onStartup.addListener(() => {
  onStart().catch(logError('startup'));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) wake().catch(logError('poll'));
});

async function onMessage(message: Message): Promise<void> {
  if (message.type === 'wake') return wakeAndPoll();
  if (message.type === 'paired') {
    await setExecutorState({ state: 'idle' });
    return wakeAndPoll();
  }
  await focusProviderTab(providerSession());
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const parsed = MessageSchema.safeParse(raw);
  if (sender.id === chrome.runtime.id && parsed.success) onMessage(parsed.data).catch(logError(parsed.data.type));
  // Answer right away: the panel does not wait for the job, only for the message to be delivered.
  sendResponse();
});
