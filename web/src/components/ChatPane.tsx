import { ArrowRight, Check, CheckCheck, Clock, FileText, Package, Paperclip, Send, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ConversationDto, MessageDto, TemplateDto } from '../../../src/core/api/contract';
import type { Lang, Strings } from '../i18n';
import { clockTime, windowLeft } from '../lib/format';
import { initials } from './ConversationList';

type Props = {
  t: Strings; lang: Lang; now: number;
  conversation: ConversationDto | null; messages: MessageDto[]; templates: TemplateDto[];
  onSendText: (text: string) => void; onSendTemplate: (tpl: TemplateDto) => void; onRetry: (m: MessageDto) => void;
  onBack: () => void; onShowOrders: () => void;
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

export function ChatPane({ t, lang, now, conversation, messages, templates, onSendText, onSendTemplate, onRetry, onBack, onShowOrders }: Props) {
  const [draft, setDraft] = useState('');
  const [picker, setPicker] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => { thread.current?.scrollTo?.({ top: thread.current.scrollHeight }); }, [messages.length, conversation?.id]);
  useEffect(() => { setDraft(''); setPicker(false); }, [conversation?.id]);

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
          <b>{conversation.contact.name ?? `+${conversation.contact.waId}`}</b>
          <span className="win" data-state={win.state}>{win.label}</span>
        </div>
        <div className="head-actions">
          <span className="tag">{conversation.assigneeUserId ? `${t.assignedTo}: ${conversation.assigneeUserId === 'u-me' ? t.mine : conversation.assigneeUserId.replace(/^u-/, '')}` : t.unassignedLabel}</span>
          <button type="button" className="btn ghost orders-toggle" onClick={onShowOrders}><Package size={17} aria-hidden />{t.showOrders}</button>
        </div>
      </header>
      {conversation.contact.optedOut && <p className="notice">{t.optedOut}</p>}
      <div className="thread" ref={thread} role="log" aria-live="polite">
        {messages.map((m) => {
          const d = dayKey(m.at);
          const sep = d !== lastDay ? <span className="tag day" key={`d${d}`}>{d === today ? t.today : new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'long' }).format(m.at)}</span> : null;
          lastDay = d;
          return [sep, (
            <div key={m.id} className={`bubble ${m.direction}`}>
              {m.text}
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
      <div className="composer">
        {picker && (
          <div className="popover" role="menu" aria-label={t.pickTemplate}>
            {templates.filter((x) => x.status === 'APPROVED').map((tpl) => (
              <button key={tpl.name} type="button" role="menuitem" onClick={() => { onSendTemplate(tpl); setPicker(false); }}>
                <b style={{ fontWeight: 500 }}>{tpl.name}</b>
                <span className="muted">{tpl.bodyText}</span>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="icon-btn" aria-label={t.pickTemplate} aria-expanded={picker} onClick={() => setPicker((v) => !v)}><FileText size={18} aria-hidden /></button>
        <button type="button" className="icon-btn" aria-label={t.attach} disabled={closed}><Paperclip size={18} aria-hidden /></button>
        <label className="vh" htmlFor="composer">{t.typeMessage}</label>
        <textarea id="composer" rows={1} value={draft} disabled={closed} placeholder={closed ? t.windowClosed : `${t.typeMessage}…`} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
        <button type="button" className="btn primary" onClick={send} disabled={closed || !draft.trim()} aria-label={t.send}><Send size={17} aria-hidden style={{ transform: lang === 'ar' ? 'scaleX(-1)' : undefined }} /><span>{t.send}</span></button>
      </div>
    </main>
  );
}
