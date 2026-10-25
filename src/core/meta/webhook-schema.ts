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
export type StatusEvent = { wamid: string; status: 'sent' | 'delivered' | 'read' | 'failed'; ts: number; errorCode?: number };
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
        ev.statuses.push({ wamid: s.id, status: s.status, ts: Number(s.timestamp), ...(code !== undefined ? { errorCode: code } : {}) });
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

// ---- Coexistence (a number kept on the WhatsApp Business app): echoes, contact sync, history, name decisions ------------

/** A message that was not received through the Cloud API: typed in the merchant's app (an echo) or read from its chat history. */
export type CoexMessage = {
  wamid: string;
  /** The customer's WhatsApp id (digits). */
  customer: string;
  ts: number;
  direction: 'in' | 'out';
  type: MessageType;
  text?: string;
  caption?: string;
  media?: InboundMedia;
  /** History only: how far an outgoing message got. */
  status?: StatusEvent['status'];
};
export type SyncedContact = { waId: string; name?: string };
export type CoexEvents = {
  phoneNumberId: string;
  /** Sent from the Business app just now (smb_message_echoes). */
  echoes: CoexMessage[];
  contacts: SyncedContact[];
  /** Past messages (history), original timestamps. */
  history: CoexMessage[];
  /** The merchant refused to share their chat history (error 2593109). */
  historyDeclined: boolean;
};

const digitsOf = (s: string) => s.replace(/\D/g, '');
const coexValueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }).loose(),
  message_echoes: z.array(z.unknown()).optional(),
  state_sync: z.array(z.unknown()).optional(),
  history: z.array(z.unknown()).optional(),
}).loose();
const echoSchema = z.object({ to: z.string().min(1), id: z.string().min(1), timestamp: unixSeconds, type: z.string() }).loose();
const stateSyncSchema = z.object({
  type: z.string(),
  action: z.string(),
  contact: z.object({ full_name: z.string().optional(), first_name: z.string().optional(), phone_number: z.string() }).loose().optional(),
}).loose();
const historyChunkSchema = z.object({
  threads: z.array(z.object({ id: z.string().min(1), messages: z.array(z.unknown()).default([]) }).loose()).optional(),
  errors: z.array(z.object({ code: z.number() }).loose()).optional(),
}).loose();
const historyMessageSchema = z.object({ from: z.string(), id: z.string().min(1), timestamp: unixSeconds, type: z.string(), history_context: z.object({ status: z.string() }).loose().optional() }).loose();
const HISTORY_STATUS: Record<string, StatusEvent['status']> = { SENT: 'sent', PENDING: 'sent', DELIVERED: 'delivered', READ: 'read', PLAYED: 'read', ERROR: 'failed' };
const HISTORY_DECLINED = 2593109;

function coexMessage(raw: Record<string, unknown>, base: { wamid: string; customer: string; ts: number; direction: 'in' | 'out'; status?: StatusEvent['status'] }): CoexMessage {
  const type = toType(String(raw.type));
  const textBody = (raw.text as { body?: unknown } | undefined)?.body;
  const body = (MEDIA_MESSAGE_TYPES as readonly string[]).includes(type) ? mediaBodySchema.safeParse(raw[type]) : null;
  return {
    ...base,
    type,
    ...(typeof textBody === 'string' ? { text: textBody } : {}),
    ...(body?.success ? { media: { id: body.data.id, mime: body.data.mime_type ?? 'application/octet-stream', ...(body.data.filename ? { filename: body.data.filename } : {}) }, ...(body.data.caption ? { caption: body.data.caption } : {}) } : {}),
  };
}

/** `smb_message_echoes`, `smb_app_state_sync` and `history` changes, per phone number. One bad item never drops its siblings. */
export function extractCoexistence(payload: unknown): CoexEvents[] {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const byNumber = new Map<string, CoexEvents>();
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'smb_message_echoes' && change.field !== 'smb_app_state_sync' && change.field !== 'history') continue;
      const v = coexValueSchema.safeParse(change.value);
      if (!v.success) continue;
      const pn = v.data.metadata.phone_number_id;
      const ev = byNumber.get(pn) ?? { phoneNumberId: pn, echoes: [], contacts: [], history: [], historyDeclined: false };
      byNumber.set(pn, ev);
      for (const item of v.data.message_echoes ?? []) {
        const e = echoSchema.safeParse(item);
        if (!e.success) continue;
        ev.echoes.push(coexMessage(e.data as Record<string, unknown>, { wamid: e.data.id, customer: digitsOf(e.data.to), ts: Number(e.data.timestamp), direction: 'out' }));
      }
      for (const item of v.data.state_sync ?? []) {
        const s = stateSyncSchema.safeParse(item);
        if (!s.success || s.data.type !== 'contact' || s.data.action !== 'add' || !s.data.contact) continue;
        const waId = digitsOf(s.data.contact.phone_number);
        if (waId.length < 8 || waId.length > 15) continue;
        const name = s.data.contact.full_name ?? s.data.contact.first_name;
        ev.contacts.push({ waId, ...(name ? { name } : {}) });
      }
      for (const item of v.data.history ?? []) {
        const chunk = historyChunkSchema.safeParse(item);
        if (!chunk.success) continue;
        if (chunk.data.errors?.some((e) => e.code === HISTORY_DECLINED)) ev.historyDeclined = true;
        for (const thread of chunk.data.threads ?? []) {
          const customer = digitsOf(thread.id);
          for (const m of thread.messages) {
            const h = historyMessageSchema.safeParse(m);
            if (!h.success || !customer) continue;
            const inbound = digitsOf(h.data.from) === customer;
            const status = h.data.history_context ? HISTORY_STATUS[h.data.history_context.status] : undefined;
            ev.history.push(coexMessage(h.data as Record<string, unknown>, { wamid: h.data.id, customer, ts: Number(h.data.timestamp), direction: inbound ? 'in' : 'out', ...(!inbound && status ? { status } : {}) }));
          }
        }
      }
    }
  }
  return [...byNumber.values()];
}

export type NameUpdateEvent = { wabaId: string; displayPhone: string; decision: 'APPROVED' | 'REJECTED' | 'PENDING' | 'DEFERRED'; requestedName: string | null };
const nameChangeSchema = z.object({
  field: z.literal('phone_number_name_update'),
  value: z.object({ display_phone_number: z.string(), decision: z.enum(['APPROVED', 'REJECTED', 'PENDING', 'DEFERRED']), requested_verified_name: z.string().nullish() }).loose(),
}).loose();

/** `phone_number_name_update`: Meta decided on a display name. */
export function extractNameUpdates(payload: unknown): NameUpdateEvent[] {
  const parsed = payloadSchema.extend({ entry: z.array(z.object({ id: z.string(), changes: z.array(z.unknown()) }).loose()) }).safeParse(payload);
  if (!parsed.success) return [];
  const out: NameUpdateEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const ch of entry.changes) {
      const c = nameChangeSchema.safeParse(ch);
      if (c.success) out.push({ wabaId: entry.id, displayPhone: c.data.value.display_phone_number, decision: c.data.value.decision, requestedName: c.data.value.requested_verified_name ?? null });
    }
  }
  return out;
}
