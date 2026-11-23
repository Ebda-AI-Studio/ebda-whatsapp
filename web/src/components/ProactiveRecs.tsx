import { useEffect, useState } from 'react';
import type { ProactiveRecsDto } from '../../../src/core/api/contract';
import type { InboxSource } from '../data/source';
import type { Strings } from '../i18n';
import { LoadError } from './LoadError';
import { Skeleton } from './Skeleton';

/** CHAT-RECS-SWITCH-1: the owner's switch for post-order product suggestions. Off by default; honest about the approved template, the consent and the wallet charge. */
export function ProactiveRecs({ t, source }: { t: Strings; source: InboxSource }) {
  const api = source.proactiveRecs!;
  const [view, setView] = useState<ProactiveRecsDto | undefined | 'error'>(undefined);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = () => { void api.get().then((v) => { setView(v); setName(v.templateName ?? ''); }, () => setView('error')); };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (change: { enabled?: boolean; templateName?: string | null }) => {
    setBusy(true);
    setNote(null);
    try {
      const v = await api.save(change);
      setView(v);
      setNote(t.saved);
    } catch (e) {
      const d = (e as { detail?: string; message?: string }).detail ?? (e as Error).message;
      setNote(d === 'template_required' ? t.prNeedTemplate : d === 'invalid_template' ? t.prBadTemplate : t.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings" aria-labelledby="proactive-recs-title">
      <h2 id="proactive-recs-title">{t.prTitle}</h2>
      <p className="muted">{t.prIntro}</p>
      <p className="muted">{t.prNeeds}</p>
      {view === undefined && <Skeleton t={t} rows={2} kind="setting" />}
      {view === 'error' && <LoadError t={t} onRetry={load} />}
      {view && view !== 'error' && (
        <>
          <div className="field">
            <label htmlFor="pr-template">{t.prTemplate}</label>
            <input id="pr-template" dir="ltr" value={name} maxLength={512} disabled={busy} aria-describedby="pr-template-hint" onChange={(e) => setName(e.target.value.trim())} />
            <small id="pr-template-hint" className="muted">{t.prTemplateHint}</small>
            <div className="settings-actions"><button type="button" className="btn" disabled={busy || name === (view.templateName ?? '')} onClick={() => void save({ templateName: name === '' ? null : name })}>{t.prSave}</button></div>
          </div>
          <div className="field">
            <div className="setting-row">
              <span id="pr-switch">{t.prSwitch}</span>
              <button type="button" role="switch" aria-checked={view.enabled} aria-labelledby="pr-switch" className="switch" disabled={busy} onClick={() => void save({ enabled: !view.enabled })}><span /></button>
            </div>
            <small className="muted">{view.enabled ? t.swOn : t.swOff}</small>
          </div>
          {note && <span role="status" className="muted">{note}</span>}
        </>
      )}
    </section>
  );
}
