import { Search } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { num, type Lang, type Strings } from '../i18n';

export type SearchStatus = 'idle' | 'loading' | 'done' | 'error';

/** The DOM id of option `i` in the list `listId`: the list items (B2) must use exactly this id so aria-activedescendant resolves. */
export const optionId = (listId: string, i: number) => `${listId}-opt-${i}`;

type Props = {
  t: Strings; lang: Lang;
  /** Accessible name (visually hidden label); also the placeholder unless one is given. */
  label: string; placeholder?: string;
  query: string; onQuery: (q: string) => void;
  status: SearchStatus;
  /** Number of results currently listed under `listId`. */
  count: number;
  /** id of the listbox/list element that shows the results (aria-controls). */
  listId: string;
  /** Controlled by the owner (it also needs the index to style the active row): -1 = none. */
  activeIndex: number; onActiveIndex: (i: number) => void;
  /** Enter on the active option. */
  onPick: (i: number) => void;
};

/**
 * ARIA combobox search box shared by every screen. Keys: ArrowDown/ArrowUp move the active option (wrapping), Home/End jump,
 * Enter picks the active one, Escape clears the query and closes. Focus stays in the input; the active row is announced through
 * aria-activedescendant. A polite live region says searching / no results / result count in the page language.
 */
export function SearchBox({ t, lang, label, placeholder, query, onQuery, status, count, listId, activeIndex, onActiveIndex, onPick }: Props) {
  const open = query.trim() !== '' && count > 0 && status !== 'error';
  const active = open && activeIndex >= 0 && activeIndex < count ? activeIndex : -1;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { onQuery(''); onActiveIndex(-1); return; }
    if (!open) return;
    const move = (i: number) => { e.preventDefault(); onActiveIndex(i); };
    if (e.key === 'ArrowDown') move(active < 0 || active === count - 1 ? 0 : active + 1);
    else if (e.key === 'ArrowUp') move(active <= 0 ? count - 1 : active - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(count - 1);
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); onPick(active); }
  };

  const message = query.trim() === '' ? ''
    : status === 'loading' ? t.searchLoading
    : status === 'error' ? t.searchFailed
    : status === 'done' ? (count === 0 ? t.searchNone(query.trim()) : t.searchCount(count, num(count, lang)))
    : '';

  return (
    <div className="search-box">
      <label className="search">
        <Search size={17} aria-hidden />
        <span className="vh">{label}</span>
        <input
          type="search" dir="auto" role="combobox" value={query} placeholder={placeholder ?? label} autoComplete="off"
          aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={active >= 0 ? optionId(listId, active) : undefined}
          onChange={(e) => { onQuery(e.target.value); onActiveIndex(-1); }} onKeyDown={onKeyDown}
        />
      </label>
      <p className="vh" aria-live="polite" aria-atomic="true">{message}</p>
    </div>
  );
}
