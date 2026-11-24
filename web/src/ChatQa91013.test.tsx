import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';
import { ROUTE_SCOPES, WHATSAPP_SCOPES } from '../../src/core/identity/scopes';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;
const down = () => Promise.reject(new Error('network'));

describe('CHAT-QA-9: a broken Customers page is one banner with disabled controls', () => {
  it('list, imports, segments and retention all failing give exactly ONE alert; Retry reloads them all and clears it', async () => {
    const source = createSampleSource();
    const c = source.contacts!;
    const real = { list: c.list, imports: c.imports, retention: c.retention, seg: c.segments!.list };
    let broken = true;
    c.list = vi.fn((...a: Parameters<typeof real.list>) => (broken ? down() : real.list(...a)));
    c.imports = vi.fn(() => (broken ? down() : real.imports()));
    c.retention = vi.fn(() => (broken ? down() : real.retention()));
    c.segments!.list = vi.fn(() => (broken ? down() : real.seg()));
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.contacts })));
    await screen.findByRole('heading', { name: t.contactsTitle, level: 1 });
    const alert = await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect((screen.getByRole('button', { name: t.rtSave }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(t.chooseFile) as HTMLInputElement).disabled).toBe(true); // the start button is disabled with no file anyway: the file input is the real proof
    broken = false;
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: t.retry })));
    expect(await screen.findByText('نورا حسن')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('CHAT-QA-13: human permission names and a brand-styled help link', () => {
  it('every API scope the server knows has a plain label in both languages (the scope list is the checklist)', () => {
    for (const lang of ['ar', 'en'] as const) {
      for (const s of WHATSAPP_SCOPES) expect(STRINGS[lang].apiScopeLabels[s], `${lang} ${s}`).toBeTruthy();
      expect(Object.keys(STRINGS[lang].apiScopeLabels).sort()).toEqual([...WHATSAPP_SCOPES].sort());
    }
  });

  it('no scope can ship raw: every scope a route gate names is in the catalogue, the catalogue is the Store accounts list (apps/accounts/src/client-scopes.ts), and no label is the id or looks like one', () => {
    const gates = new Set(Object.values(ROUTE_SCOPES).filter((g) => g !== 'any' && g !== 'person_only'));
    for (const g of gates) expect((WHATSAPP_SCOPES as readonly string[]).includes(g), `gate scope ${g} is not in WHATSAPP_SCOPES`).toBe(true);
    expect([...WHATSAPP_SCOPES]).toEqual(['conversations:read', 'messages:send', 'templates:read', 'contacts:read', 'contacts:write', 'campaigns:read']); // same list the Store issues (change both together)
    for (const lang of ['ar', 'en'] as const) {
      for (const s of WHATSAPP_SCOPES) {
        const label = STRINGS[lang].apiScopeLabels[s]!;
        expect(label.trim().length, `${lang} ${s}`).toBeGreaterThan(3);
        expect(label, `${lang} ${s}`).not.toBe(s);
        expect(label, `${lang} ${s}`).not.toMatch(/[a-z]+:[a-z]+/);
      }
    }
  });

  it('the Connect systems screen shows the labels, never the raw scope ids, and a brand help link', async () => {
    render(<App source={createSampleSource()} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.intNav })));
    await screen.findByRole('heading', { name: t.intTitle });
    const body = document.body.textContent ?? '';
    for (const s of WHATSAPP_SCOPES) { expect(body).not.toContain(s); expect(body).toContain(t.apiScopeLabels[s]!); }
    const help = screen.getAllByRole('link', { name: t.howTo }).find((a) => (a as HTMLAnchorElement).href.includes('connect-your-systems'))!;
    expect(help.className).toBe('help-link');
    expect((help as HTMLAnchorElement).href).toContain('help.ebda.app');
  });

  it('the Team and Numbers help links (.howto) get the same brand brass', async () => {
    render(<App source={createSampleSource()} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.teamNav })));
    await screen.findByRole('heading', { name: t.teamTitle, level: 1 });
    expect(screen.getAllByRole('link', { name: t.howTo }).every((a) => a.className === 'howto')).toBe(true);
  });
});
