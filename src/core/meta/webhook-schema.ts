import { z } from 'zod';

export const MESSAGE_TYPES = ['text', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'order'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number] | 'unsupported';

export type InboundMedia = { id: string; mime: string; filename?: string };
/** A tap on a button, a list row or a template quick-reply. `id` is what we set when we sent it (a template button without a payload echoes its title). */
export type InboundReply = { kind: 'button' | 'list'; id: string; title: string };
/** A cart sent from Meta's catalog. Prices stay the decimal strings Meta sent (no float arithmetic on money). */
export type InboundOrder = { catalogId?: string; note?: string; items: { retailerId: string; quantity: number; price: string; currency: string }[] };
export type InboundMessage = { wamid: string; from: string; ts: number; type: MessageType; text?: string; caption?: string; media?: InboundMedia; profileName?: string; reply?: InboundReply; order?: InboundOrder };
export const MEDIA_MESSAGE_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;
const replySchema = z.object({
  type: z.enum(['button_reply', 'list_reply']),
  button_reply: z.object({ id: z.string().min(1), title: z.string() }).loose().optional(),
  list_reply: z.object({ id: z.string().min(1), title: z.string() }).loose().optional(),
}).loose();
const templateButtonSchema = z.object({ payload: z.string().optional(), text: z.string() }).loose();
const orderSchema = z.object({
  catalog_id: z.string().optional(),
  text: z.string().optional(),
  product_items: z.array(z.object({ product_retailer_id: z.string().min(1), quantity: z.union([z.number(), z.string()]), item_price: z.union([z.number(), z.string()]), currency: z.string() }).loose()).default([]),
}).loose();
const mediaBodySchema = z.object({ id: z.string().min(1), mime_type: z.string().optional(), caption: z.string().optional(), filename: z.string().optional() }).loose();
/** Meta's `pricing` object on a status: whether the message is billable, under which model and category. Absent fields stay null. */
export type StatusPricing = { billable: boolean | null; pricingModel: string | null; category: string | null; type: string | null };
export type StatusEvent = { wamid: string; status: 'sent' | 'delivered' | 'read' | 'failed'; ts: number; errorCode?: number; pricing?: StatusPricing };
export type WebhookEvents = { phoneNumberId: string; inbound: InboundMessage[]; statuses: StatusEvent[] };

// Permissive on purpose: Meta adds fields often, and an unknown field must never drop a message.
const unixSeconds = z.string().regex(/^\d{1,12}$/);

const messageSchema = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: unixSeconds,
  type: z.string(),
  text: z.object({ body: z.string() }).loose().optional(),
}).loose();

const statusSchema = z.object({
  id: z.string(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: unixSeconds,
  errors: z.array(z.object({ code: z.number() }).loose()).optional(),
  pricing: z.object({ billable: z.boolean().optional(), pricing_model: z.string().optional(), category: z.string().optional(), type: z.string().optional() }).loose().optional(),
}).loose();

const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }).loose(),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).loose().optional() }).loose()).optional(),
  // Items are parsed one by one below, so one bad item never drops its siblings.
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
}).loose();

const payloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    changes: z.array(z.object({ field: z.string(), value: z.unknown() }).loose()),
  }).loose()),
}).loose();

function toType(t: string): MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(t) ? (t as MessageType) : 'unsupported';
}

/** Extracts messages and statuses per phone number. Returns null when the payload is not a WhatsApp webhook. */
export function extractEvents(payload: unknown): WebhookEvents[] | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const byNumber = new Map<string, WebhookEvents>();
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const v = valueSchema.safeParse(change.value);
      if (!v.success) {
        console.warn('meta webhook: change value rejected', v.error.issues[0]?.path.join('.'));
        continue;
      }
      const pn = v.data.metadata.phone_number_id;
      const ev = byNumber.get(pn) ?? { phoneNumberId: pn, inbound: [], statuses: [] };
      const names = new Map((v.data.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const item of v.data.messages ?? []) {
        const parsedMsg = messageSchema.safeParse(item);
        if (!parsedMsg.success) {
          console.warn('meta webhook: message item rejected', parsedMsg.error.issues[0]?.path.join('.'));
          continue;
        }
        const m = parsedMsg.data;
        const raw = m as Record<string, unknown>;
        let reply: InboundReply | undefined;
        let order: InboundOrder | undefined;
        let type = toType(m.type);
        if (m.type === 'interactive') {
          const r = replySchema.safeParse(raw.interactive);
          const body = r.success ? (r.data.type === 'button_reply' ? r.data.button_reply : r.data.list_reply) : undefined;
          if (r.success && body) reply = { kind: r.data.type === 'button_reply' ? 'button' : 'list', id: body.id, title: body.title };
        } else if (m.type === 'button') {
          // A tap on a template quick-reply arrives as type "button"; shown in the inbox as an interactive reply.
          const b = templateButtonSchema.safeParse(raw.button);
          if (b.success) {
            reply = { kind: 'button', id: b.data.payload ?? b.data.text, title: b.data.text };
            type = 'interactive';
          }
        } else if (m.type === 'order') {
          const o = orderSchema.safeParse(raw.order);
          if (o.success) {
            order = {
              ...(o.data.catalog_id ? { catalogId: o.data.catalog_id } : {}),
              ...(o.data.text ? { note: o.data.text } : {}),
              items: o.data.product_items.map((i) => ({ retailerId: i.product_retailer_id, quantity: Math.max(1, Math.min(99, Math.trunc(Number(i.quantity)) || 1)), price: String(i.item_price), currency: i.currency })),
            };
          }
        }
        const media = (MEDIA_MESSAGE_TYPES as readonly string[]).includes(type) ? mediaBodySchema.safeParse((m as Record<string, unknown>)[m.type]) : null;
        ev.inbound.push({
          wamid: m.id,
          from: m.from,
          ts: Number(m.timestamp),
          type,
          ...(m.text ? { text: m.text.body } : {}),
          ...(reply ? { text: reply.title, reply } : {}),
          ...(order ? { order, text: `🛒 ${order.items.reduce((n, i) => n + i.quantity, 0)}` } : {}),
          ...(media?.success ? { media: { id: media.data.id, mime: media.data.mime_type ?? 'application/octet-stream', ...(media.data.filename ? { filename: media.data.filename } : {}) }, ...(media.data.caption ? { caption: media.data.caption } : {}) } : {}),
          ...(names.get(m.from) ? { profileName: names.get(m.from) } : {}),
        });
      }
      for (const item of v.data.statuses ?? []) {
        const parsedStatus = statusSchema.safeParse(item);
        if (!parsedStatus.success) {
          console.warn('meta webhook: status item rejected', parsedStatus.error.issues[0]?.path.join('.'));
          continue;
        }
        const s = parsedStatus.data;
        const code = s.errors?.[0]?.code;
        const pr = s.pricing;
        ev.statuses.push({
          wamid: s.id, status: s.status, ts: Number(s.timestamp), ...(code !== undefined ? { errorCode: code } : {}),
          ...(pr ? { pricing: { billable: pr.billable ?? null, pricingModel: pr.pricing_model ?? null, category: pr.category ?? null, type: pr.type ?? null } } : {}),
        });
      }
      byNumber.set(pn, ev);
    }
  }
  return [...byNumber.values()];
}

