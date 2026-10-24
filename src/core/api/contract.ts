/**
 * The inbox API contract: one file shared by the Worker (validation) and the web app (typed client).
 * All routes live under /api/v1/stores/:storeId/ and require a bearer token (identity v1).
 */
import { z } from 'zod';

export const messageStatus = z.enum(['queued', 'claimed', 'accepted', 'sent', 'delivered', 'read', 'failed', 'retry']);
export const messageType = z.enum(['text', 'template', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'order', 'unsupported']);

export const contactDto = z.object({
  waId: z.string(), // digits, no '+'
  name: z.string().nullable(),
  optedOut: z.boolean(),
});

export const messageDto = z.object({
  id: z.number().int(),
  clientId: z.string().uuid().nullable(),
  wamid: z.string().nullable(),
  direction: z.enum(['in', 'out']),
  type: messageType,
  text: z.string().nullable(), // full text up to 1 KB inline; larger bodies are fetched from /messages/:id/body
  hasLongBody: z.boolean(),
  media: z.object({ mime: z.string(), size: z.number().int().nullable(), url: z.string() }).nullable(),
  template: z.object({ name: z.string(), language: z.string() }).nullable(),
  status: messageStatus.nullable(),
  errorCode: z.number().int().nullable(),
  at: z.number().int(), // epoch ms
});

export const conversationDto = z.object({
  id: z.number().int(),
  contact: contactDto,
  lastMessage: z.object({ preview: z.string().nullable(), direction: z.enum(['in', 'out']), type: messageType, status: messageStatus.nullable(), at: z.number().int() }).nullable(),
  unread: z.number().int().nonnegative(),
  assigneeUserId: z.string().nullable(),
  tags: z.array(z.string()),
  windowOpenUntil: z.number().int().nullable(), // epoch ms; null = closed (templates only)
});

export const listConversationsQuery = z.object({
  filter: z.enum(['all', 'unread', 'mine', 'unassigned']).default('all'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export const listConversationsResponse = z.object({ items: z.array(conversationDto), nextCursor: z.string().nullable() });

export const getMessagesQuery = z.object({
  before: z.coerce.number().int().optional(), // message id
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export const getMessagesResponse = z.object({ items: z.array(messageDto), nextBefore: z.number().int().nullable() });

const clientId = z.string().uuid();
export const sendMessageRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), clientId, text: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('template'), clientId, name: z.string().min(1), language: z.string().min(2), params: z.array(z.string()).max(20).default([]) }),
  z.object({
    type: z.literal('interactive'),
    clientId,
    body: z.string().min(1).max(1024),
    buttons: z.array(z.object({ id: z.string().min(1).max(256), title: z.string().min(1).max(20) })).min(1).max(3),
  }),
  z.object({ type: z.literal('media'), clientId, uploadId: z.string().min(1), caption: z.string().max(1024).optional() }),
]);
export type SendMessageRequest = z.infer<typeof sendMessageRequest>;

export const apiError = z.object({
  error: z.enum([
    'unauthorized', 'forbidden', 'not_found', 'invalid_request',
    'window_closed', 'opted_out', 'template_not_approved', 'unsupported_media', 'wallet_empty', 'rate_limited',
  ]),
  message: z.string().optional(),
});

