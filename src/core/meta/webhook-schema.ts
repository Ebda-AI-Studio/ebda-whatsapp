import { z } from 'zod';

export const MESSAGE_TYPES = ['text', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'order'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number] | 'unsupported';

export type InboundMessage = { wamid: string; from: string; ts: number; type: MessageType; text?: string; profileName?: string };
export type StatusEvent = { wamid: string; status: 'sent' | 'delivered' | 'read' | 'failed'; ts: number; errorCode?: number };
export type WebhookEvents = { phoneNumberId: string; inbound: InboundMessage[]; statuses: StatusEvent[] };

// Permissive on purpose: Meta adds fields often, and an unknown field must never drop a message.
const messageSchema = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).loose().optional(),
}).loose();

const statusSchema = z.object({
  id: z.string(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.string(),
  errors: z.array(z.object({ code: z.number() }).loose()).optional(),
}).loose();

const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }).loose(),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).loose().optional() }).loose()).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
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
      if (!v.success) continue;
      const pn = v.data.metadata.phone_number_id;
      const ev = byNumber.get(pn) ?? { phoneNumberId: pn, inbound: [], statuses: [] };
      const names = new Map((v.data.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.data.messages ?? []) {
        ev.inbound.push({
          wamid: m.id,
          from: m.from,
          ts: Number(m.timestamp),
          type: toType(m.type),
          ...(m.text ? { text: m.text.body } : {}),
          ...(names.get(m.from) ? { profileName: names.get(m.from) } : {}),
        });
      }
      for (const s of v.data.statuses ?? []) {
        const code = s.errors?.[0]?.code;
        ev.statuses.push({ wamid: s.id, status: s.status, ts: Number(s.timestamp), ...(code !== undefined ? { errorCode: code } : {}) });
      }
      byNumber.set(pn, ev);
    }
  }
  return [...byNumber.values()];
}
