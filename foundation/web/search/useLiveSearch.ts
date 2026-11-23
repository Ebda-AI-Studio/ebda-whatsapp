'use client';

import { useEffect, useRef, useState } from 'react';

export type LiveSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseLiveSearchOptions<T> {
  /** The raw text in the input. */
  query: string;
  /** Runs one search. MUST pass `signal` to its fetch so a superseded request is cancelled. */
  search: (query: string, signal: AbortSignal) => Promise<T[]>;
  /** Wait after the last keystroke. Default 150 ms. */
  debounceMs?: number;
  /** Shortest trimmed query that searches. Default 1: one Arabic letter is a word. */
  minChars?: number;
  /** Longest trimmed query sent. Default 100 (matches the API cap). */
  maxChars?: number;
  /** Master switch (e.g. a picker that is closed). */
  enabled?: boolean;
  /** Bounded per-instance cache of settled queries (0 disables). Default 30. */
  cacheSize?: number;
  /** Anything the `search` function closes over (a filter, a reload tick): when it changes the cache is dropped and the SAME query searches again. */
  refreshKey?: unknown;
}

export interface LiveSearchState<T> {
  status: LiveSearchStatus;
  /** Results for `settledQuery` only. Empty until a response for the CURRENT query lands. */
  results: T[];
  /** The trimmed query the visible results answer (equals the current query when status is ready). */
  settledQuery: string;
}

/**
 * Search-as-you-type core: debounce, abort the superseded request, and only ever expose results that
 * answer the query currently in the box. A slow response for an older query can never replace a
 * newer one (its AbortController is aborted AND its token no longer matches).
 */
export function useLiveSearch<T>({
  query,
  search,
  debounceMs = 150,
  minChars = 1,
  maxChars = 100,
  enabled = true,
  cacheSize = 30,
  refreshKey,
}: UseLiveSearchOptions<T>): LiveSearchState<T> {
  const trimmed = query.trim().slice(0, maxChars);
  const active = enabled && trimmed.length >= minChars;

  const [state, setState] = useState<LiveSearchState<T>>({
    status: 'idle',
    results: [],
    settledQuery: '',
  });
  const searchRef = useRef(search);
  searchRef.current = search;
  const cacheRef = useRef(new Map<string, T[]>());
  const refreshRef = useRef(refreshKey);

  useEffect(() => {
    if (!Object.is(refreshRef.current, refreshKey)) {
      refreshRef.current = refreshKey;
      cacheRef.current.clear();
      setState(idle<T>()); // the visible results answer an older filter: show loading, not them
    }
    if (!active) {
      setState(s => (s.status === 'idle' && s.settledQuery === '' ? s : idle<T>()));
      return;
    }
    const cached = cacheRef.current.get(trimmed);
    if (cached) {
      setState({ status: 'ready', results: cached, settledQuery: trimmed });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const results = await searchRef.current(trimmed, controller.signal);
        if (controller.signal.aborted) return;
        if (cacheSize > 0) {
          const cache = cacheRef.current;
          if (cache.size >= cacheSize) cache.delete(cache.keys().next().value as string);
          cache.set(trimmed, results);
        }
        setState({ status: 'ready', results, settledQuery: trimmed });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: 'error', results: [], settledQuery: trimmed });
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, active, debounceMs, cacheSize, refreshKey]);

  if (!active) return idle<T>();
  // Anything not answering the current query is "loading", never the older results.
  if (state.settledQuery !== trimmed) return { status: 'loading', results: [], settledQuery: '' };
  return state;
}

function idle<T>(): LiveSearchState<T> {
  return { status: 'idle', results: [], settledQuery: '' };
}
