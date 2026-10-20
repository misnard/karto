import type { ProviderSession } from '@karto/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bringProviderTabToFront, focusProviderTab, pickProviderTab } from './tab.ts';

const SITE = 'https://shop.test/';
const session: ProviderSession = {
  siteUrl: SITE,
  tabUrlPattern: `${SITE}*`,
  refreshUrl: `${SITE}refresh`,
  loginUrl: `${SITE}login`,
  isOnSite: () => true,
};

function tab(id: number, fields: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id,
    windowId: 1,
    active: false,
    status: 'complete',
    lastAccessed: 0,
    url: SITE,
    ...fields,
  } as chrome.tabs.Tab;
}

/** Hand-rolled chrome.tabs / storage.session: one active tab per window, URL patterns ending with '*'. */
function stubBrowser(tabs: chrome.tabs.Tab[], storedTabId?: number) {
  const store: Record<string, unknown> = { providerTabId: storedTabId };
  let nextId = 100;
  const activate = (id: number) => {
    const target = tabs.find((t) => t.id === id);
    if (!target) throw new Error(`No tab with id: ${id}`);
    for (const t of tabs) if (t.windowId === target.windowId) t.active = t.id === id;
    return target;
  };
  const chromeStub = {
    tabs: {
      query: vi.fn(async (q: chrome.tabs.QueryInfo) =>
        tabs.filter(
          (t) =>
            (q.url === undefined || t.url?.startsWith(String(q.url).slice(0, -1))) &&
            (q.active === undefined || t.active === q.active) &&
            (q.windowId === undefined || t.windowId === q.windowId),
        ),
      ),
      get: vi.fn(async (id: number) => {
        const found = tabs.find((t) => t.id === id);
        if (!found) throw new Error(`No tab with id: ${id}`);
        return found;
      }),
      update: vi.fn(async (id: number, props: { active?: boolean }) => (props.active ? activate(id) : tab(id))),
      create: vi.fn(async (props: { url: string; active: boolean }) => {
        const created = tab(nextId++, { url: props.url });
        tabs.push(created);
        if (props.active) activate(created.id ?? -1);
        return created;
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    windows: { update: vi.fn(async () => ({})) },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items)),
      },
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  const activeId = (windowId = 1) => tabs.find((t) => t.windowId === windowId && t.active)?.id;
  return { tabs, store, chrome: chromeStub, activeId };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pickProviderTab', () => {
  const recent = tab(1, { lastAccessed: 300 });
  const active = tab(2, { active: true, lastAccessed: 100 });
  const ours = tab(3, { lastAccessed: 50 });
  const old = tab(4, { lastAccessed: 10 });

  it.each<[string, chrome.tabs.Tab[], unknown, number | undefined]>([
    ['the tab we opened first', [recent, active, ours, old], 3, 3],
    ['then the active tab', [recent, active, old], 3, 2],
    ['then the most recently used', [old, recent], undefined, 1],
    ['nothing when there is no provider tab', [], 3, undefined],
  ])('%s', (_name, tabs, stored, expected) => {
    expect(pickProviderTab(tabs, stored)?.id).toBe(expected);
  });
});

describe('bringProviderTabToFront', () => {
  it('activates the provider tab for the job, then gives the front back', async () => {
    const browser = stubBrowser([tab(1, { url: 'https://mail.test/', active: true }), tab(2)]);

    const front = await bringProviderTabToFront(session);
    expect(front.id).toBe(2);
    expect(browser.activeId()).toBe(2);
    expect(browser.chrome.windows.update).not.toHaveBeenCalled();

    await front.restore();
    expect(browser.activeId()).toBe(1);
  });

  it('does not steal the front back when the user moved to another tab', async () => {
    const browser = stubBrowser([tab(1, { url: 'https://mail.test/', active: true }), tab(2), tab(3, { url: 'x' })]);

    const front = await bringProviderTabToFront(session);
    await browser.chrome.tabs.update(3, { active: true });
    await front.restore();

    expect(browser.activeId()).toBe(3);
  });

  it('leaves the provider tab in front when the previous tab was closed', async () => {
    const browser = stubBrowser([tab(1, { url: 'https://mail.test/', active: true }), tab(2)]);

    const front = await bringProviderTabToFront(session);
    browser.tabs.splice(0, 1);
    await front.restore();

    expect(browser.activeId()).toBe(2);
  });

  it('changes nothing when the provider tab already had the front', async () => {
    const browser = stubBrowser([tab(1, { url: 'https://mail.test/' }), tab(2, { active: true })]);

    const front = await bringProviderTabToFront(session);
    await front.restore();

    expect(browser.activeId()).toBe(2);
    expect(browser.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('opens a single provider tab when there is none, and reuses it afterwards', async () => {
    const browser = stubBrowser([tab(1, { url: 'https://mail.test/', active: true })]);

    const first = await bringProviderTabToFront(session);
    await first.restore();
    const second = await bringProviderTabToFront(session);

    expect(browser.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.chrome.tabs.create).toHaveBeenCalledWith({ url: SITE, active: false });
    expect(second.id).toBe(first.id);
    expect(browser.store.providerTabId).toBe(first.id);
  });

  it('prefers the tab we opened over other provider tabs', async () => {
    stubBrowser([tab(1, { active: true, lastAccessed: 99 }), tab(2, { windowId: 2 })], 2);
    expect((await bringProviderTabToFront(session)).id).toBe(2);
  });
});

describe('focusProviderTab', () => {
  it('uses the same preference and does not open another tab', async () => {
    const browser = stubBrowser([tab(1, { lastAccessed: 5 }), tab(2, { lastAccessed: 9 }), tab(3, { url: 'x' })]);

    await focusProviderTab(session);

    expect(browser.chrome.tabs.create).not.toHaveBeenCalled();
    expect(browser.activeId()).toBe(2);
    expect(browser.chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
  });
});