export const templateDto = z.object({
  name: z.string(),
  language: z.string(),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  status: z.enum(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED']),
  bodyText: z.string(),
  paramCount: z.number().int().nonnegative(),
  rejectedReason: z.string().nullable(),
});
export const listTemplatesResponse = z.object({ items: z.array(templateDto) });

export const noteDto = z.object({ id: z.number().int(), authorUserId: z.string(), text: z.string(), at: z.number().int() });
export const addNoteRequest = z.object({ text: z.string().min(1).max(2000) });
export const assignRequest = z.object({ userId: z.string().nullable() });
export const setTagsRequest = z.object({ tags: z.array(z.string().min(1).max(32)).max(10) });
export const searchQuery = z.object({ q: z.string().min(1).max(100), limit: z.coerce.number().int().min(1).max(50).default(20) });
export const searchResponse = z.object({ items: z.array(z.object({ conversationId: z.number().int(), messageId: z.number().int(), snippet: z.string(), at: z.number().int() })) });

/** Realtime: every event carries a monotonic seq; a client that sees a gap calls GET /events?after=<seq>. */
export const realtimeEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message.created'), seq: z.number().int(), conversationId: z.number().int(), message: messageDto }),
  z.object({ type: z.literal('message.status'), seq: z.number().int(), conversationId: z.number().int(), messageId: z.number().int(), status: messageStatus, errorCode: z.number().int().nullable() }),
  z.object({ type: z.literal('conversation.updated'), seq: z.number().int(), conversation: conversationDto }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEvent>;
export const eventsQuery = z.object({ after: z.coerce.number().int().nonnegative() });
export const eventsResponse = z.object({ items: z.array(realtimeEvent), latestSeq: z.number().int() });

/** Order panel (Phase 4 fills it from the Store RPC; until then the UI shows labelled sample data). */
export const orderSummaryDto = z.object({
  orderNumber: z.string(),
  status: z.enum(['pending_confirmation', 'confirmed', 'refused', 'shipped', 'delivered', 'cancelled', 'returned']),
  totalMinor: z.number().int(),
  currency: z.string().length(3),
  paymentMethod: z.enum(['cod', 'link', 'card', 'wallet', 'instapay']),
  itemsCount: z.number().int().positive(),
  at: z.number().int(),
});
/** The merchant confirms or refuses a COD order from the inbox; the Worker forwards it to the store (recordCodOutcome). */
export const codOutcomeRequest = z.object({ outcome: z.enum(['confirmed', 'refused']), idempotencyKey: z.string().uuid() });
export type CodOutcomeRequest = z.infer<typeof codOutcomeRequest>;

export const codOutcomeResponse = z.object({ orderNumber: z.string(), outcome: z.enum(['confirmed', 'refused']), pushed: z.boolean() });
export type CodOutcomeResponse = z.infer<typeof codOutcomeResponse>;

/** GET /me. `capabilities` lets the UI show what the deployment can do (additive: older clients ignore it). */
export const meResponse = z.object({
  userId: z.string(),
  storeId: z.string(),
  role: z.enum(['owner', 'staff', 'super_admin']),
  capabilities: z.object({ codOutcome: z.boolean() }),
});
export type MeResponse = z.infer<typeof meResponse>;

/** Store-link settings (owner only to change). */
export const storeLinkSettingsResponse = z.object({
  orderConfirmations: z.boolean(),
  orderingBot: z.boolean(),
  otpViaWhatsApp: z.boolean(),
  catalogId: z.string().nullable(),
});
export const storeLinkSettingsPatch = z.object({
  orderConfirmations: z.boolean(),
  orderingBot: z.boolean(),
  otpViaWhatsApp: z.boolean(),
  catalogId: z.string().regex(/^\d{5,25}$/).nullable(),
}).partial().refine((p) => Object.keys(p).length > 0, 'nothing to change');

export const customerOrdersResponse = z.object({ items: z.array(orderSummaryDto), source: z.enum(['store', 'sample']) });

export type ContactDto = z.infer<typeof contactDto>;
export type MessageDto = z.infer<typeof messageDto>;
export type ConversationDto = z.infer<typeof conversationDto>;
export type TemplateDto = z.infer<typeof templateDto>;
export type NoteDto = z.infer<typeof noteDto>;
export type OrderSummaryDto = z.infer<typeof orderSummaryDto>;
export type ApiError = z.infer<typeof apiError>;

/** Route table (paths relative to /api/v1/stores/:storeId). */
export const ROUTES = {
  conversations: 'GET /conversations',
  messages: 'GET /conversations/:conversationId/messages',
  messageBody: 'GET /messages/:messageId/body',
  send: 'POST /conversations/:conversationId/messages',
  read: 'POST /conversations/:conversationId/read',
  assign: 'POST /conversations/:conversationId/assign',
  notes: 'GET|POST /conversations/:conversationId/notes',
  tags: 'PUT /conversations/:conversationId/tags',
  search: 'GET /search',
  templates: 'GET|POST /templates',
  templatesSync: 'POST /templates/sync',
  media: 'GET /media/:messageId',
  upload: 'POST /media',
  events: 'GET /events',
  ws: 'GET /ws',
  orders: 'GET /contacts/:waId/orders',
  codOutcome: 'POST /contacts/:waId/orders/:orderNumber/cod-outcome',
  me: 'GET /me',
  storeLinkSettings: 'GET|PATCH /store-link/settings',
} as const;
