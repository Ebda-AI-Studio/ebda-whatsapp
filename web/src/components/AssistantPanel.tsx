import { BRAND } from '@brand';
import { ArrowUp, CircleAlert, ExternalLink, MapPin, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantSegment } from '../../../src/core/api/contract';
import { conversationIdFor, forgetConversation, safeHref, viewForPath, type AssistantApi, type ChatItem } from '../data/assistant';
import type { Lang, Strings } from '../i18n';
import { ConfirmCard } from './ConfirmCard';
import { PreviewCard } from './PreviewCard';
import type { View } from './Rail';
import { pathFor } from '../lib/route';

const MAX = 2000;

/** One reply as text and links only. Reply text is plain text (no HTML, no markdown, no image element): what the server sends can never inject markup. */
function Segments({ t, segments, onNavigate }: { t: Strings; segments: AssistantSegment[]; onNavigate: (v: View) => void }) {
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === 'text') return <span key={i} className="as-text" dir="auto">{s.text}</span>;
        if (s.kind === 'cap') {
          const view = viewForPath(s.appPath);
          return view
            ? <a key={i} className="as-chip as-where" href={pathFor(view)} onClick={(e) => { e.preventDefault(); onNavigate(view); }}><MapPin size={14} aria-hidden /><span>{t.assistantShowMe}: <span dir="auto">{s.label}</span></span></a>
            : <span key={i} className="as-text" dir="auto">{s.label}</span>;
        }
        const href = s.kind === 'cite' ? safeHref(s.url) : safeHref(s.href);
        const label = s.kind === 'cite' ? s.title : s.text;
        return href
          ? <a key={i} className="as-chip as-cite" href={href} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden /><span dir="auto">{s.kind === 'cite' ? `${t.assistantSource}: ${label}` : label}</span></a>
          : <span key={i} className="as-text" dir="auto">{label}</span>;
      })}
    </>
  );
}

/**
 * The side panel (answer-only). Opens from the rail or Ctrl/Cmd + J, closes with Esc, keeps focus inside while open and gives it back on close.
 * It shows what the server says and nothing more: every limit, refusal and "not covered" arrives as words from the server in the asked language.
 */
