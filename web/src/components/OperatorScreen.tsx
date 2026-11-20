import { ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../data/api';
import type { AutoMode, OperatorAuto, OperatorAutoList, Adjustment, ChangeLogItem, FxRate, KillSwitchAction, MarginOverride, MetaDeletion, OperatorApi, OpsStatusDto, OperatorInstapay, PricingSettings, RateCardVersion, RefundRequest, YearlyRefundQuoteView, OperatorOffboarding, AuditFilter, AuditLogItem } from '../data/billing';
import type { InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { formatMoney, formatSigned } from '../lib/format';
import { parseRates, parseScaled, toMicros } from '../lib/rates';
import { CairoWhen } from './CairoWhen';
import { dateTime } from '../lib/datetime';
import { SharedTemplatesPanel } from './SharedTemplatesPanel';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: OperatorApi; now: () => number };
type Note = { kind: 'alert' | 'status'; lines: string[] } | null;
type Run = (fn: () => Promise<string | void>, lead?: number) => Promise<boolean>;
type PanelProps = { t: Strings; lang: Lang; api: OperatorApi; now: () => number; run: Run; fail: (...lines: string[]) => void; source: InboxSource };

const HOUR = 3_600_000;
const SETTINGS_LEAD_H = 1;
const RATE_LEAD_H = 24;
const TABS = ['pricing', 'rates', 'account', 'queues', 'log', 'shared', 'killswitch', 'offboarding', 'audit'] as const;
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
      if (e.detail === 'duplicate_reference') return t.opIpDupRef;
      if (e.detail === 'held') return t.opIpHeldRefused;
      if (e.detail === 'bad_reference') return t.opIpBadRef;
      if (e.detail === 'bank_reference_required') return t.opIpRefRequired;
      if (e.detail === 'reference_mismatch') return t.opIpRefMismatch;
      if (e.detail === 'releaser_cannot_approve') return t.opIpReleaser;
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
        {tab === 'offboarding' && <OffboardingOpPanel {...panel} />}
        {tab === 'audit' && <AuditPanel {...panel} />}
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
            <span className="op-line">{line(s)}</span><span className="muted op-line" dir="auto">{s.actor === 'system' ? t.opSystemDefault : s.reason}</span></span>
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
          <label className="field"><span>{t.opEffective}</span><input type="datetime-local" value={f.at} onChange={set('at')} /></label><CairoWhen t={t} lang={lang} value={f.at} />
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
          <label className="field"><span>{t.opRatesEffective}</span><input type="datetime-local" value={ratesAt} onChange={(e) => setRatesAt(e.target.value)} /></label><CairoWhen t={t} lang={lang} value={ratesAt} />
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
          <label className="field"><span>{t.opFxEffective}</span><input type="datetime-local" value={fx.at} onChange={(e) => setFx({ ...fx, at: e.target.value })} /></label><CairoWhen t={t} lang={lang} value={fx.at} />
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
          <label className="field"><span>{t.opEffective}</span><input type="datetime-local" value={ov.at} onChange={(e) => setOv({ ...ov, at: e.target.value })} /></label><CairoWhen t={t} lang={lang} value={ov.at} />
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
      <AutoConfirmPanel t={t} lang={lang} api={api} source={source} run={run} now={now} fail={fail} />
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
  const [waiting, setWaiting] = useState<Awaited<ReturnType<typeof api.yearlyRefundRequests>>>([]);
  useEffect(() => { void api.yearlyRefundRequests().then(setWaiting, () => setWaiting([])); }, [api]);
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
      void api.yearlyRefundRequests().then(setWaiting, () => undefined);
      return done.noMoneyOut ? `${t.opYrDone(num(done.shortenedMonths, lang), money(done.debtSettledMinor), money(0))} ${t.opYrNoMoney}` : t.opYrDone(num(done.shortenedMonths, lang), money(done.debtSettledMinor), money(done.cashRefundMinor));
    });
  };
  return (
    <Card id="op-yearly" title={t.opYrTitle}>
      <p className="muted">{t.opYrHelp}</p>
      <h3 className="pane-sub">{t.opYrWaiting}</h3>
      {waiting.length === 0 ? <p className="muted">{t.opYrWaitingEmpty}</p> : (
        <ul className="wallet-rows op-rows">
          {waiting.map((w) => (
            <li key={w.id}>
              <span className="wallet-row-main"><bdi dir="ltr">{w.workspaceId}</bdi> <span className="muted">{t.opYrWaitingLine(num(w.unusedMonths, lang), money(w.refundMinor))}</span></span>
              <button type="button" className="btn ghost" onClick={() => setOrderId(w.orderId)}>{t.opYrUse}</button>
            </li>
          ))}
        </ul>
      )}
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

// ---- Workspace deletion (OFFBOARD-1): request, delete now, take over, cancel; the status and the request's log -----------------------

function OffboardingOpPanel({ t, lang, api }: PanelProps) {
  const [ws, setWs] = useState('');
  const [reason, setReason] = useState('');
  const [accept, setAccept] = useState(false);
  const [needed, setNeeded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [st, setSt] = useState<OperatorOffboarding | null>(null);
  const list = useList<OperatorOffboarding>(api.offboardings);
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const ready = ws.trim() !== '' && reason.trim().length >= 5;

  const show = async () => { try { setSt(await api.offboarding(ws.trim())); } catch { setSt(null); } };
  const request = (immediate: boolean) => async () => {
    setMsg(null);
    try {
      await api.requestOffboarding(ws.trim(), { reason: reason.trim(), ...(immediate ? { immediate: true as const } : {}), ...(accept ? { acceptWriteOff: true as const } : {}) });
      setNeeded(false); setAccept(false);
      await show(); list.reload();
    } catch (e) {
      if (e instanceof ApiError && e.detail === 'write_off_required') { setNeeded(true); setMsg(t.offOpWriteOffNeeded(money(e.amountMinor ?? 0))); } else setMsg(t.offOpFailed);
    }
  };
  const cancel = async () => {
    setMsg(null);
    try { await api.cancelOffboarding(ws.trim(), reason.trim()); await show(); list.reload(); } catch { setMsg(t.offOpFailed); }
  };
  const approve = async () => {
    setMsg(null);
    try { await api.approveOffboarding(ws.trim(), reason.trim()); setMsg(t.offOpApproved); await show(); list.reload(); } catch { setMsg(t.offOpFailed); }
  };
  const release = async () => {
    setMsg(null);
    try { await api.releaseOffboardingHold(ws.trim(), reason.trim()); await show(); list.reload(); } catch { setMsg(t.offOpFailed); }
  };
  const heldKey = st?.lastError?.startsWith('held:') ? st.lastError.slice(5) : null;

  return (
    <>
      <Card id="op-off" title={t.offOpTitle}>
        <form className="wallet-form op-grid" onSubmit={(e) => { e.preventDefault(); void show(); }}>
          <label className="field"><span>{t.offOpWorkspace}</span><input dir="ltr" value={ws} onChange={(e) => setWs(e.target.value)} /></label>
          <label className="field op-wide"><span>{t.offOpReason}</span><input dir="auto" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="settings-actions op-wide"><button type="submit" className="btn" disabled={!ws.trim()}>{t.offOpLoad}</button></div>
        </form>
        {needed && <label className="field check"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> <span>{t.offOpAccept}</span></label>}
        <div className="settings-actions">
          <button type="button" className="btn danger" disabled={!ready} onClick={() => void request(false)()}>{t.offOpRequest}</button>
          <button type="button" className="btn danger" disabled={!ready} onClick={() => void request(true)()}>{t.offOpNow}</button>
          {st?.state === 'pending' && <button type="button" className="btn" disabled={!ready} onClick={() => void cancel()}>{t.offCancel}</button>}
          {st?.needsSecondApproval && <button type="button" className="btn" disabled={!ready} onClick={() => void approve()}>{t.offOpApprove}</button>}
          {heldKey === 'suspended_abuse' && <button type="button" className="btn" disabled={!ready} onClick={() => void release()}>{t.offOpRelease}</button>}
        </div>
        {msg && <p role="alert" className="error-text">{msg}</p>}
        {st && (
          <div aria-live="polite">
            <p><span className="flag" data-ok={st.state !== 'running'}>{t.offOpState[st.state] ?? st.state}</span> <span className="muted">{st.requestedRole === 'operator' ? t.opBy(st.requestedBy) : st.requestedBy}</span></p>
            {st.state === 'pending' && <p>{t.offPending(dateTime(st.executeAfter, lang))}</p>}
            {st.writeOffMinor > 0 && <p className="muted">{t.offWriteOff(money(st.writeOffMinor))}</p>}
            {st.stepsDone.length > 0 && <p className="muted"><b>{t.offOpSteps}:</b> <bdi dir="ltr">{st.stepsDone.join(', ')}</bdi></p>}
            {st.needsSecondApproval && <p className="error-text" role="note">{t.offOpApproval}</p>}
            {st.lastError && <p className="error-text"><bdi dir="ltr">{st.lastError}</bdi>{heldKey && t.offOpHeldWhy[heldKey] ? <> {t.offOpHeldWhy[heldKey]}</> : null}</p>}
            <h3 className="pane-sub">{t.offOpLog}</h3>
            <ul className="wallet-rows">
              {(st.log ?? []).map((l, i) => <li key={i}><span className="wallet-row-main"><b>{l.action}</b> <span className="muted">• {dateTime(l.at, lang)} • <bdi dir="ltr">{l.actor}</bdi></span></span>{l.reason && <p className="muted" dir="auto">{l.reason}</p>}</li>)}
            </ul>
          </div>
        )}
      </Card>
      <Card id="op-off-list" title={t.offOpListTitle}>
        {list.error && <p className="error-text">{t.opLoadError}</p>}
        {list.items?.length === 0 && <p className="muted">{t.offOpNone}</p>}
        <ul className="wallet-rows">
          {list.items?.map((o) => <li key={o.workspaceId}><span className="wallet-row-main"><bdi dir="ltr">{o.workspaceId}</bdi> <span className="muted">• {t.offOpState[o.state] ?? o.state} • {dateTime(o.executeAfter, lang)}</span></span></li>)}
        </ul>
      </Card>
    </>
  );
}

// ---- Action log (T8): who did what to which ids ---------------------------------------------------------------------------------

function AuditPanel({ t, lang, api }: PanelProps) {
  const [form, setForm] = useState({ workspaceId: '', actor: '', action: '' });
  const [filter, setFilter] = useState<AuditFilter>({});
  const [items, setItems] = useState<AuditLogItem[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback((f: AuditFilter, append: boolean) => {
    api.auditLog(f).then((x) => { setItems((cur) => (append && cur ? [...cur, ...x] : x)); setError(false); }, () => setError(true));
  }, [api]);
  useEffect(() => { load(filter, false); }, [filter, load]);
  const apply = (e: FormEvent) => { e.preventDefault(); setFilter({ ...(form.workspaceId.trim() ? { workspaceId: form.workspaceId.trim() } : {}), ...(form.actor.trim() ? { actor: form.actor.trim() } : {}), ...(form.action.trim() ? { action: form.action.trim() } : {}) }); };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Card id="op-audit" title={t.opAuditTitle}>
      <p className="muted">{t.opAuditIntro}</p>
      <form className="wallet-form op-inline" onSubmit={apply}>
        <label className="field"><span>{t.opAuditWorkspace}</span><input dir="ltr" value={form.workspaceId} onChange={set('workspaceId')} /></label>
        <label className="field"><span>{t.opAuditActor}</span><input dir="ltr" value={form.actor} onChange={set('actor')} /></label>
        <label className="field"><span>{t.opAuditAction}</span><input dir="ltr" value={form.action} onChange={set('action')} /></label>
        <button type="submit" className="btn">{t.opAuditApply}</button>
      </form>
      {error && <p className="error-text">{t.opLoadError}</p>}
      {items?.length === 0 && <p className="muted">{t.opAuditEmpty}</p>}
      <ul className="wallet-rows op-rows">
        {items?.map((l) => (
          <li key={l.id}>
            <span className="wallet-row-main"><span className="muted">{dateTime(l.at, lang)}</span> • <b><bdi dir="ltr">{l.actor}</bdi></b> <span className="muted">({l.actorRole})</span> • <bdi dir="ltr">{l.action}</bdi>{l.status === 403 && <span className="error-text"> • {t.opAuditDenied}</span>}</span>
            <span className="muted">{l.workspaceId && <bdi dir="ltr">{l.workspaceId}</bdi>}{l.targetType && <> • <bdi dir="ltr">{l.targetType}={l.targetId}</bdi></>}</span>
          </li>
        ))}
      </ul>
      {items && items.length >= 100 && <button type="button" className="btn" onClick={() => load({ ...filter, before: items[items.length - 1]!.id }, true)}>{t.opAuditMore}</button>}
    </Card>
  );
}

// ---- InstaPay transfers: review the proof, confirm or reject --------------------------------------------------------------------

function InstapayReview({ t, lang, api, source, run }: PanelProps) {
  const list = useList<OperatorInstapay>(api.instapayQueue);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [releases, setReleases] = useState<Record<string, string>>({});
  const [noRef, setNoRef] = useState<Record<string, boolean>>({});
  const [noRefWhy, setNoRefWhy] = useState<Record<string, string>>({});
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const view = (r: OperatorInstapay) => async () => {
    await run(async () => { const link = await api.instapayProofLink(r.id); window.open(link.url, '_blank', 'noopener,noreferrer'); });
  };
  const confirm = (r: OperatorInstapay) => async () => {
    await run(async () => { const ref = (refs[r.id] ?? '').trim(); const next = noRef[r.id] ? await api.confirmInstapay(r.id, undefined, (noRefWhy[r.id] ?? '').trim()) : await api.confirmInstapay(r.id, ref); setNotes((n) => ({ ...n, [r.id]: next.needsSecond ? t.opIpSecond : '' })); list.reload(); });
  };
  const release = (r: OperatorInstapay) => async () => {
    await run(async () => { await api.releaseInstapay(r.id, (releases[r.id] ?? '').trim()); list.reload(); });
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
                {r.contestedAt && <span className="campaign-reason op-line" role="note">{t.opIpContested(dateTime(r.contestedAt, lang))}{r.contestNote ? <> • <span dir="auto">{r.contestNote}</span></> : null}</span>}
                {r.heldReason && <span className="error-text op-line" role="note">{t.opIpHeld(t.opIpHeldReasons[r.heldReason] ?? r.heldReason)}{r.heldOf ? <> • <bdi dir="ltr">{t.opIpHeldOf(r.heldOf)}</bdi></> : null}</span>}
                {notes[r.id] && <span className="campaign-reason">{notes[r.id]}</span>}
              </span>
              {mine ? <p className="muted">{t.opIpOwn}</p> : (
                <div className="op-actions">
                  <label className="field"><span>{t.opIpReason}</span><input dir="auto" maxLength={300} value={reasons[r.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })} /></label>
                  {r.heldReason && <label className="field"><span>{t.opIpReleaseReason}</span><input dir="auto" maxLength={300} value={releases[r.id] ?? ''} onChange={(e) => setReleases({ ...releases, [r.id]: e.target.value })} /></label>}
                  {!r.heldReason && !noRef[r.id] && <label className="field"><span>{t.opIpBankRef}</span><input dir="ltr" maxLength={60} value={refs[r.id] ?? ''} onChange={(e) => setRefs({ ...refs, [r.id]: e.target.value })} /></label>}
                  {!r.heldReason && <label className="field check"><input type="checkbox" checked={!!noRef[r.id]} onChange={(e) => setNoRef({ ...noRef, [r.id]: e.target.checked })} /> <span>{t.opIpNoRef}</span></label>}
                  {!r.heldReason && noRef[r.id] && <label className="field"><span>{t.opIpNoRefReason}</span><input dir="auto" maxLength={300} value={noRefWhy[r.id] ?? ''} onChange={(e) => setNoRefWhy({ ...noRefWhy, [r.id]: e.target.value })} /></label>}
                  <div className="campaign-actions">
                    <button type="button" className="btn" onClick={() => void view(r)()}>{t.opIpView}</button>
                    {r.heldReason
                      ? <button type="button" className="btn primary" disabled={(releases[r.id] ?? '').trim().length < 5} onClick={() => void release(r)()}>{t.opIpRelease}</button>
                      : <button type="button" className="btn primary" disabled={noRef[r.id] ? (noRefWhy[r.id] ?? '').trim().length < 5 : (refs[r.id] ?? '').trim().length < 4} onClick={() => void confirm(r)()}>{t.opIpConfirm}</button>}
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

// ---- InstaPay auto-confirm: verdicts with every reason, "not received", and the two kill switches -----------------------------------------------

function AutoConfirmPanel({ t, lang, api, run }: PanelProps) {
  const a = t.opAuto;
  const [data, setData] = useState<OperatorAutoList | null>(null);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState<AutoMode>('off');
  const [modeWhy, setModeWhy] = useState('');
  const [why, setWhy] = useState<Record<string, string>>({});
  const reload = useCallback(() => { api.autoConfirmations().then((d) => { setData(d); setMode(d.mode); setError(false); }, () => setError(true)); }, [api]);
  useEffect(reload, [reload]);
  const money = (m: number | null) => (m === null ? '' : formatMoney(m, 'EGP', lang));
  const revert = (r: OperatorAuto) => async () => { await run(async () => { await api.revertAutoConfirmed(r.requestId, (why[r.requestId] ?? '').trim()); reload(); }); };
  const toggleWs = (r: OperatorAuto, enabled: boolean) => async () => { await run(async () => { await api.setWorkspaceAuto(r.workspaceId, enabled, (why[r.requestId] ?? '').trim()); reload(); }); };
  return (
    <Card id="op-instapay-auto" title={a.title}>
      <p className="muted" role="note">{a.note}</p>
      {error && <p className="error-text">{t.opLoadError}</p>}
      {data && !data.ready.ready && <p className="error-text" role="note">{a.notReady(data.ready.missing)}</p>}
      <div className="op-actions">
        <label className="field"><span>{a.mode}</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as AutoMode)}>
            {(['off', 'shadow', 'live'] as const).map((m) => <option key={m} value={m}>{a.modes[m]}</option>)}
          </select>
        </label>
        <label className="field"><span>{a.reason}</span><input dir="auto" maxLength={300} value={modeWhy} onChange={(e) => setModeWhy(e.target.value)} /></label>
        <div className="campaign-actions">
          <button type="button" className="btn primary" disabled={modeWhy.trim().length < 5 || mode === data?.mode} onClick={() => void run(async () => { await api.setAutoMode(mode, modeWhy.trim()); setModeWhy(''); reload(); })}>{a.apply}</button>
        </div>
      </div>
      {data?.items.length === 0 && <p className="muted">{a.empty}</p>}
      <ul className="wallet-rows op-rows">
        {data?.items.map((r) => (
          <li key={r.requestId}>
            <span className="wallet-row-main">
              <b><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{money(r.amountMinor)}</bdi></b> <span className="status-chip" data-status={r.state === 'auto_confirmed' ? 'done' : 'pending'}>{a.states[r.state] ?? r.state}</span>
              <span className="muted op-line">{r.workspaceName ?? ''} <bdi dir="ltr">{r.workspaceId}</bdi>{r.isFirstPayment ? ` • ${a.first}` : ''}</span>
              {r.reasons.length > 0 && <span className="error-text op-line" role="note">{r.reasons.map((c) => a.reasons[c] ?? c).join(' • ')}</span>}
              {r.revertedAt !== null && r.graceUntil !== null && <span className="muted op-line">{a.reverted(dateTime(r.graceUntil, lang))}</span>}
            </span>
            <div className="op-actions">
              <label className="field"><span>{a.revertReason}</span><input dir="auto" maxLength={300} value={why[r.requestId] ?? ''} onChange={(e) => setWhy({ ...why, [r.requestId]: e.target.value })} /></label>
              <div className="campaign-actions">
                {r.state === 'auto_confirmed' && <button type="button" className="btn quiet" disabled={(why[r.requestId] ?? '').trim().length < 5} onClick={() => void revert(r)()}>{a.notReceived}</button>}
                <button type="button" className="btn" disabled={(why[r.requestId] ?? '').trim().length < 5} onClick={() => void toggleWs(r, false)()}>{a.workspaceOff}</button>
                <button type="button" className="btn" disabled={(why[r.requestId] ?? '').trim().length < 5} onClick={() => void toggleWs(r, true)()}>{a.workspaceOn}</button>
              </div>
            </div>
          </li>
        ))}
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
