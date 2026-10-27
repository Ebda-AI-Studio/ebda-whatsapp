import { Download, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { StatementDto } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { InstapayCreated, InstapayRequest, InstapayView, PackageDto, RefundRequest, TopupDto, WalletApi, WalletDto } from '../data/billing';
import type { InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { formatMoney, formatSigned } from '../lib/format';
import { useFocusOn } from '../lib/useFocusOn';
import { useLoad } from '../lib/useLoad';
import { dateTime } from './CampaignsScreen';
import { LoadError } from './LoadError';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: WalletApi; now: () => number; go?: (url: string) => void };

const MIN_TOPUP_MINOR = 1000;
const MAX_TOPUP_MINOR = 5_000_000;
const MIN_REFUND_MINOR = 5000;
const PENDING_KEY = 'wallet.pendingTopup';
const PACKAGE_PENDING_KEY = 'wallet.pendingPackage';
const PENDING_TTL_MS = 3 * 3_600_000;
const POLL_MS = 8000;

type Pending = { orderId: string; amountMinor: number; before: number; at: number };

// A top-up leaves the page for the card form, so the order being waited on has to survive the round trip. Storage may be blocked: then we just wait less well.
const readPending = (now: number): Pending | null => {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as Pending | null;
    return p && typeof p.orderId === 'string' && now - p.at < PENDING_TTL_MS ? p : null;
  } catch { return null; }
};
const writePending = (p: Pending | null) => {
  try { if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p)); else localStorage.removeItem(PENDING_KEY); } catch { /* storage blocked */ }
};

