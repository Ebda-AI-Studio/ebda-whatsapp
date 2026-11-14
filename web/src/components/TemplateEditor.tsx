import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useReducer, useRef, useState } from 'react';
import type { TemplateDto } from '../../../src/core/api/contract';
import { META_LIMITS, checkTemplate, type ExistingTemplate, type RuleField, type RuleIssue } from '../../../src/core/meta/template-rules';
import { ruleMessage } from '../../../src/core/meta/template-rule-copy';
import { fromStoredComponents, type DraftButton, type TemplateDraft } from '../../../src/core/template-draft';
import { ApiError } from '../data/api';
import type { TemplatesApi } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { dateTime } from './CampaignsScreen';
import { TemplateBubble } from './TemplateBubble';

type Props = {
  t: Strings; lang: Lang; api: TemplatesApi; mode: 'create' | 'edit'; template?: TemplateDto;
  /** the merchant's other templates, so a duplicate body is caught before Meta rejects it */
  existing: TemplateDto[]; onSaved: () => void; onClose: () => void;
};

const VAR = /\{\{\s*(\d+)\s*\}\}/g;
const varCount = (text: string) => [...text.matchAll(VAR)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
const fit = (xs: string[], n: number) => Array.from({ length: n }, (_, i) => xs[i] ?? '');

/** snake_case ASCII from what the merchant typed, plus a short suffix so two templates never collide. Arabic titles (no ASCII) become `template_xxxx`. */
export function deriveName(label: string, suffix: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return `${slug || 'template'}_${suffix}`;
}

export type EditorState = { draft: TemplateDraft; suffix: string; nameEdited: boolean };
export type EditorAction =
  | { type: 'kind'; category: TemplateDraft['category'] }
  | { type: 'language'; language: string }
  | { type: 'label'; label: string }
  | { type: 'name'; name: string }
  | { type: 'body'; text: string }
  | { type: 'example'; index: number; value: string }
  | { type: 'header'; text: string | null }
  | { type: 'headerExample'; value: string }
  | { type: 'footer'; text: string | null }
  | { type: 'addButton'; button: DraftButton }
  | { type: 'button'; index: number; patch: Partial<DraftButton> }
  | { type: 'removeButton'; index: number }
  | { type: 'auth'; patch: Partial<NonNullable<TemplateDraft['auth']>> };

export const newDraft = (suffix: string): TemplateDraft => ({
  name: deriveName('', suffix), label: '', language: 'ar', category: 'UTILITY', header: null, body: { text: '', examples: [] }, footer: null, buttons: [],
});

/** The one place the draft changes. Quick replies always sit before the other buttons, so Meta's "two contiguous groups" rule can never be broken from the screen. */
export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  const d = s.draft;
  const put = (draft: TemplateDraft): EditorState => ({ ...s, draft });
  switch (a.type) {
    case 'kind': return put({ ...d, category: a.category, ...(a.category === 'AUTHENTICATION' ? { auth: d.auth ?? { expiryMinutes: 10, securityRecommendation: true }, header: null, footer: null, buttons: [], body: { text: '', examples: [] } } : {}) });
    case 'language': return put({ ...d, language: a.language });
    case 'label': return { ...s, draft: { ...d, label: a.label, ...(s.nameEdited ? {} : { name: deriveName(a.label, s.suffix) }) } };
    case 'name': return { ...s, nameEdited: true, draft: { ...d, name: a.name } };
    case 'body': return put({ ...d, body: { text: a.text, examples: fit(d.body.examples, varCount(a.text)) } });
    case 'example': return put({ ...d, body: { ...d.body, examples: d.body.examples.map((x, i) => (i === a.index ? a.value : x)) } });
    case 'header': return put({ ...d, header: a.text === null ? null : { text: a.text, ...(d.header?.example !== undefined && varCount(a.text) > 0 ? { example: d.header.example } : {}) } });
    case 'headerExample': return put({ ...d, header: d.header ? { ...d.header, example: a.value } : d.header });
    case 'footer': return put({ ...d, footer: a.text });
    case 'addButton': {
      const qrs = d.buttons.filter((b) => b.type === 'QUICK_REPLY');
      const rest = d.buttons.filter((b) => b.type !== 'QUICK_REPLY');
      return put({ ...d, buttons: a.button.type === 'QUICK_REPLY' ? [...qrs, a.button, ...rest] : [...qrs, ...rest, a.button] });
    }
    case 'button': return put({ ...d, buttons: d.buttons.map((b, i) => (i === a.index ? ({ ...b, ...a.patch } as DraftButton) : b)) });
    case 'removeButton': return put({ ...d, buttons: d.buttons.filter((_, i) => i !== a.index) });
    case 'auth': return put({ ...d, auth: { expiryMinutes: d.auth?.expiryMinutes ?? null, securityRecommendation: d.auth?.securityRecommendation ?? false, ...a.patch } });
  }
}

