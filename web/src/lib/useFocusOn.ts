import { useEffect, useRef } from 'react';

/** Moves focus to the returned element each time `trigger` becomes truthy or changes: after an action removed the focused control, focus lands on its result (give the element tabIndex={-1}). */
export function useFocusOn<T extends HTMLElement>(trigger: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => { if (trigger) ref.current?.focus(); }, [trigger]);
  return ref;
}
