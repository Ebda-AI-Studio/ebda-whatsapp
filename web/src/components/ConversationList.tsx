import { Search } from 'lucide-react';
import type { ConversationDto } from '../../../src/core/api/contract';
import type { ConversationFilter } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { relativeTime } from '../lib/format';

type Props = {
  t: Strings; lang: Lang; now: number;
  items: ConversationDto[]; selectedId: number | null; filter: ConversationFilter; query: string; totalUnread: number;
  onFilter: (f: ConversationFilter) => void; onQuery: (q: string) => void; onOpen: (id: number) => void;
};

const FILTERS: ConversationFilter[] = ['all', 'unread', 'mine', 'unassigned'];

export function initials(name: string | null): string {
  return (name ?? '؟').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
}

export function ConversationList({ t, lang, now, items, selectedId, filter, query, totalUnread, onFilter, onQuery, onOpen }: Props) {
  return (
    <section className="list-pane" aria-labelledby="list-title">
      <div className="list-head">
        <div className="list-title">
          <h1 id="list-title">{t.conversations}</h1>
          {totalUnread > 0 && <span className="muted">{t.unreadCount(num(totalUnread, lang))}</span>}
        </div>
        <div className="chips" role="group" aria-label={t.conversations}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => onFilter(f)}>{t[f]}</button>
          ))}
        </div>
        <label className="search">
          <Search size={17} aria-hidden />
          <span className="vh">{t.search}</span>
          <input type="search" placeholder={t.search} value={query} onChange={(e) => onQuery(e.target.value)} />
        </label>
      </div>
      <ul className="rows" aria-label={t.conversations}>
        {items.length === 0 && <li className="empty">{t.noResults}</li>}
        {items.map((c) => (
          <li key={c.id}>
            <button type="button" className="row" aria-current={c.id === selectedId} onClick={() => onOpen(c.id)}>
              <span className="avatar" aria-hidden>{initials(c.contact.name)}{c.unread > 0 && c.id !== selectedId && <span className="lit" />}</span>
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{c.contact.name ?? `+${c.contact.waId}`}</span>
                  {c.lastMessage && <span className="muted">{relativeTime(c.lastMessage.at, now, lang)}</span>}
                </span>
                <span className="row-bottom">
                  <span className="row-preview">{c.lastMessage?.preview ?? ''}</span>
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
