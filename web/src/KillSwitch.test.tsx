import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { STRINGS } from './i18n';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);

describe('W2-META: the owner sees the number\'s health', () => {
  for (const lang of ['ar', 'en'] as const) {
    it(`a non-green number carries a badge and one calm sentence (${lang})`, async () => {
      const t = STRINGS[lang];
      const source = createSampleSource();
      const list = await source.numbers!.list();
      source.numbers!.list = async () => list.map((n, i) => (i === 0 ? { ...n, health: 'yellow' as const } : { ...n, health: 'green' as const }));
      render(<App source={source} now={now} initialLang={lang} />);
      await act(async () => fireEvent.click(screen.getByRole('link', { name: lang === 'ar' ? 'رقم واتساب' : 'WhatsApp number' })));
      const card = await screen.findByRole('article', { name: /\+20 100 555 0101/ });
      expect(within(card).getByText(t.numberHealth.yellow!)).toBeTruthy();
      expect(within(card).getByText(t.numberHealthHelp.yellow!)).toBeTruthy();
      const other = screen.getByRole('article', { name: /\+20 100 555 0202/ });
      expect(within(other).queryByText(t.numberHealth.green!)).toBeNull(); // healthy numbers stay quiet
    });
  }
});

describe('W2-OPS: the kill-switch card', () => {
  const t = STRINGS.ar;
  async function open(source: InboxSource = createSampleSource()) {
    source.role = 'super_admin';
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
    await screen.findByRole('heading', { name: t.opTitle, level: 1 });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opTabs.killswitch! })));
    return source;
  }
  const fill = (ws: string, reason: string) => {
    fireEvent.change(screen.getByLabelText(t.ks.workspace), { target: { value: ws } });
    fireEvent.change(screen.getByLabelText(t.ks.reason), { target: { value: reason } });
  };

  it('needs a workspace and a reason of 5+ characters before it even asks', async () => {
    const source = await open();
    const spy = vi.spyOn(source.operator!, 'killSwitch');
    fill('ws-1', 'no');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.ks.suspend })));
    expect((await screen.findByRole('alert')).textContent).toContain(t.ks.reasonShort);
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks once more, then suspends with the reason and shows the new state', async () => {
    const source = await open();
    const spy = vi.spyOn(source.operator!, 'killSwitch');
    fill('ws-1', 'abuse report 12');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.ks.suspend })));
    expect(spy).not.toHaveBeenCalled(); // a confirmation first
    const ask = screen.getByRole('group', { name: t.ks.confirm(t.ks.suspend) });
    await act(async () => fireEvent.click(within(ask).getByRole('button', { name: t.ks.yes })));
    expect(spy).toHaveBeenCalledWith('ws-1', 'suspend', 'abuse report 12');
    expect(await screen.findByText(t.ks.stateOn)).toBeTruthy();
    expect(screen.getAllByText(t.ks.done).length).toBeGreaterThan(0);
  });

  it('cancelling the confirmation does nothing', async () => {
    const source = await open();
    const spy = vi.spyOn(source.operator!, 'killSwitch');
    fill('ws-1', 'abuse report 12');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.ks.revoke })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.ks.no })));
    expect(spy).not.toHaveBeenCalled();
  });
});
