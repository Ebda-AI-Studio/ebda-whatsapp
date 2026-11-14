import { FileText } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { SharedRequestDto, SharedTemplateDto } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { TemplatesApi } from '../data/source';
import { type Lang, type Strings } from '../i18n';
import { dateTime } from './CampaignsScreen';
import type { View } from './Rail';

const NAME = /^[a-z0-9_]{1,512}$/;

/**
 * A store on the shared number: what it can use from the platform, how to ask for one more, and why marketing needs its own number.
 * Marketing is not offered here at all (WA-SHARED-NOCAMP-1), so there is no option to refuse later.
 */
export function SharedNumberTemplates({ t, lang, owner, shared, templates, requests, onNavigate, onSent }: {
  t: Strings; lang: Lang; owner: boolean; shared: NonNullable<TemplatesApi['shared']>; templates: SharedTemplateDto[]; requests: SharedRequestDto[];
  onNavigate?: ((v: View) => void) | undefined; onSent: () => void;
}) {
  const [form, setForm] = useState({ name: '', language: 'ar', category: 'UTILITY' as 'UTILITY' | 'AUTHENTICATION', body: '' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setNote(null);
    const name = form.name.trim();
    if (!NAME.test(name)) return setNote({ kind: 'error', text: t.tplSharedBadName });
    if (!form.body.trim()) return setNote({ kind: 'error', text: t.tplErrGeneric });
    setBusy(true);
    try {
      await shared.request({ name, language: form.language, category: form.category, body: form.body.trim() });
      setNote({ kind: 'ok', text: t.tplSharedSent });
      setForm((f) => ({ ...f, name: '', body: '' }));
      onSent();
    } catch (err) {
      setNote({ kind: 'error', text: err instanceof ApiError && err.status === 429 ? t.tplSharedLimit : t.tplErrGeneric });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="tpl-sharedbanner" role="note">{t.tplSharedBanner}</p>
      {onNavigate && <button type="button" className="btn primary" onClick={() => onNavigate('numbers')}>{t.tplSharedGoNumbers}</button>}

      {templates.length === 0 ? <p className="muted">{t.tplSharedEmpty}</p> : (
        <table className="tpl-table" aria-label={t.tplSharedListTitle}>
          <thead><tr><th scope="col">{t.tplColName}</th><th scope="col">{t.tplColLang}</th><th scope="col">{t.tplColCategory}</th><th scope="col">{t.tplBodyLabel}</th></tr></thead>
          <tbody>
            {templates.map((x) => (
              <tr key={`${x.name}/${x.language}`}>
                <th scope="row" data-label={t.tplColName}><span className="tpl-raw" dir="ltr">{x.name}</span></th>
                <td data-label={t.tplColLang}>{t.tplLangs[x.language] ?? x.language}</td>
                <td data-label={t.tplColCategory}><span className="tpl-cat">{t.tplCategories[x.category] ?? x.category}</span></td>
                <td data-label={t.tplBodyLabel} dir="auto">{x.bodyText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {owner && (
        <section className="tpl-confirm" aria-labelledby="tpl-sh-req">
          <h2 id="tpl-sh-req">{t.tplSharedRequestTitle}</h2>
          <p className="muted">{t.tplSharedRequestHelp}</p>
          <form className="tpl-editor" onSubmit={(e) => void submit(e)}>
            <label className="field"><span>{t.tplSharedName}</span><input dir="ltr" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>{t.tplSharedType}</span>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as 'UTILITY' | 'AUTHENTICATION' })}>
                <option value="UTILITY">{t.tplCategories.UTILITY}</option><option value="AUTHENTICATION">{t.tplCategories.AUTHENTICATION}</option>
              </select></label>
            <label className="field"><span>{t.tplLangLabel}</span>
              <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}><option value="ar">{t.tplLangs.ar}</option><option value="en">{t.tplLangs.en}</option></select></label>
            <label className="field"><span>{t.tplSharedBody}</span><textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
            {note?.kind === 'error' && <p className="error-text" role="alert">{note.text}</p>}
            <div className="settings-actions"><button type="submit" className="btn primary" disabled={busy}>{t.tplSharedSend}</button></div>
          </form>
        </section>
      )}
      <p className="tpl-note" role="status" aria-live="polite">{note?.kind === 'ok' ? note.text : ''}</p>

      <section aria-labelledby="tpl-sh-mine" className="tpl-mine">
        <h2 id="tpl-sh-mine" className="tpl-h2"><FileText size={16} aria-hidden /> {t.tplSharedMine}</h2>
        {requests.length === 0 ? <p className="muted">{t.tplSharedNone}</p> : (
          <ul className="tpl-requests">
            {requests.map((r) => (
              <li key={r.id}>
                <span className="tpl-raw" dir="ltr">{r.name}</span>
                <span className="status-chip tpl-status" data-status={r.status === 'open' ? 'pending' : r.status === 'done' ? 'approved' : 'rejected'}>{t.tplSharedStatuses[r.status] ?? r.status}</span>
                <span className="muted small">{dateTime(r.createdAt, lang)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
