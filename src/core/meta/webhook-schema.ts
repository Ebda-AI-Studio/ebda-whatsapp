import { z } from 'zod';

export const MESSAGE_TYPES = ['text', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'order'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number] | 'unsupported';

/** `voice`: Meta's flag on an audio message (true = recorded voice note, false = an audio file); absent = treated as a voice note. */
export type InboundMedia = { id: string; mime: string; filename?: string; voice?: boolean };
/** A tap on a button, a list row or a template quick-reply. `id` is what we set when we sent it (a template button without a payload echoes its title). */
export type InboundReply = { kind: 'button' | 'list'; id: string; title: string };
/** A cart sent from Meta's catalog. Prices stay the decimal strings Meta sent (no float arithmetic on money). */
export type InboundOrder = { catalogId?: string; note?: string; items: { retailerId: string; quantity: number; price: string; currency: string }[] };
/** A WhatsApp location pin. Coordinates are personal data: never logged, never shown in the inbox text, never sent anywhere (no reverse geocoding). */
export type InboundLocation = { latitude: number; longitude: number; name?: string; address?: string };
export type InboundMessage = { wamid: string; from: string; ts: number; type: MessageType; text?: string; caption?: string; media?: InboundMedia; profileName?: string; reply?: InboundReply; order?: InboundOrder; location?: InboundLocation };
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
export const locationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  name: z.string().optional(), address: z.string().optional(),
}).loose();
const mediaBodySchema = z.object({ id: z.string().min(1), mime_type: z.string().optional(), caption: z.string().optional(), filename: z.string().optional(), voice: z.boolean().optional() }).loose();
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
        let location: InboundLocation | undefined;
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
        if (m.type === 'location') {
          const l = locationSchema.safeParse(raw.location);
          if (l.success) location = { latitude: l.data.latitude, longitude: l.data.longitude, ...(l.data.name?.trim() ? { name: l.data.name.trim().slice(0, 120) } : {}), ...(l.data.address?.trim() ? { address: l.data.address.trim().slice(0, 240) } : {}) };
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
          // The inbox shows the pin's own label only (never the coordinates).
          ...(location ? { location, text: `📍 ${location.name ?? location.address ?? ''}`.trim() } : {}),
          ...(media?.success ? { media: { id: media.data.id, mime: media.data.mime_type ?? 'application/octet-stream', ...(media.data.filename ? { filename: media.data.filename } : {}), ...(media.data.voice !== undefined ? { voice: media.data.voice } : {}) }, ...(media.data.caption ? { caption: media.data.caption } : {}) } : {}),
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

export type TemplateStatusEvent = { wabaId: string; name: string; language: string; status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'PAUSED' | 'DISABLED' | 'PENDING_DELETION'; reason: string | null; templateId: string | null };
const TEMPLATE_STATUS: Record<string, TemplateStatusEvent['status']> = { APPROVED: 'APPROVED', REJECTED: 'REJECTED', PENDING: 'PENDING', IN_APPEAL: 'PENDING', PAUSED: 'PAUSED', DISABLED: 'DISABLED', PENDING_DELETION: 'PENDING_DELETION' };

const templateChangeSchema = z.object({
  field: z.literal('message_template_status_update'),
  value: z.object({ event: z.string(), message_template_name: z.string(), message_template_language: z.string(), message_template_id: z.union([z.string(), z.number()]).optional(), reason: z.string().nullish() }).loose(),
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
      out.push({ wabaId: entry.id, name: c.data.value.message_template_name, language: c.data.value.message_template_language, status, reason, templateId: c.data.value.message_template_id === undefined ? null : String(c.data.value.message_template_id) });
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

export type QualityEvent = { wabaId: string; displayPhone: string; event: string; /** Meta's own time of the event (epoch ms); 0 = not given. Used to drop an older signal that arrives later. */ at: number };
const qualityChangeSchema = z.object({
  field: z.literal('phone_number_quality_update'),
  value: z.object({ display_phone_number: z.string(), event: z.string() }).loose(),
}).loose();

/** `phone_number_quality_update` changes that carry Meta's `event` (FLAGGED, UNFLAGGED, UPGRADE, DOWNGRADE, ONBOARDING): the number's health signal. */
export function extractQualityEvents(payload: unknown): QualityEvent[] {
  const parsed = payloadSchema.extend({ entry: z.array(z.object({ id: z.string(), time: z.number().optional(), changes: z.array(z.unknown()) }).loose()) }).safeParse(payload);
  if (!parsed.success) return [];
  const out: QualityEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const ch of entry.changes) {
      const c = qualityChangeSchema.safeParse(ch);
      if (c.success) out.push({ wabaId: entry.id, displayPhone: c.data.value.display_phone_number, event: c.data.value.event, at: (entry.time ?? 0) * 1000 });
    }
  }
  return out;
}

/** `account_update`: WABA-wide. restricted = a restriction, ban or violation is active; lifted = Meta cleared it; anything else is not about sending. */
export type AccountEvent = { wabaId: string; restricted: boolean; at: number };
const accountChangeSchema = z.object({
  field: z.literal('account_update'),
  value: z.object({ event: z.string().optional(), restriction_info: z.array(z.unknown()).optional(), ban_info: z.object({ waba_ban_state: z.union([z.string(), z.array(z.string())]).optional() }).loose().optional() }).loose(),
}).loose();

/**
 * INFERRED from Meta's documented account_update shapes, not yet seen on live traffic (verify on the first real event): a ban state DISABLE / SCHEDULE_FOR_DISABLE,
 * ACCOUNT_VIOLATION, ACCOUNT_DELETED, or ACCOUNT_RESTRICTION with restriction_info = restricted; REINSTATE, or ACCOUNT_RESTRICTION with an empty restriction_info = lifted.
 */
export function extractAccountEvents(payload: unknown): AccountEvent[] {
  const parsed = payloadSchema.extend({ entry: z.array(z.object({ id: z.string(), time: z.number().optional(), changes: z.array(z.unknown()) }).loose()) }).safeParse(payload);
  if (!parsed.success) return [];
  const out: AccountEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const ch of entry.changes) {
      const c = accountChangeSchema.safeParse(ch);
      if (!c.success) continue;
      const v = c.data.value;
      const at = (entry.time ?? 0) * 1000;
      const states = ([] as string[]).concat(v.ban_info?.waba_ban_state ?? []).map((s) => s.toUpperCase());
      const event = (v.event ?? '').toUpperCase();
      if (states.includes('REINSTATE')) out.push({ wabaId: entry.id, restricted: false, at });
      else if (states.includes('DISABLE') || states.includes('SCHEDULE_FOR_DISABLE') || event === 'ACCOUNT_VIOLATION' || event === 'ACCOUNT_DELETED') out.push({ wabaId: entry.id, restricted: true, at });
      else if (event === 'ACCOUNT_RESTRICTION') out.push({ wabaId: entry.id, restricted: v.restriction_info === undefined || v.restriction_info.length > 0, at });
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
