import { ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../data/api';
import type { Adjustment, ChangeLogItem, FxRate, KillSwitchAction, MarginOverride, MetaDeletion, OperatorApi, OpsStatusDto, OperatorInstapay, PricingSettings, RateCardVersion, RefundRequest, YearlyRefundQuoteView } from '../data/billing';
import type { InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { formatMoney, formatSigned } from '../lib/format';
import { parseRates, parseScaled, toMicros } from '../lib/rates';
import { dateTime } from './CampaignsScreen';
import { SharedTemplatesPanel } from './SharedTemplatesPanel';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: OperatorApi; now: () => number };
type Note = { kind: 'alert' | 'status'; lines: string[] } | null;
type Run = (fn: () => Promise<string | void>, lead?: number) => Promise<boolean>;
type PanelProps = { t: Strings; lang: Lang; api: OperatorApi; now: () => number; run: Run; fail: (...lines: string[]) => void; source: InboxSource };

const HOUR = 3_600_000;
const SETTINGS_LEAD_H = 1;
const RATE_LEAD_H = 24;
const TABS = ['pricing', 'rates', 'account', 'queues', 'log', 'shared', 'killswitch'] as const;
type Tab = (typeof TABS)[number];

const pad = (n: number) => String(n).padStart(2, '0');
/** The value a datetime-local input wants: the browser's local wall clock. */
export const toLocalInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v: string): number | null => { const ms = new Date(v).getTime(); return Number.isFinite(ms) ? ms : null; };
/** A default that is safely past the rule's minimum lead: the minimum plus ten minutes, so submitting untouched passes. */
const defaultEffective = (now: number, leadHours: number) => toLocalInput(now + leadHours * HOUR + 10 * 60_000);

export function OperatorScreen({ t, lang, source, api, now }: Props) {
  const [tab, setTab] = useState<Tab>('pricing');
  const [note, setNote] = useState<Note>(null);

  const explain = useCallback((e: unknown, lead?: number): string => {
    if (e instanceof ApiError) {
      if (e.status === 503) return t.opGuard;
      if (e.status === 403 && e.detail === 'session_revoked') return t.opRevoked;
      if (e.detail === 'second_approver_required') return t.opSecondApprover;
      if (e.detail === 'too_soon' && lead) return t.opTooSoon(num(lead, lang));
    }
    return t.opFailed;
  }, [t, lang]);

  const run: Run = useCallback(async (fn, lead) => {
    setNote(null);
    try {
      const text = await fn();
      setNote({ kind: 'status', lines: [text || t.opSaved] });
      return true;
    } catch (e) {
      setNote({ kind: 'alert', lines: [explain(e, lead)] });
      return false;
    }
  }, [explain, t]);
  const fail = useCallback((...lines: string[]) => setNote({ kind: 'alert', lines }), []);

  const panel: PanelProps = { t, lang, api, now, run, fail, source };
  return (
    <main className="screen" aria-labelledby="operator-title">
      <header className="screen-head">
        <ShieldCheck size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="operator-title">{t.opTitle}</h1>
      </header>
      <div className="settings wide operator-layout">
        <p className="muted intro">{t.opIntro}</p>
        <ViewAsCard t={t} />
        <div className="chips" role="group" aria-label={t.opTitle}>
          {TABS.filter((k) => k !== 'shared' || source.sharedTemplates).map((k) => <button key={k} type="button" className="chip" aria-pressed={tab === k} onClick={() => { setTab(k); setNote(null); }}>{t.opTabs[k]}</button>)}
        </div>
        {note && <div role={note.kind} className={note.kind === 'alert' ? 'error-text op-note' : 'wallet-ok op-note'}>{note.lines.map((l) => <p key={l}>{l}</p>)}</div>}
        {tab === 'pricing' && <PricingPanel {...panel} />}
        {tab === 'rates' && <RatesPanel {...panel} />}
        {tab === 'account' && <AccountPanel {...panel} />}
        {tab === 'queues' && <QueuesPanel {...panel} />}
        {tab === 'log' && <LogPanel {...panel} />}
        {tab === 'killswitch' && <KillSwitchPanel {...panel} />}
        {tab === 'shared' && source.sharedTemplates && <SharedTemplatesPanel t={t} lang={lang} api={source.sharedTemplates} run={run} fail={fail} />}
      </div>
    </main>
  );
}

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="wallet-card" aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}

/** Loads a list once and again on demand; `error` is shown calmly in the panel. */
function useList<T>(load: () => Promise<T[]>): { items: T[] | null; error: boolean; reload: () => void } {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(() => { load().then((x) => { setItems(x); setError(false); }, () => setError(true)); }, [load]);
  useEffect(reload, [reload]);
  return { items, error, reload };
}

const pct = (bps: number, lang: Lang) => num(bps / 100, lang);

// ---- Pricing settings ------------------------------------------------------------------------------------------------------

