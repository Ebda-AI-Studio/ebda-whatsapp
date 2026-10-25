import { Bot } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BRAND } from '@brand';
import type { BotSettingsDto, CatalogStatusDto } from '../../../src/core/api/contract';
import { hoursSchema, locationSchema, MENU_ANSWER_MAX, MENU_MAX_ITEMS, MENU_TITLE_MAX, menuSchema, HOURS_AWAY_MAX } from '../../../src/core/store-link/bot-settings';
import type { InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { LoadError } from './LoadError';

type Menu = BotSettingsDto['menu'];
type Hours = BotSettingsDto['hours'];
type Range = Hours['week'][0][number];
type LocDraft = { name: string; address: string; latitude: string; longitude: string };
type Draft = { menu: Menu; hours: Hours; location: LocDraft };

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const len = (s: string) => Array.from(s).length;
const toLocDraft = (l: BotSettingsDto['location']): LocDraft => (l ? { name: l.name, address: l.address, latitude: String(l.latitude), longitude: String(l.longitude) } : { name: '', address: '', latitude: '', longitude: '' });
const locEmpty = (l: LocDraft) => !l.name && !l.address && !l.latitude && !l.longitude;
/** Null = cleared; undefined = half-filled or out of range (not savable). */
function toLocation(l: LocDraft): BotSettingsDto['location'] | undefined {
  if (locEmpty(l)) return null;
  const parsed = locationSchema.safeParse({ name: l.name.trim(), address: l.address.trim(), latitude: l.latitude.trim() === '' ? undefined : Number(l.latitude), longitude: l.longitude.trim() === '' ? undefined : Number(l.longitude) });
  return parsed.success ? parsed.data : undefined;
}

/** The WhatsApp catalog: create one when there is none, else show its id and the last sync. Separate from the settings form (its own action, not part of Save). */
function CatalogSection({ t, lang, source, readOnly }: { t: Strings; lang: Lang; source: InboxSource; readOnly: boolean }) {
  const api = source.catalog!;
  const [cat, setCat] = useState<CatalogStatusDto | undefined | 'error'>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const load = useCallback(() => { setCat(undefined); void api.status().then(setCat, () => setCat('error')); }, [api]);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { catalogId } = await api.provision();
      setCat({ catalogId, lastSyncAt: null });
      setCreated(true);
    } catch (e) {
      const detail = (e as { detail?: string }).detail;
      if (detail === 'catalog_already_set') load();
      else setError(detail === 'missing_permission' ? t.catErrPermission : detail === 'no_business' || detail === 'business_mismatch' ? t.catErrReconnect : detail === 'meta_error' ? t.catErrMeta : t.catErrGeneric);
    } finally {
      setBusy(false);
    }
  };

  const when = (ms: number) => new Date(ms).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' });
  return (
    <section className="settings" aria-labelledby="bot-catalog-title">
      <h2 id="bot-catalog-title">{t.catTitle}</h2>
      {cat === undefined && <p className="muted">…</p>}
      {cat === 'error' && <LoadError t={t} onRetry={load} />}
      {cat && cat !== 'error' && (cat.catalogId
        ? (
          <>
            <p dir="auto">{t.catId(cat.catalogId)}</p>
            <p className="muted">{cat.lastSyncAt ? t.catLastSync(when(cat.lastSyncAt)) : t.catNoSync}</p>
          </>
        )
        : (
          <>
            <p className="muted">{t.catNone}</p>
            {readOnly
              ? <p className="notice" role="note">{t.catOwnerOnly}</p>
              : <div className="settings-actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void create()}>{t.catCreate}</button></div>}
          </>
        ))}
      {busy && <p role="status" className="muted">{t.catCreating}</p>}
      {created && !busy && <p role="status" className="muted">{t.catCreated}</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
    </section>
  );
}

export function BotScreen({ t, lang, source }: { t: Strings; lang: Lang; source: InboxSource }) {
  // undefined = loading, 'error' = the load failed.
  const [draft, setDraft] = useState<Draft | undefined | 'error'>(undefined);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const readOnly = source.role === 'staff';

  const load = useCallback(() => {
    setDraft(undefined);
    void source.botSettings!().then((s) => setDraft({ menu: s.menu, hours: s.hours, location: toLocDraft(s.location) }), () => setDraft('error'));
  }, [source]);
  useEffect(load, [load]);

  if (draft === undefined) return <main className="screen"><div className="placeholder">…</div></main>;
  if (draft === 'error') return <main className="screen"><div className="placeholder"><LoadError t={t} onRetry={load} /></div></main>;

  const change = (next: Draft) => { setDraft(next); setStatus('idle'); };
  const { menu, hours } = draft;
  const location = toLocation(draft.location);
  const valid = menuSchema.safeParse(menu).success && hoursSchema.safeParse(hours).success && location !== undefined;
  const setMenu = (m: Menu) => change({ ...draft, menu: m });
  const setHours = (h: Hours) => change({ ...draft, hours: h });
  const setItem = (i: number, patch: (it: Menu['items'][number]) => Menu['items'][number]) => setMenu({ ...menu, items: menu.items.map((it, k) => (k === i ? patch(it) : it)) });
  const move = (i: number, by: -1 | 1) => {
    const items = [...menu.items];
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j]!, items[i]!];
    setMenu({ ...menu, items });
  };
  const addItem = () => {
    let n = menu.items.length + 1;
    while (menu.items.some((it) => it.id === `q${n}`)) n++;
    setMenu({ ...menu, items: [...menu.items, { id: `q${n}`, title: { ar: '', en: '' }, answer: { ar: '', en: '' } }] });
  };
  const setRanges = (d: (typeof DAYS)[number], ranges: Range[]) => setHours({ ...hours, week: { ...hours.week, [d]: ranges } });
  const setLoc = (patch: Partial<LocDraft>) => change({ ...draft, location: { ...draft.location, ...patch } });

  const save = async () => {
    if (!valid || location === undefined) return;
    setStatus('saving');
    try {
      const next = await source.saveBotSettings!({ menu, hours, location });
      setDraft({ menu: next.menu, hours: next.hours, location: toLocDraft(next.location) });
      setStatus('saved');
    } catch {
      setStatus('failed');
    }
  };

  const counter = (value: string, max: number) => {
    const n = len(value);
    return <small className={n > max ? 'error-text' : 'muted'}>{t.botCount(num(n, lang), num(max, lang))}</small>;
  };
  const textField = (id: string, label: string, value: string, max: number, onChange: (v: string) => void, area = false) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {area
        ? <textarea id={id} dir="auto" rows={3} value={value} disabled={readOnly} aria-invalid={len(value) > max || value.trim() === ''} onChange={(e) => onChange(e.target.value)} />
        : <input id={id} dir="auto" value={value} disabled={readOnly} aria-invalid={len(value) > max || value.trim() === ''} onChange={(e) => onChange(e.target.value)} />}
      {counter(value, max)}
    </div>
  );
  const lat = Number(draft.location.latitude);
  const lng = Number(draft.location.longitude);
  const mapUrl = location ? `https://maps.google.com/?q=${lat},${lng}` : null;
  const guide = BRAND.helpUrl ? BRAND.helpUrl(lang, 'service-menu-hours-and-location') : null;

  return (
    <main className="screen" aria-labelledby="bot-title">
      <header className="screen-head">
        <Bot size={20} aria-hidden style={{ color: 'var(--gold-ink)' }} />
        <h1 id="bot-title">{t.botTitle}</h1>
        {guide && <a className="muted" href={guide} target="_blank" rel="noopener">{t.botGuide}</a>}
      </header>
      {source.catalog && <CatalogSection t={t} lang={lang} source={source} readOnly={readOnly} />}
      <form className="settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className="muted">{t.botIntro}</p>
        {readOnly && <p className="notice" role="note">{t.botReadOnly}</p>}

        <fieldset className="field" disabled={readOnly}>
          <legend>{t.botMenuTitle}</legend>
          <div className="setting-row">
            <span id="bot-menu-label">{t.botMenuEnable}</span>
            <button type="button" role="switch" aria-checked={menu.enabled} aria-labelledby="bot-menu-label" className="switch" onClick={() => setMenu({ ...menu, enabled: !menu.enabled })}><span /></button>
          </div>
          <small className="muted">{t.botMenuHint}</small>
          {menu.items.length === 0 && <p className="muted">{t.botMenuEmpty}</p>}
          {menu.items.map((it, i) => (
            <fieldset key={it.id} className="step">
              <legend>{t.botItem(num(i + 1, lang))}</legend>
              {textField(`bot-t-ar-${it.id}`, t.botTitleAr, it.title.ar, MENU_TITLE_MAX, (v) => setItem(i, (x) => ({ ...x, title: { ...x.title, ar: v } })))}
              {textField(`bot-t-en-${it.id}`, t.botTitleEn, it.title.en, MENU_TITLE_MAX, (v) => setItem(i, (x) => ({ ...x, title: { ...x.title, en: v } })))}
              {textField(`bot-a-ar-${it.id}`, t.botAnswerAr, it.answer.ar, MENU_ANSWER_MAX, (v) => setItem(i, (x) => ({ ...x, answer: { ...x.answer, ar: v } })), true)}
              {textField(`bot-a-en-${it.id}`, t.botAnswerEn, it.answer.en, MENU_ANSWER_MAX, (v) => setItem(i, (x) => ({ ...x, answer: { ...x.answer, en: v } })), true)}
              <div className="settings-actions">
                <button type="button" className="btn ghost" disabled={i === 0} aria-label={`${t.botUp}: ${t.botItem(num(i + 1, lang))}`} onClick={() => move(i, -1)}>{t.botUp}</button>
                <button type="button" className="btn ghost" disabled={i === menu.items.length - 1} aria-label={`${t.botDown}: ${t.botItem(num(i + 1, lang))}`} onClick={() => move(i, 1)}>{t.botDown}</button>
                <button type="button" className="btn ghost" aria-label={`${t.botRemove}: ${t.botItem(num(i + 1, lang))}`} onClick={() => setMenu({ ...menu, items: menu.items.filter((_, k) => k !== i) })}>{t.botRemove}</button>
              </div>
            </fieldset>
          ))}
          <div className="settings-actions">
            <button type="button" className="btn" disabled={menu.items.length >= MENU_MAX_ITEMS} onClick={addItem}>{t.botAdd}</button>
            <span className="muted">{t.botCount(num(menu.items.length, lang), num(MENU_MAX_ITEMS, lang))}</span>
          </div>
          <small className="muted">{t.botMenuRows}</small>
        </fieldset>

        <fieldset className="field" disabled={readOnly}>
          <legend>{t.botHoursTitle}</legend>
          <div className="setting-row">
            <span id="bot-hours-label">{t.botHoursEnable}</span>
            <button type="button" role="switch" aria-checked={hours.enabled} aria-labelledby="bot-hours-label" className="switch" onClick={() => setHours({ ...hours, enabled: !hours.enabled })}><span /></button>
          </div>
          <small className="muted">{t.botHoursTz} {t.botOvernight}</small>
          {DAYS.map((d) => (
            <fieldset key={d} className="step">
              <legend>{t.botDays[d]}</legend>
              {hours.week[d].length === 0 && <p className="muted">{t.botClosedDay}</p>}
              {hours.week[d].map((r, k) => (
                <div key={k} className="param-row">
                  <label className="field"><span>{t.botOpens} ({t.botDays[d]})</span>
                    <input type="time" dir="ltr" value={r.open} onChange={(e) => setRanges(d, hours.week[d].map((x, j) => (j === k ? { ...x, open: e.target.value } : x)))} /></label>
                  <label className="field"><span>{t.botCloses} ({t.botDays[d]})</span>
                    <input type="time" dir="ltr" value={r.close} onChange={(e) => setRanges(d, hours.week[d].map((x, j) => (j === k ? { ...x, close: e.target.value } : x)))} /></label>
                  <button type="button" className="btn ghost" aria-label={`${t.botRemoveRange}: ${t.botDays[d]}`} onClick={() => setRanges(d, hours.week[d].filter((_, j) => j !== k))}>{t.botRemoveRange}</button>
                </div>
              ))}
              <div className="settings-actions">
                <button type="button" className="btn ghost" disabled={hours.week[d].length >= 2} aria-label={`${t.botAddRange}: ${t.botDays[d]}`} onClick={() => setRanges(d, [...hours.week[d], { open: '10:00', close: '18:00' }])}>{t.botAddRange}</button>
              </div>
            </fieldset>
          ))}
          {textField('bot-away-ar', t.botAwayAr, hours.awayMessage.ar, HOURS_AWAY_MAX, (v) => setHours({ ...hours, awayMessage: { ...hours.awayMessage, ar: v } }), true)}
          {textField('bot-away-en', t.botAwayEn, hours.awayMessage.en, HOURS_AWAY_MAX, (v) => setHours({ ...hours, awayMessage: { ...hours.awayMessage, en: v } }), true)}
          <div className="setting-row">
            <span id="bot-orders-label">{t.botOrdersWhileClosed}</span>
            <button type="button" role="switch" aria-checked={hours.ordersWhileClosed} aria-labelledby="bot-orders-label" className="switch" onClick={() => setHours({ ...hours, ordersWhileClosed: !hours.ordersWhileClosed })}><span /></button>
          </div>
        </fieldset>

        <fieldset className="field" disabled={readOnly}>
          <legend>{t.botLocTitle}</legend>
          <small className="muted">{t.botLocHint}</small>
          {textField('bot-loc-name', t.botLocName, draft.location.name, 100, (v) => setLoc({ name: v }))}
          {textField('bot-loc-address', t.botLocAddress, draft.location.address, 300, (v) => setLoc({ address: v }), true)}
          <label className="field"><span>{t.botLat}</span><input dir="ltr" inputMode="decimal" value={draft.location.latitude} onChange={(e) => setLoc({ latitude: e.target.value })} /></label>
          <label className="field"><span>{t.botLng}</span><input dir="ltr" inputMode="decimal" value={draft.location.longitude} onChange={(e) => setLoc({ longitude: e.target.value })} /></label>
          <div className="settings-actions">
            {mapUrl && <a href={mapUrl} target="_blank" rel="noopener">{t.botLocPreview}</a>}
            <button type="button" className="btn ghost" disabled={locEmpty(draft.location)} onClick={() => setLoc({ name: '', address: '', latitude: '', longitude: '' })}>{t.botLocClear}</button>
          </div>
        </fieldset>

        {!valid && !readOnly && <p role="alert" className="error-text">{t.botInvalid}</p>}
        {!readOnly && (
          <div className="settings-actions">
            <button type="submit" className="btn primary" disabled={status === 'saving' || !valid}>{t.save}</button>
            {(status === 'saved' || status === 'failed') && <span role="status" className={status === 'failed' ? 'error-text' : 'muted'}>{status === 'saved' ? t.saved : t.saveFailed}</span>}
          </div>
        )}
      </form>
    </main>
  );
}
