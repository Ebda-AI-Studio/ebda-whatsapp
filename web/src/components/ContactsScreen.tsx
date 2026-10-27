import { Upload, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ContactDto, ImportDto } from '../../../src/core/api/contract';
import type { ContactsApi, InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { relativeTime } from '../lib/format';
import { useTypeahead } from '../lib/useTypeahead';
import { Highlight } from './Highlight';
import { LoadError } from './LoadError';
import { SearchBox, optionId } from './SearchBox';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: ContactsApi; now: () => number };

const LIST_ID = 'contact-results';

export function ContactsScreen({ t, lang, source, api, now }: Props) {
  const [optedOut, setOptedOut] = useState(false);
  const [items, setItems] = useState<ContactDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [imports, setImports] = useState<ImportDto[]>([]);
  const owner = source.role !== 'staff';

  // Typing uses the shared search hook (from the first character, 150 ms pause, older answers dropped); the plain list loads at once.
  // The opted-out chip and a retry re-run the same query.
  const fetchSearch = useCallback((q: string, signal: AbortSignal) => api.list({ q, ...(optedOut ? { optedOut: true } : {}) }, signal).then((r) => r.items), [api, optedOut]);
  const search = useTypeahead<ContactDto>(fetchSearch, { deps: [api, optedOut, attempt] });
  const q = search.query;
  const searching = q.trim() !== '';
  useEffect(() => {
    if (searching) return;
    let stale = false;
    void api.list({ ...(optedOut ? { optedOut: true } : {}) }).then((r) => { if (!stale) { setItems(r.items); setFailed(false); } }, () => { if (!stale) setFailed(true); });
    return () => { stale = true; };
  }, [api, searching, optedOut, attempt]);
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
          <SearchBox t={t} lang={lang} label={t.searchContacts} query={q} onQuery={search.setQuery} status={searching ? search.status : 'idle'} count={shown?.length ?? 0} listId={LIST_ID} activeIndex={active} onActiveIndex={setActive} onPick={() => undefined} />
          <div className="chips" role="group" aria-label={t.contactsTitle}>
            <button type="button" className="chip" aria-pressed={!optedOut} onClick={() => setOptedOut(false)}>{t.filterAllContacts}</button>
            <button type="button" className="chip" aria-pressed={optedOut} onClick={() => setOptedOut(true)}>{t.filterOptedOut}</button>
          </div>
          {listFailed ? <LoadError t={t} onRetry={() => { setFailed(false); setAttempt((a) => a + 1); }} />
            : shown === null ? <div className="placeholder">…</div>
            : shown.length === 0 ? <p className="empty-note">{t.contactsEmpty}</p>
            : (
              <ul className="contact-list" id={LIST_ID} role="listbox" aria-label={t.contactsTitle}>
                {shown.map((c, i) => (
                  <li key={c.waId} id={optionId(LIST_ID, i)} role="option" aria-selected={i === active} data-active={i === active} className="contact-row">
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
                        <p className="muted">{t.consentProofLine(t.consentSource[c.consent.proof.source], c.consent.proof.attestedBy, new Date(c.consent.proof.at).toLocaleDateString(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB'))}</p>
                        <blockquote dir="auto">{c.consent.proof.wording}</blockquote>
                      </details>
                    )}
                    {c.lastInboundAt != null && <span className="muted small contact-when">{t.lastMessage(relativeTime(c.lastInboundAt, now(), lang))}</span>}
                  </li>
                ))}
              </ul>
            )}
        </section>
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
