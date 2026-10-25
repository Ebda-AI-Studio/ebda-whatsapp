import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationDto, MessageDto, OrderSummaryDto, SendMessageRequest, TemplateDto } from '../../src/core/api/contract';
import { ChatPane } from './components/ChatPane';
import { ConversationList } from './components/ConversationList';
import { OrderPane } from './components/OrderPane';
import { Rail, type View } from './components/Rail';
import { AgentScreen } from './components/AgentScreen';
import { CampaignsScreen } from './components/CampaignsScreen';
import { ContactsScreen } from './components/ContactsScreen';
import { NumbersScreen } from './components/NumbersScreen';
import type { ConversationFilter, InboxSource } from './data/source';
import { STRINGS, type Lang } from './i18n';

type Props = { source: InboxSource; now?: () => number; initialLang?: Lang };

export function App({ source, now = Date.now, initialLang = 'ar' }: Props) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [view, setView] = useState<View>('inbox');
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
  const flushRef = useRef<(k: string) => void>(() => undefined);
  const sentRequests = useRef(new Map<string, { conversationId: number; req: SendMessageRequest; text: string }>());

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
    [...pending.current.keys()].forEach((k) => flushRef.current(k)); // a decision on the previous chat is sent, never lost
    // Messages, read receipt and orders load in parallel and independently: one failing never blanks the others.
    void source.markRead(id).catch(() => undefined);
    if (conv) void source.orders(conv.contact.waId).then((o) => setOrders(o.items), () => setOrders([]));
    try {
      setMessages([...(await source.getMessages(id))]);
    } catch {
      setError(true);
    }
    void refresh();
  }, [source, refresh, items]);

  useEffect(() => source.onReload?.(() => {
    void refresh();
    if (selectedId !== null) void source.getMessages(selectedId).then((ms) => setMessages([...ms]), () => undefined);
  }), [source, refresh, selectedId]);

  useEffect(() => source.subscribe((e) => {
    if (e.type === 'message.status' && e.conversationId === selectedId) {
      setMessages((ms) => ms.map((m) => (m.id === e.messageId ? { ...m, status: e.status, errorCode: e.errorCode } : m)));
    } else if (e.type === 'message.created') {
      // Reconcile with an optimistic bubble by clientId first, then dedupe by id.
      if (e.conversationId === selectedId) setMessages((ms) => {
        if (e.message.clientId && ms.some((m) => m.clientId === e.message.clientId)) return ms.map((m) => (m.clientId === e.message.clientId ? newer(m, e.message) : m));
        // Same id again (e.g. media finished downloading): update the bubble in place.
        return ms.some((m) => m.id === e.message.id) ? ms.map((m) => (m.id === e.message.id ? e.message : m)) : [...ms, e.message];
      });
      void refresh();
    } else if (e.type === 'conversation.updated') {
      void refresh();
    }
  }), [source, selectedId, refresh]);

  const RANK: Record<string, number> = { failed: -1, queued: 0, claimed: 0, retry: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
  const newer = (a: MessageDto, b: MessageDto): MessageDto => ((RANK[b.status ?? 'queued'] ?? 0) >= (RANK[a.status ?? 'queued'] ?? 0) ? b : { ...b, status: a.status });

  // Optimistic send: the bubble appears at once as "queued", then reconciles by clientId (or turns failed with Retry).
  const sendOptimistic = async (req: SendMessageRequest, text: string) => {
    if (selectedId === null) return;
    const id = selectedId;
    const temp: MessageDto = { id: -Date.now(), clientId: req.clientId, wamid: null, direction: 'out', type: req.type === 'template' ? 'template' : 'text', text, hasLongBody: false, media: null, template: null, status: 'queued', errorCode: null, at: now() };
    setMessages((ms) => [...ms.filter((x) => x.clientId !== req.clientId), temp]);
    sentRequests.current.set(req.clientId, { conversationId: id, req, text });
    try {
      const m = await source.send(id, req);
      sentRequests.current.delete(req.clientId);
      setMessages((ms) => ms.map((x) => (x.clientId === req.clientId ? newer(x, m) : x)));
      void refresh();
    } catch {
      setMessages((ms) => ms.map((x) => (x.clientId === req.clientId ? { ...x, status: 'failed' } : x)));
    }
  };
  const sendText = (text: string) => sendOptimistic({ type: 'text', clientId: crypto.randomUUID(), text }, text);
  const sendTemplate = (tpl: TemplateDto, params: string[]) =>
    sendOptimistic({ type: 'template', clientId: crypto.randomUUID(), name: tpl.name, language: tpl.language, params }, tpl.bodyText.replace(/\{\{(\d+)\}\}/g, (_m, i) => params[Number(i) - 1] ?? ''));
  const takeOver = async () => {
    if (selectedId === null || !source.assign) return;
    await source.assign(selectedId, source.currentUserId || null);
    void refresh();
  };
  const sendMedia = async (file: File) => {
    if (!source.upload) return;
    try {
      const uploadId = await source.upload(file);
      await sendOptimistic({ type: 'media', clientId: crypto.randomUUID(), uploadId }, file.name);
    } catch {
      setError(true);
    }
  };
  // Retry resends the ORIGINAL request with the same clientId: the server dedupes if the first one actually landed.
  const retry = async (m: MessageDto) => {
    const original = m.clientId ? sentRequests.current.get(m.clientId) : undefined;
    if (original && original.conversationId === selectedId) await sendOptimistic(original.req, original.text);
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
  flushRef.current = flush;
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
    <div className="app" data-view={view !== 'inbox' ? 'screen' : selectedId === null ? 'list' : 'chat'} data-orders={ordersOpen ? 'open' : 'closed'}>
      <Rail t={t} view={view} onNavigate={setView} show={{ campaigns: !!source.campaigns, contacts: !!source.contacts, agent: !!source.agentSettings, numbers: !!source.numbers && source.capabilities.numbers === true }} />
      {view === 'agent' ? <AgentScreen t={t} lang={lang} source={source} />
        : view === 'campaigns' && source.campaigns ? <CampaignsScreen t={t} lang={lang} source={source} api={source.campaigns} now={now} />
        : view === 'numbers' && source.numbers ? <NumbersScreen t={t} lang={lang} source={source} api={source.numbers} />
        : view === 'contacts' && source.contacts ? <ContactsScreen t={t} lang={lang} source={source} api={source.contacts} now={now} /> : (
        <>
      <ConversationList t={t} lang={lang} now={now()} items={items} selectedId={selectedId} filter={filter} query={query} totalUnread={totalUnread} onFilter={setFilter} onQuery={setQuery} onOpen={open} onToggleLang={() => setLang((l) => (l === 'ar' ? 'en' : 'ar'))} />
      <div className="center">
        {!online && <p className="notice offline" role="status">{t.offline}</p>}
        {error && <p className="notice offline" role="alert">{t.loadError} <button type="button" className="btn ghost" onClick={() => void refresh()}>{t.retry}</button></p>}
        <ChatPane t={t} lang={lang} now={now()} conversation={selected} source={source} userNames={source.userNames} currentOrder={orders?.[0] ?? null} messages={messages} templates={templates} onSendText={sendText} onSendTemplate={sendTemplate} onSendMedia={sendMedia} onRetry={retry} onBack={() => setSelectedId(null)} onShowOrders={() => setOrdersOpen(true)} onTakeOver={source.assign ? () => void takeOver() : undefined} />
      </div>
      <OrderPane key={selectedId ?? 'none'} t={t} lang={lang} orders={selected ? orders : null} hasChat={!!selected} canDecide={source.capabilities.codOutcome} onConfirm={(o) => recordOutcome(o, 'confirmed')} onRefuse={(o) => recordOutcome(o, 'refused')} onClose={() => setOrdersOpen(false)} />
        </>
      )}
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
