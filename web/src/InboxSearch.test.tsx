import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationDto } from '../../src/core/api/contract';
import { App } from './App';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { num } from './i18n';

afterEach(cleanup);
/** The search box's own live line (the page has other status regions, e.g. the wallet banner). */
const statusOf = () => screen.getByRole('combobox').closest('.search-box')!.querySelector('[aria-live="polite"]')!;
const now = () => Date.UTC(2026, 9, 24, 17, 0);

/** A source whose searches answer only when the test says so, recording each query and its abort signal. */
async function held() {
  const base = createSampleSource();
  const all = await base.listConversations('all', '');
  const calls: string[] = [];
  const pending = new Map<string, { resolve: (v: ConversationDto[]) => void; signal?: AbortSignal }>();
  const source: InboxSource = {
    ...base,
    listConversations: (f, q, signal) => {
      if (!q.trim()) return base.listConversations(f, q);
      calls.push(q);
      return new Promise((resolve) => { pending.set(q, { resolve, signal }); });
    },
  };
  return { source, all, calls, pending };
}

describe('inbox search as you type', () => {
  it('an older query that answers last never replaces the newer results, and is aborted', async () => {
    const { source, all, pending } = await held();
    const [a, b] = all as [ConversationDto, ConversationDto];
    render(<App source={source} now={now} />);
    await screen.findByRole('option', { name: new RegExp(a.contact.name!) });
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'م' } });
    await waitFor(() => expect(pending.has('م')).toBe(true));
    fireEvent.change(box, { target: { value: 'من' } });
    await waitFor(() => expect(pending.has('من')).toBe(true));
    expect(pending.get('م')!.signal?.aborted).toBe(true);
    await act(async () => pending.get('من')!.resolve([b]));
    await act(async () => pending.get('م')!.resolve([a])); // the stale answer arrives last
    expect(screen.getByRole('option', { name: new RegExp(b.contact.name!) })).toBeTruthy();
    expect(screen.queryByRole('option', { name: new RegExp(a.contact.name!) })).toBeNull();
  });

  it('searches from the first character, once per pause in typing (150 ms), not once per keystroke', async () => {
    const { source, all, calls } = await held();
    render(<App source={source} now={now} />);
    await screen.findByRole('option', { name: new RegExp(all[0]!.contact.name!) });
    const box = screen.getByRole('combobox');
    for (const v of ['ا', 'اح', 'احم']) fireEvent.change(box, { target: { value: v } });
    await waitFor(() => expect(calls).toEqual(['احم']));
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toEqual(['احم']);
  });

  it('keyboard: arrows, Home, End move the active option; aria-activedescendant follows; Enter opens it; Escape clears the box', async () => {
    const { source, all, pending } = await held();
    render(<App source={source} now={now} />);
    await screen.findByRole('option', { name: new RegExp(all[0]!.contact.name!) });
    const box = screen.getByRole('combobox');
    expect(box.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(box, { target: { value: 'م' } });
    await waitFor(() => expect(pending.has('م')).toBe(true));
    await act(async () => pending.get('م')!.resolve(all));
    expect(box.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(box.getAttribute('aria-controls')).toBe(listbox.id);
    const opts = screen.getAllByRole('option');
    expect(opts.length).toBe(all.length);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    expect(opts[0]!.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(box, { key: 'End' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts.at(-1)!.id);
    fireEvent.keyDown(box, { key: 'Home' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    fireEvent.keyDown(box, { key: 'ArrowUp' }); // wraps to the last
    expect(box.getAttribute('aria-activedescendant')).toBe(opts.at(-1)!.id);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('option', { name: new RegExp(all.at(-1)!.contact.name!) }).getAttribute('aria-current')).toBe('true'));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect((box as HTMLInputElement).value).toBe('');
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('the status line says searching, then the count; and no results; matches are highlighted ignoring Arabic variants', async () => {
    const { source, all, pending } = await held();
    render(<App source={source} now={now} />);
    await screen.findByRole('option', { name: new RegExp(all[0]!.contact.name!) });
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'ا' } });
    await waitFor(() => expect(statusOf().textContent).toBe('بندوّر…'));
    await waitFor(() => expect(pending.has('ا')).toBe(true));
    await act(async () => pending.get('ا')!.resolve(all));
    expect(statusOf().textContent).toBe(`لقينا ${all.length === 2 ? 'نتيجتين' : num(all.length, 'ar') + ' نتايج'}`);
    // an alef query highlights the name's hamza form too (the typed letter is plain alef)
    const marks = [...document.querySelectorAll('.rows mark')].map((m) => m.textContent);
    expect(marks.length).toBeGreaterThan(0);
    fireEvent.change(box, { target: { value: 'ااا' } });
    await waitFor(() => expect(pending.has('ااا')).toBe(true));
    await act(async () => pending.get('ااا')!.resolve([]));
    expect(statusOf().textContent).toBe('مفيش نتايج لـ «ااا»');
  });
});
