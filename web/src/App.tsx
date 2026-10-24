import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationDto, MessageDto, OrderSummaryDto, TemplateDto } from '../../src/core/api/contract';
import { ChatPane } from './components/ChatPane';
import { ConversationList } from './components/ConversationList';
import { OrderPane } from './components/OrderPane';
import { Rail } from './components/Rail';
import type { ConversationFilter, InboxSource } from './data/source';
import { STRINGS, type Lang } from './i18n';

type Props = { source: InboxSource; now?: () => number; initialLang?: Lang };

export function App({ source, now = Date.now, initialLang = 'ar' }: Props) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = STRINGS[lang];
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ConversationDto[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [orders, setOrders] = useState<OrderSummaryDto[] | null>(null);
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [error, setError] = useState(false);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = lang === 'ar' ? 'Ebda WhatsApp · المحادثات' : 'Ebda WhatsApp · Inbox';
  }, [lang]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [list, all] = await Promise.all([source.listConversations(filter, query), source.listConversations('all', '')]);
      setItems(list);
      setTotalUnread(all.reduce((n, c) => n + c.unread, 0));
      setError(false);
    } catch {
      setError(true);
    }
  }, [source, filter, query]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void source.templates().then(setTemplates); }, [source]);

  const selected = useMemo(() => items.find((c) => c.id === selectedId) ?? null, [items, selectedId]);

  const open = useCallback(async (id: number) => {
    setSelectedId(id);
    setOrders(null);
    const [msgs] = await Promise.all([source.getMessages(id), source.markRead(id)]);
    setMessages([...msgs]);
    const conv = (await source.listConversations('all', '')).find((c) => c.id === id);
    if (conv) setOrders((await source.orders(conv.contact.waId)).items);
    void refresh();
  }, [source, refresh]);

  useEffect(() => source.subscribe((e) => {
    if (e.type === 'message.status' && e.conversationId === selectedId) {
      setMessages((ms) => ms.map((m) => (m.id === e.messageId ? { ...m, status: e.status, errorCode: e.errorCode } : m)));
    } else if (e.type === 'message.created') {
      if (e.conversationId === selectedId) setMessages((ms) => (ms.some((m) => m.id === e.message.id) ? ms : [...ms, e.message]));
      void refresh();
    } else if (e.type === 'conversation.updated') {
      void refresh();
    }
  }), [source, selectedId, refresh]);

  const sendText = async (text: string) => {
    if (selectedId === null) return;
    const m = await source.send(selectedId, { type: 'text', clientId: crypto.randomUUID(), text });
    setMessages((ms) => [...ms, m]);
    void refresh();
  };
  const sendTemplate = async (tpl: TemplateDto) => {
    if (selectedId === null) return;
    const m = await source.send(selectedId, { type: 'template', clientId: crypto.randomUUID(), name: tpl.name, language: tpl.language, params: [] });
    setMessages((ms) => [...ms, m]);
  };
  const retry = async (m: MessageDto) => { if (m.text) await sendText(m.text); };

  return (
    <div className="app" data-view={selectedId === null ? 'list' : 'chat'} data-orders={ordersOpen ? 'open' : 'closed'}>
      <Rail t={t} onToggleLang={() => setLang((l) => (l === 'ar' ? 'en' : 'ar'))} />
      <ConversationList t={t} lang={lang} now={now()} items={items} selectedId={selectedId} filter={filter} query={query} totalUnread={totalUnread} onFilter={setFilter} onQuery={setQuery} onOpen={open} />
      <div className="center">
        {!online && <p className="notice offline" role="status">{t.offline}</p>}
        {error && <p className="notice offline" role="alert">{t.loadError} <button type="button" className="btn ghost" onClick={() => void refresh()}>{t.retry}</button></p>}
        <ChatPane t={t} lang={lang} now={now()} conversation={selected} userNames={source.userNames} currentOrder={orders?.[0] ?? null} messages={messages} templates={templates} onSendText={sendText} onSendTemplate={sendTemplate} onRetry={retry} onBack={() => setSelectedId(null)} onShowOrders={() => setOrdersOpen(true)} />
      </div>
      {selected && <OrderPane t={t} lang={lang} orders={orders} onConfirm={() => undefined} onRefuse={() => undefined} onClose={() => setOrdersOpen(false)} />}
      <button type="button" className="sheet-backdrop" aria-label={t.close} tabIndex={-1} onClick={() => setOrdersOpen(false)} />
      {source.kind === 'sample' && <span className="sample-badge">{t.sample}</span>}
    </div>
  );
}
