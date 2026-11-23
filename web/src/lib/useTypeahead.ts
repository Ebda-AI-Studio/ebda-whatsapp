import { useRef, useState } from 'react';
import { useLiveSearch } from '../../../foundation/web/search';

/** The one debounce for every search box (plan: 150 ms, shared by the web app). */
export const SEARCH_DEBOUNCE_MS = 150;

export type TypeaheadStatus = 'idle' | 'loading' | 'done' | 'error';

/**
 * Search as you type, on the foundation's `useLiveSearch` (Ruling FDN-SEARCH-1; Store and Chat share one behaviour): starts at `minChars`
 * (default 1), waits `debounceMs` (default 150) after the last keystroke, aborts the previous request, and never shows an answer for a query
 * that is no longer the current one. An empty query is idle with no request. This wrapper only owns the box's text and keeps Chat's status names.
 *
 * `deps`: anything the fetcher closes over that should re-run the SAME query when it changes (a filter, a reload tick). Keep its length constant.
 */
export function useTypeahead<T>(fetcher: (q: string, signal: AbortSignal) => Promise<T[]>, opts: { debounceMs?: number; minChars?: number; deps?: readonly unknown[] } = {}) {
  const { debounceMs = SEARCH_DEBOUNCE_MS, minChars = 1, deps = [] } = opts;
  const [query, setQuery] = useState('');
  // A new `deps` array every render must not re-run the search: only a changed element does.
  const seen = useRef({ deps, gen: 0 });
  if (deps.length !== seen.current.deps.length || deps.some((d, i) => !Object.is(d, seen.current.deps[i]))) seen.current = { deps, gen: seen.current.gen + 1 };
  const live = useLiveSearch<T>({ query, search: fetcher, debounceMs, minChars, cacheSize: 0, refreshKey: seen.current.gen });
  const status: TypeaheadStatus = live.status === 'ready' ? 'done' : live.status;
  return { query, setQuery, results: live.results, status };
}
