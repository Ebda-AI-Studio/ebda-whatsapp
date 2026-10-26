import { ArrowRight, Check, CheckCheck, ChevronUp, Clock, FileText, Paperclip, Send, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ConversationDto, MessageDto, OrderSummaryDto, TemplateDto } from '../../../src/core/api/contract';
import type { Lang, Strings } from '../i18n';
import { clockTime, formatMoney, windowLeft } from '../lib/format';
import { initials } from './ConversationList';
import { MediaView } from './MediaView';
import type { InboxSource } from '../data/source';

type Props = {
  t: Strings; lang: Lang; now: number;
  conversation: ConversationDto | null; source: InboxSource; userNames: Record<string, string>; currentOrder: OrderSummaryDto | null; messages: MessageDto[]; templates: TemplateDto[];
  onSendText: (text: string) => void; onSendTemplate: (tpl: TemplateDto, params: string[]) => void; onSendMedia?: (file: File) => void; onRetry: (m: MessageDto) => void;
  onBack: () => void; onShowOrders: () => void; onTakeOver?: () => void;
};

function StatusIcon({ status }: { status: MessageDto['status'] }) {
  if (status === 'read') return <CheckCheck size={14} aria-hidden style={{ color: 'var(--gold-ink)' }} />;
  if (status === 'delivered') return <CheckCheck size={14} aria-hidden />;
  if (status === 'sent' || status === 'accepted') return <Check size={14} aria-hidden />;
  if (status === 'failed') return <TriangleAlert size={14} aria-hidden />;
  return <Clock size={13} aria-hidden />;
}

function dayKey(at: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(at);
}

