import { ApiError } from './api';
import type {
  AgentSettingsDto, BotFunnelDto, ConnectorDto, BotSettingsDto, BotSwitchesDto, CatalogStatusDto, CampaignDto, NumberDto, ContactDto, ConversationDto, ImportDto, MessageDto, OrderSummaryDto, RealtimeEvent, SegmentCriteria, SegmentDto, TemplateDto, NoteDto, QuickReplyDto,
} from '../../../src/core/api/contract';
import { normaliseText } from '../../../src/core/text-normalise';
import { createSampleOperator, createSampleWallet } from './sample-billing';
import type { SharedTemplatesApi } from './shared-templates';
import type { InboxSource, TeamApi } from './source';
import type { AssistantApi } from './assistant';

// Sample data for preview only (labelled in the UI). Names and orders are invented; no real customers.
const BASE = Date.UTC(2026, 9, 24, 17, 0);
const MIN = 60_000;
const H = 60 * MIN;

type Seed = { id: number; name: string; waId: string; preview: string; ago: number; unread: number; assignee: string | null; windowH: number | null; tags: string[] };
const SEEDS: Seed[] = [
  { id: 1, name: 'منى عبد الرحمن', waId: '201001112233', preview: 'عايزة أأكد الأوردر بتاع امبارح', ago: 2 * MIN, unread: 2, assignee: 'u-dina', windowH: 22, tags: ['cod_pending'] },
  { id: 2, name: 'كريم سمير', waId: '201002223344', preview: 'الشحنة اتأخرت يومين', ago: 12 * MIN, unread: 1, assignee: null, windowH: 23, tags: ['needs_human'] },
  { id: 3, name: 'هالة فؤاد', waId: '201003334455', preview: 'تمام شكرًا ليكي', ago: 35 * MIN, unread: 0, assignee: 'u-me', windowH: 23, tags: [] },
  { id: 4, name: 'أحمد ناصر', waId: '201004445566', preview: 'ممكن أغيّر المقاس؟', ago: 1 * H, unread: 1, assignee: 'u-me', windowH: 0.5, tags: ['استبدال'] },
  { id: 5, name: 'سارة محمود', waId: '201005556677', preview: 'الدفع عند الاستلام متاح؟', ago: 2 * H, unread: 0, assignee: null, windowH: 21, tags: [] },
  { id: 6, name: 'يوسف علي', waId: '201006667788', preview: 'تم الاستلام، شكرًا', ago: 30 * H, unread: 0, assignee: 'u-dina', windowH: null, tags: [] },
];

function msg(id: number, direction: 'in' | 'out', text: string, at: number, status: MessageDto['status'] = null): MessageDto {
  return { id, clientId: null, wamid: `sample.${id}`, direction, type: 'text', text, hasLongBody: false, media: null, template: null, status, errorCode: null, at };
}

const THREADS: Record<number, MessageDto[]> = {
  1: [
    msg(11, 'in', 'مساء الخير، أنا طلبت امبارح تيشيرتين مقاس L', BASE - 6 * MIN),
    msg(12, 'out', 'أهلًا يا منى! الطلب #1048 جاهز، نأكده على العنوان في مدينة نصر؟', BASE - 4 * MIN, 'read'),
    msg(13, 'in', 'عايزة أأكد الأوردر بتاع امبارح', BASE - 2 * MIN),
  ],
  2: [msg(21, 'in', 'الشحنة اتأخرت يومين، هي فين؟', BASE - 12 * MIN)],
  3: [msg(31, 'out', 'وصلك الطلب يا هالة؟', BASE - 40 * MIN, 'read'), msg(32, 'in', 'تمام شكرًا ليكي', BASE - 35 * MIN)],
  4: [msg(41, 'in', 'ممكن أغيّر المقاس؟ طلبت M ومحتاج L', BASE - 1 * H)],
  5: [msg(51, 'in', 'الدفع عند الاستلام متاح؟', BASE - 2 * H), { ...msg(52, 'out', 'أيوه متاح في القاهرة والجيزة.', BASE - 2 * H + 5 * MIN, 'delivered'), author: 'agent' }],
  6: [msg(61, 'out', 'طلبك #0996 اتسلّم. شكرًا إنك اشتريت مننا!', BASE - 31 * H, 'read'), msg(62, 'in', 'تم الاستلام، شكرًا', BASE - 30 * H)],
};

