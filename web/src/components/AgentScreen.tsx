import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AgentSettingsDto, AgentSettingsUpdate } from '../../../src/core/api/contract';
import type { InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { LoadError } from './LoadError';

const PROMISE_FLAGS = [['allowRefund', 'promiseRefund'], ['allowDiscount', 'promiseDiscount'], ['allowFreeDelivery', 'promiseFreeDelivery'], ['allowExchange', 'promiseExchange'], ['allowGuarantee', 'promiseGuarantee']] as const;
type Draft = Omit<AgentSettingsDto, 'hasApiKey' | 'credits' | 'knowledgeReady'> & { apiKey: string };

export function AgentScreen({ t, lang, source }: { t: Strings; lang: Lang; source: InboxSource }) {
  // undefined = loading, null = the server said owner only (403), 'error' = the load itself failed.
  const [settings, setSettings] = useState<AgentSettingsDto | null | undefined | 'error'>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const load = useCallback(() => {
    setSettings(undefined);
    void source.agentSettings?.().then((s) => {
      setSettings(s);
      if (s) setDraft({ ...s, apiKey: '' });
    }, () => setSettings('error'));
  }, [source]);
  useEffect(load, [load]);

  if (settings === undefined) return <main className="screen"><div className="placeholder">…</div></main>;
  if (settings === 'error') return <main className="screen"><div className="placeholder"><LoadError t={t} onRetry={load} /></div></main>;
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
  // A Q&A up to 3 KB is read whole by the agent; a bigger one is searched through an index, and until that is built the agent cannot answer from it (src/core/ai/context.ts FAQ_INLINE_MAX_CHARS).
  const faqSmall = draft.faqText.trim().length > 0 && draft.faqText.trim().length <= 3072;
  const faqBigPending = draft.faqText.trim().length > 3072 && !settings.knowledgeReady;
  const notifyBad = draft.notifyPhone !== null && !/^\+[1-9]\d{7,14}$/.test(draft.notifyPhone);

  return (
    <main className="screen" aria-labelledby="agent-title">
      <header className="screen-head">
        <Sparkles size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="agent-title">{t.agentTitle}</h1>
        <span className="muted">{t.agentCredits(num(settings.credits, lang))}</span>
      </header>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (!notifyBad) void save(); }}>
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
          <span>{t.agentTone}</span>
          <select value={draft.tone} onChange={(e) => set('tone', e.target.value as Draft['tone'])} aria-describedby="tone-hint">
            <option value="warm">{t.toneWarm}</option><option value="professional">{t.toneProfessional}</option><option value="playful">{t.tonePlayful}</option>
          </select>
          <small id="tone-hint" className="muted">{t.agentToneHint}</small>
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
        <label className="field">
          <span>{t.agentNotify}</span>
          <input dir="ltr" inputMode="tel" autoComplete="off" value={draft.notifyPhone ?? ''} placeholder="+201001234567" aria-invalid={notifyBad} aria-describedby="notify-hint" onChange={(e) => set('notifyPhone', e.target.value.trim() === '' ? null : e.target.value.trim())} />
          <small id="notify-hint" className="muted">{t.agentNotifyHint}</small>
        </label>
        <div className="field">
          <label htmlFor="agent-faq">{t.agentFaq}</label>
          <textarea id="agent-faq" dir="auto" rows={6} maxLength={20000} value={draft.faqText} onChange={(e) => set('faqText', e.target.value)} aria-describedby="faq-hint" />
          <small id="faq-hint" className="muted">{t.agentFaqHint} · {faqSmall ? t.agentFaqInline : settings.knowledgeReady ? t.agentKbReady : t.agentKbPending}</small>
          {faqBigPending && <small role="alert" className="key-set">{t.agentFaqBigPending}</small>}
        </div>
        <div className="field">
          <div className="setting-row">
            <span id="agent-recommend-label">{t.agentRecommend}</span>
            <button type="button" role="switch" aria-checked={draft.recommendProducts} aria-labelledby="agent-recommend-label" aria-describedby="agent-recommend-hint" className="switch" onClick={() => set('recommendProducts', !draft.recommendProducts)}><span /></button>
          </div>
          <small id="agent-recommend-hint" className="muted">{t.agentRecommendHint}</small>
        </div>
        <fieldset className="field">
          <legend>{t.agentPromises}</legend>
          <small className="muted">{t.agentPromisesHint}</small>
          {PROMISE_FLAGS.map(([key, label]) => (
            <div className="setting-row" key={key}>
              <span id={`agent-${key}-label`}>{t[label]}</span>
              <button type="button" role="switch" aria-checked={draft[key]} aria-labelledby={`agent-${key}-label`} className="switch" onClick={() => set(key, !draft[key])}><span /></button>
            </div>
          ))}
        </fieldset>
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
