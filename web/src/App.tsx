import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationDto, MessageDto, OrderSummaryDto, SendMessageRequest, TemplateDto } from '../../src/core/api/contract';
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
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const pendingOutcome = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const list = await source.listConversations(filter, query);
      setItems(list);
      // The unread total is only knowable from the unfiltered list; keep the last value under a filter.
      if (filter === 'all' && !query.trim()) setTotalUnread(list.reduce((n, c) => n + c.unread, 0));
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
    setMessages([]);
    const conv = items.find((c) => c.id === id);
    // Messages, read receipt and orders load in parallel: nothing waits on anything else.
    const [msgs, , ord] = await Promise.all([
      source.getMessages(id),
      source.markRead(id),
      conv ? source.orders(conv.contact.waId) : Promise.resolve({ items: [], source: 'sample' as const }),
    ]);
    setMessages([...msgs]);
    setOrders(ord.items);
    void refresh();
  }, [source, refresh, items]);

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

  // Optimistic send: the bubble appears at once as "queued", then reconciles by clientId (or turns failed with Retry).
  const sendOptimistic = async (req: SendMessageRequest, text: string) => {
    if (selectedId === null) return;
    const id = selectedId;
    const temp: MessageDto = { id: -Date.now(), clientId: req.clientId, wamid: null, direction: 'out', type: req.type === 'template' ? 'template' : 'text', text, hasLongBody: false, media: null, template: null, status: 'queued', errorCode: null, at: now() };
    setMessages((ms) => [...ms, temp]);
    try {
      const m = await source.send(id, req);
      setMessages((ms) => ms.map((x) => (x.clientId === req.clientId ? m : x)));
      void refresh();
    } catch {
      setMessages((ms) => ms.map((x) => (x.clientId === req.clientId ? { ...x, status: 'failed' } : x)));
    }
  };
  const sendText = (text: string) => sendOptimistic({ type: 'text', clientId: crypto.randomUUID(), text }, text);
  const sendTemplate = (tpl: TemplateDto) => sendOptimistic({ type: 'template', clientId: crypto.randomUUID(), name: tpl.name, language: tpl.language, params: [] }, tpl.bodyText);
  const retry = async (m: MessageDto) => {
    setMessages((ms) => ms.filter((x) => x.id !== m.id));
    if (m.text) await sendText(m.text);
  };

  // COD outcome: the rail moves at once; the store is told after a 5-second undo window.
  const recordOutcome = (order: OrderSummaryDto, outcome: 'confirmed' | 'refused') => {
    const waId = selected?.contact.waId;
    if (!waId) return;
    const before = order.status;
    setOrders((os) => os?.map((o) => (o.orderNumber === order.orderNumber ? { ...o, status: outcome } : o)) ?? os);
    if (pendingOutcome.current) clearTimeout(pendingOutcome.current);
    pendingOutcome.current = setTimeout(() => {
      pendingOutcome.current = null;
      setToast(null);
      void source.recordCodOutcome(waId, order.orderNumber, outcome).catch(() => {
        setOrders((os) => os?.map((o) => (o.orderNumber === order.orderNumber ? { ...o, status: before } : o)) ?? os);
        setToast({ text: t.loadError });
      });
    }, 5000);
    setToast({
      text: outcome === 'confirmed' ? t.confirmedToast(order.orderNumber) : t.refusedToast(order.orderNumber),
      undo: () => {
        if (pendingOutcome.current) clearTimeout(pendingOutcome.current);
        pendingOutcome.current = null;
        setOrders((os) => os?.map((o) => (o.orderNumber === order.orderNumber ? { ...o, status: before } : o)) ?? os);
        setToast(null);
      },
    });
  };

  return (
    <div className="app" data-view={selectedId === null ? 'list' : 'chat'} data-orders={ordersOpen ? 'open' : 'closed'}>
      <Rail t={t} />
      <ConversationList t={t} lang={lang} now={now()} items={items} selectedId={selectedId} filter={filter} query={query} totalUnread={totalUnread} onFilter={setFilter} onQuery={setQuery} onOpen={open} onToggleLang={() => setLang((l) => (l === 'ar' ? 'en' : 'ar'))} />
      <div className="center">
        {!online && <p className="notice offline" role="status">{t.offline}</p>}
        {error && <p className="notice offline" role="alert">{t.loadError} <button type="button" className="btn ghost" onClick={() => void refresh()}>{t.retry}</button></p>}
        <ChatPane t={t} lang={lang} now={now()} conversation={selected} userNames={source.userNames} currentOrder={orders?.[0] ?? null} messages={messages} templates={templates} onSendText={sendText} onSendTemplate={sendTemplate} onRetry={retry} onBack={() => setSelectedId(null)} onShowOrders={() => setOrdersOpen(true)} />
      </div>
      <OrderPane key={selectedId ?? 'none'} t={t} lang={lang} orders={selected ? orders : null} hasChat={!!selected} onConfirm={(o) => recordOutcome(o, 'confirmed')} onRefuse={(o) => recordOutcome(o, 'refused')} onClose={() => setOrdersOpen(false)} />
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" className="btn ghost" onClick={toast.undo}>{t.undo}</button>}
        </div>
      )}
      <button type="button" className="sheet-backdrop" aria-label={t.close} tabIndex={-1} onClick={() => setOrdersOpen(false)} />
      {source.kind === 'sample' && <span className="sample-badge">{t.sample}</span>}
    </div>
  );
}
