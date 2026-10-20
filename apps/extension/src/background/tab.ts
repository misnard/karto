import { ProviderError, type ProviderSession } from '@karto/contracts';

/* The provider tab the executor drives. Host permissions are enough to filter tabs by URL (no "tabs" permission). */

const TAB_KEY = 'providerTabId';
const LOAD_TIMEOUT_MS = 30_000;

/** Preference among the provider tabs: the one we opened, else the active one, else the most recently used. */
export function pickProviderTab(tabs: chrome.tabs.Tab[], ours: unknown): chrome.tabs.Tab | undefined {
  return (
    tabs.find((tab) => tab.id === ours) ??
    tabs.find((tab) => tab.active) ??
    tabs.toSorted((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
  );
}

/** An existing provider tab, or a new one only when there is none (no tab pile-up). */
async function getOrOpenProviderTab(session: ProviderSession, active: boolean): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ url: session.tabUrlPattern });
  const existing = pickProviderTab(tabs, (await chrome.storage.session.get(TAB_KEY))[TAB_KEY]);
  if (existing) return existing;
  const tab = await chrome.tabs.create({ url: session.siteUrl, active });
  await chrome.storage.session.set({ [TAB_KEY]: tab.id });
  return tab;
}

/** Undefined once the tab is closed. */
function findTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  return chrome.tabs.get(tabId).catch(() => undefined);
}

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(
      () => done(new ProviderError('network', 'Provider tab did not load', true)),
      LOAD_TIMEOUT_MS,
    );
    chrome.tabs.onUpdated.addListener(onUpdated);
    findTab(tabId).then((tab) => {
      if (!tab) done(new ProviderError('network', 'Provider tab was closed', true));
      else if (tab.status === 'complete') done();
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reloads the tab and waits for the page, plus a moment for the site's own anti-bot script to run. */
export async function reloadTab(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId);
  await sleep(500); // let the tab leave 'complete' before waiting for the new load
  await waitForLoad(tabId);
  await sleep(1500);
}

export interface FrontTab {
  id: number;
  /** Gives the front back to the tab that had it, unless the user has moved on meanwhile. */
  restore(): Promise<void>;
}

/**
 * Makes the provider tab the active tab of its window for the duration of a job (the window itself is not focused).
 * Some browsers (Arc) freeze background tabs: a script injected there never runs until the tab becomes active.
 */
export async function bringProviderTabToFront(session: ProviderSession): Promise<FrontTab> {
  const tab = await getOrOpenProviderTab(session, false);
  const id = tab.id;
  if (id === undefined) throw new ProviderError('network', 'Provider tab has no id', true);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  const front: FrontTab = {
    id,
    async restore() {
      if (previous?.id === undefined || previous.id === id) return;
      const [current, before] = await Promise.all([findTab(id), findTab(previous.id)]);
      if (current?.active && before) await chrome.tabs.update(previous.id, { active: true });
    },
  };
  if (!tab.active) await chrome.tabs.update(id, { active: true });
  try {
    await waitForLoad(id);
  } catch (err) {
    await front.restore();
    throw err;
  }
  return front;
}

/** Brings the provider tab (opened if needed) and its window to the front, e.g. to log in. */
export async function focusProviderTab(session: ProviderSession): Promise<void> {
  const tab = await getOrOpenProviderTab(session, true);
  if (tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** Makes this tab active and focuses its window, e.g. for the user to log in. */
export async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab) await chrome.windows.update(tab.windowId, { focused: true });
}