function PricingPanel({ t, lang, api, now, run, fail }: PanelProps) {
  const { items, error, reload } = useList<PricingSettings>(api.pricingSettings);
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const signed = (m: number) => formatSigned(m, lang);
  const line = (s: PricingSettings) => t.opSettingsLine(pct(s.marginBps, lang), money(s.creditLimitMinor), pct(s.fxBufferBps, lang), pct(s.vatBps, lang));
  const current = items?.filter((s) => s.effectiveFrom <= now()).sort((a, b) => b.effectiveFrom - a.effectiveFrom || b.ver - a.ver)[0];
  const scheduled = items?.filter((s) => s.effectiveFrom > now()) ?? [];
  const history = items?.filter((s) => s !== current && s.effectiveFrom <= now()) ?? [];

  const [f, setF] = useState({ margin: '', overdraft: '', fx: '', vat: '', at: defaultEffective(now(), SETTINGS_LEAD_H), reason: '' });
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !current) return;
    setF((x) => ({ ...x, margin: String(current.marginBps / 100), overdraft: String(current.creditLimitMinor / 100), fx: String(current.fxBufferBps / 100), vat: String(current.vatBps / 100) }));
    setSeeded(true);
  }, [current, seeded]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const marginBps = parseScaled(f.margin, 2), creditLimitMinor = parseScaled(f.overdraft, 2), fxBufferBps = parseScaled(f.fx, 2), vatBps = 0; // Ruling VAT-0: always 0 (the server refuses anything else)
    const effectiveFrom = fromLocalInput(f.at);
    if (marginBps === null || creditLimitMinor === null || fxBufferBps === null || marginBps > 100_000 || creditLimitMinor > 10_000_000 || fxBufferBps > 10_000) return fail(t.opBadNumber);
    if (f.reason.trim().length < 5) return fail(t.opReasonShort);
    if (effectiveFrom === null || effectiveFrom < now() + SETTINGS_LEAD_H * HOUR) return fail(t.opTooSoon(num(SETTINGS_LEAD_H, lang)));
    if (await run(async () => { await api.publishPricingSettings({ effectiveFrom, marginBps, creditLimitMinor, fxBufferBps, vatBps, reason: f.reason.trim() }); }, SETTINGS_LEAD_H)) { setF((x) => ({ ...x, reason: '' })); reload(); }
  };

  const list = (xs: PricingSettings[]) => (
    <ul className="wallet-rows">
      {xs.map((s) => (
        <li key={s.ver}>
          <span className="wallet-row-main"><b>{t.opVersion(num(s.ver, lang))}</b> <span className="muted">• {t.opFrom(dateTime(s.effectiveFrom, lang))} • {t.opBy(s.actor)}</span>
            <span className="op-line">{line(s)}</span><span className="muted op-line" dir="auto">{s.reason}</span></span>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {error && <p className="error-text">{t.opLoadError}</p>}
      {current && <section className="wallet-card" aria-labelledby="op-current"><h2 id="op-current">{t.opCurrent}</h2>{list([current])}</section>}
      {scheduled.length > 0 && <section className="wallet-card" aria-labelledby="op-sched"><h2 id="op-sched">{t.opScheduled}</h2>{list(scheduled)}</section>}
      <Card id="op-settings" title={t.opSettingsTitle}>
        <p className="muted">{t.opNeverRetro}</p>
        <form className="wallet-form op-grid" onSubmit={(e) => void submit(e)} noValidate>
          <label className="field"><span>{t.opMargin}</span><input inputMode="decimal" dir="ltr" value={f.margin} onChange={set('margin')} /></label>
          <label className="field"><span>{t.opOverdraft}</span><input inputMode="decimal" dir="ltr" value={f.overdraft} onChange={set('overdraft')} /></label>
          <label className="field"><span>{t.opFxBuffer}</span><input inputMode="decimal" dir="ltr" value={f.fx} onChange={set('fx')} /></label>
          <label className="field"><span>{t.opVat}</span><input inputMode="decimal" dir="ltr" value="0" readOnly aria-describedby="op-vat-locked" /><small id="op-vat-locked">{t.opVatLocked}</small></label>
          <label className="field"><span>{t.opEffective}</span><input type="datetime-local" value={f.at} onChange={set('at')} /></label>
          <label className="field op-wide"><span>{t.opReason}</span><input dir="auto" maxLength={500} value={f.reason} onChange={set('reason')} /></label>
          <div className="settings-actions op-wide"><button type="submit" className="btn primary">{t.opPublishSettings}</button></div>
        </form>
      </Card>
      {history.length > 0 && <Card id="op-history" title={t.opHistory}>{list(history)}</Card>}
    </>
  );
}

// ---- Rate cards and FX -----------------------------------------------------------------------------------------------------

function RatesPanel({ t, lang, api, now, run, fail }: PanelProps) {
  const cards = useList<RateCardVersion>(api.rateCards);
  const fxs = useList<FxRate>(api.fxRates);
  const [rates, setRates] = useState('');
  const [ratesAt, setRatesAt] = useState(() => defaultEffective(now(), RATE_LEAD_H));
  const [ratesReason, setRatesReason] = useState('');
  const [fx, setFx] = useState({ rate: '', buffer: '0', at: defaultEffective(now(), RATE_LEAD_H), reason: '' });

  const publishRates = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseRates(rates);
    if (!parsed.ok) return fail(...parsed.errors.map((er) => (er.line ? t.opRateLine(num(er.line, lang), t.opRateErrors[er.code] ?? '') : (t.opRateErrors[er.code] ?? ''))));
    if (ratesReason.trim().length < 5) return fail(t.opReasonShort);
    const effectiveFrom = fromLocalInput(ratesAt);
    if (effectiveFrom === null || effectiveFrom < now() + RATE_LEAD_H * HOUR) return fail(t.opTooSoon(num(RATE_LEAD_H, lang)));
    if (await run(async () => { await api.publishRateCard({ effectiveFrom, rates: parsed.rates, reason: ratesReason.trim() }); }, RATE_LEAD_H)) { setRates(''); setRatesReason(''); cards.reload(); }
  };
  const publishFx = async (e: FormEvent) => {
    e.preventDefault();
    const egpPerUsdMicros = toMicros(fx.rate), bufferBps = parseScaled(fx.buffer, 2);
    if (egpPerUsdMicros === null || egpPerUsdMicros < 1 || bufferBps === null || bufferBps > 10_000) return fail(t.opBadNumber);
    if (fx.reason.trim().length < 5) return fail(t.opReasonShort);
    const effectiveFrom = fromLocalInput(fx.at);
    if (effectiveFrom === null || effectiveFrom < now() + RATE_LEAD_H * HOUR) return fail(t.opTooSoon(num(RATE_LEAD_H, lang)));
    if (await run(async () => { await api.publishFx({ effectiveFrom, egpPerUsdMicros, bufferBps, reason: fx.reason.trim() }); }, RATE_LEAD_H)) { setFx((x) => ({ ...x, rate: '', reason: '' })); fxs.reload(); }
  };

  return (
    <>
      <Card id="op-rates" title={t.opRatesTitle}>
        {cards.error && <p className="error-text">{t.opLoadError}</p>}
        <ul className="wallet-rows">
          {cards.items?.map((c) => (
            <li key={c.ver}><span className="wallet-row-main"><b>{t.opVersion(num(c.ver, lang))}</b> <span className="muted">• {t.opFrom(dateTime(c.effectiveFrom, lang))} • {t.opRatesRows(num(c.rows, lang))} • {t.opBy(c.actor)}</span></span></li>
          ))}
        </ul>
        <p className="muted">{t.opNeverRetro}</p>
        <form className="wallet-form" onSubmit={(e) => void publishRates(e)} noValidate>
          <div className="field">
            <label htmlFor="op-rates-text">{t.opRatesInput}</label>
            <textarea id="op-rates-text" dir="ltr" rows={6} spellCheck={false} placeholder="EG,marketing,0.0529" aria-describedby="op-rates-help" value={rates} onChange={(e) => setRates(e.target.value)} />
            <small id="op-rates-help" className="muted">{t.opRatesHelp} • {t.opRatesLead}</small>
          </div>
          <label className="field"><span>{t.opRatesEffective}</span><input type="datetime-local" value={ratesAt} onChange={(e) => setRatesAt(e.target.value)} /></label>
          <label className="field"><span>{t.opReason}</span><input dir="auto" maxLength={500} value={ratesReason} onChange={(e) => setRatesReason(e.target.value)} /></label>
          <div className="settings-actions"><button type="submit" className="btn primary">{t.opPublishRates}</button></div>
        </form>
      </Card>
      <Card id="op-fx" title={t.opFxTitle}>
        {fxs.error && <p className="error-text">{t.opLoadError}</p>}
        <ul className="wallet-rows">
          {fxs.items?.map((x) => (
            <li key={x.ver}><span className="wallet-row-main"><b>{t.opVersion(num(x.ver, lang))}</b> <span className="muted">• {t.opFrom(dateTime(x.effectiveFrom, lang))} • {t.opBy(x.actor)}</span>
              <span className="op-line">{t.opFxLine(num(x.egpPerUsdMicros / 1_000_000, lang), pct(x.bufferBps, lang))}</span></span></li>
          ))}
        </ul>
        <form className="wallet-form op-grid" onSubmit={(e) => void publishFx(e)} noValidate>
          <label className="field"><span>{t.opFxRate}</span><input inputMode="decimal" dir="ltr" value={fx.rate} onChange={(e) => setFx({ ...fx, rate: e.target.value })} /></label>
          <label className="field"><span>{t.opFxBufferLabel}</span><input inputMode="decimal" dir="ltr" value={fx.buffer} onChange={(e) => setFx({ ...fx, buffer: e.target.value })} /></label>
          <label className="field"><span>{t.opFxEffective}</span><input type="datetime-local" value={fx.at} onChange={(e) => setFx({ ...fx, at: e.target.value })} /></label>
          <label className="field"><span>{t.opFxReason}</span><input dir="auto" maxLength={500} value={fx.reason} onChange={(e) => setFx({ ...fx, reason: e.target.value })} /></label>
          <div className="settings-actions op-wide"><button type="submit" className="btn primary">{t.opPublishFx}</button></div>
        </form>
      </Card>
    </>
  );
}

// ---- One account: margin override, who pays Meta, adjustments --------------------------------------------------------------

function AccountPanel({ t, lang, api, now, run, fail }: PanelProps) {
  const [ws, setWs] = useState('');
  const [loaded, setLoaded] = useState<{ id: string; items: MarginOverride[] } | null>(null);
  const [ov, setOv] = useState({ margin: '', at: defaultEffective(now(), SETTINGS_LEAD_H), reason: '' });
  const [fund, setFund] = useState({ phone: '', funding: 'merchant_card', reason: '' });
  const [adj, setAdj] = useState({ amount: '', reason: '' });

  const load = async (e?: FormEvent) => {
    e?.preventDefault();
    const id = ws.trim();
    if (!id) return;
    try { setLoaded({ id, items: await api.overrides(id) }); } catch { fail(t.opLoadError); }
  };
  const needWs = (): string | null => { const id = ws.trim(); if (!id) { fail(t.opWorkspace); return null; } return id; };

  const publishOverride = async (e: FormEvent) => {
    e.preventDefault();
    const id = needWs(); if (!id) return;
    const marginBps = parseScaled(ov.margin, 2), effectiveFrom = fromLocalInput(ov.at);
    if (marginBps === null || marginBps > 100_000) return fail(t.opBadNumber);
    if (ov.reason.trim().length < 5) return fail(t.opReasonShort);
    if (effectiveFrom === null || effectiveFrom < now() + SETTINGS_LEAD_H * HOUR) return fail(t.opTooSoon(num(SETTINGS_LEAD_H, lang)));
    if (await run(async () => { await api.publishOverride(id, { effectiveFrom, marginBps, reason: ov.reason.trim() }); }, SETTINGS_LEAD_H)) { setOv((x) => ({ ...x, reason: '' })); void load(); }
  };
  const setFunding = async (e: FormEvent) => {
    e.preventDefault();
    if (!fund.phone.trim()) return fail(t.opPhoneId);
    if (fund.reason.trim().length < 5) return fail(t.opReasonShort);
    if (await run(async () => { await api.setFunding(fund.phone.trim(), fund.funding as 'merchant_card' | 'platform_line', fund.reason.trim()); })) setFund((x) => ({ ...x, reason: '' }));
  };
  const createAdjustment = async (e: FormEvent) => {
    e.preventDefault();
    const id = needWs(); if (!id) return;
    const neg = adj.amount.trim().startsWith('-');
    const abs = parseScaled(adj.amount.trim().replace(/^[-+]/, ''), 2);
    if (abs === null || abs === 0) return fail(t.opBadNumber);
    if (adj.reason.trim().length < 5) return fail(t.opReasonShort);
    if (await run(async () => { const a = await api.createAdjustment(id, neg ? -abs : abs, adj.reason.trim()); return a.state === 'approved' ? t.opAdjApplied : t.opAdjQueued; })) setAdj({ amount: '', reason: '' });
  };

  return (
    <>
      <Card id="op-account" title={t.opAccountTitle}>
        <p className="muted">{t.opAccountHelp}</p>
        <form className="wallet-form op-inline" onSubmit={(e) => void load(e)}>
          <label className="field"><span>{t.opWorkspace}</span><input dir="ltr" value={ws} onChange={(e) => setWs(e.target.value)} /></label>
          <button type="submit" className="btn">{t.opLoad}</button>
        </form>
      </Card>
      <Card id="op-override" title={t.opOverrideTitle}>
        {loaded && (loaded.items.length === 0 ? <p className="muted">{t.opOverrideNone}</p> : (
          <ul className="wallet-rows">
            {loaded.items.map((o) => (
              <li key={o.ver}><span className="wallet-row-main"><b>{t.opVersion(num(o.ver, lang))}</b> <span className="muted">• {t.opFrom(dateTime(o.effectiveFrom, lang))} • {t.opBy(o.actor)}</span>
                <span className="op-line">{t.opMargin} {pct(o.marginBps, lang)}</span><span className="muted op-line" dir="auto">{o.reason}</span></span></li>
            ))}
          </ul>
        ))}
        <p className="muted">{t.opNeverRetro}</p>
        <form className="wallet-form op-grid" onSubmit={(e) => void publishOverride(e)} noValidate>
          <label className="field"><span>{t.opMargin}</span><input inputMode="decimal" dir="ltr" value={ov.margin} onChange={(e) => setOv({ ...ov, margin: e.target.value })} /></label>
          <label className="field"><span>{t.opEffective}</span><input type="datetime-local" value={ov.at} onChange={(e) => setOv({ ...ov, at: e.target.value })} /></label>
          <label className="field op-wide"><span>{t.opReason}</span><input dir="auto" maxLength={500} value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} /></label>
          <div className="settings-actions op-wide"><button type="submit" className="btn primary">{t.opPublishOverride}</button></div>
        </form>
      </Card>
      <Card id="op-funding" title={t.opFundingTitle}>
        <form className="wallet-form op-grid" onSubmit={(e) => void setFunding(e)} noValidate>
          <label className="field"><span>{t.opPhoneId}</span><input dir="ltr" value={fund.phone} onChange={(e) => setFund({ ...fund, phone: e.target.value })} /></label>
          <label className="field"><span>{t.opFundingLabel}</span>
            <select value={fund.funding} onChange={(e) => setFund({ ...fund, funding: e.target.value })}><option value="merchant_card">{t.opFundingCard}</option><option value="platform_line">{t.opFundingWallet}</option></select>
          </label>
          <label className="field op-wide"><span>{t.opFundingReason}</span><input dir="auto" maxLength={500} value={fund.reason} onChange={(e) => setFund({ ...fund, reason: e.target.value })} /></label>
          <div className="settings-actions op-wide"><button type="submit" className="btn primary">{t.opSetFunding}</button></div>
        </form>
      </Card>
      <Card id="op-adjust" title={t.opAdjTitle}>
        <form className="wallet-form op-grid" onSubmit={(e) => void createAdjustment(e)} noValidate>
          <label className="field"><span>{t.opAdjAmount}</span><input inputMode="decimal" dir="ltr" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></label>
          <label className="field op-wide"><span>{t.opAdjReason}</span><input dir="auto" maxLength={500} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></label>
          <div className="settings-actions op-wide"><button type="submit" className="btn primary">{t.opAdjCreate}</button></div>
        </form>
      </Card>
      <YearlyPlanCard t={t} lang={lang} api={api} run={run} fail={fail} />
    </>
  );
}