export function ChatPane({ t, lang, now, conversation, source, userNames, currentOrder, messages, templates, onSendText, onSendTemplate, onSendMedia, onRetry, onBack, onShowOrders, onTakeOver }: Props) {
  const [draft, setDraft] = useState('');
  const [picker, setPicker] = useState(false);
  const [fullText, setFullText] = useState<Record<number, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const [filling, setFilling] = useState<{ tpl: TemplateDto; params: string[] } | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => { thread.current?.scrollTo?.({ top: thread.current.scrollHeight }); }, [messages.length, conversation?.id]);
  useEffect(() => { setDraft(''); setPicker(false); setFilling(null); }, [conversation?.id]);

  if (!conversation) return <main className="chat"><div className="placeholder">{t.pickChat}</div></main>;

  const win = windowLeft(conversation.windowOpenUntil, now, lang);
  const closed = win.state === 'closed';
  const send = () => { const text = draft.trim(); if (!text || closed) return; onSendText(text); setDraft(''); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } };
  const today = dayKey(now);
  let lastDay = '';

  return (
    <main className="chat" aria-label={conversation.contact.name ?? conversation.contact.waId}>
      <header className="chat-head">
        <button type="button" className="icon-btn back" onClick={onBack} aria-label={t.back}><ArrowRight size={18} aria-hidden style={{ transform: lang === 'en' ? 'scaleX(-1)' : undefined }} /></button>
        <span className="avatar" aria-hidden>{initials(conversation.contact.name)}</span>
        <div className="who">
          <b dir="auto">{conversation.contact.name ?? `+${conversation.contact.waId}`}</b>
          <span className="win" data-state={win.state}>{win.label}</span>
        </div>
        <div className="head-actions">
          <span className="tag assignee">{conversation.assigneeUserId ? `${t.assignedTo}: ${userNames[conversation.assigneeUserId] ?? conversation.assigneeUserId.slice(0, 8)}` : t.unassignedLabel}</span>
        </div>
      </header>
      {currentOrder && (
        <button type="button" className="order-strip" onClick={onShowOrders}>
          <b><bdi>{currentOrder.orderNumber}</bdi></b>
          <span>{formatMoney(currentOrder.totalMinor, currentOrder.currency, lang)}</span>
          <span className="status" data-status={currentOrder.status}>{t.orderStatus[currentOrder.status]}</span>
          <span className="strip-cta">{t.viewOrder}<ChevronUp size={18} aria-hidden /></span>
        </button>
      )}
      {conversation.contact.optedOut && <p className="notice">{t.optedOut}</p>}
      {conversation.tags.includes('needs_human') && (
        <div className="human-banner" role="status">
          <span>{t.needsHumanBanner}</span>
          {onTakeOver && <button type="button" className="btn gold" onClick={onTakeOver}>{t.takeOver}</button>}
        </div>
      )}
      <div className="thread" ref={thread} role="log" aria-live="polite">
        {messages.map((m) => {
          const d = dayKey(m.at);
          const sep = d !== lastDay ? <span className="tag day" key={`d${d}`}>{d === today ? t.today : new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'long' }).format(m.at)}</span> : null;
          lastDay = d;
          return [sep, (
            <div key={m.id} className={`bubble ${m.direction}`} data-client-id={m.clientId ?? undefined}>
              {m.media && <MediaView t={t} media={m.media} source={source} />}
              {m.text && <bdi dir="auto" className="text">{fullText[m.id] ?? m.text}</bdi>}
              {m.author === 'agent' && <span className="ai-mark"><Sparkles size={12} aria-hidden />{t.agentReply}</span>}
              {m.hasLongBody && fullText[m.id] === undefined && source.longBody && (
                <button type="button" className="more" onClick={() => void source.longBody!(m.id).then((txt) => setFullText((f) => ({ ...f, [m.id]: txt })), () => undefined)}>{t.readMore}</button>
              )}
              <div className="meta" data-status={m.status ?? undefined}>
                <span>{clockTime(m.at, lang)}</span>
                {m.direction === 'out' && <><StatusIcon status={m.status} /><span className="vh">{m.status ? t.status[m.status] : ''}</span></>}
                {m.status === 'failed' && <button type="button" onClick={() => onRetry(m)}>{t.retry}</button>}
              </div>
            </div>
          )];
        })}
      </div>
      {closed && <p className="closed-note" role="status">{t.windowClosedHelp}</p>}
      {!closed && (
        <div className="quick" role="group" aria-label={t.quickReplies}>
          {t.quickReplyTexts.map((q) => (
            <button key={q} type="button" className="chip" onClick={() => setDraft(q)}>{q}</button>
          ))}
        </div>
      )}
      <div className="composer" data-closed={closed}>
        {filling && (
          <form className="popover fill" aria-label={t.templateNames[filling.tpl.name] ?? filling.tpl.name} onSubmit={(e) => { e.preventDefault(); onSendTemplate(filling.tpl, filling.params); setFilling(null); }}>
            <b style={{ fontWeight: 500 }}>{t.templateNames[filling.tpl.name] ?? filling.tpl.name}</b>
            <span className="muted" dir="auto">{filling.tpl.bodyText}</span>
            {filling.params.map((v, i) => (
              <label key={i} className="field">
                <span>{t.templateVar(i + 1)}</span>
                <input dir="auto" value={v} onChange={(e) => setFilling({ ...filling, params: filling.params.map((p, j) => (j === i ? e.target.value : p)) })} />
              </label>
            ))}
            <div className="order-actions">
              <button type="submit" className="btn gold" disabled={filling.params.some((p) => !p.trim())}>{t.sendTemplate}</button>
              <button type="button" className="btn" onClick={() => setFilling(null)}>{t.refuseCancel}</button>
            </div>
          </form>
        )}
        {picker && (
          <div className="popover" role="menu" aria-label={t.pickTemplate}>
            {templates.filter((x) => x.status === 'APPROVED').map((tpl) => (
              <button key={`${tpl.name}:${tpl.language}`} type="button" role="menuitem" onClick={() => { setPicker(false); if (tpl.paramCount > 0) setFilling({ tpl, params: Array.from({ length: tpl.paramCount }, () => '') }); else onSendTemplate(tpl, []); }}>
                <b style={{ fontWeight: 500 }}>{t.templateNames[tpl.name] ?? tpl.name}</b>
                <span className="muted" dir="auto">{tpl.bodyText}</span>
              </button>
            ))}
          </div>
        )}
        {closed
          ? <button type="button" className="btn gold" aria-label={t.pickTemplate} aria-expanded={picker} onClick={() => setPicker((v) => !v)}><FileText size={18} aria-hidden /><span>{t.pickTemplate}</span></button>
          : <button type="button" className="icon-btn" aria-label={t.pickTemplate} aria-expanded={picker} onClick={() => setPicker((v) => !v)}><FileText size={18} aria-hidden /></button>}
        {onSendMedia && source.upload && (
          <>
            <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,audio/ogg,video/mp4,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) onSendMedia(f); e.target.value = ''; }} />
            <button type="button" className="icon-btn" aria-label={t.attach} disabled={closed} onClick={() => fileInput.current?.click()}><Paperclip size={18} aria-hidden /></button>
          </>
        )}
        <label className="vh" htmlFor="composer">{t.typeMessage}</label>
        <textarea id="composer" rows={1} value={draft} disabled={closed} placeholder={`${t.typeMessage}…`} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
        <button type="button" className="btn primary" onClick={send} disabled={closed || !draft.trim()} aria-label={t.send}><Send size={17} aria-hidden style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} /><span className="send-label">{t.send}</span></button>
      </div>
    </main>
  );
}
