import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Loads once and again on demand. A failed load is `error` (unknown), never an empty list: screens render an error with Retry.
 * Once data has arrived a later failed refresh keeps the last data on screen instead of blanking it.
 */
export function useLoad<T>(load: () => Promise<T>): { data: T | null; setData: Dispatch<SetStateAction<T | null>>; error: boolean; reload: () => void } {
  const [data, setState] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    setFailed(false);
    load().then((x) => { setState(x); }, () => setFailed(true));
  }, [load]);
  useEffect(reload, [reload]);
  return { data, setData: setState, error: failed && data === null, reload };
}
