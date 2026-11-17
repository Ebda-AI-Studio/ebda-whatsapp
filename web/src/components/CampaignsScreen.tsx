import { Megaphone, Plus } from 'lucide-react';
import { BRAND } from '@brand';
import { useCallback, useEffect, useState } from 'react';
import type { CampaignDto } from '../../../src/core/api/contract';
import type { CampaignsApi, InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { templateTitle } from '../lib/format';
import type { View } from './Rail';
import { useFocusOn } from '../lib/useFocusOn';
import { useLoad } from '../lib/useLoad';
import { CampaignForm } from './CampaignForm';
import { LoadError } from './LoadError';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: CampaignsApi; now: () => number; onNavigate?: ((v: View) => void) | undefined };

export function dateTime(at: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo' }).format(at);
}

export function CampaignsScreen({ t, lang, source, api, now, onNavigate }: Props) {
  const list = useCallback(() => api.list(), [api]);
  const { data: items, setData: setItems, error: loadFailed, reload: load } = useLoad<CampaignDto[]>(list);
  const [mode, setMode] = useState<'list' | 'new'>('list');
  // The merchant's own titles for templates (best effort: without them a campaign shows the shipped or raw name).
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => { void source.templates().then((all) => setTitles(Object.fromEntries(all.filter((x) => x.label).map((x) => [`${x.name}|${x.language}`, templateTitle(t, x)]))), () => undefined); }, [source, t]);
  const owner = source.role !== 'staff';
  // Running campaigns move on their own: refresh while one is in flight.
  useEffect(() => {
    if (!items?.some((c) => c.status === 'running' || c.status === 'scheduled')) return;
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [items, load]);

  if (mode === 'new') {
    return <CampaignForm t={t} lang={lang} source={source} api={api} now={now} onClose={() => { setMode('list'); load(); }} onOpenTemplates={onNavigate ? () => onNavigate('templates') : undefined} />;
  }

  const replace = (c: CampaignDto) => setItems((xs) => xs?.map((x) => (x.id === c.id ? c : x)) ?? null);

  return (
    <main className="screen" aria-labelledby="campaigns-title">
      <header className="screen-head">
        <Megaphone size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="campaigns-title">{t.campaignsTitle}</h1>
        {owner && <button type="button" className="btn primary head-action" onClick={() => setMode('new')}><Plus size={18} aria-hidden />{t.newCampaign}</button>}
      </header>
      <div className="settings wide">
        {loadFailed ? <LoadError t={t} onRetry={load} />
          : items === null ? <Skeleton t={t} kind="campaign" />
          : items.length === 0 ? <EmptyState icon={<Megaphone size={22} />} title={t.campaignsEmptyTitle} body={t.campaignsEmpty} />
          : items.map((c) => <CampaignRow key={c.id} c={c} title={titles[`${c.template.name}|${c.template.language}`]} t={t} lang={lang} owner={owner} api={api} onChange={replace} onRemoved={load} />)}
      </div>
    </main>
  );
}

