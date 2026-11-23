import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactsScreen } from './components/ContactsScreen';
import { createSampleSource } from './data/sample';
import type { ContactsApi } from './data/source';
import { STRINGS } from './i18n';
import { contactsCsv } from './lib/contacts-csv';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const t = STRINGS.ar;
const now = () => Date.UTC(2026, 9, 24, 17, 0);

function open(role: 'owner' | 'staff', patch: Partial<ContactsApi> = {}) {
  const base = createSampleSource().contacts!;
  const api: ContactsApi = { ...base, ...patch };
  const source = { ...createSampleSource(), contacts: api, role };
  render(<ContactsScreen t={t} lang="ar" source={source} api={api} now={now} />);
  return api;
}

describe('contacts CSV', () => {
  it('writes one row per contact with consent and tags, Arabic-safe (BOM), CRLF, and defuses spreadsheet formulas in names', () => {
    const csv = contactsCsv([
      { waId: '201001234567', name: 'سارة, محمود', optedOut: false, tags: ['vip', 'gold'], consent: { source: 'keyword_start', at: Date.UTC(2026, 0, 2) }, lastInboundAt: Date.UTC(2026, 5, 1) } as never,
      { waId: '201007654321', name: '=HYPERLINK("http://x","y")', optedOut: true, tags: [], consent: null } as never,
    ]);
    expect(csv.startsWith('﻿phone,name,opted_out,')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[1]).toBe('+201001234567,"سارة, محمود",no,keyword_start,2026-01-02T00:00:00.000Z,vip;gold,2026-06-01T00:00:00.000Z');
    expect(lines[2]).toBe(`+201007654321,"'=HYPERLINK(""http://x"",""y"")",yes,,,,`);
  });
});

describe('the Contacts screen export card', () => {
  it('owner: one click fetches every contact and downloads a CSV, then says how many', async () => {
    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const api = open('owner');
    const spy = vi.spyOn(api, 'exportAllContacts');
    const card = await screen.findByRole('region', { name: t.cxTitle });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.cxButton })));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await within(card).findByText(t.cxDone((await spy.mock.results[0]!.value).length))).toBeTruthy();
  });

  it('a failed export is one plain message and no file', async () => {
    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    open('owner', { exportAllContacts: vi.fn().mockRejectedValue(new Error('403')) });
    const card = await screen.findByRole('region', { name: t.cxTitle });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.cxButton })));
    expect((await within(card).findByRole('alert')).textContent).toContain(t.cxFailed);
    expect(create).not.toHaveBeenCalled();
  });

  it('staff do not see it', async () => {
    open('staff');
    await screen.findByRole('region', { name: t.cdTitle });
    expect(screen.queryByRole('region', { name: t.cxTitle })).toBeNull();
  });
});
