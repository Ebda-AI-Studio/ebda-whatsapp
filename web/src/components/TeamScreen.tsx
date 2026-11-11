import { UsersRound } from 'lucide-react';
import { BRAND } from '@brand';
import { useCallback, useEffect, useState } from 'react';
import type { ListMembersResponse, MemberDto } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { InboxSource, TeamApi } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { LoadError } from './LoadError';
import { UpgradeCard, billingUrl } from './UpgradeCard';

type Note = { kind: 'alert' | 'status'; text: string };

/** The owner's team and seats (WA-SEATS-1). The server decides everything (limit, ownership); this screen only shows it and asks. */
export function TeamScreen({ t, lang, source, api }: { t: Strings; lang: Lang; source: InboxSource; api: TeamApi }) {
  // undefined = loading, null = not the owner (403), 'error' = the team could not be read.
  const [data, setData] = useState<ListMembersResponse | null | undefined | 'error'>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [seatLimit, setSeatLimit] = useState(false);

  const load = useCallback(() => {
    setData(undefined);
    api.list().then(setData, (e) => setData(e instanceof ApiError && e.status === 403 ? null : 'error'));
  }, [api]);
  useEffect(load, [load]);

  if (data === undefined) return <main className="screen"><div className="placeholder">…</div></main>;
  if (data === 'error') return <main className="screen"><div className="placeholder"><LoadError t={t} onRetry={load} /></div></main>;
  if (data === null || source.role !== 'owner') return <main className="screen"><div className="placeholder">{t.ownerOnly}</div></main>;

  const change = async (m: MemberDto, assign: boolean) => {
    setBusy(m.userId);
    setNote(null);
    setSeatLimit(false);
    try {
      await (assign ? api.assign(m.userId) : api.unassign(m.userId));
      setData(await api.list());
    } catch (e) {
      if (e instanceof ApiError && e.code === 'seat_limit') setSeatLimit(true);
      else if (e instanceof ApiError && e.status === 503) setNote({ kind: 'alert', text: t.teamUnavailable });
      else setNote({ kind: 'alert', text: t.teamFailed });
    } finally {
      setBusy(null);
    }
  };
  const staff = data.items.filter((m) => m.role === 'staff');

  return (
    <main className="screen" aria-labelledby="team-title">
      <header className="screen-head">
        <UsersRound size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="team-title">{t.teamTitle}</h1>
        <span className="muted">{t.teamUsage(num(data.seats.used, lang), num(data.seats.limit, lang))}</span>
      </header>
      <section className="settings">
        <p className="muted">{t.teamIntro}{BRAND.helpUrl && <> <a href={BRAND.helpUrl(lang, 'team-members-and-seats')} target="_blank" rel="noopener">{t.howTo}</a></>}</p>
        {(data.seats.overLimit || seatLimit) && <UpgradeCard title={t.upgradeTeamTitle} body={data.seats.overLimit ? t.teamOverLimit : t.teamSeatLimit(num(data.seats.limit, lang))} cta={t.upgradeCta} href={billingUrl(source.storeId)} />}
        {note && <p role={note.kind} className={note.kind === 'alert' ? 'error-text' : 'muted'}>{note.text}</p>}
        <ul className="team-list">
          {data.items.map((m) => (
            <li key={m.userId} className="team-row" data-seat={m.seat}>
              <div>
                <strong dir="auto">{m.displayName}</strong>
                <span className="muted"> · {t.teamRoles[m.role]}</span>
                <div className="muted" data-testid={`seat-${m.userId}`}>{t.teamSeats[m.seat]}</div>
              </div>
              {m.role === 'staff' && (m.seat === 'none'
                ? <button type="button" className="btn primary" disabled={busy !== null} aria-label={t.teamAssignFor(m.displayName)} onClick={() => void change(m, true)}>{t.teamAssign}</button>
                : <button type="button" className="btn" disabled={busy !== null} aria-label={t.teamUnassignFor(m.displayName)} onClick={() => void change(m, false)}>{t.teamUnassign}</button>)}
            </li>
          ))}
        </ul>
        {staff.length === 0 && <p className="muted">{t.teamEmpty}</p>}
      </section>
    </main>
  );
}
