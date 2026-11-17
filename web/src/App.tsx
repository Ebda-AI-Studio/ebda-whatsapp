import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationDto, MessageDto, OrderSummaryDto, SendMessageRequest, TemplateDto } from '../../src/core/api/contract';
import { ChatPane } from './components/ChatPane';
import { ConversationList } from './components/ConversationList';
import { OrderPane } from './components/OrderPane';
import { IntegrationsScreen } from './components/IntegrationsScreen';
import { Rail, type View } from './components/Rail';
import { BRAND } from '@brand';
import { AgentScreen } from './components/AgentScreen';
import { AssistantPanel } from './components/AssistantPanel';
import { BotScreen } from './components/BotScreen';
import { CampaignsScreen, dateTime } from './components/CampaignsScreen';
import { ContactsScreen } from './components/ContactsScreen';
import { NumbersScreen } from './components/NumbersScreen';
import { OperatorScreen } from './components/OperatorScreen';
import { TemplatesScreen } from './components/TemplatesScreen';
import { TeamScreen } from './components/TeamScreen';
import { WalletScreen } from './components/WalletScreen';
import type { WalletDto } from './data/billing';
import type { ConversationFilter, InboxSource } from './data/source';
import { STRINGS, type Lang } from './i18n';

import { formatMoney } from './lib/format';
import { useTypeahead } from './lib/useTypeahead';

type Props = { source: InboxSource; now?: () => number; initialLang?: Lang; /** The screen to open on (the address bar's screen once real routes land). */ initialView?: View };

