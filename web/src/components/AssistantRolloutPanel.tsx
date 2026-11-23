import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../data/api';
import { ASSISTANT_MODES, type AssistantMode, type AssistantPlatformFlags, type AssistantRolloutApi } from '../data/assistant-rollout';
import type { Strings } from '../i18n';

type Props = { t: Strings; api: AssistantRolloutApi; run: (fn: () => Promise<string | void>) => Promise<boolean>; fail: (...lines: string[]) => void };
type Draft = { kill: boolean; mode: AssistantMode; shadow: boolean; productKill: boolean; tools: string };
const toDraft = (f: AssistantPlatformFlags): Draft => ({ kill: f.global.kill === true, mode: f.global.mode, shadow: f.shadow === true, productKill: f.product.kill === true, tools: f.killedTools.join(', ') });
const parseTools = (s: string): string[] | null => {
  const xs = s.split(',').map((x) => x.trim()).filter(Boolean);
  return xs.length <= 100 && xs.every((x) => x.length <= 64) ? [...new Set(xs)] : null;
};

/** Operator console, "Assistant": the Smart Layer rollout switches. Every change goes through an inline confirm, and the server's answer (not the draft) is what is shown after. */
export function AssistantRolloutPanel({ t, api, run, fail }: Props) {
  const a = t.opAssistant;
  const [flags, setFlags] = useState<AssistantPlatformFlags | null>(null);
  const [loadFailed, setLoadFailed] = useState(false); // an unread switch is unknown, never "off"
  const [draft, setDraft] = useState<Draft | null>(null);
  const [asking, setAsking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const f = await api.platform(); setFlags(f); setDraft(toDraft(f)); setLoadFailed(false); } catch { setLoadFailed(true); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const onOff = (v: boolean) => (v ? a.on : a.off);
  const changes = (): string[] => {
    if (!flags || !draft) return [];
    const cur = toDraft(flags);
    const out: string[] = [];
    if (draft.kill !== cur.kill) out.push(`${a.killGlobal}: ${onOff(draft.kill)}`);
    if (draft.productKill !== cur.productKill) out.push(`${a.killProduct}: ${onOff(draft.productKill)}`);
    if (draft.mode !== cur.mode) out.push(`${a.cap}: ${a.modes[draft.mode]}`);
    if (draft.shadow !== cur.shadow) out.push(`${a.shadow}: ${onOff(draft.shadow)}`);
    const nt = parseTools(draft.tools);
    if (nt && nt.join(',') !== flags.killedTools.join(',')) out.push(`${a.killedTools}: ${nt.join(', ') || a.none}`);
    return out;
  };
  const ask = () => {
    if (!draft) return;
    if (parseTools(draft.tools) === null) return fail(a.killedToolsBad);
    const c = changes();
    if (c.length === 0) return fail(a.nothingToSave);
    setAsking(c.join('; '));
  };
  const save = async () => {
    if (!flags || !draft) return;
    const tools = parseTools(draft.tools);
    if (!tools) return;
    setAsking(null);
    const cur = toDraft(flags);
    // The server replaces a whole `global` / `product` value, so each is sent complete whenever any part of it changed.
    const patch = {
      ...(draft.kill !== cur.kill || draft.mode !== cur.mode || draft.shadow !== cur.shadow ? { global: { kill: draft.kill, mode: draft.mode, shadow: draft.shadow } } : {}),
      ...(draft.productKill !== cur.productKill ? { product: { kill: draft.productKill } } : {}),
      ...(tools.join(',') !== flags.killedTools.join(',') ? { killedTools: tools } : {}),
    };
    await run(async () => { const f = await api.setPlatform(patch); setFlags(f); setDraft(toDraft(f)); return a.saved; });
  };

  return (
    <>
      <section className="wallet-card" aria-labelledby="op-as-platform">
        <h2 id="op-as-platform">{a.platformTitle}</h2>
        <p className="muted">{a.help}</p>
        {loadFailed && <p className="error-text" role="alert">{a.loadFailed}</p>}
        {flags && draft && (
          <>
            <p aria-live="polite">
              <b>{a.current}:</b>{' '}
              <span className="flag bad" data-ok={flags.global.kill !== true}>{a.killGlobal}: {onOff(flags.global.kill === true)}</span>{' '}
              <span className="flag" data-ok={flags.product.kill !== true}>{a.killProduct}: {onOff(flags.product.kill === true)}</span>{' '}
              <span className="muted">{a.cap}: {a.modes[flags.global.mode]}</span>
            </p>
            <form className="wallet-form op-grid" onSubmit={(e) => { e.preventDefault(); ask(); }}>
              <label className="field"><span>{a.cap}</span>
                <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as AssistantMode })}>
                  {ASSISTANT_MODES.map((m) => <option key={m} value={m}>{a.modes[m]}</option>)}
                </select>
              </label>
              <label className="field"><span>{a.killedTools}</span><input dir="ltr" value={draft.tools} onChange={(e) => setDraft({ ...draft, tools: e.target.value })} /></label>
              <label className="field-check"><input type="checkbox" checked={draft.kill} onChange={(e) => setDraft({ ...draft, kill: e.target.checked })} /> <span>{a.killGlobal}</span></label>
              <label className="field-check"><input type="checkbox" checked={draft.productKill} onChange={(e) => setDraft({ ...draft, productKill: e.target.checked })} /> <span>{a.killProduct}</span></label>
              <label className="field-check"><input type="checkbox" checked={draft.shadow} onChange={(e) => setDraft({ ...draft, shadow: e.target.checked })} /> <span>{a.shadow}</span></label>
              <div className="settings-actions op-wide"><button type="submit" className="btn primary">{a.save}</button></div>
            </form>
            {asking && (
              <div className="confirm-inline" role="group" aria-label={a.confirmPlatform(asking)}>
                <span>{a.confirmPlatform(asking)}</span>
                <button type="button" className="btn danger" onClick={() => void save()}>{a.yes}</button>
                <button type="button" className="btn ghost" onClick={() => setAsking(null)}>{a.no}</button>
              </div>
            )}
          </>
        )}
      </section>
      <WorkspaceMode t={t} api={api} run={run} fail={fail} />
    </>
  );
}

