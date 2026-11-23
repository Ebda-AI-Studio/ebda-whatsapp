import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND } from '@brand';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { makeAccountsSignOut } from './signout';
import { STRINGS } from './i18n';

// CH1: a store with no Chat workspace is its own state (no retry banners, no empty inbox). CH2: store picker + active store name + sign-out in the shell.
const store = new Map<string, string>();
beforeEach(() => vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() }));
afterEach(() => { cleanup(); store.clear(); vi.unstubAllGlobals(); });
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;
const gone = () => Promise.reject(Object.assign(new Error('not_found'), { status: 404 }));
const STORES = [{ id: 'store-a', name: 'متجر الورد', role: 'owner' as const }, { id: 'store-b', name: 'متجر الشاي', role: 'staff' as const }];

describe('a store with no Chat workspace', () => {
  function noWorkspace() {
    const source = createSampleSource();
    source.storeId = 'store-x';
    source.workspaceMissing = true;
    source.stores = STORES;
    const list = vi.fn(gone); const templates = vi.fn(gone);
    source.listConversations = list as never; source.templates = templates as never;
    return { source, list, templates };
  }

  it('says Chat is not enabled for the store, offers the plan page, and shows neither retry banners nor the empty inbox', async () => {
    const { source, list, templates } = noWorkspace();
    render(<App source={source} now={now} />);
    expect(await screen.findByText(t.noWsTitle(BRAND.productNameAr ?? BRAND.productName))).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(t.noResults)).toBeNull();
    expect(screen.queryByText(t.loadError)).toBeNull();
    expect(screen.queryByText(t.dataLoadError)).toBeNull();
    const cta = screen.getByRole('link', { name: /فعّل/ });
    expect(cta.getAttribute('href')).toBe('https://store.ebda.app/stores/store-x/settings');
    expect(list).not.toHaveBeenCalled(); // nothing is fetched for a store that has nothing to fetch
    expect(templates).not.toHaveBeenCalled();
  });

  it('still lets the person pick another store and sign out', async () => {
    const { source } = noWorkspace();
    source.switchStore = vi.fn(); source.signOut = vi.fn();
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: new RegExp(t.storeMenu) })));
    const menu = screen.getByRole('dialog', { name: t.storeMenu });
    await act(async () => fireEvent.click(within(menu).getByRole('button', { name: 'متجر الشاي' })));
    expect(source.switchStore).toHaveBeenCalledWith('store-b');
    await act(async () => fireEvent.click(within(menu).getByRole('button', { name: t.signOut })));
    expect(source.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('the inbox list never renders an unknown as empty', () => {
  it('a list that fails shows the error with Retry (not "no conversations"); Retry loads it', async () => {
    const source = createSampleSource();
    const real = source.listConversations.bind(source);
    source.listConversations = vi.fn(real).mockImplementationOnce(() => Promise.reject(new Error('500'))) as never;
    render(<App source={source} now={now} />);
    const list = await screen.findByRole('listbox', { name: t.conversations });
    const alert = await within(list).findByRole('alert');
    expect(screen.queryByText(t.noResults)).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1); // one error, not a banner plus a list error
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await screen.findByText('منى عبد الرحمن')).toBeTruthy();
  });

  it('before the first answer the list is loading, not empty', async () => {
    const source = createSampleSource();
    source.listConversations = (() => new Promise(() => undefined)) as never;
    render(<App source={source} now={now} />);
    expect(screen.queryByText(t.noResults)).toBeNull();
  });
});

describe('the store switcher and account menu', () => {
  it('shows the active store name, lists the other stores, switches, and signs out', async () => {
    const source = createSampleSource();
    source.storeId = 'store-a'; source.stores = STORES; source.switchStore = vi.fn(); source.signOut = vi.fn();
    render(<App source={source} now={now} />);
    const trigger = screen.getByRole('button', { name: new RegExp(t.storeMenu) });
    expect(trigger.textContent).toContain('متجر الورد');
    await act(async () => fireEvent.click(trigger));
    const menu = screen.getByRole('dialog', { name: t.storeMenu });
    expect(within(menu).getByText('متجر الورد')).toBeTruthy(); // the active one is named, and is not offered as a target
    expect(within(menu).queryByRole('button', { name: 'متجر الورد' })).toBeNull();
    await act(async () => fireEvent.click(within(menu).getByRole('button', { name: 'متجر الشاي' })));
    expect(source.switchStore).toHaveBeenCalledWith('store-b');
    await act(async () => fireEvent.click(within(menu).getByRole('button', { name: t.signOut })));
    expect(source.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('sign-out on the shared accounts service', () => {
  it('stops the socket, posts /logout with the cookie, then reloads (even when the call fails)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const stop = vi.fn(); const reload = vi.fn();
    const done = new Promise<void>((r) => reload.mockImplementation(() => r()));
    makeAccountsSignOut({ stopRealtime: stop, accountsUrl: 'https://accounts.example', getToken: async () => 'tok', fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); throw new Error('network'); }) as never, reload })();
    await done;
    expect(stop).toHaveBeenCalled();
    expect(calls[0]!.url).toBe('https://accounts.example/logout');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.credentials).toBe('include');
  });
});

describe('other lists: a failed read is an error, never the empty copy', () => {
  it('operator shared-number asks that fail to load say so with Retry (not "no asks")', async () => {
    const source = createSampleSource();
    source.role = 'super_admin';
    const real = source.sharedTemplates!.requests!.bind(source.sharedTemplates);
    source.sharedTemplates!.requests = vi.fn(real).mockImplementationOnce(() => Promise.reject(new Error('500'))) as never;
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: t.opTabs.shared! })));
    const card = await screen.findByRole('region', { name: t.opSharedRequestsTitle });
    expect(within(card).queryByText(t.opSharedRequestsEmpty)).toBeNull();
    const alert = await within(card).findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  it('wallet credit packs that fail to load show an error with Retry instead of vanishing', async () => {
    const source = createSampleSource();
    const real = source.wallet!.creditPacks.bind(source.wallet);
    source.wallet!.creditPacks = vi.fn(real).mockImplementationOnce(() => Promise.reject(new Error('500'))) as never;
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
    const card = await screen.findByRole('region', { name: t.wCrTitle });
    const alert = await within(card).findByRole('alert');
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(within(card).queryByText(t.wCrOff)).toBeNull();
  });
});
