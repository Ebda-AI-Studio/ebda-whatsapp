import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../data/api';
import type { ConfirmToken, CreditPack, WalletApi, YearlyRefundPreview, YearlyRefundView } from '../data/billing';
import { num, type Lang, type Strings } from '../i18n';
import { formatMoney } from '../lib/format';
import { useFocusOn } from '../lib/useFocusOn';
import { dateTime } from './CampaignsScreen';

/** A refused confirmation says what to do next: the figures moved (preview again), the token ran out, or it was already used. */
export const confirmMessage = (t: Strings, err: unknown): string => {
  if (err instanceof ApiError) {
    if (err.detail === 'confirmation_mismatch') return t.wConfirmStale;
    if (err.detail === 'confirmation_expired' || err.detail === 'confirmation_missing') return t.wConfirmExpired;
    if (err.detail === 'confirmation_used') return t.wConfirmUsed;
    if (err.detail === 'offboarding_pending') return t.wOffFrozen;
  }
  return t.opFailed;
};

type Props = { t: Strings; lang: Lang; api: WalletApi };

/** Who pays Meta for an own number whose payer is not set: the owner sees what will happen and says yes. The platform line is never offered. */
export function NumberFundingAction({ t, api, phoneNumberId, onDone }: { t: Strings; api: WalletApi; phoneNumberId: string; onDone: () => void }) {
  const [confirm, setConfirm] = useState<ConfirmToken | null>(null);
  const [msg, setMsg] = useState<{ kind: 'alert' | 'status'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false); // a double click lands before the state update: the ref is what makes it one request
  const msgRef = useFocusOn<HTMLParagraphElement>(msg);
  const preview = async () => {
    setBusy(true); setMsg(null);
    try { setConfirm((await api.previewNumberFunding(phoneNumberId)).confirm); } catch (err) { setMsg({ kind: 'alert', text: err instanceof ApiError && err.detail === 'operator_funded' ? t.wFundOperator : t.opFailed }); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!confirm || flight.current) return;
    flight.current = true;
    setBusy(true); setMsg(null);
    try { await api.confirmNumberFunding(phoneNumberId, confirm); setConfirm(null); setMsg({ kind: 'status', text: t.wFundDone }); onDone(); } catch (err) { setConfirm(null); setMsg({ kind: 'alert', text: confirmMessage(t, err) }); } finally { flight.current = false; setBusy(false); }
  };
  return (
    <div className="wallet-confirm">
      {confirm ? (
        <>
          <p role="status">{t.wFundConfirmText}</p>
          <div className="settings-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void apply()}>{t.wFundConfirmBtn}</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>{t.wMoneyCancel}</button>
          </div>
        </>
      ) : <button type="button" className="btn" disabled={busy} onClick={() => void preview()}>{t.wFundAction}</button>}
      {msg && <p ref={msgRef} tabIndex={-1} role={msg.kind} className={msg.kind === 'alert' ? 'error-text' : 'wallet-ok'}>{msg.text}</p>}
    </div>
  );
}

