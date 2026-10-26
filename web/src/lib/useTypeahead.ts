import { useEffect, useRef, useState } from 'react';

/** The one debounce for every search box (plan: 150 ms, shared by the web app). */
export const SEARCH_DEBOUNCE_MS = 150;

export type TypeaheadStatus = 'idle' | 'loading' | 'done' | 'error';

/**
 * Search as you type: starts at `minChars` (default 1), waits `debounceMs` (default 150) after the last keystroke, aborts the previous
 * request, and drops any answer (or error) that arrives for a query that is no longer the current one. An empty query is idle with no request.
 */
export function useTypeahead<T>(fetcher: (q: string, signal: AbortSignal) => Promise<T[]>, opts: { debounceMs?: number; minChars?: number } = {}) {
  const { debounceMs = SEARCH_DEBOUNCE_MS, minChars = 1 } = opts;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<T[]>([]);
  const [status, setStatus] = useState<TypeaheadStatus>('idle');
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < minChars) { setResults([]); setStatus('idle'); return; }
    const controller = new AbortController();
    // Set before the debounce: while the user is still typing the old results are not shown as if they answered this query.
    setStatus('loading');
    const timer = setTimeout(() => {
      fetcherRef.current(trimmed, controller.signal).then(
        (rows) => { if (controller.signal.aborted) return; setResults(rows); setStatus('done'); },
        () => { if (controller.signal.aborted) return; setResults([]); setStatus('error'); },
      );
    }, debounceMs);
    // Cleanup runs when the query changes (and on unmount): aborting here is what makes every older answer land on a dead signal.
    return () => { clearTimeout(timer); controller.abort(); };
  }, [trimmed, debounceMs, minChars]);

  return { query, setQuery, results, status };
}
