'use client';

import { useCallback, useId, useState, type KeyboardEvent } from 'react';

export interface UseListboxNavOptions {
  count: number;
  /** Open state is owned by the caller so it can also close on blur / outside click. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Enter on an active option. Without an active option Enter is left to the form. */
  onPick: (index: number) => void;
}

/**
 * Keyboard + ARIA wiring for the combobox pattern (input keeps focus, options are highlighted via
 * aria-activedescendant). Spread `inputProps` on the input and `listProps` on the popup.
 */
export function useListboxNav({ count, open, setOpen, onPick }: UseListboxNavOptions) {
  const base = useId();
  const listId = `${base}-list`;
  const optionId = (i: number) => `${base}-opt-${i}`;
  const [activeIndex, setActiveIndex] = useState(-1);
  const shown = open && count > 0;
  const active = shown && activeIndex >= 0 && activeIndex < count ? activeIndex : -1;

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!open) setOpen(true);
          if (count > 0) setActiveIndex(i => (i + 1) % count);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!open) setOpen(true);
          if (count > 0) setActiveIndex(i => (i <= 0 ? count - 1 : i - 1));
          break;
        case 'Home':
          if (shown) {
            e.preventDefault();
            setActiveIndex(0);
          }
          break;
        case 'End':
          if (shown) {
            e.preventDefault();
            setActiveIndex(count - 1);
          }
          break;
        case 'Enter':
          if (active >= 0) {
            e.preventDefault();
            onPick(active);
          }
          break;
        case 'Escape':
          if (open) {
            e.preventDefault();
            setOpen(false);
            setActiveIndex(-1);
          }
          break;
        case 'Tab':
          setOpen(false);
          break;
      }
    },
    [count, open, shown, active, setOpen, onPick]
  );

  return {
    activeIndex: active,
    setActiveIndex,
    listId,
    optionId,
    inputProps: {
      role: 'combobox' as const,
      'aria-autocomplete': 'list' as const,
      'aria-haspopup': 'listbox' as const,
      'aria-expanded': shown,
      'aria-controls': listId,
      'aria-activedescendant': active >= 0 ? optionId(active) : undefined,
      autoComplete: 'off',
      onKeyDown,
    },
    listProps: { id: listId, role: 'listbox' as const },
  };
}
