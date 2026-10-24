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
  /** Phase 6 (additive: the inbox's embedded contact omits them). Tags from the contact and from its conversation. */
  tags: z.array(z.string()).optional(),
  /** Where and when the contact agreed to receive marketing (`import:<file>`, `keyword_start`, ...); null = no consent on record, so no marketing. */
  consent: z.object({ source: z.string(), at: z.number().int() }).nullable().optional(),
  lastInboundAt: z.number().int().nullable().optional(),
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
  /** Who wrote an outgoing message, so the inbox can mark it (additive; absent = a person or a system message). */
  author: z.enum(['agent', 'bot', 'staff']).nullable().optional(),
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

/** AI agent settings (owner only). `apiKey` never comes back: only `hasApiKey` does. */
export const agentSettingsFields = z.object({
  enabled: z.boolean(),
  persona: z.string().max(1000),
  language: z.enum(['ar', 'en', 'auto']),
  handoffMinutes: z.number().int().min(5).max(1440),
  faqText: z.string().max(20_000),
  provider: z.enum(['workers-ai', 'openai-compatible']),
  /** Only for `openai-compatible`; the platform chooses the Workers AI model. */
  model: z.string().min(1).max(100).regex(/^[\w./:@+-]+$/).nullable(),
  baseUrl: z.string().max(300).nullable(),
});
export const agentSettingsDto = agentSettingsFields.extend({
  hasApiKey: z.boolean(),
  /** AI credits available now (a workspace with its own key is never debited). */
  credits: z.number().int(),
  /** The knowledge base text is searchable (indexed); false while it is being indexed or when it is off. */
  knowledgeReady: z.boolean(),
});
/** Partial update (PUT merges): `apiKey` string = set, null = remove, absent = keep. */
export const agentSettingsUpdate = agentSettingsFields.extend({ apiKey: z.string().min(8).max(400).nullable() }).partial().refine((p) => Object.keys(p).length > 0, 'nothing to change');
export type AgentSettingsDto = z.infer<typeof agentSettingsDto>;
export type AgentSettingsUpdate = z.infer<typeof agentSettingsUpdate>;

/** Phase 6: contacts, imports. */
export const tagName = z.string().trim().min(1).max(32);
export const listContactsQuery = z.object({
  tag: tagName.optional(),
  optedOut: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const listContactsResponse = z.object({ items: z.array(contactDto), nextCursor: z.string().nullable() });
export const setContactTagsRequest = z.object({ tags: z.array(tagName).max(10) });
export const importMapping = z.object({ phone: z.string().min(1).max(100).optional(), name: z.string().min(1).max(100).optional(), tags: z.string().min(1).max(100).optional() });
/** The multipart text fields next to the `file` part. `consented` must be the literal string "true" to grant marketing consent. */
export const createImportFields = z.object({ consented: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'), mapping: z.string().max(1000).optional() });
export const importDto = z.object({
  id: z.string(),
  filename: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  consented: z.boolean(),
  total: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});
export const listImportsResponse = z.object({ items: z.array(importDto) });
export const importRejectsResponse = z.object({ items: z.array(z.object({ line: z.number().int(), reason: z.string() })) });
export type ImportDto = z.infer<typeof importDto>;

/**
 * Phase 6.2: who a campaign may reach. At least one filter, or `everyone: true` (the explicit "all contacts who agreed" audience): an
 * empty filter never silently widens to everybody. Contacts who opted out, or have no consent on record, are never in an audience
 * (`optedOut: false` is accepted for clarity; `true` is refused).
 */
export const segmentCriteria = z.strictObject({
  tags: z.strictObject({ any: z.array(tagName).max(10).optional(), all: z.array(tagName).max(10).optional() }).optional(),
  /** Epoch ms. A contact who never wrote to us has no last inbound and matches neither bound. */
  lastInboundAfter: z.number().int().nonnegative().optional(),
  lastInboundBefore: z.number().int().nonnegative().optional(),
  /** true = has at least one order that is not cancelled / refunded / refused / failed; false = has none. */
  hasOrdered: z.boolean().optional(),
  everyone: z.literal(true).optional(),
  optedOut: z.literal(false).optional(),
}).refine(
  (c) => !!c.tags?.any?.length || !!c.tags?.all?.length || c.lastInboundAfter !== undefined || c.lastInboundBefore !== undefined || c.hasOrdered !== undefined || c.everyone === true,
  { message: 'empty_criteria' },
).refine((c) => c.lastInboundAfter === undefined || c.lastInboundBefore === undefined || c.lastInboundAfter < c.lastInboundBefore, { message: 'empty_range' });
export type SegmentCriteria = z.infer<typeof segmentCriteria>;
export const segmentDto = z.object({ id: z.number().int(), name: z.string(), criteria: segmentCriteria, createdAt: z.number().int(), updatedAt: z.number().int() });
export const createSegmentRequest = z.object({ name: z.string().trim().min(1).max(60), criteria: segmentCriteria });
export const updateSegmentRequest = createSegmentRequest.partial().refine((p) => Object.keys(p).length > 0, 'nothing to change');
export const segmentPreviewRequest = z.object({ criteria: segmentCriteria });
/** `count` = people who would receive a marketing send; `excluded` = people the filter matches but who cannot be messaged, and why. */
export const segmentPreviewDto = z.object({ count: z.number().int().nonnegative(), excluded: z.object({ optedOut: z.number().int().nonnegative(), noConsent: z.number().int().nonnegative() }) });
export const listSegmentsResponse = z.object({ items: z.array(segmentDto) });
export type SegmentDto = z.infer<typeof segmentDto>;
export type SegmentPreviewDto = z.infer<typeof segmentPreviewDto>;

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
  agent: 'GET|PUT /agent',
  contacts: 'GET /contacts',
  contactTags: 'PUT /contacts/:waId/tags',
  imports: 'GET|POST /imports',
  import: 'GET /imports/:importId',
  importRejects: 'GET /imports/:importId/rejects',
  segments: 'GET|POST /segments',
  segment: 'GET|PUT|DELETE /segments/:segmentId',
  segmentPreview: 'POST /segments/preview',
  segmentCount: 'GET /segments/:segmentId/preview',
} as const;
