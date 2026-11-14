import { FileText, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SharedRequestDto, SharedTemplateDto, TemplateDto } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { InboxSource, TemplatesApi } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { templateTitle } from '../lib/format';
import { dateTime } from './CampaignsScreen';
import { EmptyState } from './EmptyState';
import { LoadError } from './LoadError';
import type { View } from './Rail';
import { SharedNumberTemplates } from './SharedNumberTemplates';
import { TemplateDetail } from './TemplateDetail';
import { TemplateEditor } from './TemplateEditor';

type Props = { t: Strings; lang: Lang; source: InboxSource; api: TemplatesApi; onNavigate?: (v: View) => void };
type Load =
  | { kind: 'loading' }
  | { kind: 'ok'; items: TemplateDto[]; starterInstalled: boolean }
  | { kind: 'no_number' }
  | { kind: 'shared'; templates: SharedTemplateDto[]; requests: SharedRequestDto[] }
  | { kind: 'token' }
  | { kind: 'error' };
type Mode = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; template: TemplateDto } | { kind: 'edit'; template: TemplateDto };

/** Maps a failed list call to what the merchant needs to hear: no number, a dead token, or a plain failure (never an empty table). */
function classify(e: unknown): Load {
  if (e instanceof ApiError && e.status === 404 && e.detail === 'no_active_number') return { kind: 'no_number' };
  if (e instanceof ApiError && e.status === 503 && e.detail === 'token_unavailable') return { kind: 'token' };
  return { kind: 'error' };
}

