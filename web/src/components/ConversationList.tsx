import { LoadError } from './LoadError';
import { useEffect, useState } from 'react';
import type { ConversationDto } from '../../../src/core/api/contract';
import type { ConversationFilter } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { relativeTime } from '../lib/format';
import { Highlight } from './Highlight';
import { Skeleton } from './Skeleton';
import { SearchBox, optionId, type SearchStatus } from './SearchBox';

type Props = {
  t: Strings; lang: Lang; now: number;
  items: ConversationDto[]; selectedId: number | null; filter: ConversationFilter; query: string; totalUnread: number;
  /** State of the search that produced `items` (idle when the box is empty). */
  searchStatus: SearchStatus;
  /** The plain list's load: only 'ok' may say "no conversations"; loading shows a wait mark and a failed load shows the error with Retry (unknown is never empty). */
  listState?: 'loading' | 'ok' | 'error';
  onRetry?: () => void;
  onFilter: (f: ConversationFilter) => void; onQuery: (q: string) => void; onOpen: (id: number) => void; onToggleLang: () => void;
  /** Calm wallet notices (low balance, debt, marketing paused); empty = nothing to say. */
  notice?: string[]; onOpenWallet?: () => void;
};

const FILTERS: ConversationFilter[] = ['all', 'unread', 'mine', 'unassigned'];

export function initials(name: string | null): string {
  return (name ?? '؟').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
}

const LIST_ID = 'conversation-results';

export function ConversationList({ t, lang, now, items, selectedId, filter, query, totalUnread, searchStatus, listState = 'ok', onRetry, onFilter, onQuery, onOpen, onToggleLang, notice = [], onOpenWallet }: Props) {
  // The keyboard-active row (-1 = none); a new result list starts with none active.
  const [active, setActive] = useState(-1);
  useEffect(() => setActive(-1), [items]);
  useEffect(() => { if (active >= 0) document.getElementById(optionId(LIST_ID, active))?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  return (
    <section className="list-pane" aria-labelledby="list-title">
      <div className="list-head">
        <div className="list-title">
          <h1 id="list-title">{t.conversations}</h1>
          <span className="list-meta">
            {totalUnread > 0 && <span className="muted">{t.unreadCount(num(totalUnread, lang))}</span>}
            <button type="button" className="lang-btn" onClick={onToggleLang} lang={lang === 'ar' ? 'en' : 'ar'}>{t.language}</button>
          </span>
        </div>
        <div className="chips" role="group" aria-label={t.conversations}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => onFilter(f)}>{t[f]}</button>
          ))}
        </div>
        <SearchBox t={t} lang={lang} label={t.search} query={query} onQuery={onQuery} status={searchStatus} count={items.length} listId={LIST_ID} activeIndex={active} onActiveIndex={setActive} onPick={(i) => { const c = items[i]; if (c) onOpen(c.id); }} />
      </div>
      {notice.length > 0 && (
        <div className="wallet-banner" data-banner="wallet" role="status">
          <span>{notice.map((line) => <span key={line} className="wallet-banner-line">{line}</span>)}</span>
          <a href="#wallet" onClick={(e) => { e.preventDefault(); onOpenWallet?.(); }}>{t.wBannerLink}</a>
        </div>
      )}
      <ul className="rows" id={LIST_ID} role="listbox" aria-label={t.conversations}>
        {items.length === 0 && (query.trim() !== ''
          ? searchStatus === 'done' && <li className="empty" role="presentation">{t.noResults}</li> // while searching, the search box above says loading / failed
          : listState === 'ok' ? <li className="empty" role="presentation">{t.noResults}</li>
          : listState === 'loading' ? <li role="presentation"><Skeleton t={t} rows={4} /></li>
          : <li role="presentation"><LoadError t={t} text={t.loadError} onRetry={() => onRetry?.()} /></li>)}
        {items.map((c, i) => (
          <li key={c.id} role="presentation">
            <button type="button" role="option" id={optionId(LIST_ID, i)} className="row" aria-selected={i === active} data-active={i === active} aria-current={c.id === selectedId} onClick={() => onOpen(c.id)}>
              <span className="avatar" data-selected={c.id === selectedId} aria-hidden>{initials(c.contact.name)}{c.tags.includes('cod_pending') && c.id !== selectedId && <span className="lit" title={t.codPending} />}</span>
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name" dir="auto"><Highlight text={c.contact.name ?? `+${c.contact.waId}`} query={query} /></span>
                  {c.lastMessage && <span className="muted">{relativeTime(c.lastMessage.at, now, lang)}</span>}
                </span>
                <span className="row-bottom">
                  <span className="row-preview" dir="auto"><Highlight text={c.lastMessage?.preview ?? ''} query={query} /></span>
                  {c.tags.includes('needs_human') && <span className="human-chip">{t.needsHuman}</span>}
                  {c.unread > 0 && <span className="pill">{num(c.unread, lang)}<span className="vh"> {t.unread}</span></span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