function WorkspaceMode({ t, api, run, fail }: Props) {
  const a = t.opAssistant;
  const [ws, setWs] = useState('');
  const [loaded, setLoaded] = useState<{ id: string; mode: AssistantMode } | null>(null);
  const [pick, setPick] = useState<AssistantMode>('off');
  const [asking, setAsking] = useState(false);

  const load = async () => {
    const id = ws.trim();
    if (!id) return fail(a.wsId);
    setLoaded(null); setAsking(false);
    try { const mode = await api.workspaceMode(id); setLoaded({ id, mode }); setPick(mode); }
    catch (e) { fail(e instanceof ApiError && e.status === 404 ? a.wsNotFound : a.loadFailed); }
  };
  const set = async () => {
    if (!loaded) return;
    setAsking(false);
    await run(async () => { const mode = await api.setWorkspaceMode(loaded.id, pick); setLoaded({ id: loaded.id, mode }); setPick(mode); return a.saved; });
  };

  return (
    <section className="wallet-card" aria-labelledby="op-as-ws">
      <h2 id="op-as-ws">{a.wsTitle}</h2>
      <p className="muted">{a.wsCapNote}</p>
      <form className="wallet-form op-grid" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="field"><span>{a.wsId}</span><input dir="ltr" autoComplete="off" value={ws} onChange={(e) => { setWs(e.target.value); setLoaded(null); setAsking(false); }} /></label>
        <div className="settings-actions op-wide"><button type="submit" className="btn">{a.wsLoad}</button></div>
      </form>
      {loaded && (
        <>
          <p aria-live="polite"><bdi dir="ltr">{a.wsCurrent(loaded.id, a.modes[loaded.mode] ?? loaded.mode)}</bdi></p>
          <div className="wallet-form op-grid">
            <label className="field"><span>{a.wsMode}</span>
              <select value={pick} onChange={(e) => { setPick(e.target.value as AssistantMode); setAsking(false); }}>
                {ASSISTANT_MODES.map((m) => <option key={m} value={m}>{a.modes[m]}</option>)}
              </select>
            </label>
            <div className="settings-actions op-wide"><button type="button" className="btn primary" onClick={() => (pick === loaded.mode ? fail(a.wsSame) : setAsking(true))}>{a.wsSet}</button></div>
          </div>
          {asking && (
            <div className="confirm-inline" role="group" aria-label={a.confirmWs(loaded.id, a.modes[pick] ?? pick)}>
              <span>{a.confirmWs(loaded.id, a.modes[pick] ?? pick)}</span>
              <button type="button" className="btn danger" onClick={() => void set()}>{a.yes}</button>
              <button type="button" className="btn ghost" onClick={() => setAsking(false)}>{a.no}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
