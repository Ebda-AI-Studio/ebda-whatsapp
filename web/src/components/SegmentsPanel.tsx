import { useCallback, useEffect, useState } from 'react';
import type { SegmentCriteria, SegmentDto } from '../../../src/core/api/contract';
import { ApiError } from '../data/api';
import type { SegmentsApi } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { LoadError } from './LoadError';

const DAY = 86_400_000;
type Form = { name: string; any: string; all: string; ordered: 'any' | 'yes' | 'no'; days: string; everyone: boolean };
const BLANK: Form = { name: '', any: '', all: '', ordered: 'any', days: '', everyone: false };

const splitTags = (v: string) => [...new Set(v.split(/[,،]/).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 10);

/** Form -> the criteria the server validates. `kept` carries the filters the form has no field for (a date bound a segment already had) so an edit never drops them. */
function toCriteria(f: Form, kept: SegmentCriteria, now: number, initialDays: string): SegmentCriteria {
  const c: SegmentCriteria = {};
  if (f.everyone) return { everyone: true };
  const any = splitTags(f.any);
  const all = splitTags(f.all);
  if (any.length || all.length) c.tags = { ...(any.length ? { any } : {}), ...(all.length ? { all } : {}) };
  if (f.ordered !== 'any') c.hasOrdered = f.ordered === 'yes';
  const d = Number(f.days);
  if (f.days.trim() !== '' && Number.isFinite(d) && d > 0) c.lastInboundAfter = f.days === initialDays && kept.lastInboundAfter !== undefined ? kept.lastInboundAfter : now - Math.round(d) * DAY;
  if (kept.lastInboundBefore !== undefined) c.lastInboundBefore = kept.lastInboundBefore;
  return c;
}
const isEmpty = (c: SegmentCriteria) => !(c.tags?.any?.length || c.tags?.all?.length || c.hasOrdered !== undefined || c.lastInboundAfter !== undefined || c.lastInboundBefore !== undefined || c.everyone);

function toForm(s: SegmentDto, now: number): Form {
  const k = s.criteria;
  return {
    name: s.name, any: (k.tags?.any ?? []).join(', '), all: (k.tags?.all ?? []).join(', '),
    ordered: k.hasOrdered === undefined ? 'any' : k.hasOrdered ? 'yes' : 'no',
    days: k.lastInboundAfter !== undefined ? String(Math.max(1, Math.round((now - k.lastInboundAfter) / DAY))) : '', everyone: k.everyone === true,
  };
}

/** Saved segments (A30): create, edit, delete. Owner only (the server answers 403 to staff). Delete asks for the segment's name first. */
export function SegmentsPanel({ t, lang, api, now, reloadKey = 0, onLoadFailed }: { t: Strings; lang: Lang; api: SegmentsApi; now: () => number; reloadKey?: number; onLoadFailed?: (failed: boolean) => void }) {
  const [items, setItems] = useState<SegmentDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<SegmentDto | null>(null);
  const [form, setForm] = useState<Form>(BLANK);
  const [initialDays, setInitialDays] = useState('');
  const [deleting, setDeleting] = useState<SegmentDto | null>(null);
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'alert' | 'preview'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { setLoadFailed(false); onLoadFailed?.(false); void api.list().then(setItems, () => { setLoadFailed(true); onLoadFailed?.(true); }); }, [api, onLoadFailed]);
  useEffect(load, [load, reloadKey]);

  const criteria = toCriteria(form, editing?.criteria ?? {}, now(), initialDays);
  const valid = form.name.trim() !== '' && !isEmpty(criteria);
  const reset = () => { setEditing(null); setForm(BLANK); setInitialDays(''); };
  const run = async (fn: () => Promise<void>, failText: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ kind: 'alert', text: e instanceof ApiError && e.status === 409 ? t.sgNameTaken : failText }); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    if (editing) { const u = await api.update(editing.id, { name: form.name.trim(), criteria }); setItems((l) => (l ?? []).map((x) => (x.id === u.id ? u : x))); }
    else { const c = await api.create(form.name.trim(), criteria); setItems((l) => [...(l ?? []), c]); }
    reset(); setMsg({ kind: 'ok', text: t.sgSaved });
  }, t.sgNameTaken);
  const preview = () => run(async () => {
    const p = await api.preview(criteria);
    setMsg({ kind: 'preview', text: t.sgPreviewResult(num(p.count, lang), num(p.excluded.optedOut, lang), num(p.excluded.noConsent, lang)) });
  }, t.itFailed);
  const remove = (s: SegmentDto) => run(async () => {
    await api.remove(s.id);
    setItems((l) => (l ?? []).filter((x) => x.id !== s.id)); setDeleting(null); setTyped(''); if (editing?.id === s.id) reset();
    setMsg({ kind: 'ok', text: t.sgDeleted });
  }, t.itFailed);

  return (
    <section className="import-panel segments-panel" aria-labelledby="sg-title">
      <h2 id="sg-title">{t.sgTitle}</h2>
      <p className="muted small">{t.sgHint}</p>
      {loadFailed && !onLoadFailed && <LoadError t={t} onRetry={load} />}
      {items && items.length === 0 && <p className="muted small">{t.sgEmpty}</p>}
      {items && items.length > 0 && (
        <ul className="segment-list">
          {items.map((s) => (
            <li key={s.id}>
              <bdi dir="auto"><b>{s.name}</b></bdi>
              <span className="order-actions">
                <button type="button" className="btn" onClick={() => { setEditing(s); const f = toForm(s, now()); setForm(f); setInitialDays(f.days); setDeleting(null); setMsg(null); }}>{t.sgEdit}</button>
                <button type="button" className="btn danger" onClick={() => { setDeleting(s); setTyped(''); setMsg(null); }}>{t.sgDelete}</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <div className="confirm-box">
          <p className="muted small">{t.sgDeleteWarn(deleting.name)}</p>
          <label className="field"><span>{t.sgDeleteConfirm}</span><input dir="auto" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          <div className="order-actions">
            <button type="button" className="btn danger" disabled={busy || typed.trim() !== deleting.name} onClick={() => void remove(deleting)}>{t.sgDeleteGo}</button>
            <button type="button" className="btn" onClick={() => { setDeleting(null); setTyped(''); }}>{t.sgCancel}</button>
          </div>
        </div>
      )}
      <h3 className="pane-sub">{editing ? t.sgEdit : t.sgNew}</h3>
      <label className="field"><span>{t.sgName}</span><input dir="auto" maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <div><button type="button" className="chip" aria-pressed={form.everyone} onClick={() => setForm({ ...form, everyone: !form.everyone })}>{t.sgEveryone}</button></div>
      {!form.everyone && (
        <>
          <label className="field"><span>{t.sgTagsAny}</span><input dir="auto" value={form.any} onChange={(e) => setForm({ ...form, any: e.target.value })} /></label>
          <label className="field"><span>{t.sgTagsAll}</span><input dir="auto" value={form.all} onChange={(e) => setForm({ ...form, all: e.target.value })} /></label>
          <label className="field"><span>{t.sgOrdered}</span>
            <select value={form.ordered} onChange={(e) => setForm({ ...form, ordered: e.target.value as Form['ordered'] })}>
              <option value="any">{t.sgOrderedAny}</option><option value="yes">{t.sgOrderedYes}</option><option value="no">{t.sgOrderedNo}</option>
            </select>
          </label>
          <label className="field"><span>{t.sgActiveDays}</span><input dir="ltr" inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></label>
        </>
      )}
      {form.name.trim() !== '' && isEmpty(criteria) && <small className="muted">{t.sgNeedFilter}</small>}
      <div className="settings-actions">
        <button type="button" className="btn primary" disabled={busy || !valid || loadFailed} onClick={() => void save()}>{editing ? t.sgSave : t.sgCreate}</button>
        <button type="button" className="btn" disabled={busy || isEmpty(criteria) || loadFailed} onClick={() => void preview()}>{t.sgPreview}</button>
        {editing && <button type="button" className="btn" onClick={reset}>{t.sgCancel}</button>}
      </div>
      {msg && <p role={msg.kind === 'alert' ? 'alert' : 'status'} className={msg.kind === 'alert' ? 'error-text' : 'wallet-ok'}>{msg.text}</p>}
    </section>
  );
}