/** "120.5" → 12050 piasters. Strings only: no float touches money. Arabic-Indic digits are accepted. */
export function egpToMinor(text: string): number | null {
  const ascii = text.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(ascii);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

export function monthOptions(now: number, count = 12): string[] {
  const d = new Date(now);
  return Array.from({ length: count }, (_v, i) => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

const monthLabel = (month: string, lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1));

export function WalletScreen({ t, lang, source, api, now, go = (u) => window.location.assign(u) }: Props) {
  const [wallet, setWallet] = useState<WalletDto | null | 'error'>(null);
  const owner = source.role === 'owner';
  const canSeeStatement = source.role !== 'staff';
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const signed = (m: number) => formatSigned(m, lang);

  const [pending, setPending] = useState<Pending | null>(() => readPending(now()));
  const [topupNote, setTopupNote] = useState<'waiting' | 'arrived' | 'failed' | null>(() => (readPending(now()) ? 'waiting' : null));
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // One check settles a waiting top-up. The order's own state decides (`paid`: the server credits before it marks paid; `failed`/`expired`: nothing taken).
  // Only when the order cannot be asked does the balance growing by the amount stand in for it: other credits (a refund, an adjustment) also move it.
  const check = useCallback(async () => {
    let w: WalletDto;
    // A failed first load is an error with Retry; a failed later poll keeps the wallet already on screen.
    try { w = await api.wallet(); setWallet(w); } catch { setWallet((cur) => cur ?? 'error'); return; }
    const p = pendingRef.current;
    if (!p) return;
    let verdict: 'arrived' | 'failed' | null = null;
    try {
      const s = await api.topupState(p.orderId);
      if (s.state === 'paid') verdict = 'arrived';
      else if (s.state === 'failed' || s.state === 'expired') verdict = 'failed';
    } catch {
      if (w.balanceMinor >= p.before + p.amountMinor) verdict = 'arrived';
    }
    if (verdict) { writePending(null); setPending(null); setTopupNote(verdict); }
    if (verdict === 'arrived') void api.wallet().then(setWallet, () => undefined); // show the credited balance
  }, [api]);

  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => void check(), POLL_MS);
    const on = () => void check();
    window.addEventListener('focus', on);
    document.addEventListener('visibilitychange', on);
    return () => { clearInterval(id); window.removeEventListener('focus', on); document.removeEventListener('visibilitychange', on); };
  }, [pending, check]);

  if (wallet === null) return <main className="screen"><div className="placeholder">…</div></main>;
  if (wallet === 'error') return <main className="screen"><div className="placeholder"><p role="alert">{t.walletLoadError} <button type="button" className="btn ghost" onClick={() => void check()}>{t.retry}</button></p></div></main>;

  const cardOnly = wallet.funding.length > 0 && wallet.funding.every((f) => f.funding === 'merchant_card');
  const walletPays = wallet.funding.some((f) => f.funding === 'platform_line');
  const paused = wallet.availableMinor <= 0 && walletPays;

  return (
    <main className="screen" aria-labelledby="wallet-title">
      <header className="screen-head">
        <Wallet size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="wallet-title">{t.walletTitle}</h1>
      </header>
      <div className="settings wide wallet-layout">
        <p className="muted intro">{t.walletIntro}</p>

        <section className="wallet-balance" aria-labelledby="w-balance-title">
          <h2 id="w-balance-title">{t.wBalanceTitle}</h2>
          <p className="wallet-available"><span className="wallet-label">{t.wAvailable}</span><b>{money(wallet.availableMinor)}</b></p>
          <dl className="wallet-figures">
            <div><dt>{t.wBalance}</dt><dd>{money(wallet.balanceMinor)}</dd></div>
            <div><dt>{t.wHeld}</dt><dd>{money(wallet.heldMinor)}</dd></div>
            <div><dt>{t.wAiCredits}</dt><dd>{num(wallet.aiCredits.available, lang)}</dd></div>
          </dl>
          {wallet.debtMinor > 0 && <p className="wallet-debt">{t.wDebtLine(money(wallet.debtMinor))}</p>}
          {paused && <p className="wallet-debt">{t.wMarketingPaused}</p>}
          <p className="muted">{t.wOverdraft(money(wallet.creditLimitMinor))}</p>
        </section>

        <div className="wallet-cols">
          <section className="wallet-card" aria-labelledby="w-funding-title">
            <h2 id="w-funding-title">{t.wFundingTitle}</h2>
            {wallet.funding.length === 0 ? <p className="muted">{t.wFundingNone}</p> : (
              <ul className="wallet-list">
                {wallet.funding.map((f) => (
                  <li key={f.phoneNumberId}>
                    <b><bdi dir="ltr">{f.displayPhone ?? f.phoneNumberId}</bdi></b>
                    <span className="flag" data-ok={f.funding === 'merchant_card'}>{f.funding === 'merchant_card' ? t.opFundingCard : f.funding === 'unknown' ? t.opFundingUnknown : t.opFundingWallet}</span>
                    <p className="muted">{f.funding === 'merchant_card' ? t.wFundingCard : f.funding === 'unknown' ? t.wFundingUnknown : t.wFundingWallet}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="wallet-card" aria-labelledby="w-plan-title">
            <h2 id="w-plan-title">{t.wPlanTitle}</h2>
            {wallet.plan === null ? <p className="muted">{t.wPlanNone}</p> : (
              <>
                <p><b><bdi dir="ltr">{wallet.plan.packageId}</bdi></b> <span className="status-chip" data-status={wallet.plan.status === 'active' ? 'running' : wallet.plan.status === 'trialing' ? 'scheduled' : wallet.plan.status === 'past_due' ? 'paused' : 'cancelled'}>{t.planStatus[wallet.plan.status]}</span></p>
                <p className="muted">{t.wPlanEnds(dateTime(wallet.plan.periodEnd, lang))}</p>
                {wallet.plan.status === 'past_due' && <p className="campaign-reason">{t.wPlanPastDue}</p>}
              </>
            )}
          </section>
        </div>

        {owner && (
          <TopupCard t={t} lang={lang} api={api} wallet={wallet} pending={pending} note={topupNote} go={go} now={now}
            onStarted={(p) => { writePending(p); setPending(p); setTopupNote('waiting'); }} cardOnly={cardOnly} />
        )}
        {owner && <PackagesCard t={t} lang={lang} api={api} go={go} now={now} onActivated={() => void api.wallet().then(setWallet, () => undefined)} />}
        {owner && <InstapayCard t={t} lang={lang} api={api} />}
        {canSeeStatement && <StatementCard t={t} lang={lang} api={api} now={now} />}
        {owner && <RefundCard t={t} lang={lang} api={api} />}
      </div>
    </main>
  );
}

function TopupCard({ t, lang, api, wallet, pending, note, go, now, onStarted, cardOnly }: {
  t: Strings; lang: Lang; api: WalletApi; wallet: WalletDto; pending: Pending | null; note: 'waiting' | 'arrived' | 'failed' | null;
  go: (url: string) => void; now: () => number; onStarted: (p: Pending) => void; cardOnly: boolean;
}) {
  const [amount, setAmount] = useState('');
  const [order, setOrder] = useState<TopupDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const signed = (m: number) => formatSigned(m, lang);

  if (!wallet.topupsEnabled) {
    return <section className="wallet-card" aria-labelledby="w-topup-title"><h2 id="w-topup-title">{t.wTopupTitle}</h2><p className="muted">{t.wTopupOff}</p></section>;
  }

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const minor = egpToMinor(amount);
    if (minor === null || minor < MIN_TOPUP_MINOR || minor > MAX_TOPUP_MINOR) { setError(t.wTopupBadAmount); return; }
    setBusy(true);
    setError(null);
    try { setOrder(await api.topup(minor)); } catch { setError(t.wTopupError); } finally { setBusy(false); }
  };
  const pay = () => {
    // Only an https checkout page is ever opened; anything else from the server is refused, never followed.
    let ok = false;
    try { ok = !!order?.checkoutUrl && new URL(order.checkoutUrl).protocol === 'https:'; } catch { ok = false; }
    if (!order || !order.checkoutUrl || !ok) { setError(t.wTopupError); return; }
    onStarted({ orderId: order.orderId, amountMinor: order.amountMinor, before: wallet.balanceMinor, at: now() });
    go(order.checkoutUrl);
  };

  return (
    <section className="wallet-card" aria-labelledby="w-topup-title">
      <h2 id="w-topup-title">{t.wTopupTitle}</h2>
      {cardOnly && <p className="muted">{t.wFundingCard}</p>}
      <form className="wallet-form" onSubmit={(e) => void start(e)} noValidate>
        <label className="field">
          <span>{t.wTopupAmount}</span>
          <input inputMode="decimal" dir="ltr" value={amount} aria-describedby="w-topup-hint" onChange={(e) => { setAmount(e.target.value); setOrder(null); setError(null); }} />
        </label>
        <small id="w-topup-hint" className="muted"><span>{t.wTopupHint}</span> <span>{t.wTopupRange(money(MIN_TOPUP_MINOR), money(MAX_TOPUP_MINOR))}</span></small>
        {!order && <div className="settings-actions"><button type="submit" className="btn primary" disabled={busy}>{t.wTopupContinue}</button></div>}
      </form>
      {order && (
        <div className="wallet-summary">
          <p>{t.wTopupSummary(money(order.amountMinor), money(order.feeMinor), money(order.totalMinor))}</p>
          <button type="button" className="btn gold" onClick={pay}>{t.wTopupPay}</button>
        </div>
      )}
      {error && <p role="alert" className="error-text">{error}</p>}
      {note === 'waiting' && pending && <p role="status" className="muted">{t.wTopupWaiting}</p>}
      {note === 'arrived' && <p role="status" className="wallet-ok">{t.wTopupArrived}</p>}
      {note === 'failed' && <p role="alert" className="error-text">{t.wTopupFailed}</p>}
    </section>
  );
}

type PendingPackage = { orderId: string; at: number };
const readPendingPackage = (now: number): PendingPackage | null => {
  try {
    const p = JSON.parse(localStorage.getItem(PACKAGE_PENDING_KEY) ?? 'null') as PendingPackage | null;
    return p && typeof p.orderId === 'string' && now - p.at < PENDING_TTL_MS ? p : null;
  } catch { return null; }
};
const writePendingPackage = (p: PendingPackage | null) => {
  try { if (p) localStorage.setItem(PACKAGE_PENDING_KEY, JSON.stringify(p)); else localStorage.removeItem(PACKAGE_PENDING_KEY); } catch { /* storage blocked */ }
};

/** Self-serve packages (owner). Hidden while the server has the switch off (404). The order's own state decides when the package is active, never the return from the card form. */
function PackagesCard({ t, lang, api, go, now, onActivated }: { t: Strings; lang: Lang; api: WalletApi; go: (url: string) => void; now: () => number; onActivated: () => void }) {
  const [list, setList] = useState<PackageDto[] | 'loading' | 'off' | 'error'>('loading');
  const [pending, setPending] = useState<PendingPackage | null>(() => readPendingPackage(now()));
  const [note, setNote] = useState<'waiting' | 'activated' | 'failed' | null>(() => (readPendingPackage(now()) ? 'waiting' : null));
  const [error, setError] = useState(false);
  const [queued, setQueued] = useState(false); // WA-YEARLY-SWITCH-2: a queued period cannot be switched
  const [busy, setBusy] = useState<string | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const money = (m: number) => formatMoney(m, 'EGP', lang);

  const load = useCallback(() => {
    setList('loading');
    api.packages().then(setList, (e: unknown) => setList(e instanceof ApiError && e.status === 404 ? 'off' : 'error'));
  }, [api]);
  useEffect(load, [load]);

  const check = useCallback(async () => {
    const p = pendingRef.current;
    if (!p) return;
    try {
      const s = await api.packageOrderState(p.orderId);
      const verdict = s.state === 'paid' ? 'activated' : s.state === 'failed' || s.state === 'expired' || s.state === 'refunded' ? 'failed' : null;
      if (verdict) { writePendingPackage(null); setPending(null); setNote(verdict); if (verdict === 'activated') onActivated(); }
    } catch { /* keep waiting; the next poll asks again */ }
  }, [api, onActivated]);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => void check(), POLL_MS);
    const on = () => void check();
    window.addEventListener('focus', on);
    document.addEventListener('visibilitychange', on);
    return () => { clearInterval(id); window.removeEventListener('focus', on); document.removeEventListener('visibilitychange', on); };
  }, [pending, check]);

  if (list === 'off') return null;

  const buy = async (id: string) => {
    setBusy(id);
    setError(false);
    setQueued(false);
    try {
      const o = await api.buyPackage(id);
      // Only an https checkout page is ever opened; anything else from the server is refused, never followed.
      let ok = false;
      try { ok = !!o.checkoutUrl && new URL(o.checkoutUrl).protocol === 'https:'; } catch { ok = false; }
      if (!ok || !o.checkoutUrl) { setError(true); return; }
      const p = { orderId: o.orderId, at: now() };
      writePendingPackage(p);
      setPending(p);
      setNote('waiting');
      go(o.checkoutUrl);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'yearly_queued') setQueued(true); else setError(true);
    } finally { setBusy(null); }
  };

  return (
    <section className="wallet-card" aria-labelledby="w-packages-title">
      <h2 id="w-packages-title">{t.wPackagesTitle}</h2>
      <p className="muted">{t.wPackagesIntro}</p>
      <p className="muted">{t.wYearlyUpgradeNote}</p>
      {list === 'loading' ? <p className="muted">…</p>
        : list === 'error' ? <p role="alert" className="error-text">{t.wPackagesError} <button type="button" className="btn ghost" onClick={load}>{t.retry}</button></p>
        : list.length === 0 ? <p className="muted">{t.wPackagesEmpty}</p> : (
          <ul className="wallet-list">
            {list.map((p) => (
              <li key={p.id}>
                <b dir="auto">{p.name}</b> <span>{money(p.priceMinor)}</span>
                <p className="muted">{t.wPackageCredits(num(p.aiCredits, lang))}</p>
                <p className="muted">{t.wPackageMembers(num(p.maxMembers, lang))}</p>
                {p.periodMonths > 1 && <p className="muted">{t.wPackageYearly(num(p.periodMonths, lang))}</p>}
                <ul className="muted">{p.features.filter((k) => k in t.wPackageFeature).map((k) => <li key={k}>{t.wPackageFeature[k]}</li>)}</ul>
                <button type="button" className="btn gold" disabled={busy !== null || pending !== null} onClick={() => void buy(p.id)}>{t.wPackageBuy}</button>
              </li>
            ))}
          </ul>
        )}
      {queued && <p role="alert" className="error-text">{t.wYearlyQueued}</p>}
      {error && <p role="alert" className="error-text">{t.wPackageError}</p>}
      {note === 'waiting' && pending && <p role="status" className="muted">{t.wPackageWaiting}</p>}
      {note === 'activated' && <p role="status" className="wallet-ok">{t.wPackageActivated}</p>}
      {note === 'failed' && <p role="alert" className="error-text">{t.wPackageFailed}</p>}
    </section>
  );
}

