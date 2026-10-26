import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { STRINGS } from './i18n';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 25, 12, 0);

async function open(source: InboxSource = createSampleSource(), lang: 'ar' | 'en' = 'ar') {
  const t = STRINGS[lang];
  source.role = 'super_admin';
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: STRINGS.ar.opNav })));
  await screen.findByRole('heading', { name: STRINGS.ar.opTitle, level: 1 });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: STRINGS.ar.opTabs.shared! })));
  return { source, t };
}
const t = STRINGS.ar;

describe('operator: shared number templates', () => {
  it('the tab exists in both languages and is offered only when the source has the shared-template API', async () => {
    expect(STRINGS.ar.opTabs.shared).toBeTruthy();
    expect(STRINGS.en.opTabs.shared).toBe('Shared number templates');
    const source = createSampleSource();
    delete source.sharedTemplates;
    source.role = 'super_admin';
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
    expect(screen.queryByRole('button', { name: t.opTabs.shared! })).toBeNull();
  });

  it('lists the catalog and says which templates stores can use: approved utility or authentication only', async () => {
    await open();
    const list = await screen.findByRole('region', { name: t.opSharedTitle });
    const rows = within(list).getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const byName = (n: string) => rows.find((r) => r.textContent!.includes(n))!;
    expect(within(byName('order_update')).getByText(t.opSharedUsable)).toBeTruthy();
    expect(within(byName('weekend_offer')).getByText(t.opSharedBlocked)).toBeTruthy(); // marketing: never from the shared number
    expect(within(byName('pending_utility')).getByText(t.opSharedBlocked)).toBeTruthy(); // not approved yet
  });

  it('sync asks Meta through the API, reports the counts and reloads the list', async () => {
    const { source } = await open();
    const sync = vi.spyOn(source.sharedTemplates!, 'sync');
    const list = vi.spyOn(source.sharedTemplates!, 'list');
    await screen.findByRole('region', { name: t.opSharedTitle });
    const before = list.mock.calls.length;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opSharedSync })));
    expect(sync).toHaveBeenCalledTimes(1);
    expect(list.mock.calls.length).toBeGreaterThan(before);
    expect((await screen.findByRole('status')).textContent).toContain(t.opSharedSynced('3', '0'));
  });

  it('submit sends a BODY component for a utility or authentication template; marketing is not offered; a bad name never reaches the API', async () => {
    const { source } = await open();
    const submit = vi.spyOn(source.sharedTemplates!, 'submit');
    await screen.findByRole('region', { name: t.opSharedTitle });
    const category = screen.getByLabelText(t.opSharedCategory) as HTMLSelectElement;
    expect([...category.options].map((o) => o.value)).toEqual(['UTILITY', 'AUTHENTICATION']);
    fireEvent.change(screen.getByLabelText(t.opSharedName), { target: { value: 'Bad Name!' } });
    fireEvent.change(screen.getByLabelText(t.opSharedBody), { target: { value: 'طلبك {{1}} جاهز' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opSharedSubmit })));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(t.opSharedBadName);
    fireEvent.change(screen.getByLabelText(t.opSharedName), { target: { value: 'order_ready' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opSharedSubmit })));
    expect(submit).toHaveBeenCalledWith({ name: 'order_ready', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'طلبك {{1}} جاهز' }] });
  });

  it('with no platform number (or the switch off) the server answers 404 and the panel says so instead of showing an empty table', async () => {
    const source = createSampleSource();
    source.sharedTemplates!.list = async () => { throw new ApiError('not_found', 404); };
    await open(source);
    expect((await screen.findByRole('alert')).textContent).toContain(t.opSharedUnavailable);
  });
});