const ORDERS: Record<string, OrderSummaryDto[]> = {
  '201001112233': [
    { orderNumber: '#1048', status: 'pending_confirmation', totalMinor: 68000, currency: 'EGP', paymentMethod: 'cod', itemsCount: 2, at: BASE - 20 * H },
    { orderNumber: '#0996', status: 'delivered', totalMinor: 42000, currency: 'EGP', paymentMethod: 'cod', itemsCount: 1, at: BASE - 20 * 24 * H },
    { orderNumber: '#0871', status: 'delivered', totalMinor: 95000, currency: 'EGP', paymentMethod: 'link', itemsCount: 3, at: BASE - 60 * 24 * H },
  ],
  '201002223344': [{ orderNumber: '#1031', status: 'shipped', totalMinor: 125000, currency: 'EGP', paymentMethod: 'cod', itemsCount: 2, at: BASE - 3 * 24 * H }],
  '201004445566': [{ orderNumber: '#1040', status: 'confirmed', totalMinor: 54000, currency: 'EGP', paymentMethod: 'card', itemsCount: 1, at: BASE - 26 * H }],
  '201006667788': [{ orderNumber: '#0996', status: 'delivered', totalMinor: 42000, currency: 'EGP', paymentMethod: 'cod', itemsCount: 1, at: BASE - 2 * 24 * H }],
};

const TEMPLATES: TemplateDto[] = [
  { name: 'cod_confirmation', language: 'ar', category: 'UTILITY', status: 'APPROVED', bodyText: 'أهلًا {{1}}، عندك طلب رقم {{2}} بإجمالي {{3}}. تحب نأكده؟', paramCount: 3, rejectedReason: null },
  { name: 'shipping_update', language: 'ar', category: 'UTILITY', status: 'APPROVED', bodyText: 'طلبك {{1}} اتشحن، وتقدر تتابعه من هنا: {{2}}', paramCount: 2, rejectedReason: null },
  { name: 'order_confirmation', language: 'ar', category: 'UTILITY', status: 'APPROVED', bodyText: 'شكرًا يا {{1}}، طلبك {{2}} اتأكد وهيوصلك خلال {{3}} أيام.', paramCount: 3, rejectedReason: null },
  { name: 'eid_offer', language: 'ar', category: 'MARKETING', status: 'APPROVED', bodyText: 'كل سنة وانت طيب يا {{1}}! خصم 20٪ على كل حاجة لحد آخر الأسبوع: {{2}}', paramCount: 2, rejectedReason: null },
  { name: 'back_in_stock', language: 'ar', category: 'MARKETING', status: 'APPROVED', bodyText: 'المنتج اللي كنت مستنيه رجع تاني يا {{1}}.', paramCount: 1, rejectedReason: null },
];

// Extra sample contacts for the contacts screen and audience counts (invented).
const MORE_CONTACTS: ContactDto[] = [
  { waId: '201007778899', name: 'نورا حسن', optedOut: false, tags: ['vip'], consent: { source: 'import:customers.csv', at: BASE - 40 * 24 * H }, lastInboundAt: BASE - 3 * 24 * H },
  { waId: '201008889900', name: 'مصطفى عادل', optedOut: true, tags: [], consent: { source: 'import:customers.csv', at: BASE - 40 * 24 * H }, lastInboundAt: BASE - 50 * 24 * H },
  { waId: '201009990011', name: null, optedOut: false, tags: ['vip'], consent: null, lastInboundAt: null },
];

