import { useCallback, useEffect, useState } from 'react';
import type { BotSwitchesDto, ThrottleReportDto } from '../../../src/core/api/contract';
import type { InboxSource } from '../data/source';
import { num, type Lang, type Strings } from '../i18n';
import { dateTime } from './CampaignsScreen';
import { LoadError } from './LoadError';
import { Skeleton } from './Skeleton';

type Key = keyof BotSwitchesDto;
/** The two switches that message customers or cost money per use: turning them ON asks the server for a confirm token first (SETTINGS-CONFIRM-1). */
const NEEDS_CONFIRM: readonly Key[] = ['orderConfirmations', 'otpViaWhatsApp'];
const UNLIMITED = 1_000_000_000;

/** A28 + A31-A33: sending speed and tier use, and the three owner switches. The server decides who may change them; `readOnly` only hides the doing. */
export function BotSwitches({ t, lang, source, readOnly }: { t: Strings; lang: Lang; source: InboxSource; readOnly: boolean }) {
  const api = source.switches!;
  const [sw, setSw] = useState<BotSwitchesDto | undefined | 'error'>(undefined);
  const [thr, setThr] = useState<ThrottleReportDto | null | undefined | 'error'>(undefined);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ key: Key; token: string } | null>(null);
  const [note, setNote] = useState<{ kind: 'saved' | 'failed' | 'expired'; key: Key } | null>(null);

  const load = useCallback(() => {
    void api.get().then(setSw, () => setSw('error'));
    void api.throttle().then(setThr, () => setThr('error'));
  }, [api]);
  useEffect(load, [load]);

  const save = async (key: Key, value: boolean, token?: string) => {
    setBusy(true);
    setNote(null);
    try {
      const next = await api.save({ [key]: value }, token);
      setSw(next);
      setAsking(null);
      setNote({ kind: 'saved', key });
    } catch (e) {
      const detail = (e as { detail?: string }).detail;
      setAsking(null);
      setNote({ kind: detail === 'confirm_expired' || detail === 'confirm_invalid' ? 'expired' : 'failed', key });
    } finally {
      setBusy(false);
    }
  };

  const flip = async (key: Key) => {
    if (sw === undefined || sw === 'error' || readOnly || busy) return;
    const value = !sw[key];
    if (value && NEEDS_CONFIRM.includes(key)) {
      setBusy(true);
      setNote(null);
      try {
        const { confirmToken } = await api.preview({ [key]: true });
        setAsking({ key, token: confirmToken });
      } catch {
        setNote({ kind: 'failed', key });
      } finally {
        setBusy(false);
      }
      return;
    }
    await save(key, value);
  };

  const rows: { key: Key; label: string; hint: string; ask?: string }[] = [
    { key: 'orderingBot', label: t.swOrdering, hint: t.swOrderingHint },
    { key: 'orderConfirmations', label: t.swConfirmations, hint: t.swConfirmationsHint, ask: t.swConfirmConfirmations },
    { key: 'otpViaWhatsApp', label: t.swOtp, hint: t.swOtpHint, ask: t.swConfirmOtp },
  ];
  const msg = (k: Key) => (note?.key !== k ? null : note.kind === 'saved' ? t.saved : note.kind === 'expired' ? t.swExpired : t.saveFailed);

  return (
    <>
      <section className="settings" aria-labelledby="bot-sending-title">
        <h2 id="bot-sending-title">{t.thTitle}</h2>
        <p className="muted">{t.thIntro}</p>
        {thr === undefined && <Skeleton t={t} rows={1} kind="setting" />}
        {thr === 'error' && <LoadError t={t} onRetry={load} />}
        {thr === null && <p className="muted">{t.swNoNumber}</p>}
        {thr && thr !== 'error' && (
          <ul>
            <li>{thr.tier >= UNLIMITED ? t.tierUnlimited : t.tierLine(num(thr.tier, lang))}</li>
            {thr.tier < UNLIMITED && <li>{t.thUsed(num(thr.usedInWindow, lang), num(thr.tier, lang))}</li>}
            <li>{t.thMps(num(thr.mps, lang))}</li>
            <li>{t.thWaiting(thr.waiting, num(thr.waiting, lang))}</li>
            {thr.nextSlotAt !== null && <li>{t.thNext(dateTime(thr.nextSlotAt, lang))}</li>}
          </ul>
        )}
      </section>
      {/* CHAT-SA-5: every switch here (ordering bot, order confirmations, store-login codes) belongs to a Store, so a standalone workspace has none. */}
      {!source.standalone && (
      <section className="settings" aria-labelledby="bot-switches-title">
        <h2 id="bot-switches-title">{t.swTitle}</h2>
        <p className="muted">{t.swIntro}</p>
        {sw === undefined && <Skeleton t={t} rows={1} kind="setting" />}
        {sw === 'error' && <LoadError t={t} onRetry={load} />}
        {sw && sw !== 'error' && rows.map((r) => (
          <div key={r.key} className="field">
            <div className="setting-row">
              <span id={`sw-${r.key}`}>{r.label}</span>
              <button type="button" role="switch" aria-checked={sw[r.key]} aria-labelledby={`sw-${r.key}`} aria-describedby={`sw-${r.key}-hint`} className="switch" disabled={readOnly || busy} onClick={() => void flip(r.key)}><span /></button>
            </div>
            <small id={`sw-${r.key}-hint`} className="muted">{r.hint} {sw[r.key] ? t.swOn : t.swOff}</small>
            {asking?.key === r.key && (
              <div role="group" aria-label={t.swConfirmTitle} className="notice">
                <p>{r.ask}</p>
                <div className="settings-actions">
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void save(r.key, true, asking.token)}>{t.swConfirmGo}</button>
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => setAsking(null)}>{t.swConfirmCancel}</button>
                </div>
              </div>
            )}
            {msg(r.key) && <span role={note?.kind === 'saved' ? 'status' : 'alert'} className={note?.kind === 'saved' ? 'muted' : 'error-text'}>{msg(r.key)}</span>}
          </div>
        ))}
      </section>
      )}
    </>
  );
}