function StatementCard({ t, lang, api, now }: { t: Strings; lang: Lang; api: WalletApi; now: () => number }) {
  const months = useMemo(() => monthOptions(now()), [now]);
  const [month, setMonth] = useState(months[0]!);
  const [st, setSt] = useState<StatementDto | null | 'error'>(null);
  const [csvError, setCsvError] = useState(false);
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const signed = (m: number) => formatSigned(m, lang);

  useEffect(() => {
    let live = true;
    setSt(null);
    api.statement(month).then((s) => { if (live) setSt(s); }, () => { if (live) setSt('error'); });
    return () => { live = false; };
  }, [api, month]);

  const download = async () => {
    setCsvError(false);
    try {
      const url = await api.statementCsv(month);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${month}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { setCsvError(true); }
  };

  const totalLine = (label: string, v: { count: number; amountMinor: number }) => (
    <li key={label}><span>{label}</span><span className="wallet-count">{t.wCount(num(v.count, lang))}</span><b><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{signed(v.amountMinor)}</bdi></b></li>
  );

  return (
    <section className="wallet-card" aria-labelledby="w-statement-title">
      <div className="wallet-card-head">
        <h2 id="w-statement-title">{t.wStatementTitle}</h2>
        <label className="field wallet-month"><span className="vh">{t.wMonth}</span>
          <select aria-label={t.wMonth} value={month} onChange={(e) => setMonth(e.target.value)}>{months.map((m) => <option key={m} value={m}>{monthLabel(m, lang)}</option>)}</select>
        </label>
        <button type="button" className="btn" onClick={() => void download()}><Download size={16} aria-hidden />{t.wCsv}</button>
      </div>
      {csvError && <p role="alert" className="error-text">{t.wCsvError}</p>}
      {st === null ? <p className="muted">…</p> : st === 'error' ? <p role="alert" className="error-text">{t.wStatementError}</p> : (
        <>
          <dl className="wallet-figures">
            <div><dt>{t.wOpening}</dt><dd>{money(st.openingMinor)}</dd></div>
            <div><dt>{t.wClosing}</dt><dd>{money(st.closingMinor)}</dd></div>
          </dl>
          {st.rows.length === 0 ? <p className="muted">{t.wNoRows}</p> : (
            <>
              <div className="wallet-cols">
                <div>
                  <h3 className="pane-sub">{t.wByKind}</h3>
                  <ul className="wallet-totals" aria-label={t.wByKind}>{Object.entries(st.totalsByKind).map(([k, v]) => totalLine(t.ledgerKinds[k] ?? k, v))}</ul>
                </div>
                <div>
                  <h3 className="pane-sub">{t.wByCategory}</h3>
                  <ul className="wallet-totals" aria-label={t.wByCategory}>{Object.entries(st.totalsByCategory).map(([k, v]) => totalLine(t.billCategories[k] ?? k, v))}</ul>
                </div>
              </div>
              <h3 className="pane-sub">{t.wRows}</h3>
              <ul className="wallet-rows" aria-label={t.wRows}>
                {st.rows.map((r) => (
                  <li key={r.ref}>
                    <span className="wallet-row-main"><b>{t.ledgerKinds[r.kind] ?? r.kind}</b>{r.category && <span className="muted"> • {t.billCategories[r.category] ?? r.category}</span>}{r.note && <span className="muted" dir="auto"> • {r.note}</span>}</span>
                    <span className="muted wallet-row-date">{dateTime(r.at, lang)}</span>
                    <b className="wallet-amount" data-sign={r.amountMinor < 0 ? 'out' : 'in'}><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{signed(r.amountMinor)}</bdi></b>
                  </li>
                ))}
              </ul>
              {st.truncated && <p className="muted">{t.wTruncated}</p>}
            </>
          )}
          {st.cardCosts.length > 0 && (
            <>
              <h3 className="pane-sub">{t.wCardCosts}</h3>
              <ul className="wallet-totals">
                {st.cardCosts.map((c) => <li key={c.category}>{t.wCardCostLine(t.billCategories[c.category] ?? c.category, num(c.count, lang), new Intl.NumberFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c.usdMicros / 1_000_000))}</li>)}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function RefundCard({ t, lang, api }: { t: Strings; lang: Lang; api: WalletApi }) {
  const list = useCallback(() => api.refundRequests(), [api]);
  const { data: items, setData: setItems, error: loadFailed, reload } = useLoad<RefundRequest[]>(list);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ kind: 'alert' | 'status'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const msgRef = useFocusOn<HTMLParagraphElement>(msg);
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const signed = (m: number) => formatSigned(m, lang);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const minor = egpToMinor(amount);
    if (minor === null || minor < MIN_REFUND_MINOR) { setMsg({ kind: 'alert', text: t.wRefundBelowMin }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.requestRefund(minor, note);
      setItems((xs) => [r, ...(xs ?? [])]);
      setAmount(''); setNote('');
      setMsg({ kind: 'status', text: t.wRefundSent });
    } catch (err) {
      setMsg({ kind: 'alert', text: (err instanceof ApiError && err.detail && t.refundReasons[err.detail]) || t.opFailed });
    } finally { setBusy(false); }
  };

  return (
    <section className="wallet-card" aria-labelledby="w-refund-title">
      <h2 id="w-refund-title">{t.wRefundTitle}</h2>
      <p className="muted">{t.wRefundRules}</p>
      <form className="wallet-form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="field"><span>{t.wRefundAmount}</span><input inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field"><span>{t.wRefundNote}</span><textarea dir="auto" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="settings-actions"><button type="submit" className="btn primary" disabled={busy}>{t.wRefundSend}</button></div>
      </form>
      {msg && <p ref={msgRef} tabIndex={-1} role={msg.kind} className={msg.kind === 'alert' ? 'error-text' : 'wallet-ok'}>{msg.text}</p>}
      <h3 className="pane-sub">{t.wRefundPast}</h3>
      {loadFailed ? <LoadError t={t} onRetry={reload} />
        : items === null ? <p className="muted">…</p> : items.length === 0 ? <p className="muted">{t.wRefundEmpty}</p> : (
        <ul className="wallet-rows" aria-label={t.wRefundPast}>
          {items.map((r) => (
            <li key={r.id}>
              <span className="wallet-row-main"><b><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{signed(r.amountMinor)}</bdi></b> <span className="status-chip" data-status={r.state === 'paid' ? 'done' : r.state === 'rejected' || r.state === 'failed' ? 'failed' : 'pending'}>{t.refundStates[r.state] ?? r.state}</span>
                {r.decisionNote && <span className="muted op-line" dir="auto">{r.decisionNote}</span>}</span>
              <span className="muted wallet-row-date">{dateTime(r.createdAt, lang)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** Pay a package or a top-up by InstaPay transfer (owner). Hidden while the server has it off (404). The server owns the amount; the proof is checked again there. */
function InstapayCard({ t, lang, api }: { t: Strings; lang: Lang; api: WalletApi }) {
  const [view, setView] = useState<InstapayView | 'loading' | 'off' | 'error'>('loading');
  const [packages, setPackages] = useState<PackageDto[]>([]);
  const [kind, setKind] = useState<'package' | 'topup'>('package');
  const [packageId, setPackageId] = useState('');
  const [amount, setAmount] = useState('');
  const [created, setCreated] = useState<InstapayCreated | null>(null);
  const [msg, setMsg] = useState<{ kind: 'alert' | 'status'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (m: number) => formatMoney(m, 'EGP', lang);

  const load = useCallback(() => {
    api.instapay().then(setView, (e: unknown) => setView(e instanceof ApiError && e.status === 404 ? 'off' : 'error'));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => { api.packages().then((p) => { setPackages(p); setPackageId((cur) => cur || p[0]?.id || ''); }, () => setPackages([])); }, [api]);

  if (view === 'loading' || view === 'off') return null;
  if (view === 'error') return <section className="wallet-card" aria-labelledby="w-ip-title"><h2 id="w-ip-title">{t.wIpTitle}</h2><p role="alert" className="error-text">{t.wIpError}</p></section>;
  if (!view.payee) return <section className="wallet-card" aria-labelledby="w-ip-title"><h2 id="w-ip-title">{t.wIpTitle}</h2><p className="muted">{t.wIpUnavailable}</p></section>;

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    let input: Parameters<WalletApi['createInstapay']>[0];
    if (kind === 'package') {
      if (!packageId) return;
      input = { kind: 'package', packageId };
    } else {
      const minor = egpToMinor(amount);
      if (minor === null || minor < MIN_TOPUP_MINOR || minor > MAX_TOPUP_MINOR) { setMsg({ kind: 'alert', text: t.wTopupBadAmount }); return; }
      input = { kind: 'topup', amountMinor: minor };
    }
    setBusy(true);
    try { setCreated(await api.createInstapay(input)); load(); } catch (err) { setMsg({ kind: 'alert', text: err instanceof ApiError && err.code === 'yearly_queued' ? t.wYearlyQueued : t.wIpError }); } finally { setBusy(false); }
  };

  const upload = async (id: string, file: File | undefined) => {
    if (!file) return;
    if (file.size > PROOF_MAX_BYTES) { setMsg({ kind: 'alert', text: t.wIpTooBig }); return; }
    if (!PROOF_TYPES.includes(file.type)) { setMsg({ kind: 'alert', text: t.wIpBadType }); return; }
    setBusy(true);
    setMsg(null);
    try { await api.uploadInstapayProof(id, file); setCreated(null); setMsg({ kind: 'status', text: t.wIpUploaded }); load(); } catch (err) {
      setMsg({ kind: 'alert', text: err instanceof ApiError && err.status === 409 ? t.wIpExpiredUpload : err instanceof ApiError && err.status === 413 ? t.wIpTooBig : err instanceof ApiError && err.status === 415 ? t.wIpBadType : t.wIpError });
    } finally { setBusy(false); }
  };

  const payee = created?.payee ?? view.payee;
  const safeQr = (() => { try { return payee.qrUrl && new URL(payee.qrUrl).protocol === 'https:' ? payee.qrUrl : null; } catch { return null; } })();

  return (
    <section className="wallet-card" aria-labelledby="w-ip-title">
      <h2 id="w-ip-title">{t.wIpTitle}</h2>
      <p className="muted">{t.wIpIntro}</p>
      {!created && (
        <form className="wallet-form" onSubmit={(e) => void start(e)} noValidate>
          <div role="radiogroup" aria-label={t.wIpTitle} className="campaign-actions">
            <label><input type="radio" name="ip-kind" checked={kind === 'package'} onChange={() => setKind('package')} /> {t.wIpKindPackage}</label>
            <label><input type="radio" name="ip-kind" checked={kind === 'topup'} onChange={() => setKind('topup')} /> {t.wIpKindTopup}</label>
          </div>
          {kind === 'package' ? (
            <label className="field"><span>{t.wIpPickPackage}</span>
              <select value={packageId} onChange={(e) => setPackageId(e.target.value)}>{packages.map((p) => <option key={p.id} value={p.id}>{p.name} • {money(p.priceMinor)}</option>)}</select>
            </label>
          ) : (
            <label className="field"><span>{t.wIpAmount}</span><input inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          )}
          <div className="settings-actions"><button type="submit" className="btn primary" disabled={busy}>{t.wIpCreate}</button></div>
        </form>
      )}
      {created && (
        <>
          <div className="wallet-summary">
            <p><b>{t.wIpPayTo}</b> <bdi dir="ltr">{payee.handle}</bdi> • {t.wIpPayee(payee.name)}</p>
            {safeQr && <img src={safeQr} alt={t.wIpQrAlt} width={160} height={160} loading="lazy" />}
            <p>{t.wIpExact}: <b><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{money(created.amountMinor)}</bdi></b></p>
            <p>{t.wIpReference}: <b><bdi dir="ltr">{created.reference}</bdi></b></p>
            <p className="muted">{t.wIpExpires(dateTime(created.expiresAt, lang))}</p>
          </div>
          <label className="field"><span>{t.wIpUpload}</span><input type="file" accept={PROOF_TYPES.join(',')} disabled={busy} onChange={(e) => void upload(created.id, e.target.files?.[0])} /></label>
          <small className="muted">{t.wIpUploadHint}</small>
        </>
      )}
      {msg && <p role={msg.kind === 'alert' ? 'alert' : 'status'} className={msg.kind === 'alert' ? 'error-text' : 'wallet-ok'}>{msg.text}</p>}
      <h3 className="pane-sub">{t.wIpPast}</h3>
      {view.items.length === 0 ? <p className="muted">{t.wIpNone}</p> : (
        <ul className="wallet-rows" aria-label={t.wIpPast}>
          {view.items.map((r: InstapayRequest) => (
            <li key={r.id}>
              <span className="wallet-row-main">
                <b><bdi dir={lang === 'ar' ? 'rtl' : 'ltr'}>{money(r.amountMinor)}</bdi></b> <span className="status-chip" data-status={r.state === 'confirmed' ? 'done' : r.state === 'rejected' || r.state === 'expired' ? 'failed' : 'pending'}>{t.instapayStates[r.state] ?? r.state}</span>
                <span className="muted op-line"><bdi dir="ltr">{r.reference}</bdi> • {dateTime(r.createdAt, lang)}</span>
                {r.state === 'rejected' && r.rejectReason && <span className="op-line" dir="auto">{t.wIpRejectedLine(r.rejectReason)}</span>}
              </span>
              {r.state === 'awaiting_proof' && Date.now() < r.expiresAt && <button type="button" className="btn" onClick={() => setCreated({ ...r, payee: view.payee! })}>{t.wIpOpen}</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
