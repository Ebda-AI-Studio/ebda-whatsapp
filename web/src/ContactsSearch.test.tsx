import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContactDto } from '../../src/core/api/contract';
import { ContactsScreen } from './components/ContactsScreen';
import { createSampleSource } from './data/sample';
import type { ContactsApi } from './data/source';
import { STRINGS } from './i18n';

afterEach(cleanup);
/** The search box's own live line (the page has other status regions, e.g. the wallet banner). */
const statusOf = () => screen.getByRole('combobox').closest('.search-box')!.querySelector('[aria-live="polite"]')!;
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const c = (waId: string, name: string): ContactDto => ({ waId, name, tags: [], optedOut: false, consent: null, lastInboundAt: null } as unknown as ContactDto);
const ALL = [c('201001110001', 'أحمد علي'), c('201001110002', 'منى سعيد'), c('201001110003', 'فاطمة محمد')];

/** A contacts API whose searches answer only when the test says so, recording each query and its abort signal. */
function held() {
  const base = createSampleSource().contacts!;
  const calls: string[] = [];
  const pending = new Map<string, { resolve: (v: ContactDto[]) => void; signal?: AbortSignal }>();
  const api: ContactsApi = {
    ...base,
    list: (q, signal) => {
      if (!q.q?.trim()) return Promise.resolve({ items: ALL, nextCursor: null });
      calls.push(q.q);
      return new Promise((resolve) => { pending.set(q.q!, { resolve: (items) => resolve({ items, nextCursor: null }), signal }); });
    },
  };
  return { api, calls, pending };
}
const renderScreen = (api: ContactsApi) => {
  const source = { ...createSampleSource(), contacts: api, role: 'staff' as const };
  return render(<ContactsScreen t={STRINGS.ar} lang="ar" source={source} api={api} now={now} />);
};

describe('contacts search as you type', () => {
  it('an older query that answers last never replaces the newer results, and is aborted', async () => {
    const { api, pending } = held();
    renderScreen(api);
    await screen.findByText('أحمد علي');
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'م' } });
    await waitFor(() => expect(pending.has('م')).toBe(true));
    fireEvent.change(box, { target: { value: 'من' } });
    await waitFor(() => expect(pending.has('من')).toBe(true));
    expect(pending.get('م')!.signal?.aborted).toBe(true);
    await act(async () => pending.get('من')!.resolve([ALL[1]!]));
    await act(async () => pending.get('م')!.resolve([ALL[0]!])); // the stale answer arrives last
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option').textContent).toContain('منى سعيد');
    expect(screen.queryByText('أحمد علي')).toBeNull();
  });

  it('searches from the first character with the shared 150 ms pause, once per pause', async () => {
    const { api, calls } = held();
    renderScreen(api);
    await screen.findByText('أحمد علي');
    const box = screen.getByRole('combobox');
    for (const v of ['ا', 'اح', 'احم']) fireEvent.change(box, { target: { value: v } });
    await waitFor(() => expect(calls).toEqual(['احم']));
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toEqual(['احم']);
  });

  it('rows are options with ids; arrows/Home/End move the active one and aria-activedescendant follows', async () => {
    const { api, pending } = held();
    renderScreen(api);
    await screen.findByText('أحمد علي');
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'ا' } });
    await waitFor(() => expect(pending.has('ا')).toBe(true));
    await act(async () => pending.get('ا')!.resolve(ALL));
    const listbox = screen.getByRole('listbox');
    expect(box.getAttribute('aria-controls')).toBe(listbox.id);
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(3);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    expect(opts[0]!.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[1]!.id);
    fireEvent.keyDown(box, { key: 'End' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[2]!.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // wraps
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    fireEvent.keyDown(box, { key: 'Home' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect((box as HTMLInputElement).value).toBe('');
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('status line and highlight: searching, count, no results; أ/ا and ة/ه variants are highlighted in the stored form', async () => {
    const { api, pending } = held();
    renderScreen(api);
    await screen.findByText('أحمد علي');
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'فاطمه' } });
    await waitFor(() => expect(statusOf().textContent).toBe('بندوّر…'));
    await waitFor(() => expect(pending.has('فاطمه')).toBe(true));
    await act(async () => pending.get('فاطمه')!.resolve([ALL[2]!]));
    expect(statusOf().textContent).toBe('لقينا نتيجة واحدة');
    expect([...document.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['فاطمة']);
    fireEvent.change(box, { target: { value: 'ااا' } });
    await waitFor(() => expect(pending.has('ااا')).toBe(true));
    await act(async () => pending.get('ااا')!.resolve([]));
    expect(statusOf().textContent).toBe('مفيش نتايج لـ «ااا»');
  });
});
