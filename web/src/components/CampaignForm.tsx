import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CampaignDto, CampaignParam, SegmentCriteria, SegmentDto, SegmentPreviewDto, TemplateDto } from '../../../src/core/api/contract';
import type { WalletDto } from '../data/billing';
import { ApiError } from '../data/api';
import type { CampaignsApi, InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { formatMoney, templateTitle } from '../lib/format';
import { LoadError } from './LoadError';

type Props = {
  t: Strings; lang: Lang; source: InboxSource; api: CampaignsApi; now: () => number; onClose: () => void;
  /** goes to the Templates screen (the empty state points there) */
  onOpenTemplates?: (() => void) | undefined };
type AudienceMode = 'segment' | 'tags' | 'everyone';
type ParamDraft = { kind: 'text' | 'name' | 'link'; value: string };

const HTTPS = /^https:\/\/[^\s/]+\.[^\s]+$/;

/** Placeholders shown in the preview bubble for per-recipient values. */
function previewText(body: string, params: ParamDraft[], lang: Lang): string {
  return body.replace(/\{\{(\d+)\}\}/g, (m, i: string) => {
    const p = params[Number(i) - 1];
    if (!p) return m;
    if (p.kind === 'name') return lang === 'ar' ? 'منى' : 'Mona';
    // LTR isolate: a URL inside Arabic text must not be reordered by the bidi algorithm.
    if (p.kind === 'link') return '\u2066https://…/t/…\u2069';
    return p.value || m;
  });
}

export function CampaignForm({ t, lang, source, api, now, onClose, onOpenTemplates }: Props) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<AudienceMode>('segment');
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [segmentId, setSegmentId] = useState<number | null>(null);
  const [tag, setTag] = useState('');
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [tplKey, setTplKey] = useState('');
  const [params, setParams] = useState<ParamDraft[]>([]);
  const [linkUrl, setLinkUrl] = useState('');
  const [timing, setTiming] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');
  const [preview, setPreview] = useState<SegmentPreviewDto | null | 'loading' | 'error'>(null);
  const [draft, setDraft] = useState<CampaignDto | null>(null);
  const [phase, setPhase] = useState<'edit' | 'creating' | 'sending'>('edit');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.segments().then((s) => { setSegments(s); if (s[0]) setSegmentId(s[0].id); else setMode('tags'); }, () => setMode('tags'));
  }, [api]);
  // Campaigns are marketing: only approved marketing templates (utility messages go out per order, not as broadcasts).
  const loadTemplates = useCallback(() => {
    setTemplatesFailed(false);
    // Paused and pending marketing templates stay in the list, greyed with the reason, so a merchant sees why one cannot be picked instead of it vanishing.
    void source.templates().then((all) => setTemplates(all.filter((x) => x.category === 'MARKETING' && ['APPROVED', 'PAUSED', 'PENDING'].includes(x.status))), () => setTemplatesFailed(true));
  }, [source]);
  useEffect(loadTemplates, [loadTemplates]);

  const criteria: SegmentCriteria | null = useMemo(() => {
    if (mode === 'everyone') return { everyone: true };
    if (mode === 'tags') return tag.trim() ? { tags: { any: [tag.trim()] } } : null;
    return segments.find((s) => s.id === segmentId)?.criteria ?? null;
  }, [mode, tag, segmentId, segments]);

  // Live audience count, debounced; a late answer for an older filter is dropped.
  useEffect(() => {
    if (!criteria) { setPreview(null); return; }
    let stale = false;
    setPreview('loading');
    const id = setTimeout(() => void api.preview(criteria).then((p) => { if (!stale) setPreview(p); }, () => { if (!stale) setPreview('error'); }), 250);
    return () => { stale = true; clearTimeout(id); };
  }, [api, criteria]);

  const usable = templates.filter((x) => x.status === 'APPROVED');
  const template = usable.find((x) => `${x.name}|${x.language}` === tplKey) ?? null;
  const pickTemplate = (key: string) => {
    setTplKey(key);
    const tpl = usable.find((x) => `${x.name}|${x.language}` === key);
    setParams(Array.from({ length: tpl?.paramCount ?? 0 }, () => ({ kind: 'text', value: '' })));
  };
  const setParam = (i: number, p: Partial<ParamDraft>) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const needsLink = params.some((p) => p.kind === 'link');
  const scheduledAt = timing === 'later' && at ? new Date(at).getTime() : undefined;

  const valid = name.trim().length > 0 && criteria !== null && template !== null
    && params.every((p) => p.kind === 'link' || p.value.trim().length > 0)
    && (!needsLink || HTTPS.test(linkUrl.trim()))
    && (timing === 'now' || (scheduledAt !== undefined && Number.isFinite(scheduledAt) && scheduledAt > now()))
    && (dailyLimit === '' || Number(dailyLimit) >= 1);

  const [funding, setFunding] = useState<{ funding: WalletDto['funding'][number]['funding'] }[] | null>(null);
  useEffect(() => {
    void source.wallet?.wallet().then((w) => setFunding(w.funding), () => undefined);
  }, [source]);

  // Any edit after review discards the draft: the estimate no longer matches what would be sent.
  useEffect(() => {
    if (!draft || phase !== 'edit') return;
    const old = draft;
    setDraft(null);
    void api.remove(old.id).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, criteria, tplKey, params, linkUrl, dailyLimit]);

  const explain = (e: unknown, fallback: string) => {
    if (e instanceof ApiError) {
      if (e.code === 'template_not_approved') return t.errTemplate;
      if (e.detail === 'empty_audience') return t.errEmpty;
      if (e.detail === 'invalid_schedule') return t.errSchedule;
      if (e.code === 'forbidden') return t.ownerSends;
    }
    return fallback;
  };

  const review = async () => {
    if (!template || !criteria) return;
    setPhase('creating');
    setError(null);
    const wire: CampaignParam[] = params.map((p) => (p.kind === 'name' ? { kind: 'name', fallback: p.value.trim() } : p.kind === 'link' ? { kind: 'link' } : { kind: 'text', value: p.value.trim() }));
    try {
      const created = await api.create({
        name: name.trim(), template: { name: template.name, language: template.language }, params: wire,
        audience: mode === 'segment' && segmentId !== null ? { segmentId } : { criteria },
        ...(dailyLimit ? { dailySendLimit: Number(dailyLimit) } : {}), ...(needsLink ? { linkUrl: linkUrl.trim() } : {}),
      });
      setDraft(created);
    } catch (e) {
      setError(explain(e, t.createFailed));
    } finally {
      setPhase('edit');
    }
  };

  const send = async () => {
    if (!draft) return;
    setPhase('sending');
    setError(null);
    try {
      await api.send(draft.id, scheduledAt);
      onClose();
    } catch (e) {
      setError(explain(e, t.sendFailedCampaign));
      setPhase('edit');
    }
  };

  const n = (v: number) => num(v, lang);
  const est = draft?.estimate;
  // A zero price is "Meta bills the merchant's card" only when every active number says so; anything unknown stays "not ready".
  const cardBilled = !!funding && funding.length > 0 && funding.every((f) => f.funding === 'merchant_card');

  return (
    <main className="screen" aria-labelledby="new-campaign-title">
      <header className="screen-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t.backToCampaigns}><ArrowRight size={20} aria-hidden className="dir-icon" /></button>
        <h1 id="new-campaign-title">{t.newCampaign}</h1>
      </header>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (draft) void send(); else if (valid) void review(); }}>
        <label className="field">
          <span>{t.campaignName}</span>
          <input dir="auto" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>

        <fieldset className="step">
          <legend>{t.stepAudience}</legend>
          {segments.length > 0 && (
            <label className="radio"><input type="radio" name="aud" checked={mode === 'segment'} onChange={() => setMode('segment')} />{t.audienceSegment}</label>
          )}
          {mode === 'segment' && segments.length > 0 && (
            <select aria-label={t.audienceSegment} value={segmentId ?? ''} onChange={(e) => setSegmentId(Number(e.target.value))}>
              {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <label className="radio"><input type="radio" name="aud" checked={mode === 'tags'} onChange={() => setMode('tags')} />{t.audienceTags}</label>
          {mode === 'tags' && (
            <label className="field inset"><span>{t.tagLabel}</span><input dir="auto" value={tag} maxLength={32} placeholder={t.tagsPlaceholder} onChange={(e) => setTag(e.target.value)} /></label>
          )}
          <label className="radio"><input type="radio" name="aud" checked={mode === 'everyone'} onChange={() => setMode('everyone')} />{t.audienceEveryone}</label>
          <div className="audience-count" aria-live="polite">
            {preview === 'loading' ? <span className="muted">{t.audienceCounting}</span>
              : preview === 'error' ? <span className="error-text">{t.audienceUnknown}</span>
              : preview && (
                <>
                  <b>{t.audienceCount(n(preview.count))}</b>
                  {(preview.excluded.optedOut > 0 || preview.excluded.noConsent > 0) && <span className="muted">{t.excludedLine(n(preview.excluded.optedOut), n(preview.excluded.noConsent))}</span>}
                </>
              )}
          </div>
          <small className="muted">{t.consentRule}</small>
        </fieldset>

        <fieldset className="step">
          <legend>{t.stepMessage}</legend>
          {templatesFailed ? <LoadError t={t} onRetry={loadTemplates} />
            : usable.length === 0 ? (
              <>
                <p className="muted">{t.noTemplates}</p>
                {onOpenTemplates && <button type="button" className="btn" onClick={onOpenTemplates}>{t.tplCampaignGoTemplates}</button>}
              </>
            ) : (
            <label className="field">
              <span>{t.pickApproved}</span>
              <select value={tplKey} onChange={(e) => pickTemplate(e.target.value)}>
                <option value="" disabled>—</option>
                {templates.map((x) => <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`} disabled={x.status !== 'APPROVED'}>{x.status === 'APPROVED' ? templateTitle(t, x) : t.tplUnavailableOption(templateTitle(t, x), t.tplStatuses[x.status] ?? x.status)}</option>)}
              </select>
            </label>
          )}
          {params.map((p, i) => {
            const label = n(i + 1);
            return (
              <div className="param-row" key={i}>
                <label className="field">
                  <span>{t.paramKind(label)}</span>
                  <select value={p.kind} onChange={(e) => setParam(i, { kind: e.target.value as ParamDraft['kind'] })}>
                    <option value="text">{t.paramText}</option>
                    <option value="name">{t.paramName}</option>
                    <option value="link">{t.paramLink}</option>
                  </select>
                </label>
                {p.kind !== 'link' && (
                  <label className="field">
                    <span>{p.kind === 'name' ? t.paramFallback : t.paramValue}</span>
                    <input dir="auto" value={p.value} maxLength={p.kind === 'name' ? 60 : 1000} onChange={(e) => setParam(i, { value: e.target.value })} />
                  </label>
                )}
              </div>
            );
          })}
          {needsLink && (
            <div className="field">
              <label htmlFor="camp-link">{t.linkUrl}</label>
              <input id="camp-link" dir="ltr" type="url" value={linkUrl} placeholder="https://" aria-describedby="camp-link-hint" aria-invalid={linkUrl !== '' && !HTTPS.test(linkUrl.trim())} onChange={(e) => setLinkUrl(e.target.value)} />
              <small id="camp-link-hint" className="muted">{t.linkHint}</small>
            </div>
          )}
          {template && (
            <figure className="tpl-preview">
              <figcaption className="muted small">{t.preview}</figcaption>
              <p dir="auto">{previewText(template.bodyText, params, lang)}</p>
            </figure>
          )}
        </fieldset>

        <fieldset className="step">
          <legend>{t.stepTiming}</legend>
          <label className="radio"><input type="radio" name="when" checked={timing === 'now'} onChange={() => setTiming('now')} />{t.sendNow}</label>
          <label className="radio"><input type="radio" name="when" checked={timing === 'later'} onChange={() => setTiming('later')} />{t.sendLater}</label>
          {timing === 'later' && <label className="field inset"><span>{t.sendAt}</span><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>}
          <div className="field">
            <label htmlFor="camp-limit">{t.dailyLimit}</label>
            <input id="camp-limit" type="number" min={1} inputMode="numeric" value={dailyLimit} aria-describedby="camp-limit-hint" onChange={(e) => setDailyLimit(e.target.value.replace(/\D/g, ''))} />
            <small id="camp-limit-hint" className="muted">{t.dailyLimitHint}</small>
          </div>
        </fieldset>

        {draft && (
          <section className="estimate" aria-labelledby="estimate-title">
            <h2 id="estimate-title">{t.stepReview}</h2>
            <p><b>{est ? t.audienceCount(n(est.audience)) : t.audienceUnknown}</b></p>
            {est && est.perMessageMinor > 0 ? (
              <>
                <p className="estimate-total">{t.costLine(formatMoney(est.totalMinor, 'EGP', lang))}</p>
                <p className="muted">{t.costPer(formatMoney(est.perMessageMinor, 'EGP', lang))} · {t.costNote}</p>
              </>
            ) : <p className="muted">{cardBilled ? t.costCard : t.costPending}</p>}
          </section>
        )}

        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="settings-actions">
          {draft
            ? <button type="submit" className="btn primary" disabled={phase !== 'edit'}>{timing === 'later' ? t.confirmSchedule : t.confirmSend}</button>
            : <button type="submit" className="btn primary" disabled={!valid || phase !== 'edit'}>{t.reviewCta}</button>}
          {phase === 'creating' && <span className="muted" role="status">{t.creating}</span>}
        </div>
      </form>
    </main>
  );
}