/** Yearly package: the operator's own refund figures, then a confirmed REQUEST. Nothing here moves money. Hidden unless a yearly package is running or a request exists. */
export function YearlyRefundCard({ t, lang, api }: Props) {
  const [view, setView] = useState<YearlyRefundView | null>(null);
  const [preview, setPreview] = useState<YearlyRefundPreview | null>(null);
  const [msg, setMsg] = useState<{ kind: 'alert' | 'status'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const msgRef = useFocusOn<HTMLParagraphElement>(msg);
  const money = (m: number) => formatMoney(m, 'EGP', lang);
  const load = useCallback(() => { void api.yearlyRefund().then(setView, () => setView(null)); }, [api]);
  useEffect(load, [load]);
  if (!view || (!view.quote && !view.request && view.reason !== 'queued_periods' && view.reason !== 'order_queued')) return null;

  const figures = (q: { unusedMonths: number; grossMinor: number; debtSettledMinor: number; refundMinor: number }) => (
    <dl className="wallet-figures">
      <div><dt>{t.wYrUnused}</dt><dd>{num(q.unusedMonths, lang)}</dd></div>
      <div><dt>{t.wYrGross}</dt><dd>{money(q.grossMinor)}</dd></div>
      <div><dt>{t.wYrDebt}</dt><dd>{money(q.debtSettledMinor)}</dd></div>
      <div><dt>{t.wYrCash}</dt><dd>{money(q.refundMinor)}</dd></div>
    </dl>
  );
  const ask = async () => {
    setBusy(true); setMsg(null);
    try { setPreview(await api.previewYearlyRefund()); } catch (err) { setMsg({ kind: 'alert', text: err instanceof ApiError && err.detail === 'nothing_to_refund' ? t.wYrNothing : t.opFailed }); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!preview || flight.current) return;
    flight.current = true;
    setBusy(true); setMsg(null);
    try {
      await api.requestYearlyRefund(preview.confirm);
      setPreview(null); setMsg({ kind: 'status', text: t.wYrSent }); load();
    } catch (err) {
      setPreview(null);
      setMsg({ kind: 'alert', text: err instanceof ApiError && err.detail === 'request_pending' ? t.wYrNoPending : confirmMessage(t, err) });
    } finally { flight.current = false; setBusy(false); }
  };
  const waiting = view.request?.state === 'pending';
  return (
    <section className="wallet-card" aria-labelledby="w-yr-title">
      <h2 id="w-yr-title">{t.wYrTitle}</h2>
      <p className="muted">{t.wYrIntro}</p>
      {view.request && <p role="status">{waiting ? t.wYrPending : t.wYrExecuted} <span className="muted">{dateTime(view.request.createdAt, lang)}</span></p>}
      {!waiting && view.quote && (preview ? (
        <>
          {figures(preview.quote)}
          <p className="muted">{t.wYrNote}</p>
          <div className="settings-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void send()}>{t.wYrConfirmBtn}</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setPreview(null)}>{t.wMoneyCancel}</button>
          </div>
        </>
      ) : view.quote.unusedMonths > 0 && view.quote.grossMinor > 0 ? (
        <>
          {figures(view.quote)}
          <p className="muted">{t.wYrNote}</p>
          <div className="settings-actions"><button type="button" className="btn" disabled={busy} onClick={() => void ask()}>{t.wYrAsk}</button></div>
        </>
      ) : <p className="muted">{t.wYrNothing}</p>)}
      {!view.quote && (view.reason === 'queued_periods' || view.reason === 'order_queued') && <p className="muted">{t.wYrQueued}</p>}
      {msg && <p ref={msgRef} tabIndex={-1} role={msg.kind} className={msg.kind === 'alert' ? 'error-text' : 'wallet-ok'}>{msg.text}</p>}
    </section>
  );
}

const CREDITS_PENDING_KEY = 'wallet.pendingCredits';
const PENDING_TTL_MS = 3 * 3_600_000;
const POLL_MS = 8000;
type PendingCredits = { orderId: string; credits: number; at: number };
const readPending = (now: number): PendingCredits | null => {
  try {
    const p = JSON.parse(localStorage.getItem(CREDITS_PENDING_KEY) ?? 'null') as PendingCredits | null;
    return p && typeof p.orderId === 'string' && now - p.at < PENDING_TTL_MS ? p : null;
  } catch { return null; }
};
const writePending = (p: PendingCredits | null) => {
  try { if (p) localStorage.setItem(CREDITS_PENDING_KEY, JSON.stringify(p)); else localStorage.removeItem(CREDITS_PENDING_KEY); } catch { /* storage blocked */ }
};

/** Buy AI credits by card. The page leaves for the card form; the credits are added by the server when the provider confirms, and this card waits for that. */
export function CreditPacksCard({ t, lang, api, now, go, onCredited }: Props & { now: () => number; go: (url: string) => void; onCredited: () => void }) {
  const [packs, setPacks] = useState<{ items: CreditPack[]; enabled: boolean } | null>(null);
  const [chosen, setChosen] = useState<{ pack: CreditPack; confirm: ConfirmToken } | null>(null);
  const [pending, setPending] = useState<PendingCredits | null>(() => readPending(now()));
  const [note, setNote] = useState<{ kind: 'arrived'; credits: number } | { kind: 'failed' } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'alert' | 'status'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const msgRef = useFocusOn<HTMLParagraphElement>(msg);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const money = (m: number) => formatMoney(m, 'EGP', lang);

  useEffect(() => { void api.creditPacks().then(setPacks, () => setPacks(null)); }, [api]);
  // The order's own state decides: `paid` means the server already added the credits.
  const check = useCallback(async () => {
    const p = pendingRef.current;
    if (!p) return;
    try {
      const s = await api.creditOrderState(p.orderId);
      if (s.state === 'paid') { writePending(null); setPending(null); setNote({ kind: 'arrived', credits: p.credits }); onCredited(); }
      else if (s.state === 'failed' || s.state === 'expired') { writePending(null); setPending(null); setNote({ kind: 'failed' }); }
    } catch { /* keep waiting: the next check asks again */ }
  }, [api, onCredited]);
  useEffect(() => { void check(); }, [check]);
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => void check(), POLL_MS);
    const on = () => void check();
    window.addEventListener('focus', on);
    document.addEventListener('visibilitychange', on);
    return () => { clearInterval(id); window.removeEventListener('focus', on); document.removeEventListener('visibilitychange', on); };
  }, [pending, check]);

  if (!packs) return null;
  const pick = async (pack: CreditPack) => {
    setBusy(true); setMsg(null); setNote(null);
    try { setChosen({ pack, confirm: (await api.previewCreditPack(pack.id)).confirm }); } catch { setMsg({ kind: 'alert', text: t.opFailed }); } finally { setBusy(false); }
  };
  const pay = async () => {
    if (!chosen || flight.current) return;
    flight.current = true;
    setBusy(true); setMsg(null);
    try {
      const o = await api.buyCreditPack(chosen.pack.id, chosen.confirm);
      setChosen(null);
      // Only an https checkout page is ever opened; anything else from the server is refused, never followed.
      if (!o.checkoutUrl || !/^https:\/\//.test(o.checkoutUrl)) { setMsg({ kind: 'alert', text: t.opFailed }); return; }
      const p = { orderId: o.orderId, credits: o.credits, at: now() };
      writePending(p); setPending(p);
      go(o.checkoutUrl);
    } catch (err) { setChosen(null); setMsg({ kind: 'alert', text: confirmMessage(t, err) }); } finally { flight.current = false; setBusy(false); }
  };
  return (
    <section className="wallet-card" id="w-credits" aria-labelledby="w-credits-title">
      <h2 id="w-credits-title" tabIndex={-1}>{t.wCrTitle}</h2>
      <p className="muted">{t.wCrIntro}</p>
      {!packs.enabled || packs.items.length === 0 ? <p className="muted">{t.wCrOff}</p> : chosen ? (
        <>
          <p role="status">{t.wCrConfirmText(num(chosen.pack.credits, lang), money(chosen.pack.priceMinor))}</p>
          <div className="settings-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void pay()}>{t.wCrConfirmBtn}</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setChosen(null)}>{t.wMoneyCancel}</button>
          </div>
        </>
      ) : (
        <ul className="wallet-list">
          {packs.items.map((p) => (
            <li key={p.id}>
              <b>{t.wCrPack(num(p.credits, lang), money(p.priceMinor))}</b>
              <button type="button" className="btn" disabled={busy || pending !== null} onClick={() => void pick(p)}>{t.wCrBuy}</button>
            </li>
          ))}
        </ul>
      )}
      {pending && <p role="status" className="muted">{t.wCrWaiting}</p>}
      {note?.kind === 'arrived' && <p role="status" className="wallet-ok">{t.wCrArrived(num(note.credits, lang))}</p>}
      {note?.kind === 'failed' && <p role="alert" className="error-text">{t.wCrFailed}</p>}
      {msg && <p ref={msgRef} tabIndex={-1} role={msg.kind} className={msg.kind === 'alert' ? 'error-text' : 'wallet-ok'}>{msg.text}</p>}
    </section>
  );
}
