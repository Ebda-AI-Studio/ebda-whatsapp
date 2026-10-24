import type { ConversationDto, MessageDto, OrderSummaryDto, RealtimeEvent, TemplateDto } from '../../../src/core/api/contract';
import type { InboxSource } from './source';

// Sample data for preview only (labelled in the UI). Names and orders are invented; no real customers.
const BASE = Date.UTC(2026, 9, 24, 17, 0);
const MIN = 60_000;
const H = 60 * MIN;

type Seed = { id: number; name: string; waId: string; preview: string; ago: number; unread: number; assignee: string | null; windowH: number | null; tags: string[] };
const SEEDS: Seed[] = [
  { id: 1, name: 'منى عبد الرحمن', waId: '201001112233', preview: 'عايزة أأكد الأوردر بتاع امبارح', ago: 2 * MIN, unread: 2, assignee: 'u-dina', windowH: 22, tags: ['cod_pending'] },
  { id: 2, name: 'كريم سمير', waId: '201002223344', preview: 'الشحنة اتأخرت يومين', ago: 12 * MIN, unread: 1, assignee: null, windowH: 23, tags: ['شحن'] },
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
  5: [msg(51, 'in', 'الدفع عند الاستلام متاح؟', BASE - 2 * H), msg(52, 'out', 'أيوه متاح في القاهرة والجيزة.', BASE - 2 * H + 5 * MIN, 'delivered')],
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
];

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
  const listeners = new Set<(e: RealtimeEvent) => void>();
  let seq = 0;
  let nextId = 1000;
  return {
    kind: 'sample',
    capabilities: { codOutcome: true },
    currentUserId: 'u-me',
    userNames: { 'u-me': 'أنا', 'u-dina': 'دينا' },
    async listConversations(filter, q) {
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
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
  };
}