export function AssistantPanel({ t, lang, storeId, userId, api, onNavigate, onClose, onUnavailable }: { t: Strings; lang: Lang; storeId: string; userId: string; api: AssistantApi; onNavigate: (v: View) => void; onClose: () => void; onUnavailable: () => void }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [rated, setRated] = useState<Record<string, 'up' | 'down'>>({});
  const conv = useRef(conversationIdFor(storeId, userId));
  const panel = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  // Earlier turns of this conversation (this person's own); a failure just starts empty.
  useEffect(() => {
    let alive = true;
    api.conversation(conv.current).then((rows) => {
      if (alive) setItems(rows.map((r): ChatItem => (r.role === 'merchant' ? { id: r.id, role: 'merchant', text: r.text } : { id: r.id, role: 'assistant', segments: [{ kind: 'text', text: r.text }] })));
    }, () => undefined);
    field.current?.focus();
    return () => { alive = false; };
  }, [api]);

  useEffect(() => { log.current?.scrollTo?.({ top: log.current.scrollHeight }); }, [items, busy]);

  // Esc closes; Tab stays inside the panel (it is a modal-like layer on a phone).
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea:not([disabled])')];
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ask = useCallback(async (q: string) => {
    const clean = q.trim();
    if (!clean || busy) return;
    setFailed(null);
    setBusy(true);
    setItems((cur) => [...cur, { id: crypto.randomUUID(), role: 'merchant', text: clean }]);
    setText('');
    try {
      const r = await api.turn({ conversationId: conv.current, text: clean, locale: lang });
      if (r.status === 'off') { setOff(true); onUnavailable(); return; }
      setItems((cur) => [...cur, { id: r.turnId, role: 'assistant', segments: r.segments, turnId: r.turnId, status: r.status, previews: r.previews, approvals: r.approvals }]);
    } catch {
      setFailed(clean);
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  }, [api, busy, lang, onUnavailable]);

  const rate = (turnId: string, thumb: 'up' | 'down') => {
    if (rated[turnId]) return;
    setRated((r) => ({ ...r, [turnId]: thumb }));
    void api.feedback(turnId, thumb).catch(() => setRated((r) => { const { [turnId]: _gone, ...rest } = r; return rest; }));
  };
  const over = text.length > MAX;

  return (
    <section ref={panel} id="assistant-panel" className="assistant" role="dialog" aria-modal="false" aria-labelledby="assistant-title" data-testid="assistant-panel">
      <header className="as-head">
        <h2 id="assistant-title">{t.assistantTitle}</h2>
        {items.length > 0 && <button type="button" className="btn ghost as-new" onClick={() => { forgetConversation(storeId, userId); conv.current = conversationIdFor(storeId, userId); setItems([]); setFailed(null); }}>{t.assistantNew}</button>}
        <button type="button" className="as-close" aria-label={t.assistantClose} onClick={onClose}><X size={20} aria-hidden /></button>
      </header>

      <div ref={log} className="as-log" role="log" aria-live="polite" aria-label={t.assistantLog}>
        {off && <p className="as-note" role="status">{t.assistantOff}</p>}
        {!off && items.length === 0 && (
          <div className="as-empty">
            <p className="state-title">{t.assistantEmptyTitle}</p>
            <p className="state-body">{t.assistantIntro}</p>
            <ul className="as-suggest">
              {t.assistantSuggest.map((q) => <li key={q}><button type="button" className="chip" onClick={() => void ask(q)}>{q}</button></li>)}
            </ul>
            {BRAND.supportEmail && <p className="state-body as-support">{t.assistantSupport} <a href={`mailto:${BRAND.supportEmail}`} dir="ltr">{BRAND.supportEmail}</a></p>}
          </div>
        )}
        {items.map((m) => m.role === 'merchant'
          ? <div key={m.id} className="as-msg as-me"><span className="vh">{t.assistantYou}: </span><p dir="auto">{m.text}</p></div>
          : (
            <div key={m.id} className="as-msg as-bot" data-status={m.status}>
              <span className="vh">{t.assistantTitle}: </span>
              <p className="as-body"><Segments t={t} segments={m.segments} onNavigate={onNavigate} /></p>
              {m.previews?.map((c) => {
                const ap = c.approvalId ? m.approvals?.find((a) => a.approvalId === c.approvalId) : undefined;
                return c.policy === 'confirm' && ap ? <ConfirmCard key={c.previewId} t={t} lang={lang} card={c} approval={ap} api={api} /> : <PreviewCard key={c.previewId} t={t} lang={lang} card={c} api={api} />;
              })}
              {m.turnId && m.status === 'answered' && (
                <div className="as-rate" role="group" aria-label={t.assistantRateGroup}>
                  {rated[m.turnId]
                    ? <span className="muted" role="status">{t.assistantThanks}</span>
                    : (
                      <>
                        <button type="button" className="as-thumb" aria-label={t.assistantThumbUp} onClick={() => rate(m.turnId!, 'up')}><ThumbsUp size={16} aria-hidden /></button>
                        <button type="button" className="as-thumb" aria-label={t.assistantThumbDown} onClick={() => rate(m.turnId!, 'down')}><ThumbsDown size={16} aria-hidden /></button>
                      </>
                    )}
                </div>
              )}
            </div>
          ))}
        {busy && <div className="as-msg as-bot as-wait" role="status"><span className="as-dots" aria-hidden><i /><i /><i /></span><span>{t.assistantThinking}</span></div>}
        {failed !== null && (
          <div role="alert" className="state state-error as-fail">
            <CircleAlert size={20} aria-hidden />
            <p>{t.assistantError}</p>
            <button type="button" className="btn ghost" onClick={() => { const q = failed; setItems((cur) => cur.slice(0, -1)); void ask(q); }}>{t.retry}</button>
          </div>
        )}
      </div>

      <form className="as-compose" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <label className="vh" htmlFor="assistant-input">{t.assistantPlaceholder}</label>
        <textarea
          id="assistant-input" ref={field} rows={2} dir="auto" value={text} placeholder={t.assistantPlaceholder} aria-describedby="assistant-count"
          disabled={off}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(text); } }}
        />
        <button type="submit" className="btn gold as-send" disabled={busy || off || !text.trim() || over} aria-label={t.assistantSend}><ArrowUp size={18} aria-hidden /></button>
        <span id="assistant-count" className={over ? 'as-count error-text' : 'as-count muted'} aria-live={over ? 'polite' : 'off'}>{over ? t.assistantTooLong : t.assistantHint}</span>
      </form>
    </section>
  );
}
