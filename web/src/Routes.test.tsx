import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';
import { dateTime } from './components/CampaignsScreen';
import { parsePath } from './lib/route';

afterEach(cleanup);
const NOW = Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;
const ownerApp = (role: 'super_admin' | 'owner' = 'super_admin') => { const source = createSampleSource(); source.role = role; return render(<App source={source} now={() => NOW} />); };
const click = async (name: string) => act(async () => fireEvent.click(screen.getByRole('link', { name })));

describe('shell routes', () => {
  it('navigating changes the URL and the tab title follows the screen', async () => {
    ownerApp();
    expect(location.pathname).toBe('/');
    await click(t.opNav);
    expect(location.pathname).toBe('/ops');
    expect(document.title).toContain(t.opNav);
    await click(t.walletNav);
    expect(location.pathname).toBe('/wallet');
    expect(document.title).toContain(t.walletNav);
  });

  it('a refresh / deep link restores the screen', async () => {
    history.replaceState(null, '', '/ops');
    ownerApp();
    expect(await screen.findByRole('heading', { name: t.opTitle, level: 1 })).toBeTruthy();
    expect(document.title).toContain(t.opNav);
  });

  it('the back button returns to the previous screen', async () => {
    ownerApp();
    await click(t.opNav);
    await screen.findByRole('heading', { name: t.opTitle, level: 1 });
    await act(async () => { history.back(); await new Promise((r) => setTimeout(r, 30)); });
    expect(location.pathname).toBe('/');
    expect(screen.queryByRole('heading', { name: t.opTitle, level: 1 })).toBeNull();
    expect(screen.getByRole('listbox', { name: t.conversations ?? 'المحادثات' })).toBeTruthy();
  });

  it('an unknown path shows a not-found state with a way back', async () => {
    history.replaceState(null, '', '/nope');
    ownerApp();
    expect(screen.getByText(t.nfTitle, { selector: '.state-title' })).toBeTruthy();
    expect(document.title).toContain(t.nfTitle);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.nfBack })));
    expect(location.pathname).toBe('/');
  });

  it('opening a conversation puts its id in the address, and a deep link to it opens it', async () => {
    const first = ownerApp('owner');
    const target = await screen.findByRole('option', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const m = /^\/chat\/(\d+)$/.exec(location.pathname);
    expect(m).toBeTruthy();
    first.unmount();
    ownerApp('owner');
    expect(await screen.findByRole('log')).toBeTruthy();
    expect(parsePath(location.pathname)).toMatchObject({ kind: 'view', view: 'inbox', chatId: Number(m![1]) });
  });
});

describe('unknown is not a value', () => {
  it('a 0 / null / NaN time renders a dash, never 1 January 1970', () => {
    for (const bad of [0, null, undefined, Number.NaN, -1]) expect(dateTime(bad as number, 'ar')).toBe('—');
    expect(dateTime(NOW, 'en')).not.toBe('—');
  });
});
