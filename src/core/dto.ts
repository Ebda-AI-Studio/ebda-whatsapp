import type { ConversationDto, MessageDto } from './api/contract';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** The columns messageDto needs, selected in one place so every reader maps the same shape. */
export const MESSAGE_COLUMNS = `m.id, m.wamid, m.direction, m.type, m.preview, m.body, m.body_r2_key, m.status, m.error_code, m.idempotency_key,
  m.template_name, m.template_lang, m.media_mime, m.media_size, m.media_r2_key, m.author, m.created_at`;

export type MessageRow = {
  id: number; wamid: string | null; direction: 'in' | 'out'; type: string; preview: string | null; body: string | null; body_r2_key: string | null;
  status: string | null; error_code: number | null; idempotency_key: string | null; template_name: string | null; template_lang: string | null;
  media_mime: string | null; media_size: number | null; media_r2_key: string | null; author: string | null; created_at: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KNOWN_TYPES = new Set(['text', 'template', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'order']);

export function clientIdOf(idempotencyKey: string | null): string | null {
  if (!idempotencyKey?.startsWith('ui:')) return null;
  const id = idempotencyKey.slice(3);
  return UUID.test(id) ? id : null;
}

export function messageDto(r: MessageRow, workspaceId: string): MessageDto {
  return {
    id: r.id,
    clientId: clientIdOf(r.idempotency_key),
    wamid: r.wamid,
    direction: r.direction,
    type: (KNOWN_TYPES.has(r.type) ? r.type : 'unsupported') as MessageDto['type'],
    // Up to 1 KB the whole text is inline; longer bodies expose their first 280 characters here and the rest via /messages/:id/body.
    text: r.body ?? r.preview,
    hasLongBody: r.body_r2_key !== null,
    media: r.media_mime && r.media_r2_key ? { mime: r.media_mime, size: r.media_size, url: `/api/v1/stores/${workspaceId}/media/${r.id}` } : null,
    template: r.template_name ? { name: r.template_name, language: r.template_lang ?? '' } : null,
    status: (r.status as MessageDto['status']) ?? null,
    errorCode: r.error_code,
    at: r.created_at,
    // Only set for the AI agent, the ordering bot and staff; a system message or a customer's keeps the Phase 2 shape.
    ...(r.author === 'agent' || r.author === 'bot' || r.author === 'staff' ? { author: r.author } : {}),
  };
}

export type ConversationRow = {
  id: number; wa_id: string; profile_name: string | null; opted_out_at: number | null; last_inbound_at: number | null;
  unread: number; assignee_user_id: string | null; last_message_at: number | null;
  lm_preview: string | null; lm_direction: 'in' | 'out' | null; lm_type: string | null; lm_status: string | null; lm_at: number | null;
};

export function conversationDto(r: ConversationRow, tags: string[], now: number): ConversationDto {
  const until = r.last_inbound_at ? r.last_inbound_at * 1000 + WINDOW_MS : null;
  return {
    id: r.id,
    contact: { waId: r.wa_id, name: r.profile_name, optedOut: r.opted_out_at !== null },
    lastMessage: r.lm_direction
      ? { preview: r.lm_preview, direction: r.lm_direction, type: (KNOWN_TYPES.has(r.lm_type ?? '') ? r.lm_type : 'unsupported') as MessageDto['type'], status: (r.lm_status as MessageDto['status']) ?? null, at: r.lm_at ?? 0 }
      : null,
    unread: r.unread,
    assigneeUserId: r.assignee_user_id,
    tags,
    windowOpenUntil: until !== null && until > now ? until : null,
  };
}