export type TemplateStatusEvent = { wabaId: string; name: string; language: string; status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'PAUSED' | 'DISABLED'; reason: string | null };
const TEMPLATE_STATUS: Record<string, TemplateStatusEvent['status']> = { APPROVED: 'APPROVED', REJECTED: 'REJECTED', PENDING: 'PENDING', IN_APPEAL: 'PENDING', PAUSED: 'PAUSED', DISABLED: 'DISABLED' };

const templateChangeSchema = z.object({
  field: z.literal('message_template_status_update'),
  value: z.object({ event: z.string(), message_template_name: z.string(), message_template_language: z.string(), reason: z.string().nullish() }).loose(),
}).loose();

/** `message_template_status_update` changes, per WABA. Events we do not model (FLAGGED, …) are skipped. */
export function extractTemplateStatuses(payload: unknown): TemplateStatusEvent[] {
  const parsed = payloadSchema.extend({ entry: z.array(z.object({ id: z.string(), changes: z.array(z.unknown()) }).loose()) }).safeParse(payload);
  if (!parsed.success) return [];
  const out: TemplateStatusEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const ch of entry.changes) {
      const c = templateChangeSchema.safeParse(ch);
      const status = c.success ? TEMPLATE_STATUS[c.data.value.event] : undefined;
      if (!c.success || !status) continue;
      const reason = c.data.value.reason && c.data.value.reason !== 'NONE' ? c.data.value.reason : null;
      out.push({ wabaId: entry.id, name: c.data.value.message_template_name, language: c.data.value.message_template_language, status, reason });
    }
  }
  return out;
}

export type TierUpdateEvent = { wabaId: string; displayPhone: string; currentLimit: string };
const tierChangeSchema = z.object({
  field: z.literal('phone_number_quality_update'),
  value: z.object({ display_phone_number: z.string(), current_limit: z.string() }).loose(),
}).loose();

/** `phone_number_quality_update` changes: Meta moved a number to another messaging tier. */
export function extractTierUpdates(payload: unknown): TierUpdateEvent[] {
  const parsed = payloadSchema.extend({ entry: z.array(z.object({ id: z.string(), changes: z.array(z.unknown()) }).loose()) }).safeParse(payload);
  if (!parsed.success) return [];
  const out: TierUpdateEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const ch of entry.changes) {
      const c = tierChangeSchema.safeParse(ch);
      if (c.success) out.push({ wabaId: entry.id, displayPhone: c.data.value.display_phone_number, currentLimit: c.data.value.current_limit });
    }
  }
  return out;
}

export type TemplateCategoryEvent = { wabaId: string; name: string; language: string; newCategory: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' };
const categoryChangeSchema = z.object({
  field: z.literal('template_category_update'),
  value: z.object({
    message_template_name: z.string().optional(), message_template_element: z.string().optional(), message_template_language: z.string(),
    new_category: z.string().optional(), correct_category: z.string().optional(),
  }).loose(),
}).loose();

/**
 * `template_category_update`: Meta re-categorised a template (typically utility -> marketing), which changes what its sends cost.
 * Field names follow Meta's documented payload (name, language, new_category); NOT yet seen against live traffic.
 */
export function extractTemplateCategoryUpdates(payload: unknown): TemplateCategoryEvent[] {
  const parsed = payloadSchema.extend({ entry: z.array(z.object({ id: z.string(), changes: z.array(z.unknown()) }).loose()) }).safeParse(payload);
  if (!parsed.success) return [];
  const out: TemplateCategoryEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const ch of entry.changes) {
      const c = categoryChangeSchema.safeParse(ch);
      if (!c.success) continue;
      const name = c.data.value.message_template_name ?? c.data.value.message_template_element;
      const cat = (c.data.value.new_category ?? c.data.value.correct_category ?? '').toUpperCase();
      if (name && (cat === 'MARKETING' || cat === 'UTILITY' || cat === 'AUTHENTICATION')) out.push({ wabaId: entry.id, name, language: c.data.value.message_template_language, newCategory: cat });
    }
  }
  return out;
}
