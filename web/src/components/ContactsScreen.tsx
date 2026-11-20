import { Upload, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { phoneDigits } from '../../../src/core/text-normalise';
import type { ContactDto, ImportDto, RetentionDto } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { ContactsApi, InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { contactsCsv } from '../lib/contacts-csv';
import { dateOnly } from '../lib/datetime';
import { relativeTime } from '../lib/format';
import { useTypeahead } from '../lib/useTypeahead';
import { Highlight } from './Highlight';
import { LoadError } from './LoadError';
import { EmptyState } from './EmptyState';
import { SearchBox, optionId } from './SearchBox';
import { SegmentsPanel } from './SegmentsPanel';
import { TagEditor } from './TagEditor';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: ContactsApi; now: () => number };

const LIST_ID = 'contact-results';

export function ContactsScreen({ t, lang, source, api, now }: Props) {
  const [optedOut, setOptedOut] = useState(false);
  const [items, setItems] = useState<ContactDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [imports, setImports] = useState<ImportDto[]>([]);
  const owner = source.role !== 'staff';
  const [selected, setSelected] = useState<ContactDto | null>(null);
  const [attemptList, setAttemptList] = useState(0);

  // Typing uses the shared search hook (from the first character, 150 ms pause, older answers dropped); the plain list loads at once.
  // The opted-out chip and a retry re-run the same query.
  const fetchSearch = useCallback((q: string, signal: AbortSignal) => api.list({ q, ...(optedOut ? { optedOut: true } : {}) }, signal).then((r) => r.items), [api, optedOut]);
  const search = useTypeahead<ContactDto>(fetchSearch, { deps: [api, optedOut, attempt, attemptList] });
  const q = search.query;
  const searching = q.trim() !== '';
  useEffect(() => {
    if (searching) return;
    let stale = false;
    void api.list({ ...(optedOut ? { optedOut: true } : {}) }).then((r) => { if (!stale) { setItems(r.items); setFailed(false); } }, () => { if (!stale) setFailed(true); });
    return () => { stale = true; };
  }, [api, searching, optedOut, attempt, attemptList]);
  // null = nothing to show yet. While a newer search loads the previous results stay (no blanking on every keystroke).
  const shown = searching ? (search.status === 'loading' && search.results.length === 0 ? null : search.results) : items;
  const listFailed = searching ? search.status === 'error' : failed;
  const [active, setActive] = useState(-1);
  useEffect(() => setActive(-1), [shown]);
  useEffect(() => { if (active >= 0) document.getElementById(optionId(LIST_ID, active))?.scrollIntoView?.({ block: 'nearest' }); }, [active]);

  const [importsFailed, setImportsFailed] = useState(false);
  const loadImports = useCallback(() => api.imports().then((x) => { setImports(x); setImportsFailed(false); }, () => setImportsFailed(true)), [api]);
  useEffect(() => { void loadImports(); }, [loadImports]);
  // An import runs in the background: poll until none is pending or running.
  useEffect(() => {
    if (!imports.some((i) => i.status === 'pending' || i.status === 'running')) return;
    const id = setInterval(() => void loadImports(), 2_000);
    return () => clearInterval(id);
  }, [imports, loadImports]);

  return (
    <main className="screen" aria-labelledby="contacts-title">
      <header className="screen-head">
        <Users size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="contacts-title">{t.contactsTitle}</h1>
      </header>
      <div className="settings wide contacts-layout">
        <section aria-label={t.contactsTitle}>
          {/* Enter has nothing to open here (a contact has no detail view yet); the keys still move the active row for screen readers. */}
          <SearchBox t={t} lang={lang} label={t.searchContacts} query={q} onQuery={search.setQuery} status={searching ? search.status : 'idle'} count={shown?.length ?? 0} listId={LIST_ID} activeIndex={active} onActiveIndex={setActive} onPick={(i) => { if (shown?.[i]) setSelected(shown[i]!); }} />
          <div className="chips" role="group" aria-label={t.contactsTitle}>
            <button type="button" className="chip" aria-pressed={!optedOut} onClick={() => setOptedOut(false)}>{t.filterAllContacts}</button>
            <button type="button" className="chip" aria-pressed={optedOut} onClick={() => setOptedOut(true)}>{t.filterOptedOut}</button>
          </div>
          {listFailed ? <LoadError t={t} onRetry={() => { setFailed(false); setAttempt((a) => a + 1); }} />
            : shown === null ? <div className="placeholder">…</div>
            : shown.length === 0 ? <EmptyState icon={<Users size={22} />} title={t.contactsEmptyTitle} body={t.contactsEmpty} />
            : (
              <ul className="contact-list" id={LIST_ID} role="listbox" aria-label={t.contactsTitle}>
                {shown.map((c, i) => (
                  <li key={c.waId} id={optionId(LIST_ID, i)} role="option" aria-selected={i === active || selected?.waId === c.waId} data-active={i === active} className="contact-row" onClick={() => setSelected(c)}>
                    <div className="contact-main">
                      <b dir="auto">{c.name ? <Highlight text={c.name} query={q} /> : t.noName}</b>
                      <span className="muted small" dir="ltr">+{c.waId.slice(0, -4).replace(/\d/g, '•')}{c.waId.slice(-4)}</span>
                    </div>
                    <div className="contact-tags">
                      {(c.tags ?? []).map((tag) => <span key={tag} className="tag" dir="auto">{tag}</span>)}
                      {c.optedOut ? <span className="flag bad">{t.optedOutBadge}</span>
                        : <span className="flag" data-ok={!!c.consent}>{c.consent ? t.consentYes : t.consentNo}</span>}
                    </div>
                    {c.consent?.proof && (
                      <details className="consent-proof small">
                        <summary>{t.consentProof}</summary>
                        <p className="muted">{t.consentProofLine(t.consentSource[c.consent.proof.source], c.consent.proof.attestedBy, dateOnly(c.consent.proof.at, lang))}</p>
                        <blockquote dir="auto">{c.consent.proof.wording}</blockquote>
                      </details>
                    )}
                    {c.lastInboundAt != null && <span className="muted small contact-when">{t.lastMessage(relativeTime(c.lastInboundAt, now(), lang))}</span>}
                  </li>
                ))}
              </ul>
            )}
        </section>
        <div className="contact-side">
          <CustomerTools t={t} api={api} owner={owner} contact={selected} onRenamed={(name) => { setSelected((c) => (c ? { ...c, name } : c)); setAttemptList((a) => a + 1); }} onMerged={() => { setSelected(null); setAttemptList((a) => a + 1); }} onTagged={(tags) => { setSelected((c) => (c ? { ...c, tags } : c)); setAttemptList((a) => a + 1); }} />
          {source.role === 'owner' && <ExportAllCard t={t} api={api} />}
          {owner && <RetentionCard t={t} api={api} />}
          {owner && <SegmentsPanel t={t} lang={lang} api={api.segments} now={now} />}
        </div>
        {owner && <ImportPanel t={t} lang={lang} api={api} imports={imports} failed={importsFailed} onRetry={() => void loadImports()} onStarted={() => void loadImports()} />}
      </div>
    </main>
  );
}

function ImportPanel({ t, lang, api, imports, failed, onRetry, onStarted }: { t: Strings; lang: Lang; api: ContactsApi; imports: ImportDto[]; failed: boolean; onRetry: () => void; onStarted: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [rejects, setRejects] = useState<{ line: number; reason: string }[] | null>([]);
  const n = (v: number) => num(v, lang);

  const start = async () => {
    if (!file) return;
    setBusy(true);
    setError(false);
    try {
      await api.importCsv(file, consented, t.importConsent);
      setFile(null);
      setConsented(false);
      onStarted();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const loadRejects = async (id: string) => {
    setRejects(await api.rejects(id).catch(() => null)); // null = could not load, not "no rejected rows"
    setOpen(id);
  };
  const toggleRejects = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    await loadRejects(id);
  };

  return (
    <aside className="import-panel" aria-labelledby="import-title">
      <h2 id="import-title">{t.importTitle}</h2>
      <p className="muted small">{t.importHint}</p>
      <label className="file-pick">
        <Upload size={18} aria-hidden />
        <span>{file ? <bdi>{file.name}</bdi> : t.chooseFile}</span>
        <input type="file" accept=".csv,text/csv" aria-label={t.chooseFile} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} aria-describedby="consent-hint" />
        <span>{t.importConsent}</span>
      </label>
      <small id="consent-hint" className="muted">{t.importConsentHint}</small>
      <div className="settings-actions">
        <button type="button" className="btn primary" disabled={!file || busy} onClick={() => void start()}>{t.startImport}</button>
        {busy && <span className="muted" role="status">{t.importing}</span>}
      </div>
      {error && <p role="alert" className="error-text">{t.importFailed}</p>}
      {failed && <LoadError t={t} onRetry={onRetry} />}

      {imports.length > 0 && (
        <>
          <h3 className="pane-sub">{t.importsHistory}</h3>
          <ul className="import-list">
            {imports.map((i) => (
              <li key={i.id}>
                <div className="import-top"><bdi>{i.filename}</bdi><span className="status-chip" data-status={i.status}>{t.importStatus[i.status]}</span></div>
                <span className="muted small">{i.consented ? t.consentWithFile : t.consentWithoutFile}</span>
                {i.status === 'done' && <span className="small">{t.importLine(n(i.created), n(i.updated), n(i.rejected))}</span>}
                {i.status === 'failed' && i.error && <span className="error-text small">{t.importErrors[i.error] ?? t.importFailed}</span>}
                {i.status === 'done' && i.rejected > 0 && (
                  <button type="button" className="link-btn" aria-expanded={open === i.id} onClick={() => void toggleRejects(i.id)}>{t.showRejects}</button>
                )}
                {open === i.id && (
                  rejects === null ? <LoadError t={t} onRetry={() => void loadRejects(i.id)} /> : <ul className="reject-list">
                    {rejects.map((r) => <li key={r.line}><span className="muted">{t.rejectLine(n(r.line))}</span> {t.rejectReasons[r.reason] ?? r.reason}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

// ---- Customer data tools: rename, export (B5), merge (M-175) ----------------------------------------------------------------------

/** What the owner types: any form of an Egyptian or international number, as WhatsApp's id (digits, country code first). */
export function toWaId(raw: string): string | null {
  let d = phoneDigits(raw);
  if (d.startsWith('00')) d = d.slice(2);
  if (/^01\d{9}$/.test(d)) d = `20${d.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

function CustomerTools({ t, api, owner, contact, onRenamed, onMerged, onTagged }: { t: Strings; api: ContactsApi; owner: boolean; contact: ContactDto | null; onRenamed: (name: string) => void; onMerged: () => void; onTagged: (tags: string[]) => void }) {
  const [eraseTyped, setEraseTyped] = useState('');
  const [name, setName] = useState('');
  const [into, setInto] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(contact?.name ?? ''); setInto(''); setEraseTyped(''); }, [contact?.waId, contact?.name]);
  useEffect(() => { if (contact) setMsg(null); }, [contact?.waId]); // a message about the last action stays until another customer is picked
  const run = async (fn: () => Promise<void>, ok: string, notFound?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); } catch (e) {
      // The server answers 404 'contact not found' for a customer that is already gone (a second erase); any other failure keeps the generic message.
      setMsg({ kind: 'alert', text: notFound && e instanceof ApiError && e.status === 404 && e.code === 'contact not found' ? notFound : t.cdFailed });
    } finally { setBusy(false); }
  };
  const target = toWaId(into);
  const download = async () => {
    const data = await api.exportContact(contact!.waId);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer-data-${contact!.waId.slice(-4)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="import-panel" aria-labelledby="cd-title">
      <h2 id="cd-title">{t.cdTitle}</h2>
      {!contact ? <p className="muted small">{t.cdSelect}</p> : (
        <>
          <p dir="auto"><b>{contact.name ?? t.noName}</b> <span className="muted small" dir="ltr">+{contact.waId.slice(0, -4).replace(/\d/g, '•')}{contact.waId.slice(-4)}</span></p>
          <label className="field"><span>{t.cdName}</span><input dir="auto" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="settings-actions">
            <button type="button" className="btn primary" disabled={busy || name.trim() === ''} onClick={() => void run(async () => { const r = await api.renameContact(contact.waId, name.trim()); onRenamed(r.name ?? name.trim()); }, t.cdSaved)}>{t.cdSave}</button>
          </div>
          <TagEditor t={t} label={t.cdTags} tags={contact.tags ?? []} onSave={async (next) => { const r = await api.setContactTags(contact.waId, next); onTagged(r.tags); return r.tags; }} />
          {owner && (
            <>
              <div className="settings-actions"><button type="button" className="btn" disabled={busy} onClick={() => void run(download, '')}>{t.cdExport}</button></div>
              <small className="muted">{t.cdExportHint}</small>
              <h3 className="pane-sub">{t.cdMergeTitle}</h3>
              <p className="muted small">{t.cdMergeWarn}</p>
              <label className="field"><span>{t.cdMergeInto}</span><input dir="ltr" inputMode="tel" value={into} onChange={(e) => setInto(e.target.value)} /></label>
              <div className="settings-actions">
                <button type="button" className="btn danger" disabled={busy || !target || target === contact.waId} onClick={() => void run(async () => { await api.mergeContacts(contact.waId, target!); onMerged(); }, t.cdMerged)}>{t.cdMergeGo}</button>
              </div>
              <h3 className="pane-sub">{t.cdEraseTitle}</h3>
              <p className="muted small">{t.cdEraseWarn}</p>
              <label className="field"><span>{t.cdEraseConfirm}</span><input dir="ltr" inputMode="numeric" value={eraseTyped} onChange={(e) => setEraseTyped(e.target.value)} /></label>
              <div className="settings-actions">
                <button type="button" className="btn danger" disabled={busy || toWaId(eraseTyped) !== contact.waId} onClick={() => void run(async () => { await api.eraseContact(contact.waId); onMerged(); }, t.cdErased, t.cdErasedBefore)}>{t.cdEraseGo}</button>
              </div>
            </>
          )}
        </>
      )}
      {msg && msg.text !== '' && <p role={msg.kind === 'alert' ? 'alert' : 'status'} className={msg.kind === 'alert' ? 'error-text' : 'wallet-ok'}>{msg.text}</p>}
    </section>
  );
}

function RetentionCard({ t, api }: { t: Strings; api: ContactsApi }) {
  const [view, setView] = useState<RetentionDto | null>(null);
  const [days, setDays] = useState('730');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert'; text: string } | null>(null);
  useEffect(() => { void api.retention().then((v) => { setView(v); setDays(String(v.effectiveDays)); }, () => undefined); }, [api]);
  const options = Object.keys(t.rtOptions).map(Number);
  if (view && !options.includes(view.effectiveDays)) options.push(view.effectiveDays);
  options.sort((a, b) => a - b);
  const save = async () => {
    setMsg(null);
    try {
      const n = Number(days);
      const v = await api.setRetention(n === (view?.defaultDays ?? 730) ? null : n);
      setView(v); setMsg({ kind: 'ok', text: t.rtSaved });
    } catch { setMsg({ kind: 'alert', text: t.cdFailed }); }
  };
  return (
    <section className="import-panel" aria-labelledby="rt-title">
      <h2 id="rt-title">{t.rtTitle}</h2>
      <p className="muted small">{t.rtHelp}</p>
      <label className="field">
        <select aria-label={t.rtTitle} value={days} onChange={(e) => setDays(e.target.value)} disabled={!view}>
          {options.map((d) => <option key={d} value={d}>{t.rtOptions[d] ?? `${d}`}</option>)}
        </select>
      </label>
      <div className="settings-actions"><button type="button" className="btn primary" disabled={!view} onClick={() => void save()}>{t.rtSave}</button></div>
      {msg && <p role={msg.kind === 'alert' ? 'alert' : 'status'} className={msg.kind === 'alert' ? 'error-text' : 'wallet-ok'}>{msg.text}</p>}
    </section>
  );
}

/** Self-service export of every contact (owner only, audited by the server): a CSV the owner keeps. */
function ExportAllCard({ t, api }: { t: Strings; api: ContactsApi }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [count, setCount] = useState(0);
  const run = async () => {
    setState('busy');
    try {
      const all = await api.exportAllContacts();
      const url = URL.createObjectURL(new Blob([contactsCsv(all)], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'contacts.csv';
      a.click();
      URL.revokeObjectURL(url);
      setCount(all.length);
      setState('done');
    } catch { setState('failed'); }
  };
  return (
    <section className="import-panel" aria-labelledby="cx-title">
      <h2 id="cx-title">{t.cxTitle}</h2>
      <p className="muted small">{t.cxHint}</p>
      <div className="settings-actions"><button type="button" className="btn" disabled={state === 'busy'} onClick={() => void run()}>{state === 'busy' ? t.cxBusy : t.cxButton}</button></div>
      {state === 'done' && <p role="status" className="wallet-ok">{t.cxDone(count)}</p>}
      {state === 'failed' && <p role="alert" className="error-text">{t.cxFailed}</p>}
    </section>
  );
}
