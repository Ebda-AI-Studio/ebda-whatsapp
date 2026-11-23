import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { markStandalone } from './data/workspaces';
import type { InboxSource } from './data/source';
import { STRINGS, type Lang } from './i18n';
import { stringsFor, withWorkspacePicker } from './i18n-workspace';
import { StoreMenu } from './components/StoreMenu';
import { NoSeat } from './components/NoSeat';

// CHAT-SA-5: a standalone workspace shows inbox, contacts, campaigns, templates, numbers, wallet, agent, bot and nothing that needs a Store; a Store workspace is unchanged.
const mem = new Map<string, string>();
beforeEach(() => vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear() }));
afterEach(() => { cleanup(); mem.clear(); vi.unstubAllGlobals(); });
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const STORE_WORD = /store|متجر|المتجر|متاجر/i;

function standalone(): InboxSource {
  const s = createSampleSource();
  markStandalone(s);
  s.storeId = 'sw_' + 'a'.repeat(26);
  s.stores = [{ id: s.storeId, name: 'مكتب النور', role: 'owner', kind: 'standalone' }];
  return s;
}

const NAV: [keyof typeof STRINGS.ar, string][] = [['tplNav', 'templates'], ['campaigns', 'campaigns'], ['contacts', 'contacts'], ['agent', 'agent'], ['botNav', 'bot'], ['numbersNav', 'numbers'], ['walletNav', 'wallet']];

describe.each<Lang>(['ar', 'en'])('a standalone workspace (%s)', (lang) => {
  it('hides the orders pane and the order strip, and the inbox never asks for orders', async () => {
    const s = standalone();
    const orders = vi.fn(s.orders);
    s.orders = orders;
    const { container } = render(<App source={s} now={now} initialLang={lang} />);
    const t = stringsFor(lang, true);
    await screen.findAllByText(/./, { selector: '.conv-name, .name, h3' }).catch(() => undefined);
    expect(container.querySelector('.orders')).toBeNull();
    expect(screen.queryByLabelText(t.customerOrders)).toBeNull();
    expect(container.querySelector('.app')?.getAttribute('data-nostore')).toBe('on');
    expect(orders).not.toHaveBeenCalled();
    expect(container.querySelector('.order-strip')).toBeNull();
  });

  it('has no Team screen yet (PR-6 turns it on), no catalogue, no product suggestions, no store-only switches, no recommend toggle', async () => {
    const s = standalone();
    expect(s.team).toBeUndefined(); expect(s.catalog).toBeUndefined(); expect(s.proactiveRecs).toBeUndefined();
    const t = stringsFor(lang, true);
    render(<App source={s} now={now} initialLang={lang} />);
    expect(screen.queryByRole('link', { name: t.teamNav })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.botNav })));
    expect(await screen.findByRole('heading', { name: t.thTitle })).toBeTruthy();
    expect(screen.queryByText(t.catTitle)).toBeNull();
    expect(screen.queryByText(t.prTitle)).toBeNull();
    expect(screen.queryByText(t.swTitle)).toBeNull();
    expect(screen.queryByText(t.swOtp)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.agent })));
    await screen.findByLabelText(t.agentFaq);
    expect(screen.queryByText(t.agentRecommend)).toBeNull();
  });

  it('numbers: the checklist has no "link your store" step', async () => {
    const s = standalone();
    const t = stringsFor(lang, true);
    render(<App source={s} now={now} initialLang={lang} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.numbersNav })));
    await screen.findAllByText(t.stepNumber);
    expect(screen.queryByText(/Ebda Store/)).toBeNull();
  });

  it('no visible text on any screen a standalone person opens says store / متجر', async () => {
    const s = standalone();
    const t = stringsFor(lang, true);
    const { container } = render(<App source={s} now={now} initialLang={lang} />);
    const seen: string[] = [];
    const scan = (where: string) => {
      // The fixtures (a contact or a number NAMED "متجر منى") are customer data, not product copy: only element text outside user-data nodes is checked.
      const text = Array.from(container.querySelectorAll('h1,h2,h3,p,small,label,button,a,li,span,legend,th,td'))
        .filter((e) => !e.closest('.conv-list, .list, [data-user-data]') )
        .map((e) => e.textContent ?? '').join('\n');
      seen.push(`${where}: ${text}`);
    };
    for (const [key] of NAV) {
      const link = screen.queryByRole('link', { name: (t as Record<string, unknown>)[key] as string });
      if (!link) continue; // a screen this fixture does not have
      await act(async () => fireEvent.click(link));
      await act(async () => { await Promise.resolve(); });
      scan(String(key));
    }
    expect(seen.length).toBeGreaterThanOrEqual(4); // the walk really visited screens
    // 'متجر منى' is a number's verified business name in the fixture (customer data), not product copy.
    const hits = seen.flatMap((blk) => blk.split('\n').filter((l) => STORE_WORD.test(l) && !/متجر منى/.test(l)).map((l) => `${blk.split(':')[0]} -> ${l.slice(0, 120)}`));
    expect(hits).toEqual([]);
  });

  it('the account menu says workspaces and shows the workspace icon, with another workspace to switch to', () => {
    const s = standalone();
    s.stores = [...s.stores!, { id: 'sw_' + 'b'.repeat(26), name: 'مكتب الفجر', role: 'staff', kind: 'standalone' }];
    const t = stringsFor(lang, true);
    render(<StoreMenu t={t} source={{ stores: s.stores, storeId: s.storeId, standalone: true, switchStore: vi.fn() }} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t.storeMenu) }));
    expect(screen.getByText(t.storeMenuSwitch)).toBeTruthy();
    expect(screen.getByText('مكتب الفجر')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(STORE_WORD);
  });

  it('the no-seat page says workspace', () => {
    render(<NoSeat reason="none" onRetry={vi.fn()} onSignOut={vi.fn()} onSwitch={vi.fn()} standalone />);
    expect(document.body.textContent).not.toMatch(STORE_WORD);
  });
});

describe('every override is a real key and a real string', () => {
  it('stringsFor(standalone) keeps every key of the Store table (nothing missing) and only changes strings', () => {
    for (const lang of ['ar', 'en'] as const) {
      const base = STRINGS[lang]; const sa = stringsFor(lang, true);
      expect(Object.keys(sa).sort()).toEqual(Object.keys(base).sort());
      for (const k of Object.keys(base) as (keyof typeof base)[]) expect(typeof sa[k]).toBe(typeof base[k]);
    }
  });
  it('stringsFor(not standalone) is the shared table itself (the Store UI is byte-identical)', () => {
    expect(stringsFor('ar', false)).toBe(STRINGS.ar);
    expect(stringsFor('en', undefined)).toBe(STRINGS.en);
  });
  it('a Store person who also has a standalone workspace gets workspace wording on the picker only', () => {
    const mixed = { stores: [{ kind: 'store' as const }, { kind: 'standalone' as const }] };
    const t = withWorkspacePicker(STRINGS.ar, 'ar', mixed);
    expect(t.storeMenuSwitch).toBe('غيّر مساحة العمل');
    expect(t.inbox).toBe(STRINGS.ar.inbox);
    expect(t.numbersIntro).toBe(STRINGS.ar.numbersIntro); // still the Store wording
    expect(withWorkspacePicker(STRINGS.ar, 'ar', { stores: [{ kind: 'store' }] })).toBe(STRINGS.ar);
  });
});
