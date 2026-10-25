import { Search, Upload, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ContactDto, ImportDto } from '../../../src/core/api/contract';
import type { ContactsApi, InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { relativeTime } from '../lib/format';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: ContactsApi; now: () => number };

export function ContactsScreen({ t, lang, source, api, now }: Props) {
  const [q, setQ] = useState('');
  const [optedOut, setOptedOut] = useState(false);
  const [items, setItems] = useState<ContactDto[] | null>(null);
  const [imports, setImports] = useState<ImportDto[]>([]);
  const owner = source.role !== 'staff';

  useEffect(() => {
    let stale = false;
    const run = () => void api.list({ q, ...(optedOut ? { optedOut: true } : {}) }).then((r) => { if (!stale) setItems(r.items); }, () => { if (!stale) setItems([]); });
    // Typing is debounced; a filter tap fetches at once.
    const id = q ? setTimeout(run, 250) : (run(), undefined);
    return () => { stale = true; clearTimeout(id); };
  }, [api, q, optedOut]);

  const loadImports = useCallback(() => api.imports().then(setImports, () => undefined), [api]);
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
          <label className="search">
            <Search size={18} aria-hidden />
            <input type="search" dir="auto" value={q} placeholder={t.searchContacts} aria-label={t.searchContacts} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="chips" role="group" aria-label={t.contactsTitle}>
            <button type="button" className="chip" aria-pressed={!optedOut} onClick={() => setOptedOut(false)}>{t.filterAllContacts}</button>
            <button type="button" className="chip" aria-pressed={optedOut} onClick={() => setOptedOut(true)}>{t.filterOptedOut}</button>
          </div>
          {items === null ? <div className="placeholder">…</div>
            : items.length === 0 ? <p className="empty-note">{t.contactsEmpty}</p>
            : (
              <ul className="contact-list" aria-label={t.contactsTitle}>
                {items.map((c) => (
                  <li key={c.waId} className="contact-row">
                    <div className="contact-main">
                      <b dir="auto">{c.name ?? t.noName}</b>
                      <span className="muted small" dir="ltr">+{c.waId.slice(0, -4).replace(/\d/g, '•')}{c.waId.slice(-4)}</span>
                    </div>
                    <div className="contact-tags">
                      {(c.tags ?? []).map((tag) => <span key={tag} className="tag" dir="auto">{tag}</span>)}
                      {c.optedOut ? <span className="flag bad">{t.optedOutBadge}</span>
                        : <span className="flag" data-ok={!!c.consent}>{c.consent ? t.consentYes : t.consentNo}</span>}
                    </div>
                    {c.lastInboundAt != null && <span className="muted small contact-when">{t.lastMessage(relativeTime(c.lastInboundAt, now(), lang))}</span>}
                  </li>
                ))}
              </ul>
            )}
        </section>
        {owner && <ImportPanel t={t} lang={lang} api={api} imports={imports} onStarted={() => void loadImports()} />}
      </div>
    </main>
  );
}

function ImportPanel({ t, lang, api, imports, onStarted }: { t: Strings; lang: Lang; api: ContactsApi; imports: ImportDto[]; onStarted: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [rejects, setRejects] = useState<{ line: number; reason: string }[]>([]);
  const n = (v: number) => num(v, lang);

  const start = async () => {
    if (!file) return;
    setBusy(true);
    setError(false);
    try {
      await api.importCsv(file, consented);
      setFile(null);
      setConsented(false);
      onStarted();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const toggleRejects = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setRejects(await api.rejects(id).catch(() => []));
    setOpen(id);
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
                  <ul className="reject-list">
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
