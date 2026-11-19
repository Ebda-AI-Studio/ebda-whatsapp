import { Check, Circle, Phone, Plus } from 'lucide-react';
import { BRAND } from '@brand';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { NumberDto, NumberNoticeDto, SharedNumberDto } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { InboxSource, NumbersApi } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { SignupStopped, launchEmbeddedSignup, prepareEmbeddedSignup } from '../lib/embedded-signup';
import { useFocusOn } from '../lib/useFocusOn';
import { useLoad } from '../lib/useLoad';
import { dateTime } from './CampaignsScreen';
import { LoadError } from './LoadError';
import { EmptyState } from './EmptyState';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: NumbersApi };
type Note = { kind: 'status' | 'alert'; text: string } | null;

const TIERS: Record<string, number> = { TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000 };

function stateOf(n: NumberDto): 'active' | 'pending' | 'failed' | 'locked' | 'disconnected' {
  if (n.status === 'active') return 'active';
  if (n.registration === 'locked') return 'locked';
  if (n.registration === 'pending' || n.registration === 'failed') return n.registration;
  return 'disconnected';
}

export function NumbersScreen({ t, lang, source, api }: Props) {
  const list = useCallback(() => api.list(), [api]);
  const { data: items, setData: setItems, error: loadFailed, reload: load } = useLoad<NumberDto[]>(list);
  const [notices, setNotices] = useState<NumberNoticeDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [addedId, setAddedId] = useState<string | null>(null);
  const noteRef = useFocusOn<HTMLParagraphElement>(note);
  const [checks, setChecks] = useState({ templates: false, agent: false });
  const owner = source.role !== 'staff';
  // Config and Meta's SDK are fetched when the screen opens: the click then calls FB.login with nothing awaited before it (a popup opened after an await is blocked).
  type SignupCfg = Awaited<ReturnType<NumbersApi['signupConfig']>>;
  const cfgRef = useRef<SignupCfg | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.signupConfig().then((cfg) => {
      if (!live) return;
      cfgRef.current = cfg;
      if (cfg) void (api.prepare ?? prepareEmbeddedSignup)(cfg).catch(() => undefined);
    }, () => undefined);
    return () => { live = false; };
  }, [api]);
  useEffect(() => {
    if (owner) void api.notices?.().then(setNotices, () => undefined);
  }, [api, owner, items]);
  useEffect(() => {
    void source.templates().then((ts) => setChecks((c) => ({ ...c, templates: ts.some((x) => x.status === 'APPROVED') })), () => undefined);
    void source.agentSettings?.().then((a) => setChecks((c) => ({ ...c, agent: !!a?.enabled })), () => undefined);
  }, [source]);

  const explain = (e: unknown): Note => {
    if (e instanceof SignupStopped) {
      if (e.reason === 'cancelled') return { kind: 'status', text: t.signupCancelled };
      return { kind: 'alert', text: e.reason === 'no_number' ? t.signupNoNumber : e.reason === 'sdk_unavailable' ? t.signupSdk : t.signupError };
    }
    if (e instanceof ApiError) return { kind: 'alert', text: t.numberErrors[e.code] ?? t.numberFailed };
    return { kind: 'alert', text: t.numberFailed };
  };

  const connect = async () => {
    setBusy(true);
    setNote(null);
    try {
      const launch = api.launch ?? launchEmbeddedSignup;
      let cfg = cfgRef.current;
      let popup = cfg ? launch(cfg) : null; // synchronous inside the click when the config is ready
      if (cfg === undefined) { // the config has not arrived yet: wait for it, then open
        cfg = await api.signupConfig();
        cfgRef.current = cfg;
        popup = cfg ? launch(cfg) : null;
      }
      if (!cfg || !popup) { setNote({ kind: 'alert', text: t.signupUnavailable }); return; }
      const r = await popup;
      // The code expires 30 seconds after Meta issues it: send it before anything else.
      const added = await api.connect({ code: r.code, event: r.event, wabaId: r.wabaId, phoneNumberId: r.phoneNumberId, ...(r.businessId ? { businessId: r.businessId } : {}) });
      setItems((xs) => [...(xs ?? []).filter((x) => x.phoneNumberId !== added.phoneNumberId), added]);
      setAddedId(added.phoneNumberId); // focus moves to the new number
    } catch (e) {
      setNote(explain(e));
      load(); // a half-finished connect still shows its number and what is left to do
    } finally {
      setBusy(false);
    }
  };

  const replace = (n: NumberDto) => setItems((xs) => xs?.map((x) => (x.phoneNumberId === n.phoneNumberId ? n : x)) ?? null);
  const anyActive = !!items?.some((n) => n.status === 'active');
  const steps = [
    { label: t.stepNumber, done: anyActive, guide: 'connect-your-own-number' },
    { label: t.stepTemplates, done: checks.templates, guide: 'templates-and-the-24-hour-window' },
    ...(BRAND.storeName ? [{ label: t.stepStore(BRAND.storeName), done: source.capabilities.codOutcome, guide: 'cod-confirmations' }] : []),
    { label: t.stepAgent, done: checks.agent, guide: 'ai-agent' },
  ];

  return (
    <main className="screen" aria-labelledby="numbers-title">
      <header className="screen-head">
        <Phone size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="numbers-title">{t.numbersTitle}</h1>
        {owner && (
          <button type="button" className="btn primary head-action" disabled={busy} onClick={() => void connect()}>
            <Plus size={18} aria-hidden />{t.connectNumber}
          </button>
        )}
      </header>
      <div className="settings wide numbers-layout">
        <section className="numbers-main">
          <p className="muted intro">{t.numbersIntro}</p>
          {notices.map((n) => (
            <div key={n.id} className="number-health" role="status">
              <p className="flag bad">{t.metaUserRemovedApp}</p>
              <button type="button" className="btn quiet" onClick={() => void api.dismissNotice?.(n.id).then(() => setNotices((l) => l.filter((x) => x.id !== n.id)), (e) => setNote(explain(e)))}>{t.metaUserRemovedAppKeep}</button>
            </div>
          ))}
          {busy && <p className="muted" role="status">{t.connecting}</p>}
          {note && <p ref={noteRef} tabIndex={-1} role={note.kind} className={note.kind === 'alert' ? 'error-text' : 'muted'}>{note.text}</p>}
          {loadFailed ? <LoadError t={t} onRetry={load} />
            : items === null ? <div className="placeholder">…</div>
            : items.length === 0 ? <EmptyState icon={<Phone size={22} />} title={t.numbersEmptyTitle} body={t.numbersEmpty} />
            : items.map((n) => <NumberCard key={n.phoneNumberId} n={n} focus={n.phoneNumberId === addedId} t={t} lang={lang} owner={owner} api={api} onChange={replace} onError={(e) => setNote(explain(e))} />)}
        </section>
        {owner && <SharedCard t={t} api={api} />}
        <aside className="checklist" aria-labelledby="checklist-title">
          <h2 id="checklist-title">{t.checklistTitle}</h2>
          <ol aria-labelledby="checklist-title">
            {steps.map((s) => (
              <li key={s.guide} data-done={s.done}>
                {s.done ? <Check size={18} aria-hidden className="step-icon" /> : <Circle size={18} aria-hidden className="step-icon" />}
                <span className="step-label">{s.label}</span>
                <span className="vh">{s.done ? t.stepDone : t.stepTodo}</span>
                {BRAND.helpUrl ? <a href={BRAND.helpUrl(lang, s.guide)} target="_blank" rel="noopener" className="help-link">{t.howTo}</a> : <span />}
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </main>
  );
}

function NumberCard({ n, focus, t, lang, owner, api, onChange, onError }: { n: NumberDto; focus: boolean; t: Strings; lang: Lang; owner: boolean; api: NumbersApi; onChange: (n: NumberDto) => void; onError: (e: unknown) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = stateOf(n);
  const titleId = `num-${n.phoneNumberId}`;
  const ref = useFocusOn<HTMLElement>(focus);
  const run = (fn: () => Promise<NumberDto>) => async () => {
    setBusy(true);
    try { onChange(await fn()); } catch (e) { onError(e); } finally { setBusy(false); setAsking(false); }
  };
  const tier = n.messagingLimitTier === 'TIER_UNLIMITED' ? t.tierUnlimited : n.messagingLimitTier && TIERS[n.messagingLimitTier] ? t.tierLine(num(TIERS[n.messagingLimitTier]!, lang)) : null;
  const syncOpen = n.syncDeadlineAt !== null && (n.historySync === 'requested' || n.contactsSync === 'requested');

  return (
    <article ref={ref} tabIndex={-1} className="number-card" aria-labelledby={titleId} data-state={state}>
      <div className="campaign-top">
        <h2 id={titleId}><bdi dir="ltr">{n.displayPhone ?? n.phoneNumberId}</bdi>{n.verifiedName && <span className="muted"> · {n.verifiedName}</span>}</h2>
        <span className="status-chip" data-status={state === 'active' ? 'running' : state === 'disconnected' ? 'cancelled' : 'paused'}>{t.numberState[state]}</span>
      </div>
      {n.isOnBizApp && <p className="flag" data-ok="true">{t.onBizApp}</p>}
      {state === 'locked' && <p className="campaign-reason">{t.lockedHelp}</p>}
      {(state === 'pending' || state === 'failed') && <p className="campaign-reason">{t.pendingHelp}</p>}
      {state === 'active' && (n.qualityRating || tier) && (
        <p className="muted number-meta">{[n.qualityRating ? t.quality[n.qualityRating] ?? null : null, tier].filter(Boolean).join(' · ')}</p>
      )}
      {state === 'active' && n.health && n.health !== 'green' && (
        <div className="number-health" data-health={n.health}>
          <p className="flag bad" role="status">{t.numberHealth[n.health]}</p>
          <p className="campaign-reason">{t.numberHealthHelp[n.health]}</p>
        </div>
      )}
      {(n.historySync || n.contactsSync) && (
        <p className="muted small">
          {[n.historySync && t.historySync[n.historySync], n.contactsSync && t.contactsSync[n.contactsSync]].filter(Boolean).join(' · ')}
          {syncOpen && n.syncDeadlineAt && <> · {t.syncDeadline(dateTime(n.syncDeadlineAt, lang))}</>}
        </p>
      )}
      <div className="campaign-actions">
        {asking ? (
          <div className="confirm-inline" role="group" aria-label={t.disconnectAsk}>
            <span>{t.disconnectAsk}</span>
            <button type="button" className="btn danger" disabled={busy} onClick={run(() => api.disconnect(n.phoneNumberId))}>{t.disconnectYes}</button>
            <button type="button" className="btn" onClick={() => setAsking(false)}>{t.disconnectNo}</button>
          </div>
        ) : (
          <>
            {owner && (state === 'pending' || state === 'failed') && <button type="button" className="btn primary" disabled={busy} onClick={run(() => api.register(n.phoneNumberId))}>{t.resumeRegistration}</button>}
            {state !== 'disconnected' && <button type="button" className="btn" disabled={busy} onClick={run(() => api.refresh(n.phoneNumberId))}>{t.refreshNumber}</button>}
            {owner && state === 'active' && <button type="button" className="btn quiet" onClick={() => setAsking(true)}>{t.disconnectNumber}</button>}
          </>
        )}
      </div>
    </article>
  );
}


/** The shared platform number (owner). Hidden while the server has it off (404). A plan that does not include it is explained, never silently ignored. */
function SharedCard({ t, api }: { t: Strings; api: NumbersApi }) {
  const [st, setSt] = useState<SharedNumberDto | 'off' | 'loading'>('loading');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ kind: 'alert' | 'status'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api.shared) { setSt('off'); return; }
    api.shared.status().then(setSt, () => setSt('off'));
  }, [api]);
  if (st === 'loading' || st === 'off' || !api.shared || !st.available) return null;
  const shared = api.shared;
  const act = async (fn: () => Promise<SharedNumberDto>) => {
    setBusy(true);
    setMsg(null);
    try { setSt(await fn()); } catch (e) {
      setMsg({ kind: 'alert', text: e instanceof ApiError && e.code === 'package_required' ? t.sharedPackageRequired : e instanceof ApiError && e.detail === 'display_name_taken' ? t.sharedNameTaken : t.sharedError });
    } finally { setBusy(false); }
  };
  const join = (e: FormEvent) => { e.preventDefault(); void act(() => shared.join(name.trim() || undefined)); };
  return (
    <section className="numbers-main" aria-labelledby="shared-title">
      <h2 id="shared-title">{t.sharedTitle}</h2>
      <p className="muted">{t.sharedIntro}</p>
      {st.member ? (
        <>
          <p>{t.sharedMember(st.displayName ?? '')}</p>
          <button type="button" className="btn quiet" disabled={busy} onClick={() => void act(() => shared.leave())}>{t.sharedLeave}</button>
        </>
      ) : (
        <form className="wallet-form" onSubmit={join} noValidate>
          {st.packageRequired && <p className="campaign-reason" role="note">{t.sharedPackageRequired}</p>}
          <label className="field"><span>{t.sharedNameLabel}</span><input dir="auto" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="settings-actions"><button type="submit" className="btn primary" disabled={busy}>{t.sharedJoin}</button></div>
        </form>
      )}
      {msg && <p role={msg.kind === 'alert' ? 'alert' : 'status'} className={msg.kind === 'alert' ? 'error-text' : 'muted'}>{msg.text}</p>}
    </section>
  );
}