// ---- Refund queue and adjustments ------------------------------------------------------------------------------------------

const chip = (state: string) => (state === 'paid' || state === 'approved' ? 'done' : state === 'rejected' || state === 'failed' ? 'failed' : 'pending');

function QueuesPanel({ t, lang, api, source, run, now, fail }: PanelProps) {
  const refunds = useList<RefundRequest>(api.refundQueue);
  const deletions = useList<MetaDeletion>(api.metaDeletions);
  const adjustments = useList<Adjustment>(api.adjustments);
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const signed = (m: number) => formatSigned(m, lang);
  const [asking, setAsking] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Record<string, string>>({});
  const [local, setLocal] = useState<Record<string, RefundRequest | Adjustment>>({});
  const merged = useMemo(() => ({ r: (r: RefundRequest) => (local[r.id] as RefundRequest | undefined) ?? r, a: (a: Adjustment) => (local[a.id] as Adjustment | undefined) ?? a }), [local]);

  const decideRefund = (r: RefundRequest, decision: 'approve' | 'reject') => async () => {
    setAsking(null);
    await run(async () => { const next = await api.decideRefund(r.id, decision, notes[r.id] ?? ''); setLocal((l) => ({ ...l, [r.id]: next })); });
  };
  const decideAdj = (a: Adjustment, decision: 'approve' | 'reject') => async () => {
    await run(async () => { const next = await api.decideAdjustment(a.id, decision); setLocal((l) => ({ ...l, [a.id]: next })); });
  };

  return (
    <>
      <Card id="op-meta-deletions" title={t.opDeletionsTitle}>
        {deletions.error && <p className="error-text">{t.opLoadError}</p>}
        {deletions.items?.length === 0 && <p className="muted">{t.opDeletionsEmpty}</p>}
        <ul className="wallet-rows op-rows">
          {deletions.items?.map((d) => (
            <li key={d.code}>
              <span className="wallet-row-main"><code dir="ltr">{d.code.slice(0, 8)}</code> <span className="status-chip" data-status={d.state === 'done' ? 'ok' : d.state === 'queued' ? 'wait' : 'bad'}>{t.opDeletionState[d.state]}</span></span>
              <span className="muted small">{dateTime(d.receivedAt, lang)} · {t.opDeletionRemoved(num(d.removedConnections, lang))}</span>
            </li>
          ))}
        </ul>
        <p className="muted small">{t.opDeletionsHelp}</p>
      </Card>
      <Card id="op-refunds" title={t.opRefundTitle}>
        {refunds.error && <p className="error-text">{t.opLoadError}</p>}
        {refunds.items?.length === 0 && <p className="muted">{t.opRefundEmpty}</p>}
        <ul className="wallet-rows op-rows">
          {refunds.items?.map((raw) => {
            const r = merged.r(raw);
            return (
              <li key={r.id}>
                <span className="wallet-row-main">
                  <b><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{signed(r.amountMinor)}</bdi></b> <span className="status-chip" data-status={chip(r.state)}>{t.refundStates[r.state] ?? r.state}</span>
                  <span className="muted op-line"><bdi dir="ltr">{r.workspaceId}</bdi> • {t.opRequestedBy(r.requestedBy)} • {dateTime(r.createdAt, lang)}</span>
                  {r.note && <span className="op-line" dir="auto">{r.note}</span>}
                  {r.state !== 'pending' && (r.cardRefundedMinor > 0 || r.manualMinor > 0) && <span className="muted op-line">{t.opRefundLine(money(r.cardRefundedMinor), money(r.manualMinor))}</span>}
                  {r.decisionNote && <span className="muted op-line" dir="auto">{r.decisionNote}</span>}
                </span>
                {r.state === 'pending' && (
                  asking === r.id ? (
                    <div className="confirm-inline" role="group" aria-label={t.opApproveAsk}>
                      <span>{t.opApproveAsk}</span>
                      <button type="button" className="btn primary" onClick={() => void decideRefund(r, 'approve')()}>{t.opApproveYes}</button>
                      <button type="button" className="btn" onClick={() => setAsking(null)}>{t.opApproveNo}</button>
                    </div>
                  ) : (
                    <div className="op-actions">
                      <label className="field"><span>{t.opDecisionNote}</span><input dir="auto" maxLength={500} value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} /></label>
                      <div className="campaign-actions">
                        <button type="button" className="btn primary" onClick={() => setAsking(r.id)}>{t.opApprove}</button>
                        <button type="button" className="btn quiet" onClick={() => void decideRefund(r, 'reject')()}>{t.opReject}</button>
                      </div>
                    </div>
                  )
                )}
                {r.state === 'processing' && (
                  <div className="campaign-actions">
                    <button type="button" className="btn quiet" onClick={() => void run(async () => { const out = await api.abandonRefund(r.id); if (out.needsSecond) setNotes((n) => ({ ...n, [r.id]: t.opAbandonNeedsSecond })); refunds.reload(); })}>{t.opAbandon}</button>
                    {notes[r.id] === t.opAbandonNeedsSecond && <span className="campaign-reason">{t.opAbandonNeedsSecond}</span>}
                  </div>
                )}
                {r.state === 'manual_payout' && (
                  <div className="op-actions">
                    <label className="field"><span>{t.opLinkLabel}</span><input dir="ltr" maxLength={64} value={links[r.id] ?? ''} onChange={(e) => setLinks({ ...links, [r.id]: e.target.value })} /></label>
                    <div className="campaign-actions">
                      <button type="button" className="btn" disabled={!/^[A-Za-z0-9_-]{1,64}$/.test(links[r.id] ?? '')} onClick={() => void run(async () => { await api.linkDashboardRefund(r.id, links[r.id]!, r.manualMinor); refunds.reload(); setLocal((l) => { const { [r.id]: _gone, ...rest } = l; return rest; }); })}>{t.opLinkButton}</button>
                    </div>
                  </div>
                )}
                {r.state === 'manual_payout' && <div className="campaign-actions"><button type="button" className="btn" onClick={() => void run(async () => { await api.markRefundPaid(r.id); refunds.reload(); setLocal((l) => { const { [r.id]: _gone, ...rest } = l; return rest; }); })}>{t.opManualPaid}</button></div>}
              </li>
            );
          })}
        </ul>
      </Card>
      <InstapayReview t={t} lang={lang} api={api} source={source} run={run} now={now} fail={fail} />
      <Card id="op-adjlist" title={t.opAdjList}>
        {adjustments.error && <p className="error-text">{t.opLoadError}</p>}
        {adjustments.items?.length === 0 && <p className="muted">{t.opAdjEmpty}</p>}
        <ul className="wallet-rows op-rows">
          {adjustments.items?.map((raw) => {
            const a = merged.a(raw);
            const mine = a.requestedBy === source.currentUserId;
            return (
              <li key={a.id}>
                <span className="wallet-row-main">
                  <b><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{signed(a.amountMinor)}</bdi></b> <span className="status-chip" data-status={chip(a.state)}>{t.adjStates[a.state] ?? a.state}</span>
                  <span className="op-line" dir="auto">{a.reason}</span>
                  <span className="muted op-line"><bdi dir="ltr">{a.workspaceId}</bdi> • {t.opRequestedBy(a.requestedBy)} • {dateTime(a.createdAt, lang)}</span>
                </span>
                {a.state === 'pending' && (
                  mine ? <p className="muted">{t.opOwnRequest}</p> : (
                    <>
                      <p className="muted">{t.opSecondApprover}</p>
                      <div className="campaign-actions">
                        <button type="button" className="btn primary" onClick={() => void decideAdj(a, 'approve')()}>{t.opApprove}</button>
                        <button type="button" className="btn quiet" onClick={() => void decideAdj(a, 'reject')()}>{t.opReject}</button>
                      </div>
                    </>
                  )
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}

/** Cancel a yearly plan: look at the refund (unused whole months x price/12, debt first), then cancel at the end of the current month. */
function YearlyPlanCard({ t, lang, api, run, fail }: Pick<PanelProps, 't' | 'lang' | 'api' | 'run' | 'fail'>) {
  const [orderId, setOrderId] = useState('');
  const [reason, setReason] = useState('');
  const [quote, setQuote] = useState<YearlyRefundQuoteView | null>(null);
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const show = async (e: FormEvent) => {
    e.preventDefault();
    const id = orderId.trim();
    if (!id) return fail(t.opYrOrder);
    setQuote(null);
    await run(async () => { setQuote(await api.yearlyRefundQuote(id)); return ''; });
  };
  const execute = async () => {
    if (!quote) return;
    if (reason.trim().length < 5) return fail(t.opReasonShort);
    await run(async () => {
      const done = await api.yearlyRefundExecute(quote.orderId, reason.trim());
      setQuote(null);
      return done.noMoneyOut ? `${t.opYrDone(num(done.shortenedMonths, lang), money(done.debtSettledMinor), money(0))} ${t.opYrNoMoney}` : t.opYrDone(num(done.shortenedMonths, lang), money(done.debtSettledMinor), money(done.cashRefundMinor));
    });
  };
  return (
    <Card id="op-yearly" title={t.opYrTitle}>
      <p className="muted">{t.opYrHelp}</p>
      <form className="wallet-form op-inline" onSubmit={(e) => void show(e)}>
        <label className="field"><span>{t.opYrOrder}</span><input dir="ltr" value={orderId} onChange={(e) => setOrderId(e.target.value)} /></label>
        <button type="submit" className="btn">{t.opYrShow}</button>
      </form>
      {quote && (
        <>
          <p role="status">{t.opYrQuote(num(quote.unusedMonths, lang), money(quote.grossMinor), money(quote.debtSettledMinor), money(quote.refundMinor))}</p>
          <label className="field"><span>{t.opReason}</span><input dir="auto" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="settings-actions"><button type="button" className="btn primary" onClick={() => void execute()}>{t.opYrExecute}</button></div>
        </>
      )}
    </Card>
  );
}

// ---- Change log ------------------------------------------------------------------------------------------------------------

function LogPanel({ t, lang, api }: PanelProps) {
  const { items, error } = useList<ChangeLogItem>(api.changeLog);
  const json = (v: unknown) => (v === null || v === undefined ? '—' : JSON.stringify(v));
  return (
    <Card id="op-log" title={t.opLogTitle}>
      {error && <p className="error-text">{t.opLoadError}</p>}
      {items?.length === 0 && <p className="muted">{t.opLogEmpty}</p>}
      <ul className="wallet-rows op-rows">
        {items?.map((l) => (
          <li key={l.id}>
            <span className="wallet-row-main"><span className="muted">{dateTime(l.at, lang)}</span> • <b>{l.actor}</b> • <bdi dir="ltr">{l.action}</bdi>{l.workspaceId && <span className="muted"> • <bdi dir="ltr">{l.workspaceId}</bdi></span>}</span>
            <dl className="op-diff"><div><dt>{t.opBefore}</dt><dd><code dir="ltr">{json(l.before)}</code></dd></div><div><dt>{t.opAfter}</dt><dd><code dir="ltr">{json(l.after)}</code></dd></div></dl>
            {l.reason && <p className="muted" dir="auto">{l.reason}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---- InstaPay transfers: review the proof, confirm or reject --------------------------------------------------------------------

function InstapayReview({ t, lang, api, source, run }: PanelProps) {
  const list = useList<OperatorInstapay>(api.instapayQueue);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const view = (r: OperatorInstapay) => async () => {
    await run(async () => { const link = await api.instapayProofLink(r.id); window.open(link.url, '_blank', 'noopener,noreferrer'); });
  };
  const confirm = (r: OperatorInstapay) => async () => {
    await run(async () => { const next = await api.confirmInstapay(r.id); setNotes((n) => ({ ...n, [r.id]: next.needsSecond ? t.opIpSecond : '' })); list.reload(); });
  };
  const reject = (r: OperatorInstapay) => async () => {
    await run(async () => { await api.rejectInstapay(r.id, (reasons[r.id] ?? '').trim()); list.reload(); });
  };
  return (
    <Card id="op-instapay" title={t.opIpTitle}>
      <p className="muted" role="note">{t.opIpSla}</p>
      {list.error && <p className="error-text">{t.opLoadError}</p>}
      {list.items?.length === 0 && <p className="muted">{t.opIpEmpty}</p>}
      <ul className="wallet-rows op-rows">
        {list.items?.map((r) => {
          const mine = r.createdBy === source.currentUserId;
          return (
            <li key={r.id}>
              <span className="wallet-row-main">
                <b><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{money(r.amountMinor)}</bdi></b> <span className="status-chip" data-status="pending">{t.instapayStates[r.state] ?? r.state}</span>
                <span className="muted op-line"><bdi dir="ltr">{r.workspaceId}</bdi> • {t.opIpLine(t.opIpKinds[r.kind] ?? r.kind, r.reference)} • {r.proofAt ? dateTime(r.proofAt, lang) : ''}</span>
                {r.firstApprover && <span className="muted op-line">{t.opIpFirstBy(r.firstApprover)}</span>}
                {notes[r.id] && <span className="campaign-reason">{notes[r.id]}</span>}
              </span>
              {mine ? <p className="muted">{t.opIpOwn}</p> : (
                <div className="op-actions">
                  <label className="field"><span>{t.opIpReason}</span><input dir="auto" maxLength={300} value={reasons[r.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })} /></label>
                  <div className="campaign-actions">
                    <button type="button" className="btn" onClick={() => void view(r)()}>{t.opIpView}</button>
                    <button type="button" className="btn primary" onClick={() => void confirm(r)()}>{t.opIpConfirm}</button>
                    <button type="button" className="btn quiet" disabled={(reasons[r.id] ?? '').trim().length < 3} onClick={() => void reject(r)()}>{t.opIpReject}</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---- Kill switch (W2-OPS) ----------------------------------------------------------------------------------------------------

function KillSwitchPanel({ t, lang, api, run, fail }: PanelProps) {
  const k = t.ks;
  const [ws, setWs] = useState('');
  const [reason, setReason] = useState('');
  const [st, setSt] = useState<{ id: string; status: OpsStatusDto } | null>(null);
  const [asking, setAsking] = useState<{ action: KillSwitchAction; label: string } | null>(null);

  const load = async (id = ws.trim()) => {
    if (!id) return fail(t.opWorkspace);
    try { setSt({ id, status: await api.opsStatus(id) }); } catch { fail(t.opLoadError); }
  };
  const ask = (action: KillSwitchAction, label: string) => {
    if (!ws.trim()) return fail(t.opWorkspace);
    if (reason.trim().length < 5) return fail(k.reasonShort);
    setAsking({ action, label });
  };
  const doIt = async () => {
    if (!asking) return;
    const { action } = asking;
    setAsking(null);
    if (await run(async () => { await api.killSwitch(ws.trim(), action, reason.trim()); return k.done; })) { setReason(''); await load(); }
  };
  const health = (h: string) => t.numberHealth[h] ?? h;

  return (
    <>
      <Card id="op-ks" title={k.title}>
        <p className="muted">{k.help}</p>
        <form className="wallet-form op-grid" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <label className="field"><span>{k.workspace}</span><input dir="ltr" value={ws} onChange={(e) => setWs(e.target.value)} /></label>
          <label className="field op-wide"><span>{k.reason}</span><input dir="auto" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="settings-actions op-wide"><button type="submit" className="btn">{k.load}</button></div>
        </form>
        {st && (
          <div className="op-ks-status" aria-live="polite">
            <p><span className={st.status.suspended ? 'flag bad' : 'flag'} data-ok={!st.status.suspended}>{st.status.suspended ? k.stateOn : k.stateOff}</span> <span className="muted">{st.status.evicted ? k.evicted : k.notEvicted}</span></p>
            {st.status.integrationsRevokedAt !== null && <p className="muted small">{k.integrationsRevoked(dateTime(st.status.integrationsRevokedAt, lang))}</p>}
            <h3 className="pane-sub">{k.numbers}</h3>
            {st.status.numbers.length === 0 ? <p className="muted">{k.none}</p> : (
              <ul className="wallet-rows">{st.status.numbers.map((n) => <li key={n.phoneNumberId}><span className="wallet-row-main"><bdi dir="ltr">{n.phoneNumberId}</bdi> <span className="flag" data-ok={n.health === 'green'}>{health(n.health)}</span></span></li>)}</ul>
            )}
            {st.status.sharedNumber && <p><b>{k.platform}:</b> <bdi dir="ltr">{st.status.sharedNumber.phoneNumberId}</bdi> <span className="flag" data-ok={st.status.sharedNumber.health === 'green'}>{health(st.status.sharedNumber.health)}</span></p>}
            {st.status.recentActions.length > 0 && (
              <>
                <h3 className="pane-sub">{k.history}</h3>
                <ul className="wallet-rows">{st.status.recentActions.map((a) => <li key={`${a.at}-${a.action}`}><span className="wallet-row-main"><b>{a.action}</b> <span className="muted">• {dateTime(a.at, lang)} • {t.opBy(a.actor)}</span><span className="muted op-line" dir="auto">{a.reason}</span></span></li>)}</ul>
              </>
            )}
          </div>
        )}
        <div className="settings-actions op-ks-actions">
          <button type="button" className="btn danger" onClick={() => ask('suspend', k.suspend)}>{k.suspend}</button>
          <button type="button" className="btn" onClick={() => ask('unsuspend', k.unsuspend)}>{k.unsuspend}</button>
          <button type="button" className="btn danger" onClick={() => ask('campaigns/pause', k.pauseCampaigns)}>{k.pauseCampaigns}</button>
          <button type="button" className="btn danger" onClick={() => ask('shared-number/evict', k.evict)}>{k.evict}</button>
          <button type="button" className="btn" onClick={() => ask('shared-number/readmit', k.readmit)}>{k.readmit}</button>
          <button type="button" className="btn danger" onClick={() => ask('integrations/revoke', k.revoke)}>{k.revoke}</button>
          <button type="button" className="btn" onClick={() => ask('integrations/restore', k.restore)}>{k.restore}</button>
        </div>
        {asking && (
          <div className="confirm-inline" role="group" aria-label={k.confirm(asking.label)}>
            <span>{k.confirm(asking.label)}</span>
            <button type="button" className="btn danger" onClick={() => void doIt()}>{k.yes}</button>
            <button type="button" className="btn ghost" onClick={() => setAsking(null)}>{k.no}</button>
          </div>
        )}
      </Card>
    </>
  );
}

/** T35: open a merchant's workspace read-only. The page asks for a reason and the server writes an audit row for every request. */
function ViewAsCard({ t }: { t: Strings }) {
  const [id, setId] = useState('');
  const ok = /^[A-Za-z0-9_-]{1,64}$/.test(id.trim());
  return (
    <section className="view-as-card" aria-labelledby="view-as-title">
      <h2 id="view-as-title">{t.viewAsTitle}</h2>
      <p className="muted">{t.viewAsHelp}</p>
      <label>{t.viewAsWorkspace}<input value={id} onChange={(e) => setId(e.target.value)} dir="ltr" autoComplete="off" /></label>
      {ok ? <a className="btn" href={`/?store=${encodeURIComponent(id.trim())}&viewAs=1`}>{t.viewAsOpen}</a> : <span className="muted">{t.viewAsNeedsId}</span>}
    </section>
  );
}
