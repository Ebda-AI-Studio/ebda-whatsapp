import { Plug } from 'lucide-react';
import { BRAND } from '@brand';
import { useCallback, useEffect, useState } from 'react';
import { webhookTool, type ConnectorDto, type ConnectorPut } from '../../../src/core/api/contract';
import { z } from 'zod';
import { WHATSAPP_SCOPES } from '../../../src/core/identity/scopes';
import type { InboxSource } from '../data/source';
import type { Lang, Strings } from '../i18n';
import { LoadError } from './LoadError';
import { Skeleton } from './Skeleton';
import { IntegrationMark } from './IntegrationMark';

type Connectors = NonNullable<InboxSource['connectors']>;
type Draft = { id: string; kind: 'webhook' | 'odoo'; enabled: boolean; url: string; tools: string; database: string; login: string; secret: string; existing: boolean };

const SCOPES = WHATSAPP_SCOPES;
const blank: Draft = { id: '', kind: 'webhook', enabled: true, url: '', tools: '', database: '', login: '', secret: '', existing: false };
const toolsSchema = z.array(webhookTool).min(1).max(10);

/** The tools text as a list, or null when it is not valid (the same rules the server applies). */
function parseTools(text: string) {
  try {
    const parsed = toolsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const draftOf = (c: ConnectorDto): Draft => ({
  id: c.id, kind: c.kind, enabled: c.enabled, existing: true, secret: '',
  url: c.config.url,
  tools: 'tools' in c.config ? JSON.stringify(c.config.tools, null, 2) : '',
  database: 'database' in c.config ? c.config.database : '',
  login: 'login' in c.config ? c.config.login : '',
});

/** The shortest secret the server accepts (src/core/api/contract.ts connectorPut): 16 for a webhook, 8 for Odoo. */
export const SECRET_MIN = { webhook: 16, odoo: 8 } as const;

/** The body to save, or null while the draft is not savable. A secret is sent only when typed (an edit keeps the stored one). */
function bodyOf(d: Draft): ConnectorPut | null {
  const secret = d.secret.trim() === '' ? {} : { secret: d.secret };
  if (!d.existing && d.secret.trim() === '') return null;
  if (d.secret.trim() !== '' && d.secret.length < SECRET_MIN[d.kind]) return null;
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(d.id) || d.id.length > 16 || !d.url.trim()) return null;
  if (d.kind === 'webhook') {
    const tools = parseTools(d.tools);
    return tools ? { kind: 'webhook', enabled: d.enabled, config: { url: d.url.trim(), tools }, ...secret } : null;
  }
  return d.database.trim() && d.login.trim() ? { kind: 'odoo', enabled: d.enabled, config: { url: d.url.trim(), database: d.database.trim(), login: d.login.trim() }, ...secret } : null;
}

const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

/** Agent connectors (owner) and where an integration token is made. The server owns every rule; this screen only hides what the role cannot do. */
export function IntegrationsScreen({ t, lang, source, readOnly = false }: { t: Strings; lang: Lang; source: InboxSource; readOnly?: boolean }) {
  const api: Connectors = source.connectors!;
  const [list, setList] = useState<ConnectorDto[] | undefined | 'error'>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const load = useCallback(() => { setList(undefined); void api.list().then(setList, () => setList('error')); }, [api]);
  useEffect(load, [load]);

  const set = (p: Partial<Draft>) => { if (draft) { setDraft({ ...draft, ...p }); setAsking(false); setMessage(null); } };
  const body = draft ? bodyOf(draft) : null;
  const toolsBad = !!draft && draft.kind === 'webhook' && draft.tools !== '' && parseTools(draft.tools) === null;

  const save = async () => {
    if (!draft || !body) return;
    setBusy(true);
    try {
      await api.save(draft.id, body);
      setDraft(null);
      setAsking(false);
      setMessage({ kind: 'status', text: t.connSaved });
      load();
    } catch (e) {
      const detail = (e as { detail?: string }).detail;
      setAsking(false);
      setMessage({ kind: 'alert', text: (detail && t.connErr[detail]) || t.connErrGeneric });
    } finally {
      setBusy(false);
    }
  };
  const test = async (id: string) => {
    setBusy(true);
    try {
      const r = await api.test(id);
      setTests((x) => ({ ...x, [id]: r.ok ? t.connTestOk : r.error === 'rate_limited' ? t.connTestWait : t.connTestFail(r.error ?? '') }));
    } catch (e) {
      setTests((x) => ({ ...x, [id]: (e as { code?: string }).code === 'rate_limited' ? t.connTestWait : t.connTestFail('') }));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try { await api.remove(id); setDeleting(null); load(); } catch { setMessage({ kind: 'alert', text: t.connErrGeneric }); } finally { setBusy(false); }
  };

  const toolNames = draft?.kind === 'webhook' ? (parseTools(draft.tools) ?? []).map((x) => `${draft.id}__${x.name}`).join('، ') : `${draft?.id ?? ''}__odoo`;

  return (
    <main className="screen" aria-labelledby="int-title">
      <header className="screen-head">
        <Plug size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="int-title">{t.intTitle}</h1>
      </header>
      <section className="settings" aria-labelledby="conn-title">
        <h2 id="conn-title">{t.connTitle}</h2>
        <p className="muted">{t.connIntro}</p>
        {readOnly && <p className="muted" role="note">{t.connReadOnly}</p>}
        {list === undefined && <Skeleton t={t} rows={3} />}
        {list === 'error' && <LoadError t={t} onRetry={load} />}
        {Array.isArray(list) && list.length === 0 && !draft && <p className="muted">{t.connNone}</p>}
        {Array.isArray(list) && list.map((c) => (
          <article key={c.id} className="campaign" aria-label={c.id}>
            <h3 dir="auto" className="int-title"><IntegrationMark kind={c.kind} />{c.id} · {c.kind}{c.enabled ? '' : ` · ${t.connOff}`}</h3>
            <p className="muted small" dir="auto">{hostOf(c.config.url)} · {t.connToolsLine(c.tools.join('، '))}</p>
            {c.hasSecret && <p className="muted small">{t.connHasSecret}</p>}
            {tests[c.id] && <p role="status" className="muted">{tests[c.id]}</p>}
            {readOnly ? null : deleting === c.id ? (
              <div className="confirm-inline" role="group" aria-label={t.connDeleteAsk}>
                <span>{t.connDeleteAsk}</span>
                <button type="button" className="btn danger" disabled={busy} onClick={() => void remove(c.id)}>{t.connDeleteYes}</button>
                <button type="button" className="btn" onClick={() => setDeleting(null)}>{t.connConfirmNo}</button>
              </div>
            ) : (
              <div className="campaign-actions">
                <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(draftOf(c)); setAsking(false); setMessage(null); }}>{t.connEdit}</button>
                <button type="button" className="btn" disabled={busy} onClick={() => void test(c.id)}>{t.connTest}</button>
                <button type="button" className="btn quiet" onClick={() => setDeleting(c.id)}>{t.connDelete}</button>
              </div>
            )}
          </article>
        ))}
        {!readOnly && !draft && <div className="settings-actions"><button type="button" className="btn primary" onClick={() => { setDraft(blank); setMessage(null); }}>{t.connAdd}</button></div>}
        {!readOnly && draft && (
          <form onSubmit={(e) => { e.preventDefault(); if (body) setAsking(true); }}>
            <label className="field"><span>{t.connId}</span><input dir="ltr" maxLength={16} value={draft.id} readOnly={draft.existing} onChange={(e) => set({ id: e.target.value })} /></label>
            <div className="int-pick"><IntegrationMark kind={draft.kind} />
              <label className="field"><span>{t.connKind}</span>
                <select value={draft.kind} disabled={draft.existing} onChange={(e) => set({ kind: e.target.value as Draft['kind'] })}><option value="webhook">Webhook</option><option value="odoo">Odoo</option></select>
              </label></div>
            <div className="setting-row">
              <span id="conn-enabled-label">{t.connEnabled}</span>
              <button type="button" role="switch" aria-checked={draft.enabled} aria-labelledby="conn-enabled-label" className="switch" onClick={() => set({ enabled: !draft.enabled })}><span /></button>
            </div>
            <label className="field"><span>{t.connUrl}</span><input dir="ltr" type="url" maxLength={300} value={draft.url} onChange={(e) => set({ url: e.target.value })} /></label>
            {draft.kind === 'webhook' ? (
              <>
                <label className="field"><span>{t.connTools}</span><textarea dir="ltr" rows={8} value={draft.tools} aria-invalid={toolsBad} onChange={(e) => set({ tools: e.target.value })} /></label>
                {toolsBad ? <small className="error-text">{t.connToolsBad}</small> : <small className="muted">{t.connToolsHint}</small>}
              </>
            ) : (
              <>
                <label className="field"><span>{t.connDb}</span><input dir="ltr" value={draft.database} onChange={(e) => set({ database: e.target.value })} /></label>
                <label className="field"><span>{t.connLogin}</span><input dir="ltr" value={draft.login} onChange={(e) => set({ login: e.target.value })} /></label>
              </>
            )}
            <label className="field">
              <span>{draft.kind === 'webhook' ? t.connSecretWebhook : t.connSecretOdoo}</span>
              <input dir="ltr" type="password" autoComplete="off" value={draft.secret} onChange={(e) => set({ secret: e.target.value })} />
            </label>
            {draft.secret !== '' && draft.secret.length < SECRET_MIN[draft.kind]
              ? <small className="error-text" role="status">{t.connSecretShort(SECRET_MIN[draft.kind])}</small>
              : <small className="muted">{t.connSecretHint} {t.connSecretMin(SECRET_MIN[draft.kind])}</small>}
            {asking && body && (
              <div className="confirm-inline" role="group" aria-label={t.connConfirmTitle}>
                <span>{t.connConfirmText(hostOf(draft.url), toolNames)}</span>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{t.connConfirmYes}</button>
                <button type="button" className="btn" onClick={() => setAsking(false)}>{t.connConfirmNo}</button>
              </div>
            )}
            <div className="settings-actions">
              <button type="submit" className="btn primary" disabled={!body || busy || asking}>{t.connSave}</button>
              <button type="button" className="btn quiet" onClick={() => { setDraft(null); setAsking(false); }}>{t.connCancel}</button>
            </div>
          </form>
        )}
        {message && <p role={message.kind} className={message.kind === 'alert' ? 'error-text' : 'muted'}>{message.text}</p>}
      </section>
      <section className="settings" aria-labelledby="api-title">
        <h2 id="api-title">{t.apiTitle}</h2>
        <p>{t.apiBody}</p>
        <p className="muted">{t.apiScopes}: {SCOPES.map((s) => t.apiScopeLabels[s] ?? s).join(lang === 'ar' ? '، ' : ', ')}</p>
        <p className="muted">{t.apiPlan}{BRAND.helpUrl && <> <a className="help-link" href={BRAND.helpUrl(lang, 'connect-your-systems')} target="_blank" rel="noopener">{t.howTo}</a></>}</p>
        {BRAND.accountsUrl && <a className="btn" href={BRAND.accountsUrl} target="_blank" rel="noopener noreferrer">{t.apiOpen}</a>}
      </section>
    </main>
  );
}
