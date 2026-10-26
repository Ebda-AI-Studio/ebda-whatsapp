import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationDto } from '../../src/core/api/contract';
import { App } from './App';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';

afterEach(cleanup);
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
    await screen.findByRole('button', { name: new RegExp(a.contact.name!) });
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'م' } });
    await waitFor(() => expect(pending.has('م')).toBe(true));
    fireEvent.change(box, { target: { value: 'من' } });
    await waitFor(() => expect(pending.has('من')).toBe(true));
    expect(pending.get('م')!.signal?.aborted).toBe(true);
    await act(async () => pending.get('من')!.resolve([b]));
    await act(async () => pending.get('م')!.resolve([a])); // the stale answer arrives last
    expect(screen.getByRole('button', { name: new RegExp(b.contact.name!) })).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(a.contact.name!) })).toBeNull();
  });

  it('searches from the first character, once per pause in typing (150 ms), not once per keystroke', async () => {
    const { source, all, calls } = await held();
    render(<App source={source} now={now} />);
    await screen.findByRole('button', { name: new RegExp(all[0]!.contact.name!) });
    const box = screen.getByRole('searchbox');
    for (const v of ['ا', 'اح', 'احم']) fireEvent.change(box, { target: { value: v } });
    await waitFor(() => expect(calls).toEqual(['احم']));
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toEqual(['احم']);
  });
});
