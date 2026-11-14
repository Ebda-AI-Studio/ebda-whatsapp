import { ArrowRight, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { TemplateDto } from '../../../src/core/api/contract';
import { fromStoredComponents } from '../../../src/core/template-draft';
import { BRAND } from '@brand';
import { ApiError } from '../data/api';
import type { TemplatesApi } from '../data/source';
import type { Lang, Strings } from '../i18n';
import { templateTitle } from '../lib/format';
import { dateTime } from './CampaignsScreen';
import { TemplateBubble } from './TemplateBubble';

type Props = {
  t: Strings; lang: Lang; api: TemplatesApi; owner: boolean; template: TemplateDto;
  onBack: () => void; onEdit: (t: TemplateDto) => void; onDeleted: () => void;
};

/** One template: where it stands with Meta, why it was refused (plain words first, Meta's code second), and what the merchant can do about it. */
export function TemplateDetail({ t, lang, api, owner, template, onBack, onEdit, onDeleted }: Props) {
  const [tpl, setTpl] = useState(template);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

  // The list row can be minutes old: ask again so the edit allowance and the status are Meta's latest answer.
  useEffect(() => {
    let live = true;
    void api.detail(template.name, template.language).then((x) => { if (live) setTpl(x); }, () => undefined);
    return () => { live = false; };
  }, [api, template.name, template.language]);

  const draft = fromStoredComponents((tpl.components ?? []) as never, { name: tpl.name, language: tpl.language, category: tpl.category, label: tpl.label ?? null });
  const allowance = tpl.editAllowance;
  const status = tpl.status;
  const canEditByStatus = status === 'REJECTED' || status === 'PAUSED' || status === 'APPROVED';
  const waitText = allowance && !allowance.allowed && allowance.retryAt ? t.tplEditWait(dateTime(allowance.retryAt, lang)) : null;
  const blockedReason = status === 'DISABLED' ? null : !canEditByStatus ? t.tplEditNotNow : allowance && !allowance.allowed ? (waitText ?? t.tplEditNotNow) : null;
  const canEdit = owner && canEditByStatus && (!allowance || allowance.allowed);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.remove(tpl.name, tpl.language);
      onDeleted();
    } catch (e) {
      setAsking(false);
      setError(e instanceof ApiError && e.detail === 'in_use' ? t.tplErrInUse : e instanceof ApiError && e.status === 503 ? t.tplErrUnavailable : t.tplErrGeneric);
    } finally {
      setBusy(false);
    }
  };

  const titleId = `${uid}-t`;
  return (
    <main className="screen" aria-labelledby={titleId}>
      <header className="screen-head">
        <button type="button" className="btn ghost" onClick={onBack}><ArrowRight size={18} aria-hidden />{t.tplDetailBack}</button>
        <h1 id={titleId}>{templateTitle(t, tpl)}</h1>
        <span className="status-chip tpl-status" data-status={status.toLowerCase()}>{t.tplStatuses[status] ?? status}</span>
      </header>
      <div className="settings">
        <p className="tpl-raw" dir="ltr">{tpl.name} · {tpl.language}</p>
        <p className="tpl-timeline" role="status">{t.tplTimeline[status] ?? ''}</p>
        <TemplateBubble draft={draft} empty={t.tplPreviewEmpty} />
        <p className="muted"><span className="tpl-cat">{t.tplCategories[tpl.category] ?? tpl.category}</span></p>

        {tpl.advice && (
          <section className="tpl-reason" aria-labelledby={`${uid}-r`}>
            <h2 id={`${uid}-r`} className="vh">{t.tplColStatus}</h2>
            <p>{lang === 'ar' ? tpl.advice.ar : tpl.advice.en}</p>
            {BRAND.helpUrl && <p><a href={BRAND.helpUrl(lang, 'template-review-and-rejections')} target="_blank" rel="noopener">{t.tplReasonHelp}</a></p>}
            {tpl.rejectedReason && <details><summary>{t.tplRawReason}</summary><code dir="ltr">{tpl.rejectedReason}</code></details>}
          </section>
        )}

        {!owner && <p className="muted" role="note">{t.tplStaffNote}</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        {owner && (
          <div className="tpl-actions">
            {status !== 'DISABLED' && (
              <button type="button" className="btn primary" disabled={!canEdit} aria-describedby={blockedReason ? `${uid}-why` : undefined} onClick={() => onEdit(tpl)}>
                <Pencil size={16} aria-hidden />{status === 'APPROVED' ? t.tplEditApproved : t.tplEditResubmit}
              </button>
            )}
            {status === 'APPROVED' && <p className="muted small">{t.tplCategoryLocked}</p>}
            {blockedReason && <p id={`${uid}-why`} className="muted">{blockedReason}</p>}
            {status === 'DISABLED' ? <p className="muted">{t.tplDisabledNote}</p> : (
              <button type="button" className="btn quiet" onClick={() => setAsking(true)}><Trash2 size={16} aria-hidden />{t.tplDelete}</button>
            )}
          </div>
        )}
        {asking && (
          <div className="tpl-confirm" role="alertdialog" aria-labelledby={`${uid}-dt`} aria-describedby={`${uid}-db`}>
            <h2 id={`${uid}-dt`}>{t.tplDeleteTitle}</h2>
            <p id={`${uid}-db`}>{t.tplDeleteBody}{status === 'APPROVED' && <> {t.tplDeleteApproved}</>}</p>
            <div className="settings-actions">
              <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>{t.tplDeleteGo}</button>
              <button type="button" className="btn" disabled={busy} autoFocus onClick={() => setAsking(false)}>{t.tplCancel}</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
