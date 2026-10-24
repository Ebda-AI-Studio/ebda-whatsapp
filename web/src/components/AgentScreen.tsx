import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentSettingsDto, AgentSettingsUpdate } from '../../../src/core/api/contract';
import type { InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';

type Draft = Omit<AgentSettingsDto, 'hasApiKey' | 'credits' | 'knowledgeReady'> & { apiKey: string };

export function AgentScreen({ t, lang, source }: { t: Strings; lang: Lang; source: InboxSource }) {
  const [settings, setSettings] = useState<AgentSettingsDto | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    void source.agentSettings?.().then((s) => {
      setSettings(s);
      if (s) setDraft({ ...s, apiKey: '' });
    }, () => setSettings(null));
  }, [source]);

  if (settings === undefined) return <main className="screen"><div className="placeholder">…</div></main>;
  if (settings === null || !draft) return <main className="screen"><div className="placeholder">{t.ownerOnly}</div></main>;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setDraft({ ...draft, [k]: v }); setStatus('idle'); };
  const save = async () => {
    setStatus('saving');
    const { apiKey, ...rest } = draft;
    const update: AgentSettingsUpdate = { ...rest, ...(apiKey ? { apiKey } : {}) };
    try {
      const next = await source.saveAgentSettings!(update);
      setSettings(next);
      setDraft({ ...next, apiKey: '' });
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };
  const own = draft.provider === 'openai-compatible';

  return (
    <main className="screen" aria-labelledby="agent-title">
      <header className="screen-head">
        <Sparkles size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="agent-title">{t.agentTitle}</h1>
        <span className="muted">{t.agentCredits(num(settings.credits, lang))}</span>
      </header>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className="muted">{t.agentIntro}</p>
        <div className="setting-row">
          <span id="agent-enable-label">{t.agentEnable}</span>
          <button type="button" role="switch" aria-checked={draft.enabled} aria-labelledby="agent-enable-label" className="switch" onClick={() => set('enabled', !draft.enabled)}><span /></button>
        </div>
        <label className="field">
          <span>{t.agentPersona}</span>
          <input dir="auto" value={draft.persona} maxLength={1000} placeholder={t.agentPersonaHint} onChange={(e) => set('persona', e.target.value)} />
        </label>
        <label className="field">
          <span>{t.agentLanguage}</span>
          <select value={draft.language} onChange={(e) => set('language', e.target.value as Draft['language'])}>
            <option value="ar">{t.langAr}</option><option value="en">{t.langEn}</option><option value="auto">{t.langAuto}</option>
          </select>
        </label>
        <label className="field">
          <span>{t.agentHandoff}</span>
          <input type="number" min={5} max={1440} value={draft.handoffMinutes} onChange={(e) => set('handoffMinutes', Math.min(1440, Math.max(5, Number(e.target.value) || 5)))} />
        </label>
        <div className="field">
          <label htmlFor="agent-faq">{t.agentFaq}</label>
          <textarea id="agent-faq" dir="auto" rows={6} maxLength={20000} value={draft.faqText} onChange={(e) => set('faqText', e.target.value)} aria-describedby="faq-hint" />
          <small id="faq-hint" className="muted">{t.agentFaqHint} · {settings.knowledgeReady ? t.agentKbReady : t.agentKbPending}</small>
        </div>
        <fieldset className="field">
          <legend>{t.agentProvider}</legend>
          <label className="radio"><input type="radio" name="provider" checked={!own} onChange={() => set('provider', 'workers-ai')} />{t.providerBuiltIn}</label>
          <label className="radio"><input type="radio" name="provider" checked={own} onChange={() => set('provider', 'openai-compatible')} />{t.providerOwn}</label>
        </fieldset>
        {own && (
          <>
            <label className="field"><span>{t.agentBaseUrl}</span><input dir="ltr" value={draft.baseUrl ?? ''} placeholder="https://api.openai.com/v1" onChange={(e) => set('baseUrl', e.target.value || null)} /></label>
            <label className="field"><span>{t.agentModel}</span><input dir="ltr" value={draft.model ?? ''} onChange={(e) => set('model', e.target.value || null)} /></label>
            <div className="field">
              <label htmlFor="agent-key">{t.agentApiKey}</label>
              <input id="agent-key" dir="ltr" type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => set('apiKey', e.target.value)} aria-describedby="key-hint" />
              <small id="key-hint" className="muted">{settings.hasApiKey && <b className="key-set">{t.agentKeySet}</b>} {t.agentKeyHint}</small>
            </div>
          </>
        )}
        <div className="settings-actions">
          <button type="submit" className="btn primary" disabled={status === 'saving'}>{t.save}</button>
          {(status === 'saved' || status === 'failed') && <span role="status" className={status === 'failed' ? 'error-text' : 'muted'}>{status === 'saved' ? t.saved : t.saveFailed}</span>}
        </div>
      </form>
    </main>
  );
}