function CampaignRow({ c, title, t, lang, owner, api, onChange, onRemoved }: { c: CampaignDto; title: string | undefined; t: Strings; lang: Lang; owner: boolean; api: CampaignsApi; onChange: (c: CampaignDto) => void; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [acted, setActed] = useState(0);
  const ref = useFocusOn<HTMLElement>(acted);
  const titleId = `camp-${c.id}`;
  const n = (v: number) => num(v, lang);
  const total = c.totals.recipients;
  const pct = (v: number) => (total > 0 ? `${Math.min(100, (v / total) * 100)}%` : '0%');
  const act = (fn: () => Promise<CampaignDto>) => async () => {
    setBusy(true);
    try { onChange(await fn()); setActed((k) => k + 1); } catch { /* the list refresh shows the true state */ } finally { setBusy(false); setAsking(false); }
  };
  const live = c.status === 'running' || c.status === 'scheduled' || c.status === 'paused';
  const when = c.status === 'scheduled' && c.scheduledAt ? t.scheduledFor(dateTime(c.scheduledAt, lang))
    : c.finishedAt ? t.finishedAt(dateTime(c.finishedAt, lang))
    : c.startedAt ? t.startedAt(dateTime(c.startedAt, lang)) : null;

  return (
    <article ref={ref} tabIndex={-1} className="campaign" aria-labelledby={titleId} data-status={c.status}>
      <div className="campaign-top">
        <h2 id={titleId}>{c.name}</h2>
        <span className="status-chip" data-status={c.status}>{t.campaignStatus[c.status]}</span>
      </div>
      <p className="muted campaign-meta">
        <bdi>{title ?? t.templateNames[c.template.name] ?? c.template.name}</bdi>{when && <> · {when}</>}
      </p>
      {c.status === 'paused' && c.pauseReason && <p className="campaign-reason" data-reason={c.pauseReason}>{t.pauseReasons[c.pauseReason] ?? t.pauseUnknown}</p>}
      {c.status === 'paused' && c.pauseReason && (c.pauseReason === 'operator_paused' || !t.pauseReasons[c.pauseReason]) && <p className="campaign-reason-contact">{t.pauseContact(BRAND.supportEmail ?? t.wSupport)}</p>}
      {c.status === 'scheduled' && total > 0 && <p className="audience-line">{t.audienceCount(n(total))}</p>}
      {total > 0 && c.status !== 'scheduled' && (
        <>
          <div className="meter" role="img" aria-label={`${t.stopSent} ${n(c.totals.sent)}، ${t.stopDelivered} ${n(c.totals.delivered)}، ${t.stopRead} ${n(c.totals.read)}`}>
            <span className="meter-sent" style={{ width: pct(c.totals.sent) }} />
            <span className="meter-delivered" style={{ width: pct(c.totals.delivered) }} />
            <span className="meter-read" style={{ width: pct(c.totals.read) }} />
          </div>
          <dl className="campaign-stats">
            <div><dt>{t.stopSent}</dt><dd>{t.ofRecipients(n(c.totals.sent), n(total))}</dd></div>
            <div><dt>{t.stopDelivered}</dt><dd>{n(c.totals.delivered)}</dd></div>
            <div><dt>{t.stopRead}</dt><dd>{n(c.totals.read)}</dd></div>
            {c.linkUrl && <div className="wide-stat"><dt className="vh">{t.paramLink}</dt><dd>{t.clicksLine(n(c.clicks.unique), n(c.clicks.total))}</dd></div>}
          </dl>
          {(c.totals.failed > 0 || c.totals.skipped > 0) && <p className="muted small">{t.failedLine(n(c.totals.failed), n(c.totals.skipped))}</p>}
        </>
      )}
      {(live || (c.status === 'draft' && owner)) && (
        <div className="campaign-actions">
          {asking ? (
            <div className="confirm-inline" role="group" aria-label={t.cancelAsk}>
              <span>{t.cancelAsk}</span>
              <button type="button" className="btn danger" disabled={busy} onClick={act(() => api.cancel(c.id))}>{t.cancelYes}</button>
              <button type="button" className="btn" onClick={() => setAsking(false)}>{t.cancelNo}</button>
            </div>
          ) : (
            <>
              {c.status === 'running' && <button type="button" className="btn" disabled={busy} onClick={act(() => api.pause(c.id))}>{t.pause}</button>}
              {c.status === 'paused' && owner && <button type="button" className="btn primary" disabled={busy} onClick={act(() => api.resume(c.id))}>{t.resume}</button>}
              {live && <button type="button" className="btn quiet" onClick={() => setAsking(true)}>{t.cancelCampaign}</button>}
              {c.status === 'draft' && <button type="button" className="btn quiet" disabled={busy} onClick={async () => { setBusy(true); try { await api.remove(c.id); onRemoved(); } finally { setBusy(false); } }}>{t.deleteDraft}</button>}
            </>
          )}
        </div>
      )}
    </article>
  );
}