export function App({ source, now = Date.now, initialLang = 'ar', initialView = 'inbox' }: Props) {
  const [lang, setLang] = useState<Lang>(initialLang);
  // Connectors reach the client's own systems with a secret: owner only. The server refuses staff (routes/connectors.ts, 403); this keeps the screen from rendering for them too, whatever address they typed.
  const canIntegrations = !!source.connectors && source.role === 'owner';
  // The assistant: offered only while the server says it is on for this store; a first turn that answers "off" withdraws it for the session.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantGone, setAssistantGone] = useState(false);
  const assistantOn = !!source.assistant && source.capabilities.assistant === true && !assistantGone;
  const toggleAssistant = useCallback(() => setAssistantOpen((o) => !o), []);
  const closeAssistant = useCallback(() => { setAssistantOpen(false); document.getElementById('assistant-launcher')?.focus(); }, []);
  useEffect(() => {
    if (!assistantOn) return;
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); setAssistantOpen((o) => !o); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assistantOn]);
  const [view, setView] = useState<View>(initialView);
  const t = STRINGS[lang];
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [reloadTick, setReloadTick] = useState(0);
  const [items, setItems] = useState<ConversationDto[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [orders, setOrders] = useState<OrderSummaryDto[] | null>(null);
  const [ordersFailed, setOrdersFailed] = useState(false);
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
    document.title = `${lang === 'ar' && BRAND.productNameAr ? BRAND.productNameAr : BRAND.productName} ·${lang === 'ar' ? 'المحادثات' : 'Inbox'}`;
  }, [lang]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // Search as you type (shared hook): from the first character, 150 ms after typing pauses, the previous request aborted, an older answer never shown.
  // The filter and a live-reload tick re-run the same query; with an empty box the plain list below is shown instead.
  const fetchSearch = useCallback((q: string, signal: AbortSignal) => source.listConversations(filter, q, signal), [source, filter]);
  const search = useTypeahead<ConversationDto>(fetchSearch, { deps: [source, filter, reloadTick] });
  const query = search.query;
  const searching = query.trim() !== '';
  const shown = searching ? search.results : items;

  // The plain list (empty search box). Latest request wins: a newer refresh aborts the one in flight, and an older answer is dropped.
  const latest = useRef<{ seq: number; ctrl: AbortController | null }>({ seq: 0, ctrl: null });
  const refresh = useCallback(async () => {
    if (searching) { setReloadTick((n) => n + 1); return; } // a live update while searching re-runs the search
    latest.current.ctrl?.abort();
    const ctrl = new AbortController();
    const seq = ++latest.current.seq;
    latest.current.ctrl = ctrl;
    try {
      const list = await source.listConversations(filter, '', ctrl.signal);
      if (seq !== latest.current.seq) return;
      setItems(list);
      // The unread total is only knowable from the unfiltered list; keep the last value under a filter.
      if (filter === 'all') setTotalUnread(list.reduce((n, c) => n + c.unread, 0));
      setError(false);
    } catch {
      if (seq === latest.current.seq) setError(true);
    }
  }, [source, filter, searching]);
  useEffect(() => { if (!searching) void refresh(); }, [refresh, searching]);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const loadTemplates = useCallback(() => { void source.templates().then((ts) => { setTemplates(ts); setTemplatesFailed(false); }, () => setTemplatesFailed(true)); }, [source]);
  useEffect(loadTemplates, [loadTemplates]);

  // The low-balance banner reads the wallet whenever the inbox is on screen (coming back from the wallet screen refreshes it).
  const [walletDto, setWalletDto] = useState<WalletDto | null>(null);
  useEffect(() => {
    if (view !== 'inbox' || !source.wallet) return;
    let live = true;
    void source.wallet.wallet().then((w) => { if (live) setWalletDto(w); }, () => undefined);
    return () => { live = false; };
  }, [source, view]);
  const walletNotice = useMemo(() => {
    if (!walletDto) return [];
    const lines: string[] = [];
    // A bought package does not renew itself: a week before it ends the owner is reminded (the Store-included one is renewed by the Store).
    const plan = walletDto.plan;
    if (plan && plan.packageId !== 'store-included' && (plan.status === 'active' || plan.status === 'trialing') && plan.periodEnd > now() && plan.periodEnd - now() <= 7 * 86_400_000) lines.push(t.wBannerRenew(dateTime(plan.periodEnd, lang)));
    if (walletDto.instapayNotice) lines.push(t.ipRejectedBanner(walletDto.instapayNotice.reason));
    if (walletDto.aiCredits.low) lines.push(t.wBannerCreditsLow); // the banner link opens the wallet, where the credits card sits
    if (walletDto.lowBalance || walletDto.debtMinor > 0) {
      const money: string[] = [];
      if (walletDto.debtMinor > 0) money.push(t.wBannerDebt(formatMoney(walletDto.debtMinor, 'EGP', lang)));
      // Marketing only stops on the wallet when the wallet is what pays for a number; with cards paying Meta the claim would be false.
      if (walletDto.availableMinor <= 0 && walletDto.funding.some((f) => f.funding === 'platform_line')) money.push(t.wMarketingPaused);
      if (money.length === 0) money.push(t.wBannerLow);
      lines.push(...money);
    }
    return lines;
  }, [walletDto, t, lang, now]);

  const selected = useMemo(() => shown.find((c) => c.id === selectedId) ?? items.find((c) => c.id === selectedId) ?? null, [shown, items, selectedId]);

  const open = useCallback(async (id: number) => {
    setSelectedId(id);
    setOrders(null);
    setOrdersFailed(false);
    setMessages([]);
    const conv = shown.find((c) => c.id === id) ?? items.find((c) => c.id === id);
    // Messages, read receipt and orders load in parallel: nothing waits on anything else.
    [...pending.current.keys()].forEach((k) => flushRef.current(k)); // a decision on the previous chat is sent, never lost
    // Messages, read receipt and orders load in parallel and independently: one failing never blanks the others.
    void source.markRead(id).catch(() => undefined);
    if (conv) void source.orders(conv.contact.waId).then((o) => setOrders(o.items), () => setOrdersFailed(true));
    try {
      setMessages([...(await source.getMessages(id))]);
    } catch {
      setError(true);
    }
    void refresh();
  }, [source, refresh, shown, items]);

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
    <div className="app" data-viewas={source.viewAs ? 'on' : undefined} data-view={view !== 'inbox' ? 'screen' : selectedId === null ? 'list' : 'chat'} data-orders={ordersOpen ? 'open' : 'closed'}>
      {source.viewAs && <p className="view-as-banner" role="status" aria-label={t.viewAsBanner}>{t.viewAsBanner}</p>}
      <Rail t={t} view={view} onNavigate={setView} onSignOut={source.signOut ? () => source.signOut!() : undefined} show={{ templates: !!source.templatesApi, campaigns: !!source.campaigns, contacts: !!source.contacts, integrations: canIntegrations, agent: !!source.agentSettings, bot: !!source.botSettings, numbers: !!source.numbers && source.capabilities.numbers === true, wallet: !!source.wallet, team: !!source.team && source.role === 'owner', operator: source.role === 'super_admin' && !!source.operator }} assistant={assistantOn ? { open: assistantOpen, onToggle: toggleAssistant } : undefined} />
      {view === 'agent' ? <AgentScreen t={t} lang={lang} source={source} />
        : view === 'integrations' && source.connectors ? (canIntegrations ? <IntegrationsScreen t={t} lang={lang} source={source} /> : <p className="view-denied" role="alert">{t.notAllowed}</p>)
        : view === 'bot' && source.botSettings ? <BotScreen t={t} lang={lang} source={source} />
        : view === 'templates' && source.templatesApi ? <TemplatesScreen t={t} lang={lang} source={source} api={source.templatesApi} onNavigate={setView} />
        : view === 'campaigns' && source.campaigns ? <CampaignsScreen t={t} lang={lang} source={source} api={source.campaigns} now={now} onNavigate={setView} />
        : view === 'wallet' && source.wallet ? <WalletScreen t={t} lang={lang} source={source} api={source.wallet} now={now} />
        : view === 'operator' && source.operator && source.role === 'super_admin' ? <OperatorScreen t={t} lang={lang} source={source} api={source.operator} now={now} />
        : view === 'team' && source.team ? <TeamScreen t={t} lang={lang} source={source} api={source.team} />
        : view === 'numbers' && source.numbers ? <NumbersScreen t={t} lang={lang} source={source} api={source.numbers} />
        : view === 'contacts' && source.contacts ? <ContactsScreen t={t} lang={lang} source={source} api={source.contacts} now={now} /> : (
        <>
      <ConversationList t={t} lang={lang} now={now()} items={shown} selectedId={selectedId} filter={filter} query={query} totalUnread={totalUnread} searchStatus={searching ? search.status : 'idle'} onFilter={setFilter} onQuery={search.setQuery} onOpen={open} onToggleLang={() => setLang((l) => (l === 'ar' ? 'en' : 'ar'))} notice={walletNotice} onOpenWallet={() => setView('wallet')} />
      <div className="center">
        {!online && <p className="notice offline" role="status">{t.offline}</p>}
        {error && <p className="notice offline" role="alert">{t.loadError} <button type="button" className="btn ghost" onClick={() => void refresh()}>{t.retry}</button></p>}
        {templatesFailed && <p className="notice offline" role="alert">{t.dataLoadError} <button type="button" className="btn ghost" onClick={loadTemplates}>{t.retry}</button></p>}
        <ChatPane t={t} lang={lang} now={now()} conversation={selected} source={source} userNames={source.userNames} currentOrder={orders?.[0] ?? null} messages={messages} templates={templates} onSendText={sendText} onSendTemplate={sendTemplate} onSendMedia={sendMedia} onRetry={retry} onBack={() => setSelectedId(null)} onShowOrders={() => setOrdersOpen(true)} onTakeOver={source.assign ? () => void takeOver() : undefined} />
      </div>
      <OrderPane key={selectedId ?? 'none'} t={t} lang={lang} orders={selected ? orders : null} failed={ordersFailed} onRetry={() => { const conv = shown.find((c) => c.id === selectedId) ?? items.find((c) => c.id === selectedId); if (!conv) return; setOrdersFailed(false); void source.orders(conv.contact.waId).then((o) => setOrders(o.items), () => setOrdersFailed(true)); }} hasChat={!!selected} canDecide={source.capabilities.codOutcome} onConfirm={(o) => recordOutcome(o, 'confirmed')} onRefuse={(o) => recordOutcome(o, 'refused')} onClose={() => setOrdersOpen(false)} />
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
      {assistantOn && assistantOpen && source.assistant && (
        <AssistantPanel t={t} lang={lang} storeId={source.storeId ?? 'store'} userId={source.currentUserId} api={source.assistant} onClose={closeAssistant} onUnavailable={() => { setAssistantGone(true); setAssistantOpen(false); }}
          onNavigate={(v) => { setView(v); if (window.matchMedia?.('(max-width: 819px)').matches) closeAssistant(); }} />
      )}
      {source.kind === 'sample' && <span className="sample-badge">{t.sample}</span>}
    </div>
  );
}