export function TemplatesScreen({ t, lang, source, api, onNavigate }: Props) {
  const owner = source.role !== 'staff';
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sync' | 'install' | null>(null);
  const [installFailed, setInstallFailed] = useState(false);
  const installed = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await api.list();
      setState({ kind: 'ok', items: r.items, starterInstalled: r.starterInstalled });
      return r;
    } catch (e) {
      const next = classify(e);
      // No own number: a store on the shared number still has something to show (the platform's templates and its asks); anything else keeps the prompt.
      if (next.kind === 'no_number' && api.shared) {
        try {
          const [templates, requests] = await Promise.all([api.shared.list(), api.shared.requests()]);
          setState({ kind: 'shared', templates, requests });
          return null;
        } catch (e2) {
          setState((s) => (s.kind === 'ok' ? s : e2 instanceof ApiError && e2.status === 404 ? next : classify(e2)));
          return null;
        }
      }
      setState((s) => (s.kind === 'ok' ? s : next)); // a failed refresh keeps the table that is already on screen
      return null;
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const install = useCallback(async () => {
    setBusy('install');
    setInstallFailed(false);
    try {
      const r = await api.installDefaults();
      if (r.failed.length > 0) setInstallFailed(true);
    } catch {
      setInstallFailed(true);
    } finally {
      setBusy(null);
    }
    await load();
  }, [api, load]);

  // An empty account that never had its starter set gets it once, automatically (the connect hook normally did this already).
  useEffect(() => {
    if (state.kind !== 'ok' || !owner || installed.current) return;
    if (state.items.length === 0 && !state.starterInstalled) { installed.current = true; void install(); }
  }, [state, owner, install]);

  const sync = async () => {
    setBusy('sync');
    setNote(null);
    try {
      const r = await api.sync();
      setNote(t.tplSynced(num(r.upserted, lang), num(r.removed, lang), r.removed));
      await load();
    } catch {
      setNote(t.tplSyncFailed);
    } finally {
      setBusy(null);
    }
  };

  if (mode.kind === 'new') return <TemplateEditor t={t} lang={lang} api={api} mode="create" existing={state.kind === 'ok' ? state.items : []} onSaved={() => { setMode({ kind: 'list' }); void load(); }} onClose={() => setMode({ kind: 'list' })} />;
  if (mode.kind === 'edit') return <TemplateEditor t={t} lang={lang} api={api} mode="edit" template={mode.template} existing={state.kind === 'ok' ? state.items : []} onSaved={() => { setMode({ kind: 'list' }); void load(); }} onClose={() => setMode({ kind: 'detail', template: mode.template })} />;
  if (mode.kind === 'detail') return <TemplateDetail t={t} lang={lang} api={api} owner={owner} template={mode.template} onBack={() => { setMode({ kind: 'list' }); void load(); }} onEdit={(tpl) => setMode({ kind: 'edit', template: tpl })} onDeleted={() => { setMode({ kind: 'list' }); setNote(t.tplDeleted); void load(); }} />;

  const items = state.kind === 'ok' ? state.items : [];
  const empty = state.kind === 'ok' && items.length === 0;
  return (
    <main className="screen" aria-labelledby="templates-title">
      <header className="screen-head">
        <FileText size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="templates-title">{t.tplTitle}</h1>
        {owner && state.kind === 'ok' && <button type="button" className="btn primary head-action" onClick={() => setMode({ kind: 'new' })}><Plus size={18} aria-hidden />{t.tplNew}</button>}
      </header>
      <div className="settings wide">
        <p className="muted">{t.tplIntro}</p>
        {!owner && <p className="muted" role="note">{t.tplStaffNote}</p>}
        {state.kind === 'ok' && (
          <div className="tpl-toolbar">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void sync()}><RefreshCw size={16} aria-hidden />{busy === 'sync' ? t.tplSyncing : t.tplSync}</button>
          </div>
        )}
        <p className="tpl-note" role="status" aria-live="polite">{note}</p>
        {state.kind === 'loading' ? <div className="placeholder">{t.tplLoading}</div>
          : state.kind === 'error' ? <LoadError t={t} onRetry={() => { setState({ kind: 'loading' }); void load(); }} />
          : state.kind === 'shared' && api.shared ? (
            <SharedNumberTemplates t={t} lang={lang} owner={owner} shared={api.shared} templates={state.templates} requests={state.requests} onNavigate={onNavigate} onSent={() => void load()} />
          ) : state.kind === 'no_number' ? (
            <EmptyState icon={<FileText size={22} />} title={t.tplNoNumberTitle} body={t.tplNoNumber} />
          ) : state.kind === 'token' ? (
            <EmptyState icon={<FileText size={22} />} title={t.tplTokenTitle} body={t.tplToken} />
          ) : empty ? (
            <>
              <EmptyState icon={<FileText size={22} />} title={t.tplEmptyTitle} body={busy === 'install' ? t.tplInstalling : installFailed ? t.tplInstallFailed : t.tplInstalling} />
              {owner && installFailed && busy === null && <button type="button" className="btn primary" onClick={() => void install()}>{t.tplInstallRetry}</button>}
            </>
          ) : (
            <table className="tpl-table">
              <thead><tr><th scope="col">{t.tplColName}</th><th scope="col">{t.tplColLang}</th><th scope="col">{t.tplColCategory}</th><th scope="col">{t.tplColStatus}</th><th scope="col">{t.tplColUpdated}</th><td><span className="vh">{t.tplOpen}</span></td></tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={`${x.name}/${x.language}`} data-status={x.status}>
                    <th scope="row" data-label={t.tplColName}>
                      <span className="tpl-label">{templateTitle(t, x)}</span>
                      <span className="tpl-raw" dir="ltr">{x.name}</span>
                      {x.status === 'REJECTED' && x.advice && <span className="tpl-advice">{lang === 'ar' ? x.advice.ar : x.advice.en}</span>}
                    </th>
                    <td data-label={t.tplColLang}>{t.tplLangs[x.language] ?? x.language}</td>
                    <td data-label={t.tplColCategory}><span className="tpl-cat">{t.tplCategories[x.category] ?? x.category}</span></td>
                    <td data-label={t.tplColStatus}><span className="status-chip tpl-status" data-status={x.status.toLowerCase()}>{t.tplStatuses[x.status] ?? x.status}</span></td>
                    <td data-label={t.tplColUpdated}>{x.updatedAt ? dateTime(x.updatedAt, lang) : '—'}</td>
                    <td><button type="button" className="btn ghost" aria-label={`${t.tplOpen}: ${templateTitle(t, x)}`} onClick={() => setMode({ kind: 'detail', template: x })}>{t.tplOpen}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        {(state.kind === 'no_number') && onNavigate && <button type="button" className="btn primary" onClick={() => onNavigate('numbers')}>{t.tplGoNumbers}</button>}
        {state.kind === 'token' && onNavigate && <button type="button" className="btn primary" onClick={() => onNavigate('numbers')}>{t.tplGoNumbers}</button>}
      </div>
    </main>
  );
}
