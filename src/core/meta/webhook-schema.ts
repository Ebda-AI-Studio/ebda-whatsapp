import { z } from 'zod';

export const MESSAGE_TYPES = ['text', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'order'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number] | 'unsupported';

export type InboundMedia = { id: string; mime: string; filename?: string };
export type InboundMessage = { wamid: string; from: string; ts: number; type: MessageType; text?: string; caption?: string; media?: InboundMedia; profileName?: string };
export const MEDIA_MESSAGE_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;
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
        const type = toType(m.type);
        const media = (MEDIA_MESSAGE_TYPES as readonly string[]).includes(type) ? mediaBodySchema.safeParse((m as Record<string, unknown>)[m.type]) : null;
        ev.inbound.push({
          wamid: m.id,
          from: m.from,
          ts: Number(m.timestamp),
          type,
          ...(m.text ? { text: m.text.body } : {}),
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
