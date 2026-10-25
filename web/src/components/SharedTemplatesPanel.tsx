import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { TemplateDto } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import { usableByStores, type SharedTemplatesApi } from '../data/shared-templates';
import { num, type Lang, type Strings } from '../i18n';

type Props = {
  t: Strings; lang: Lang; api: SharedTemplatesApi;
  run: (fn: () => Promise<string | void>) => Promise<boolean>;
  fail: (...lines: string[]) => void;
};
const NAME = /^[a-z0-9_]{1,512}$/;

/** Operator console, "Shared number templates": the platform WABA's catalog. Stores cannot see or change it. */
export function SharedTemplatesPanel({ t, lang, api, run, fail }: Props) {
  const [items, setItems] = useState<TemplateDto[] | null>(null);
  const [state, setState] = useState<'ok' | 'unavailable' | 'error'>('ok');
  const [form, setForm] = useState({ name: '', language: 'ar', category: 'UTILITY', body: '' });

  const reload = useCallback(async () => {
    try {
      setItems(await api.list());
      setState('ok');
    } catch (e) {
      setState(e instanceof ApiError && e.status === 404 ? 'unavailable' : 'error');
    }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  const sync = async () => {
    if (await run(async () => { const r = await api.sync(); return t.opSharedSynced(num(r.upserted, lang), num(r.removed, lang)); })) await reload();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!NAME.test(name)) return fail(t.opSharedBadName);
    if (!form.body.trim()) return fail(t.opSharedBodyNeeded);
    const input = { name, language: form.language as 'ar' | 'en', category: form.category as 'UTILITY' | 'AUTHENTICATION', components: [{ type: 'BODY' as const, text: form.body.trim() }] };
    if (await run(async () => { await api.submit(input); return t.opSharedSubmitted; })) { setForm((f) => ({ ...f, name: '', body: '' })); await reload(); }
  };

  if (state === 'unavailable') return <div role="alert" className="error-text op-note"><p>{t.opSharedUnavailable}</p></div>;
  return (
    <>
      <section className="wallet-card" aria-labelledby="op-shared-list">
        <h2 id="op-shared-list">{t.opSharedTitle}</h2>
        <p className="muted">{t.opSharedHelp}</p>
        <button type="button" className="btn" onClick={() => void sync()}>{t.opSharedSync}</button>
        {state === 'error' && <p className="error-text" role="alert">{t.opLoadError}</p>}
        {items && items.length === 0 && <p className="muted">{t.opSharedEmpty}</p>}
        {items && items.length > 0 && (
          <table className="op-table">
            <thead><tr><th scope="col">{t.opSharedName}</th><th scope="col">{t.opSharedLang}</th><th scope="col">{t.opSharedCategory}</th><th scope="col">{t.opSharedStatus}</th><th scope="col">{t.opSharedStores}</th></tr></thead>
            <tbody>
              {items.map((x) => (
                <tr key={`${x.name}/${x.language}`}>
                  <td dir="ltr">{x.name}</td><td>{x.language}</td><td>{x.category}</td><td>{x.status}{x.rejectedReason ? ` (${x.rejectedReason})` : ''}</td>
                  <td>{usableByStores(x) ? t.opSharedUsable : t.opSharedBlocked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="wallet-card" aria-labelledby="op-shared-submit">
        <h2 id="op-shared-submit">{t.opSharedSubmitTitle}</h2>
        <p className="muted">{t.opSharedNoMarketing}</p>
        <form className="wallet-form" onSubmit={(e) => void submit(e)}>
          <label className="field"><span>{t.opSharedName}</span><input dir="ltr" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>{t.opSharedLang}</span>
            <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}><option value="ar">ar</option><option value="en">en</option></select></label>
          <label className="field"><span>{t.opSharedCategory}</span>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option value="UTILITY">UTILITY</option><option value="AUTHENTICATION">AUTHENTICATION</option></select></label>
          <label className="field"><span>{t.opSharedBody}</span><textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
          <button type="submit" className="btn primary">{t.opSharedSubmit}</button>
        </form>
      </section>
    </>
  );
}