const D = 24 * H;
const counts0 = { queued: 0, claimed: 0, retry: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
function sampleCampaign(p: Partial<CampaignDto> & Pick<CampaignDto, 'id' | 'name' | 'status'>, t: CampaignDto['totals']): CampaignDto {
  return {
    pauseReason: null, template: { name: 'eid_offer', language: 'ar' }, category: 'MARKETING', params: [{ kind: 'name', fallback: 'يا فندم' }, { kind: 'link' }],
    audience: { segmentId: 1, criteria: { tags: { any: ['vip'] } } }, scheduledAt: null, dailySendLimit: null, linkUrl: 'https://example.com/eid',
    clicks: { unique: Math.round(t.read * 0.31), total: Math.round(t.read * 0.42) }, createdAt: BASE - 3 * D, startedAt: BASE - 2 * D, finishedAt: null,
    counts: { ...counts0, delivered: t.delivered - t.read, read: t.read, failed: t.failed, skipped: t.skipped, queued: t.pending },
    totals: t, ...p,
  };
}
const CAMPAIGNS: CampaignDto[] = [
  sampleCampaign({ id: 'c-1', name: 'عروض العيد', status: 'running' }, { recipients: 1240, pending: 380, sent: 860, delivered: 812, read: 534, failed: 31, skipped: 17 }),
  sampleCampaign({ id: 'c-2', name: 'رجوع المقاسات', status: 'scheduled', template: { name: 'back_in_stock', language: 'ar' }, params: [{ kind: 'name', fallback: 'يا فندم' }], linkUrl: null, scheduledAt: BASE + 18 * H, startedAt: null }, { recipients: 320, pending: 320, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 }),
  sampleCampaign({ id: 'c-3', name: 'تخفيضات نص الشهر', status: 'paused', pauseReason: 'wallet_empty' }, { recipients: 2100, pending: 1500, sent: 600, delivered: 571, read: 290, failed: 12, skipped: 8 }),
  sampleCampaign({ id: 'c-4', name: 'العملاء الجداد', status: 'completed', finishedAt: BASE - 9 * D, createdAt: BASE - 12 * D, startedAt: BASE - 11 * D }, { recipients: 410, pending: 0, sent: 402, delivered: 396, read: 301, failed: 6, skipped: 8 }),
];
const SEGMENT_SEED: SegmentDto[] = [
  { id: 1, name: 'عملاء VIP', criteria: { tags: { any: ['vip'] } }, createdAt: BASE - 30 * D, updatedAt: BASE - 30 * D },
  { id: 2, name: 'كلمونا آخر 30 يوم', criteria: { lastInboundAfter: BASE - 30 * D }, createdAt: BASE - 20 * D, updatedAt: BASE - 20 * D },
];
const sampleNumber = (p: Partial<NumberDto> & Pick<NumberDto, 'phoneNumberId' | 'displayPhone'>): NumberDto => ({
  wabaId: 'waba-sample-1', verifiedName: 'متجر منى', kind: 'own', onboarding: 'cloud_api', status: 'active', registration: 'registered', qualityRating: 'GREEN',
  messagingLimitTier: 'TIER_1K', throughputLevel: 'STANDARD', nameStatus: 'APPROVED', platformType: 'CLOUD_API', isOnBizApp: false, historySync: null, contactsSync: null,
  connectedAt: BASE - 9 * D, syncDeadlineAt: null, lastStatusSyncAt: BASE - H, ...p,
});
const NUMBERS: NumberDto[] = [
  sampleNumber({ phoneNumberId: 'pn-sample-1', displayPhone: '+20 100 555 0101', onboarding: 'business_app', registration: 'not_needed', isOnBizApp: true, historySync: 'received', contactsSync: 'received', throughputLevel: null }),
  sampleNumber({ phoneNumberId: 'pn-sample-2', displayPhone: '+20 100 555 0202', verifiedName: 'متجر منى - فرع 2', status: 'disconnected', registration: 'failed', qualityRating: null, messagingLimitTier: null, connectedAt: BASE - 2 * H }),
];

// Illustrative per-message cost for the sample estimate (piasters); the live figure comes from the wallet.
const SAMPLE_PER_MESSAGE_MINOR = 250;

function matches(c: ContactDto, k: SegmentCriteria): boolean {
  const tags = c.tags ?? [];
  if (k.tags?.any?.length && !k.tags.any.some((t) => tags.includes(t))) return false;
  if (k.tags?.all?.length && !k.tags.all.every((t) => tags.includes(t))) return false;
  if (k.lastInboundAfter !== undefined && !(c.lastInboundAt != null && c.lastInboundAt > k.lastInboundAfter)) return false;
  if (k.lastInboundBefore !== undefined && !(c.lastInboundAt != null && c.lastInboundAt < k.lastInboundBefore)) return false;
  return true;
}

export function createSampleSource(): InboxSource {
  const threads = structuredClone(THREADS);
  const orders = structuredClone(ORDERS);
  const convs: ConversationDto[] = SEEDS.map((s) => ({
    id: s.id,
    contact: { waId: s.waId, name: s.name, optedOut: false },
    lastMessage: { preview: s.preview, direction: 'in', type: 'text', status: null, at: BASE - s.ago },
    unread: s.unread,
    assigneeUserId: s.assignee,
    tags: s.tags,
    windowOpenUntil: s.windowH === null ? null : BASE + s.windowH * H,
  }));
  let agent: AgentSettingsDto = { enabled: false, persona: '', language: 'ar', handoffMinutes: 120, faqText: '', tone: 'warm', notifyPhone: null, provider: 'workers-ai', model: null, baseUrl: null, allowRefund: false, allowDiscount: false, allowFreeDelivery: false, allowExchange: false, allowGuarantee: false, hasApiKey: false, credits: 500, knowledgeReady: false };
  let switches: BotSwitchesDto = { orderingBot: true, orderConfirmations: false, otpViaWhatsApp: false };
  const pendingConfirms = new Set<string>();
  let bot: BotSettingsDto = {
    menu: { enabled: false, items: [] },
    hours: { enabled: false, timezone: 'Africa/Cairo', week: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, awayMessage: { ar: 'احنا مقفولين دلوقتي، هنرد عليك أول ما نفتح.', en: 'We are closed right now; we will reply as soon as we open.' }, ordersWhileClosed: true },
    location: null,
  };
  let catalog: CatalogStatusDto = { catalogId: null, lastSyncAt: null };
  const connectorList: ConnectorDto[] = [];
  let retentionDays: number | null = null;
  const contacts: ContactDto[] = [
    ...SEEDS.map((x): ContactDto => ({ waId: x.waId, name: x.name, optedOut: false, tags: x.tags.filter((t) => t !== 'needs_human' && t !== 'cod_pending'), consent: x.id % 2 ? { source: 'keyword_start', at: BASE - 10 * D } : null, lastInboundAt: BASE - x.ago })),
    ...structuredClone(MORE_CONTACTS),
  ];
  const segments = structuredClone(SEGMENT_SEED);
  const quick: QuickReplyDto[] = [];
  const notes = new Map<number, NoteDto[]>();
  let toolId = 100;
  const campaigns = structuredClone(CAMPAIGNS);
  const numbers = structuredClone(NUMBERS);
  const num = (id: string) => {
    const n = numbers.find((x) => x.phoneNumberId === id);
    if (!n) throw new Error('not_found');
    return n;
  };
  const imports: ImportDto[] = [{ id: 'i-1', filename: 'customers.csv', status: 'done', consented: true, total: 214, created: 198, updated: 9, rejected: 7, error: null, createdAt: BASE - 40 * D, finishedAt: BASE - 40 * D + 40_000 }];
  const preview = (k: SegmentCriteria) => {
    const hit = k.everyone ? contacts : contacts.filter((c) => matches(c, k));
    const optedOut = hit.filter((c) => c.optedOut).length;
    const noConsent = hit.filter((c) => !c.optedOut && !c.consent).length;
    // Sample counts are scaled up so the screens show realistic numbers; the live API counts real contacts.
    return { count: (hit.length - optedOut - noConsent) * 100, excluded: { optedOut: optedOut * 100, noConsent: noConsent * 100 } };
  };
  const find = (id: string) => {
    const c = campaigns.find((x) => x.id === id);
    if (!c) throw new Error('not_found');
    return c;
  };
  const listeners = new Set<(e: RealtimeEvent) => void>();
  let seq = 0;
  let nextId = 1000;
  return {
    kind: 'sample',
    capabilities: { codOutcome: true, numbers: true, assistant: true },
    role: 'owner',
    currentUserId: 'u-me',
    userNames: { 'u-me': 'أنا', 'u-dina': 'دينا' },
    async listConversations(filter, q, _signal) {
      const query = q.trim();
      return convs
        .filter((c) => (filter === 'unread' ? c.unread > 0 : filter === 'mine' ? c.assigneeUserId === 'u-me' : filter === 'unassigned' ? c.assigneeUserId === null : true))
        .filter((c) => !query || (c.contact.name ?? '').includes(query) || (c.lastMessage?.preview ?? '').includes(query))
        .sort((a, b) => (b.lastMessage?.at ?? 0) - (a.lastMessage?.at ?? 0));
    },
    async getMessages(id) {
      return threads[id] ?? [];
    },
    async send(id, req) {
      const tpl = req.type === 'template' ? TEMPLATES.find((x) => x.name === req.name) : undefined;
      const text = req.type === 'text' ? req.text
        : req.type === 'template' ? (tpl?.bodyText ?? req.name).replace(/\{\{(\d+)\}\}/g, (_m, i) => req.params[Number(i) - 1] ?? '')
        : req.type === 'interactive' ? req.body : (req.caption ?? '');
      const m: MessageDto = { ...msg(nextId++, 'out', text, Date.now(), 'queued'), clientId: req.clientId, type: req.type === 'template' ? 'template' : 'text' };
      (threads[id] ??= []).push(m);
      const c = convs.find((x) => x.id === id);
      if (c) c.lastMessage = { preview: text, direction: 'out', type: m.type, status: 'queued', at: m.at };
      setTimeout(() => listeners.forEach((l) => l({ type: 'message.status', seq: ++seq, conversationId: id, messageId: m.id, status: 'sent', errorCode: null })), 600);
      return m;
    },
    async markRead(id) {
      const c = convs.find((x) => x.id === id);
      if (c) c.unread = 0;
    },
    async orders(waId) {
      return { items: (orders[waId] ?? []).map((o) => ({ ...o })), source: 'sample' };
    },
    async templates() {
      return TEMPLATES;
    },
    async recordCodOutcome(waId, orderNumber, outcome) {
      const o = orders[waId]?.find((x) => x.orderNumber === orderNumber);
      if (o && o.status === 'pending_confirmation') o.status = outcome;
    },
    async agentSettings() {
      return { ...agent };
    },
    async saveAgentSettings(update) {
      const { apiKey, ...rest } = update;
      agent = { ...agent, ...rest, hasApiKey: apiKey === undefined ? agent.hasApiKey : apiKey !== null };
      return { ...agent };
    },
    async botSettings() {
      return structuredClone(bot);
    },
    async saveBotSettings(update) {
      bot = structuredClone(update);
      return structuredClone(bot);
    },
    switches: {
      async get() { return { ...switches }; },
      async preview() { const confirmToken = crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'); pendingConfirms.add(confirmToken); return { confirmToken }; },
      async save(change, confirmToken) {
        if ((change.orderConfirmations === true || change.otpViaWhatsApp === true) && !(confirmToken && pendingConfirms.delete(confirmToken))) throw Object.assign(new Error('confirm_required'), { detail: confirmToken ? 'confirm_invalid' : 'confirm_required' });
        switches = { ...switches, ...change };
        return { ...switches };
      },
      async throttle() { return { tier: 1000, mps: 80, usedInWindow: 120, waiting: 0, nextSlotAt: null }; },
    },
    async botFunnel(days) {
      const totals = { 7: [120, 96, 54, 31, 22, 40, 9], 30: [520, 410, 236, 140, 101, 170, 38], 90: [1480, 1150, 650, 390, 281, 470, 104] }[days];
      const steps = ['conversation', 'browse', 'cart', 'checkout', 'order', 'menu', 'handoff'] as const;
      const list = Array.from({ length: days }, (_, i) => new Date(Date.UTC(2026, 9, 24) - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
      return { from: list[0]!, to: list[days - 1]!, days: list, steps: steps.map((step, k) => ({ step, total: totals[k]!, series: list.map((_, i) => (i === days - 1 ? totals[k]! : 0)) })) } satisfies BotFunnelDto;
    },
    catalog: {
      async status() {
        return { ...catalog };
      },
      async provision() {
        catalog = { catalogId: '1234567890123', lastSyncAt: null, items: { synced: 0, excluded: 0, rejected: 0 }, leftOut: [], commerce: { catalogVisible: true, cartEnabled: true, failed: null }, error: null, syncing: true, pending: 0 };
        return { catalogId: '1234567890123' };
      },
      async resync() {
        if (!catalog.catalogId) throw Object.assign(new Error('catalog_not_set'), { detail: 'catalog_not_set' });
        catalog = { ...catalog, syncing: true };
        return { started: true };
      },
      async setCommerce(v) {
        catalog = { ...catalog, commerce: { ...v, failed: null } };
        return v;
      },
      async linkExisting(catalogId) {
        catalog = { catalogId, lastSyncAt: null, items: { synced: 0, excluded: 0, rejected: 0 }, leftOut: [], commerce: { catalogVisible: true, cartEnabled: true, failed: null }, error: null, syncing: true, pending: 0 };
      },
    },
    connectors: {
      list: async () => connectorList.map((c) => ({ ...c })),
      async save(id, body) {
        const had = connectorList.findIndex((c) => c.id === id);
        const prev = had >= 0 ? connectorList[had]! : undefined;
        if (!prev && !body.secret) throw new ApiError('invalid_request', 400, 'secret_required');
        const row: ConnectorDto = {
          id, kind: body.kind, enabled: body.enabled, hasSecret: !!body.secret || !!prev?.hasSecret, config: body.config,
          tools: body.kind === 'webhook' ? body.config.tools.map((x) => `${id}__${x.name}`) : [`${id}__odoo`], updatedAt: Date.now(), updatedBy: 'u-me',
        };
        if (had >= 0) connectorList[had] = row; else connectorList.push(row);
        return { ...row };
      },
      async remove(id) { const i = connectorList.findIndex((c) => c.id === id); if (i >= 0) connectorList.splice(i, 1); },
      test: async () => ({ ok: true }),
    },
    inboxTools: {
      quickReplies: {
        list: async () => quick.map((q) => ({ ...q })),
        async create(text) {
          if (quick.length >= 20 || quick.some((q) => q.text === text)) throw new ApiError('invalid_request', 409);
          const q: QuickReplyDto = { id: ++toolId, text, position: quick.length + 1, createdAt: Date.now() };
          quick.push(q);
          return { ...q };
        },
        async update(id, text) {
          const q = quick.find((x) => x.id === id);
          if (!q) throw new ApiError('not_found', 404);
          q.text = text;
          return { ...q };
        },
        async remove(id) {
          const i = quick.findIndex((x) => x.id === id);
          if (i < 0) throw new ApiError('not_found', 404);
          quick.splice(i, 1);
        },
      },
      notes: async (id) => [...(notes.get(id) ?? [])],
      async addNote(id, text) {
        const n: NoteDto = { id: ++toolId, authorUserId: 'u-me', text, at: Date.now() };
        notes.set(id, [...(notes.get(id) ?? []), n]);
        return n;
      },
      async setTags(id, tags) {
        const c = convs.find((x) => x.id === id);
        if (!c) throw new ApiError('not_found', 404);
        c.tags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
        return { ...c };
      },
    },
    async assign(id, userId) {
      const c = convs.find((x) => x.id === id);
      if (c) {
        c.assigneeUserId = userId;
        c.tags = c.tags.filter((t) => t !== 'needs_human');
      }
    },
    campaigns: {
      list: async () => campaigns.map((c) => ({ ...c })).sort((a, b) => b.createdAt - a.createdAt),
      get: async (id) => ({ ...find(id) }),
      async create(req) {
        const criteria = 'segmentId' in req.audience ? segments.find((x) => x.id === (req.audience as { segmentId: number }).segmentId)!.criteria : req.audience.criteria;
        const audience = preview(criteria).count;
        const c = sampleCampaign({
          id: `c-${nextId++}`, name: req.name, status: 'draft', template: req.template, params: req.params ?? [], linkUrl: req.linkUrl ?? null,
          category: TEMPLATES.find((x) => x.name === req.template.name)?.category ?? 'MARKETING', dailySendLimit: req.dailySendLimit ?? null,
          audience: { segmentId: 'segmentId' in req.audience ? req.audience.segmentId : null, criteria }, createdAt: Date.now(), startedAt: null,
          estimate: { audience, perMessageMinor: SAMPLE_PER_MESSAGE_MINOR, totalMinor: audience * SAMPLE_PER_MESSAGE_MINOR },
        }, { recipients: 0, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 });
        c.clicks = { unique: 0, total: 0 };
        campaigns.push(c);
        return { ...c };
      },
      async send(id, scheduledAt) {
        const c = find(id);
        const n = c.estimate?.audience ?? 0;
        Object.assign(c, { status: scheduledAt ? 'scheduled' : 'running', scheduledAt: scheduledAt ?? null, startedAt: scheduledAt ? null : Date.now(), estimate: undefined, totals: { recipients: n, pending: n, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 } });
        return { ...c };
      },
      async pause(id) { return { ...Object.assign(find(id), { status: 'paused', pauseReason: 'manual' }) }; },
      async resume(id) { return { ...Object.assign(find(id), { status: 'running', pauseReason: null }) }; },
      async cancel(id) { return { ...Object.assign(find(id), { status: 'cancelled', pauseReason: null, finishedAt: Date.now() }) }; },
      async remove(id) { campaigns.splice(campaigns.findIndex((x) => x.id === id), 1); },
      segments: async () => segments.map((x) => ({ ...x })),
      preview: async (k) => preview(k),
    },
    numbers: {
      list: async () => numbers.map((n) => ({ ...n })),
      signupConfig: async () => ({ appId: 'sample', configId: 'sample', graphVersion: 'v25.0' }),
      prepare: async () => undefined,
      // The sample popup "finishes" with an existing WhatsApp Business app number, the most common case for merchants.
      launch: async () => ({ code: 'sample-code', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: 'waba-sample-3', phoneNumberId: 'pn-sample-3' }),
      async connect(req) {
        const n = sampleNumber({ phoneNumberId: req.phoneNumberId, wabaId: req.wabaId, displayPhone: '+20 100 555 0303', onboarding: req.event === 'FINISH' ? 'cloud_api' : 'business_app', registration: req.event === 'FINISH' ? 'registered' : 'not_needed', isOnBizApp: req.event !== 'FINISH', historySync: req.event === 'FINISH' ? null : 'requested', contactsSync: req.event === 'FINISH' ? null : 'requested', connectedAt: Date.now(), syncDeadlineAt: req.event === 'FINISH' ? null : Date.now() + 24 * H });
        numbers.push(n);
        return { ...n };
      },
      refresh: async (id) => ({ ...Object.assign(num(id), { lastStatusSyncAt: Date.now() }) }),
      register: async (id) => ({ ...Object.assign(num(id), { status: 'active', registration: 'registered', qualityRating: 'GREEN', messagingLimitTier: 'TIER_250' }) }),
      disconnect: async (id) => ({ ...Object.assign(num(id), { status: 'disconnected' }) }),
      shared: (() => {
        let st = { available: true, member: false, displayName: null as string | null, displayPhone: '+20 100 555 0900', packageRequired: false };
        return {
          status: async () => ({ ...st }),
          async join(displayName?: string) { st = { ...st, member: true, displayName: displayName?.trim() || 'Sample Shop' }; return { ...st }; },
          async leave() { st = { ...st, member: false, displayName: null }; return { ...st }; },
        };
      })(),
    },
    assistant: createSampleAssistant(),
    team: createSampleTeam(),
    wallet: createSampleWallet(),
    operator: createSampleOperator('u-me'),
    sharedTemplates: createSampleSharedTemplates(),
    contacts: {
      async list(q) {
        const query = normaliseText(q.q ?? '');
        const digits = query.replace(/\D/g, '');
        // Same matching as the server (name tokens by prefix through the shared normaliser, phone by digits), so sample mode behaves like the real one.
        const items = contacts
          .filter((c) => !query || query.split(' ').every((qt) => normaliseText(c.name ?? '').split(' ').some((w) => w.startsWith(qt))) || (digits.length >= 3 && c.waId.includes(digits)))
          .filter((c) => !q.tag || (c.tags ?? []).includes(q.tag))
          .filter((c) => q.optedOut === undefined || c.optedOut === q.optedOut);
        return { items: items.map((c) => ({ ...c })), nextCursor: null };
      },
      async importCsv(file, consented, _wording) {
        const id = `i-${nextId++}`;
        const imp: ImportDto = { id, filename: file.name, status: 'running', consented, total: 0, created: 0, updated: 0, rejected: 0, error: null, createdAt: Date.now(), finishedAt: null };
        imports.unshift(imp);
        setTimeout(() => Object.assign(imp, { status: 'done', total: 52, created: 48, updated: 2, rejected: 2, finishedAt: Date.now() }), 1500);
        return id;
      },
      imports: async () => imports.map((i) => ({ ...i })),
      rejects: async () => [{ line: 14, reason: 'invalid_phone' }, { line: 37, reason: 'duplicate_in_file' }],
      async setContactTags(waId, tags) {
        const c = contacts.find((x) => x.waId === waId);
        if (!c) throw new ApiError('not_found', 404);
        c.tags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
        return { tags: c.tags };
      },
      segments: {
        list: async () => segments.map((x) => ({ ...x })),
        async create(name, criteria) {
          if (segments.some((x) => x.name === name)) throw new ApiError('invalid_request', 409, 'name_taken');
          const seg: SegmentDto = { id: ++toolId, name, criteria, createdAt: Date.now(), updatedAt: Date.now() };
          segments.push(seg);
          return { ...seg };
        },
        async update(id, patch) {
          const seg = segments.find((x) => x.id === id);
          if (!seg) throw new ApiError('not_found', 404);
          Object.assign(seg, patch, { updatedAt: Date.now() });
          return { ...seg };
        },
        async remove(id) {
          const i = segments.findIndex((x) => x.id === id);
          if (i < 0) throw new ApiError('not_found', 404);
          segments.splice(i, 1);
        },
        preview: async (k) => preview(k),
      },
      async renameContact(waId, name) {
        const c = contacts.find((x) => x.waId === waId);
        if (!c) throw new ApiError('not_found', 404);
        if (name !== null) c.name = name;
        return { waId, name: c.name, optedOut: c.optedOut };
      },
      async exportContact(waId) {
        if (!contacts.some((x) => x.waId === waId)) throw new ApiError('not_found', 404);
        return { version: 1, subject: { waId }, messages: [], nextAfter: null };
      },
      async mergeContacts(fromWaId, intoWaId) {
        const i = contacts.findIndex((x) => x.waId === fromWaId);
        if (i < 0 || !contacts.some((x) => x.waId === intoWaId)) throw new ApiError('not_found', 404);
        contacts.splice(i, 1);
      },
      retention: async () => ({ days: retentionDays, effectiveDays: retentionDays ?? 730, defaultDays: 730, minDays: 30, maxDays: 3650 }),
      async setRetention(days) {
        retentionDays = days;
        return { days, effectiveDays: days ?? 730, defaultDays: 730, minDays: 30, maxDays: 3650 };
      },
    },
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
  };
}

function createSampleSharedTemplates(): SharedTemplatesApi {
  const items: TemplateDto[] = [
    { name: 'order_update', language: 'ar', category: 'UTILITY', status: 'APPROVED', bodyText: 'طلبك {{1}} اتحدّث', paramCount: 1, rejectedReason: null },
    { name: 'weekend_offer', language: 'ar', category: 'MARKETING', status: 'APPROVED', bodyText: 'عرض الويك إند {{1}}', paramCount: 1, rejectedReason: null },
    { name: 'pending_utility', language: 'ar', category: 'UTILITY', status: 'PENDING', bodyText: 'تذكير {{1}}', paramCount: 1, rejectedReason: null },
  ];
  return {
    list: async () => items.map((t) => ({ ...t })),
    sync: async () => ({ upserted: items.length, removed: 0 }),
    requests: async () => [{ id: 'sr-1', workspaceId: 'ws-sample-1', name: 'order_ready', language: 'ar', category: 'UTILITY', body: 'أهلًا {{1}}، طلبك {{2}} جاهز للاستلام.', status: 'open', createdAt: BASE - 3 * H, decidedAt: null }],
    submit: async (input) => { items.push({ name: input.name, language: input.language, category: input.category, status: 'PENDING', bodyText: input.components[0]!.text, paramCount: 0, rejectedReason: null }); return { status: 'PENDING' }; },
  };
}

/** Sample team for the preview: the owner, three staff and a package with room for two staff seats (the owner counts as one of three). */
/** The preview's assistant: one canned grounded answer, so the panel can be seen without a server. */
function createSampleAssistant(): AssistantApi {
  return {
    turn: async () => ({
      status: 'answered', previews: [], turnId: crypto.randomUUID(),
      segments: [
        { kind: 'text', text: 'تقدر تشحن المحفظة من شاشة المحفظة، وبتختار الكارت أو إنستاباي. ' },
        { kind: 'cap', capabilityId: 'wallet.view', label: 'المحفظة', appPath: '/wallet' },
      ],
    }),
    conversation: async () => [],
    feedback: async () => undefined,
    apply: async () => ({ status: 'applied', appliedId: crypto.randomUUID(), undoUntil: Date.now() + 86_400_000 }),
    undo: async () => ({ status: 'undone' }),
    confirm: async () => ({ status: 'applied', appliedId: crypto.randomUUID() }),
    reject: async () => ({ status: 'rejected' }),
  };
}

function createSampleTeam(): TeamApi {
  const people = [
    { userId: 'u-me', displayName: 'ليلى', role: 'owner' as const, addedAt: '2026-09-01T00:00:00.000Z' },
    { userId: 'u-1', displayName: 'مصطفى', role: 'staff' as const, addedAt: '2026-09-02T00:00:00.000Z' },
    { userId: 'u-2', displayName: 'دينا', role: 'staff' as const, addedAt: '2026-09-03T00:00:00.000Z' },
    { userId: 'u-3', displayName: 'كريم', role: 'staff' as const, addedAt: '2026-09-04T00:00:00.000Z' },
  ];
  const seated = new Set<string>(['u-1']);
  const LIMIT = 3;
  return {
    async list() {
      return { items: people.map((m) => ({ ...m, seat: m.role === 'owner' ? ('owner' as const) : seated.has(m.userId) ? ('seated' as const) : ('none' as const) })), seats: { limit: LIMIT, used: 1 + seated.size, overLimit: false } };
    },
    async assign(userId) {
      if (!seated.has(userId) && seated.size >= LIMIT - 1) throw new ApiError('seat_limit', 403);
      seated.add(userId);
    },
    async unassign(userId) {
      seated.delete(userId);
    },
  };
}
