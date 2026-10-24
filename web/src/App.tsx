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
  const [toast, setToast] = useState<{ kind: 'confirmed' | 'refused'; orderNumber: string } | { kind: 'error' } | null>(null);
  type Pending = { waId: string; orderNumber: string; outcome: 'confirmed' | 'refused'; before: OrderSummaryDto['status']; timer: ReturnType<typeof setTimeout> };
  const pending = useRef(new Map<string, Pending>());

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
      // Reconcile with an optimistic bubble by clientId first, then dedupe by id.
      if (e.conversationId === selectedId) setMessages((ms) => {
        if (e.message.clientId && ms.some((m) => m.clientId === e.message.clientId)) return ms.map((m) => (m.clientId === e.message.clientId ? e.message : m));
        // Same id again (e.g. media finished downloading): update the bubble in place.
        return ms.some((m) => m.id === e.message.id) ? ms.map((m) => (m.id === e.message.id ? e.message : m)) : [...ms, e.message];
      });
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
  const sendTemplate = (tpl: TemplateDto, params: string[]) =>
    sendOptimistic({ type: 'template', clientId: crypto.randomUUID(), name: tpl.name, language: tpl.language, params }, tpl.bodyText.replace(/\{\{(\d+)\}\}/g, (_m, i) => params[Number(i) - 1] ?? ''));
  const retry = async (m: MessageDto) => {
    setMessages((ms) => ms.filter((x) => x.id !== m.id));
    if (m.text) await sendText(m.text);
  };

  // COD outcome: the rail moves at once; the store is told after a 5-second undo window. A pending decision is never
  // dropped: a newer decision flushes it immediately, and so does leaving or hiding the page.
  const setStatus = (orderNumber: string, status: OrderSummaryDto['status']) =>
    setOrders((os) => os?.map((o) => (o.orderNumber === orderNumber ? { ...o, status } : o)) ?? os);
  const flush = useCallback((orderNumber: string) => {
    const p = pending.current.get(orderNumber);
    if (!p) return;
    clearTimeout(p.timer);
    pending.current.delete(orderNumber);
    setToast((tt) => (tt && tt.kind !== 'error' && tt.orderNumber === orderNumber ? null : tt));
    void source.recordCodOutcome(p.waId, p.orderNumber, p.outcome).catch(() => {
      setStatus(p.orderNumber, p.before);
      setToast({ kind: 'error' });
    });
  }, [source]);
  useEffect(() => {
    const flushAll = () => [...pending.current.keys()].forEach(flush);
    const onHide = () => { if (document.visibilityState === 'hidden') flushAll(); };
    window.addEventListener('pagehide', flushAll);
    document.addEventListener('visibilitychange', onHide);
    return () => { window.removeEventListener('pagehide', flushAll); document.removeEventListener('visibilitychange', onHide); };
  }, [flush]);
  const recordOutcome = (order: OrderSummaryDto, outcome: 'confirmed' | 'refused') => {
    const waId = selected?.contact.waId;
    if (!waId) return;
    [...pending.current.keys()].forEach(flush);
    setStatus(order.orderNumber, outcome);
    const timer = setTimeout(() => flush(order.orderNumber), 5000);
    pending.current.set(order.orderNumber, { waId, orderNumber: order.orderNumber, outcome, before: order.status, timer });
    setToast({ kind: outcome, orderNumber: order.orderNumber });
  };
  const undo = (orderNumber: string) => {
    const p = pending.current.get(orderNumber);
    if (!p) return;
    clearTimeout(p.timer);
    pending.current.delete(orderNumber);
    setStatus(orderNumber, p.before);
    setToast(null);
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
          {toast.kind === 'error' ? <span>{t.loadError}</span> : (
            <>
              <span>{(toast.kind === 'confirmed' ? t.confirmedToast : t.refusedToast)('\u2068' + toast.orderNumber + '\u2069')}</span>
              <button type="button" className="btn ghost" onClick={() => undo(toast.orderNumber)}>{t.undo}</button>
            </>
          )}
        </div>
      )}
      <button type="button" className="sheet-backdrop" aria-label={t.close} tabIndex={-1} onClick={() => setOrdersOpen(false)} />
      {source.kind === 'sample' && <span className="sample-badge">{t.sample}</span>}
    </div>
  );
}
