import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SEARCH_DEBOUNCE_MS, useTypeahead } from './useTypeahead';

afterEach(cleanup);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fetcher whose calls answer only when the test says so; records each query and its abort signal. */
function held() {
  const calls: string[] = [];
  const pending = new Map<string, { resolve: (v: string[]) => void; reject: (e: unknown) => void; signal: AbortSignal }>();
  const fetcher = (q: string, signal: AbortSignal) => {
    calls.push(q);
    return new Promise<string[]>((resolve, reject) => { pending.set(q, { resolve, reject, signal }); });
  };
  return { fetcher, calls, pending };
}

describe('useTypeahead', () => {
  it('debounce is 150 ms', () => { expect(SEARCH_DEBOUNCE_MS).toBe(150); });

  it('an older query answering last never shows up, and its signal is aborted', async () => {
    const { fetcher, pending } = held();
    const { result } = renderHook(() => useTypeahead(fetcher, { debounceMs: 5 }));
    act(() => result.current.setQuery('م'));
    await waitFor(() => expect(pending.has('م')).toBe(true));
    act(() => result.current.setQuery('من'));
    await waitFor(() => expect(pending.has('من')).toBe(true));
    expect(pending.get('م')!.signal.aborted).toBe(true);
    expect(pending.get('من')!.signal.aborted).toBe(false);
    await act(async () => pending.get('من')!.resolve(['new']));
    await act(async () => pending.get('م')!.resolve(['stale'])); // the stale answer arrives last
    expect(result.current.results).toEqual(['new']);
    expect(result.current.status).toBe('done');
  });

  it('an error from a stale request is ignored', async () => {
    const { fetcher, pending } = held();
    const { result } = renderHook(() => useTypeahead(fetcher, { debounceMs: 5 }));
    act(() => result.current.setQuery('a'));
    await waitFor(() => expect(pending.has('a')).toBe(true));
    act(() => result.current.setQuery('ab'));
    await waitFor(() => expect(pending.has('ab')).toBe(true));
    await act(async () => pending.get('ab')!.resolve(['ok']));
    await act(async () => pending.get('a')!.reject(new Error('boom')));
    expect(result.current.status).toBe('done');
    expect(result.current.results).toEqual(['ok']);
  });

  it('an error from the current request sets status error and clears results', async () => {
    const { fetcher, pending } = held();
    const { result } = renderHook(() => useTypeahead(fetcher, { debounceMs: 5 }));
    act(() => result.current.setQuery('a'));
    await waitFor(() => expect(pending.has('a')).toBe(true));
    expect(result.current.status).toBe('loading');
    await act(async () => pending.get('a')!.reject(new Error('boom')));
    expect(result.current.status).toBe('error');
    expect(result.current.results).toEqual([]);
  });

  it('one request per pause (150 ms), from the first character', async () => {
    const { fetcher, calls } = held();
    const { result } = renderHook(() => useTypeahead(fetcher));
    for (const v of ['ا', 'اح', 'احم']) act(() => result.current.setQuery(v));
    await waitFor(() => expect(calls).toEqual(['احم']));
    await sleep(250);
    expect(calls).toEqual(['احم']);
  });

  it('empty or blank query makes no request, goes idle, aborts the in-flight one', async () => {
    const { fetcher, calls, pending } = held();
    const { result } = renderHook(() => useTypeahead(fetcher, { debounceMs: 5 }));
    act(() => result.current.setQuery('a'));
    await waitFor(() => expect(pending.has('a')).toBe(true));
    act(() => result.current.setQuery(''));
    expect(result.current.status).toBe('idle');
    expect(pending.get('a')!.signal.aborted).toBe(true);
    await act(async () => pending.get('a')!.resolve(['late']));
    expect(result.current.results).toEqual([]);
    act(() => result.current.setQuery('   '));
    await sleep(30);
    expect(calls).toEqual(['a']);
    expect(result.current.status).toBe('idle');
  });

  it('minChars holds the request back', async () => {
    const { fetcher, calls } = held();
    const { result } = renderHook(() => useTypeahead(fetcher, { debounceMs: 5, minChars: 2 }));
    act(() => result.current.setQuery('a'));
    await sleep(40);
    expect(calls).toEqual([]);
    expect(result.current.status).toBe('idle');
  });

  it('aborts the in-flight request on unmount', async () => {
    const { fetcher, pending } = held();
    const { result, unmount } = renderHook(() => useTypeahead(fetcher, { debounceMs: 5 }));
    act(() => result.current.setQuery('a'));
    await waitFor(() => expect(pending.has('a')).toBe(true));
    unmount();
    expect(pending.get('a')!.signal.aborted).toBe(true);
  });
});