const toExisting = (xs: TemplateDto[]): ExistingTemplate[] => xs.map((x) => ({
  name: x.name, language: x.language, bodyText: x.bodyText,
  footer: (x.components?.find((c) => String(c.type).toUpperCase() === 'FOOTER')?.text as string | undefined) ?? null,
}));

export function TemplateEditor({ t, lang, api, mode, template, existing, onSaved, onClose }: Props) {
  const init = useMemo<EditorState>(() => {
    const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => (b % 36).toString(36)).join('');
    if (template) return { draft: fromStoredComponents(template.components as never, { name: template.name, language: template.language, category: template.category, label: template.label ?? null }), suffix, nameEdited: true };
    return { draft: newDraft(suffix), suffix, nameEdited: false };
  }, [template]);
  const [state, dispatch] = useReducer(editorReducer, init);
  const d = state.draft;
  const [phase, setPhase] = useState<'edit' | 'checking' | 'confirm' | 'sending' | 'sent'>('edit');
  const [hash, setHash] = useState<string | null>(null);
  const [acked, setAcked] = useState(false);
  const [serverIssues, setServerIssues] = useState<RuleIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recat, setRecat] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const uid = useId();
  const auth = d.category === 'AUTHENTICATION';
  const lockedCategory = mode === 'edit' && template?.status === 'APPROVED';

  // Instant feedback from the same rules the server enforces; the server `check` stays the gate.
  const others = useMemo(() => toExisting(existing), [existing]);
  const issues = useMemo(() => {
    const local = checkTemplate(d, others);
    const seen = new Set(local.map((i) => `${i.code}:${i.field}:${JSON.stringify(i.params ?? {})}`));
    return [...local, ...serverIssues.filter((i) => !seen.has(`${i.code}:${i.field}:${JSON.stringify(i.params ?? {})}`))];
  }, [d, others, serverIssues]);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const at = (...fields: RuleField[]) => issues.filter((i) => fields.includes(i.field));
  const nameOk = d.label.trim().length > 0;
  const canSubmit = nameOk && errors.length === 0 && (warnings.length === 0 || acked) && phase === 'edit';

  const Issues = ({ fields }: { fields: RuleField[] }) => (
    <div aria-live="polite">
      {at(...fields).map((i, k) => <p key={`${i.code}${k}`} className={i.severity === 'error' ? 'error-text field-issue' : 'field-issue field-warn'} data-severity={i.severity}>{ruleMessage(i, lang)}</p>)}
    </div>
  );

  const addVariable = () => {
    const ta = bodyRef.current;
    const text = d.body.text;
    const pos = ta?.selectionStart ?? text.length;
    const n = varCount(text) + 1;
    dispatch({ type: 'body', text: `${text.slice(0, pos)}{{${n}}}${text.slice(pos)}` });
  };

  const explain = (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.detail === 'exists') return t.tplErrExists;
      if (e.detail === 'payload_changed') return t.tplErrChanged;
      if (e.detail === 'edit_limit') return t.tplErrEditLimit(e.extra?.retryAt ? dateTime(e.extra.retryAt, lang) : '…');
      if (e.detail === 'not_editable') return t.tplErrNotEditable;
      if (e.detail === 'token_unavailable') return t.tplErrToken;
      if (e.status === 503) return t.tplErrUnavailable;
      if (e.status === 400 && e.detail && e.detail !== 'invalid_template') return t.tplErrMeta(e.detail);
    }
    return t.tplErrGeneric;
  };

  const review = async () => {
    setError(null);
    setPhase('checking');
    try {
      const r = await api.check(d);
      setServerIssues(r.issues);
      if (r.issues.some((i) => i.severity === 'error')) { setPhase('edit'); return; }
      setHash(r.payloadHash);
      setPhase('confirm');
    } catch (e) {
      setError(explain(e));
      setPhase('edit');
    }
  };

  const send = async () => {
    setPhase('sending');
    setError(null);
    try {
      if (mode === 'edit' && template) await api.edit(template.name, template.language, d, hash ?? undefined);
      else setRecat((await api.create(d, hash ?? undefined)).categoryChanged);
      setPhase('sent');
    } catch (e) {
      if (e instanceof ApiError && e.detail === 'invalid_template' && e.extra?.issues) setServerIssues(e.extra.issues);
      setError(explain(e));
      setPhase(e instanceof ApiError && e.detail === 'exists' ? 'edit' : 'edit');
    }
  };

  const titleId = `${uid}-title`;
  const heading = mode === 'edit' ? t.tplEditorEditTitle : t.tplEditorNewTitle;
  const head = (
    <header className="screen-head">
      <button type="button" className="btn ghost" onClick={onClose}><ArrowRight size={18} aria-hidden />{t.tplBack}</button>
      <h1 id={titleId}>{heading}</h1>
    </header>
  );

  if (phase === 'sent') {
    return (
      <main className="screen" aria-labelledby={titleId}>
        {head}
        <div className="settings">
          <p className="tpl-sent" role="status">{t.tplSent}</p>
          {recat && <p className="tpl-recat" role="status">{t.tplRecat}</p>}
          <TemplateBubble draft={d} empty={t.tplPreviewEmpty} />
          <button type="button" className="btn primary" autoFocus onClick={onSaved}>{t.tplDone}</button>
        </div>
      </main>
    );
  }

  if (phase === 'confirm' || phase === 'sending') {
    return (
      <main className="screen" aria-labelledby={titleId}>
        {head}
        <div className="settings">
          <section className="tpl-confirm" role="group" aria-labelledby={`${uid}-ct`}>
            <h2 id={`${uid}-ct`}>{t.tplConfirmTitle}</h2>
            <TemplateBubble draft={d} empty={t.tplPreviewEmpty} />
            <p>{t.tplConfirmBody}</p>
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="settings-actions">
              <button type="button" className="btn primary" disabled={phase === 'sending'} onClick={() => void send()}>{phase === 'sending' ? t.tplSending : t.tplConfirmGo}</button>
              <button type="button" className="btn" disabled={phase === 'sending'} onClick={() => setPhase('edit')}>{t.tplConfirmBack}</button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const nVars = varCount(d.body.text);
  const urlCount = d.buttons.filter((b) => b.type === 'URL').length;
  const phoneCount = d.buttons.filter((b) => b.type === 'PHONE_NUMBER').length;
  const copyCount = d.buttons.filter((b) => b.type === 'COPY_CODE').length;
  const qrCount = d.buttons.filter((b) => b.type === 'QUICK_REPLY').length;
  const full = d.buttons.length >= META_LIMITS.BUTTONS_MAX;

  return (
    <main className="screen" aria-labelledby={titleId}>
      {head}
      <form className="settings tpl-editor" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void review(); }}>
        <fieldset className="field" disabled={lockedCategory}>
          <legend>{t.tplKindLabel}</legend>
          <div className="tpl-kinds">
            {(['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const).map((k) => (
              <label key={k} className="tpl-kind" data-selected={d.category === k}>
                <input type="radio" name={`${uid}-kind`} checked={d.category === k} onChange={() => dispatch({ type: 'kind', category: k })} />
                <b>{t.tplKinds[k]!.title}</b><span className="muted">{t.tplKinds[k]!.hint}</span>
              </label>
            ))}
          </div>
          {lockedCategory && <p className="muted">{t.tplCategoryLocked}</p>}
          <Issues fields={['category']} />
        </fieldset>

        <label className="field"><span>{t.tplLangLabel}</span>
          <select value={d.language} disabled={mode === 'edit'} onChange={(e) => dispatch({ type: 'language', language: e.target.value })}>
            {!['ar', 'en'].includes(d.language) && <option value={d.language}>{d.language}</option>}
            <option value="ar">{t.tplLangs.ar}</option><option value="en">{t.tplLangs.en}</option>
          </select></label>

        <div className="field">
          <label htmlFor={`${uid}-title-in`}>{t.tplTitleLabel}</label>
          <input id={`${uid}-title-in`} value={d.label} maxLength={80} onChange={(e) => dispatch({ type: 'label', label: e.target.value })} aria-describedby={`${uid}-th`} />
          <span id={`${uid}-th`} className="muted small">{t.tplTitleHelp}</span>
        </div>

        {auth ? (
          <>
            <p className="muted">{t.tplAuthNote}</p>
            <label className="field"><span>{t.tplAuthExpiry}</span>
              <input type="number" inputMode="numeric" min={META_LIMITS.AUTH_EXPIRY_MIN} max={META_LIMITS.AUTH_EXPIRY_MAX} value={d.auth?.expiryMinutes ?? ''} onChange={(e) => dispatch({ type: 'auth', patch: { expiryMinutes: e.target.value === '' ? null : Number(e.target.value) } })} /></label>
            <label className="check"><input type="checkbox" checked={d.auth?.securityRecommendation ?? false} onChange={(e) => dispatch({ type: 'auth', patch: { securityRecommendation: e.target.checked } })} />{t.tplAuthSecurity}</label>
            <Issues fields={['body']} />
          </>
        ) : (
          <>
            <label className="field"><span>{t.tplHeaderLabel}</span>
              <input value={d.header?.text ?? ''} onChange={(e) => dispatch({ type: 'header', text: e.target.value === '' ? null : e.target.value })} /></label>
            {d.header && varCount(d.header.text) === 1 && (
              <label className="field"><span>{t.tplHeaderExample}</span><input value={d.header.example ?? ''} onChange={(e) => dispatch({ type: 'headerExample', value: e.target.value })} /></label>
            )}
            <Issues fields={['header']} />

            <div className="field">
              <label htmlFor={`${uid}-body`}>{t.tplBodyLabel}</label>
              <textarea id={`${uid}-body`} ref={bodyRef} rows={5} value={d.body.text} aria-describedby={`${uid}-bc`} onChange={(e) => dispatch({ type: 'body', text: e.target.value })} />
              <div className="tpl-body-tools">
                <button type="button" className="btn ghost" onClick={addVariable}><Plus size={16} aria-hidden />{t.tplAddVar}</button>
                <span id={`${uid}-bc`} className="muted small">{t.tplCounter(num([...d.body.text].length, lang), num(META_LIMITS.BODY_MAX, lang))}</span>
              </div>
              <p className="muted small">{t.tplVarHelp}</p>
              <Issues fields={['body']} />
            </div>
            {Array.from({ length: nVars }, (_, i) => (
              <label key={i} className="field"><span>{t.tplVarExample(i + 1)}</span>
                <input value={d.body.examples[i] ?? ''} onChange={(e) => dispatch({ type: 'example', index: i, value: e.target.value })} /></label>
            ))}
            <Issues fields={['examples']} />

            <label className="field"><span>{t.tplFooterLabel}</span>
              <input value={d.footer ?? ''} onChange={(e) => dispatch({ type: 'footer', text: e.target.value === '' ? null : e.target.value })} /></label>
            <Issues fields={['footer']} />

            <fieldset className="field tpl-buttons">
              <legend>{t.tplButtonsLabel}</legend>
              {d.buttons.map((b, i) => (
                <div key={i} className="tpl-button-row" role="group" aria-label={t.tplButtonN(i + 1)}>
                  {b.type !== 'COPY_CODE' && <label className="field"><span>{t.tplBtnText}</span><input value={b.text} onChange={(e) => dispatch({ type: 'button', index: i, patch: { text: e.target.value } })} /></label>}
                  {b.type === 'URL' && (<>
                    <label className="field"><span>{t.tplBtnUrl}</span><input dir="ltr" value={b.url} onChange={(e) => dispatch({ type: 'button', index: i, patch: { url: e.target.value } })} /></label>
                    {/\{\{/.test(b.url) && <label className="field"><span>{t.tplBtnUrlExample}</span><input dir="ltr" value={b.example ?? ''} onChange={(e) => dispatch({ type: 'button', index: i, patch: { example: e.target.value } })} /></label>}
                  </>)}
                  {b.type === 'PHONE_NUMBER' && <label className="field"><span>{t.tplBtnPhone}</span><input dir="ltr" value={b.phone} onChange={(e) => dispatch({ type: 'button', index: i, patch: { phone: e.target.value } })} /></label>}
                  {b.type === 'COPY_CODE' && <label className="field"><span>{t.tplBtnCopyExample}</span><input dir="ltr" value={b.example} onChange={(e) => dispatch({ type: 'button', index: i, patch: { example: e.target.value } })} /></label>}
                  <button type="button" className="btn quiet" onClick={() => dispatch({ type: 'removeButton', index: i })}><Trash2 size={16} aria-hidden />{t.tplRemoveButton}</button>
                </div>
              ))}
              <div className="tpl-add-buttons">
                <button type="button" className="btn ghost" disabled={full || qrCount >= META_LIMITS.QR_MAX} onClick={() => dispatch({ type: 'addButton', button: { type: 'QUICK_REPLY', text: '' } })}>{t.tplAddQr}</button>
                <button type="button" className="btn ghost" disabled={full || urlCount >= META_LIMITS.URL_MAX} onClick={() => dispatch({ type: 'addButton', button: { type: 'URL', text: '', url: 'https://' } })}>{t.tplAddUrl}</button>
                <button type="button" className="btn ghost" disabled={full || phoneCount >= META_LIMITS.PHONE_MAX} onClick={() => dispatch({ type: 'addButton', button: { type: 'PHONE_NUMBER', text: '', phone: '' } })}>{t.tplAddPhone}</button>
                <button type="button" className="btn ghost" disabled={full || copyCount >= 1} onClick={() => dispatch({ type: 'addButton', button: { type: 'COPY_CODE', example: '' } })}>{t.tplAddCopy}</button>
              </div>
              <Issues fields={['buttons']} />
            </fieldset>
          </>
        )}

        {mode === 'create' && (
          <details className="tpl-advanced">
            <summary>{t.tplAdvanced}</summary>
            <div className="field">
              <label htmlFor={`${uid}-name-in`}>{t.tplNameField}</label>
              <input id={`${uid}-name-in`} dir="ltr" value={d.name} onChange={(e) => dispatch({ type: 'name', name: e.target.value })} aria-describedby={`${uid}-nh`} />
              <span id={`${uid}-nh`} className="muted small">{t.tplNameHelp}</span>
            </div>
            <Issues fields={['name']} />
          </details>
        )}
        {mode === 'create' && at('name').length > 0 && <Issues fields={['name']} />}

        <section aria-labelledby={`${uid}-pv`}>
          <h2 id={`${uid}-pv`} className="tpl-h2">{t.tplPreview}</h2>
          <TemplateBubble draft={d} empty={t.tplPreviewEmpty} />
        </section>

        {warnings.length > 0 && errors.length === 0 && (
          <label className="check tpl-ack"><input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />{t.tplWarnAck}</label>
        )}
        {errors.length > 0 && <p className="muted" role="status">{t.tplIssuesBlock}</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="settings-actions">
          <button type="submit" className="btn primary" disabled={!canSubmit}>{phase === 'checking' ? t.tplChecking : t.tplSubmit}</button>
          <button type="button" className="btn" onClick={onClose}>{t.tplCancel}</button>
        </div>
      </form>
    </main>
  );
}
