/**
 * The inbox API contract: one file shared by the Worker (validation) and the web app (typed client).
 * All routes live under /api/v1/stores/:storeId/ and require a bearer token (identity v1).
 */
import { REASON_ORDER } from '../../../foundation/instapay-decision';
import { z } from 'zod';
import { hoursSchema, locationSchema, menuSchema } from '../store-link/bot-settings';

export const messageStatus = z.enum(['queued', 'claimed', 'accepted', 'sent', 'delivered', 'read', 'failed', 'retry']);
export const messageType = z.enum(['text', 'template', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'order', 'unsupported']);

export const contactDto = z.object({
  waId: z.string(), // digits, no '+'
  name: z.string().nullable(),
  optedOut: z.boolean(),
  /** Phase 6 (additive: the inbox's embedded contact omits them). Tags from the contact and from its conversation. */
  tags: z.array(z.string()).optional(),
  /** Where and when the contact agreed to receive marketing (`import:<file>`, `keyword_start`, ...); null = no consent on record, so no marketing. */
  consent: z.object({
    source: z.string(),
    at: z.number().int(),
    /** A4: the evidence of the newest grant (absent for consents recorded before proofs were kept). */
    proof: z.object({ source: z.enum(['import', 'opt_in', 'link']), attestedBy: z.string(), wording: z.string(), at: z.number().int(), ref: z.string().nullable() }).optional(),
  }).nullable().optional(),
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
  author: z.enum(['agent', 'bot', 'staff', 'app']).nullable().optional(),
  /** An inbound voice note the agent heard: its `text` is the transcript ('transcribed'), or it could not be heard ('not_transcribed'). Absent = not a voice note the agent handled. */
  voice: z.enum(['transcribed', 'not_transcribed']).optional(),
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
  /** Typeahead: contact name, phone digits or message text; the answer is one page with no cursor. */
  q: z.string().trim().min(1).max(100).optional(),
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
    'window_closed', 'opted_out', 'template_not_approved', 'unsupported_media', 'wallet_empty', 'rate_limited', 'plan_blocked', 'funding_unknown', 'rate_unavailable',
    'registration_locked', 'number_conflict', 'signup_failed', 'signup_unavailable', 'unavailable', 'package_required', 'plan_feature', 'plan_required', 'vat_locked', 'yearly_queued', 'seat_limit', 'no_seat',
  ]),
  message: z.string().optional(),
  /** templates: the rule issues behind a 400, or the moment a 409 edit_limit unlocks (epoch ms). */
  issues: z.array(z.object({ code: z.string(), severity: z.enum(['error', 'warning']), field: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() })).optional(),
  retryAt: z.number().int().optional(),
  /** plan_feature: which plan feature the package lacks (the client shows the upgrade CTA for it). */
  feature: z.enum(['campaigns', 'order_in_chat', 'api']).optional(),
  /** write_off_required: the wallet balance the requester has to agree to give up (piasters). */
  amountMinor: z.number().int().optional(),
});

export const templateEditAllowance = z.union([
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), reason: z.enum(['status', 'daily', 'monthly']), retryAt: z.number().int().nullable() }),
]);
export const templateDto = z.object({
  name: z.string(),
  language: z.string(),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  status: z.enum(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'PENDING_DELETION']),
  bodyText: z.string(),
  paramCount: z.number().int().nonnegative(),
  rejectedReason: z.string().nullable(),
  // additive (merchant template self-service): the merchant's own title, Meta's components, last change, and whether Meta still lets this one be edited
  label: z.string().nullable().optional(),
  components: z.array(z.record(z.string(), z.any())).optional(),
  updatedAt: z.number().int().optional(),
  editAllowance: templateEditAllowance.optional(),
  /** Plain Arabic / English advice for a rejected, paused or disabled template (Meta's raw `rejectedReason` stays alongside it). */
  advice: z.object({ ar: z.string(), en: z.string(), kind: z.enum(['format', 'policy', 'length', 'duplicate', 'category', 'unknown']) }).optional(),
});
const draftButton = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: z.string().max(200) }),
  z.object({ type: z.literal('URL'), text: z.string().max(200), url: z.string().max(2100), example: z.string().max(2100).optional() }),
  z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().max(200), phone: z.string().max(40) }),
  z.object({ type: z.literal('COPY_CODE'), example: z.string().max(40) }),
]);
/** What the Templates screen and the Smart Layer send to check / create / edit. The server re-runs Meta's rules on it; `expectedHash` is the hash of the last check. */
export const templateDraftSchema = z.object({
  name: z.string().min(1).max(512),
  label: z.string().trim().min(1).max(80),
  language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  header: z.object({ text: z.string().max(200), example: z.string().max(200).optional() }).nullable(),
  body: z.object({ text: z.string().max(2000), examples: z.array(z.string().max(300)).max(20) }),
  footer: z.string().max(200).nullable(),
  buttons: z.array(draftButton).max(20),
  auth: z.object({ expiryMinutes: z.number().int().nullable(), securityRecommendation: z.boolean() }).optional(),
});
export type TemplateDraftInput = z.infer<typeof templateDraftSchema>;
/** `expectedHash` is REQUIRED: the approval to submit is bound to the payload that was checked and previewed (the hash `POST /templates/check` returned). */
export const templateDraftRequest = templateDraftSchema.extend({ expectedHash: z.string().regex(/^[0-9a-f]{64}$/) });
export const templateIssueDto = z.object({ code: z.string(), severity: z.enum(['error', 'warning']), field: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() });
export const checkTemplateResponse = z.object({ issues: z.array(templateIssueDto), payloadHash: z.string() });
export const createTemplateResponse = z.object({ name: z.string(), language: z.string(), status: z.string(), category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']), categoryChanged: z.boolean() });
export const editTemplateResponse = z.object({ status: z.string() });
/** A platform template a store on the shared number may use (APPROVED utility / authentication only). */
export const sharedTemplateDto = z.object({ name: z.string(), language: z.string(), category: z.enum(['UTILITY', 'AUTHENTICATION']), bodyText: z.string(), paramCount: z.number().int().nonnegative() });
export const listSharedTemplatesResponse = z.object({ items: z.array(sharedTemplateDto) });
export const sharedRequestCreate = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/),
  category: z.enum(['UTILITY', 'AUTHENTICATION', 'MARKETING']),
  body: z.string().trim().min(1).max(1024),
});
export const sharedRequestDto = z.object({
  id: z.string(), name: z.string(), language: z.string(), category: z.enum(['UTILITY', 'AUTHENTICATION']), body: z.string(),
  status: z.enum(['open', 'done', 'declined']), createdAt: z.number().int(), decidedAt: z.number().int().nullable(),
});
export const listSharedRequestsResponse = z.object({ items: z.array(sharedRequestDto) });
export type SharedTemplateDto = z.infer<typeof sharedTemplateDto>;
export type SharedRequestDto = z.infer<typeof sharedRequestDto>;
export const listTemplatesResponse = z.object({ items: z.array(templateDto), /** the brand's starter set is in place for the connected number (the screen installs it once when this is false and the list is empty) */ starterInstalled: z.boolean().optional() });

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
  capabilities: z.object({ codOutcome: z.boolean(), numbers: z.boolean().optional() }),
});
export type MeResponse = z.infer<typeof meResponse>;

/** Store-link settings (owner only to change). */
export const storeLinkSettingsResponse = z.object({
  orderConfirmations: z.boolean(),
  orderingBot: z.boolean(),
  otpViaWhatsApp: z.boolean(),
  catalogId: z.string().nullable(),
  menu: menuSchema,
  hours: hoursSchema,
  location: locationSchema,
});
/** The merchant-written part of the settings (service menu, business hours, location): what the Bot screen edits. */
/** The Meta catalog of the store link: its id (null = none yet) and when a sync last succeeded. */
export const catalogStatusDto = z.object({
  catalogId: z.string().nullable(),
  lastSyncAt: z.number().int().nullable(),
  /** Items by state: in Meta's catalogue, left out by us (no image, bad image link, no title), refused by Meta. Absent from an older server. */
  items: z.object({ synced: z.number().int(), excluded: z.number().int(), rejected: z.number().int() }).optional(),
  /** The first few items not in the catalogue, with the reason code (no_image, bad_image, no_title, meta_rejected). */
  leftOut: z.array(z.object({ retailerId: z.string(), reason: z.string() })).optional(),
  /** The shop button and the cart on the number (null = not read yet). `failed` = the last attempt to set them did not work. */
  commerce: z.object({ catalogVisible: z.boolean(), cartEnabled: z.boolean(), failed: z.enum(['missing_permission', 'meta_error']).nullable() }).nullable().optional(),
  /** The last sync failed: `missing_permission` = reconnect and approve catalogue access; `sync_failed` = Meta or the Store did not answer. Null = fine. */
  error: z.enum(['missing_permission', 'sync_failed']).nullable().optional(),
  /** A full pass is running (large catalogues take several runs). */
  syncing: z.boolean().optional(),
  /** Changes waiting to be sent. */
  pending: z.number().int().optional(),
});
export const catalogCommerceRequest = z.object({ catalogVisible: z.boolean(), cartEnabled: z.boolean() }).strict();
export const catalogResyncResponse = z.object({ started: z.boolean() });
export type RetentionDto = z.infer<typeof retentionDto>;
export type CatalogStatusDto = z.infer<typeof catalogStatusDto>;
/** Strict on purpose: the business is never taken from the client (a business id in the body is a 400). */
export const provisionCatalogRequest = z.object({ name: z.string().trim().min(1).max(100).optional() }).strict();
export const provisionCatalogResponse = z.object({ catalogId: z.string() });
export const botSettingsDto = storeLinkSettingsResponse.pick({ menu: true, hours: true, location: true });
export type BotSettingsDto = z.infer<typeof botSettingsDto>;
export const storeLinkSettingsPatch = z.object({
  orderConfirmations: z.boolean(),
  orderingBot: z.boolean(),
  otpViaWhatsApp: z.boolean(),
  catalogId: z.string().regex(/^\d{5,25}$/).nullable(),
  menu: menuSchema,
  hours: hoursSchema,
  location: locationSchema,
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
  /** The promises the agent may make (reply guard, Ruling WA-GUARD-PROMISE-1). All default off: the FAQ text never switches one on. */
  allowRefund: z.boolean(),
  allowDiscount: z.boolean(),
  allowFreeDelivery: z.boolean(),
  allowExchange: z.boolean(),
  allowGuarantee: z.boolean(),
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

// ---- Phase 9.3: connectors (the agent's tools into a client's own systems; owner only) ---------------------------------
export const connectorId = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/).max(16);
const toolName = z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/).max(40);
/** One argument of a webhook tool: the model supplies only strings, numbers, booleans or one of a fixed list of words. */
export const webhookParam = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,29}$/),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  description: z.string().max(200).optional(),
  required: z.boolean().optional(),
  /** Strings only (default 200). */
  maxLength: z.number().int().min(1).max(500).optional(),
  /** Enums only. */
  values: z.array(z.string().min(1).max(60)).min(1).max(20).optional(),
  /** Numbers only. */
  min: z.number().optional(),
  max: z.number().optional(),
}).refine((p) => (p.type === 'enum') === (p.values !== undefined), 'values belong to enums only');
export const webhookTool = z.object({
  name: toolName,
  description: z.string().min(1).max(300),
  params: z.array(webhookParam).max(10),
}).refine((t) => new Set(t.params.map((p) => p.name)).size === t.params.length, 'duplicate parameter');
export const webhookConfig = z.object({
  url: z.string().max(300),
  tools: z.array(webhookTool).min(1).max(10),
}).refine((c) => new Set(c.tools.map((t) => t.name)).size === c.tools.length, 'duplicate tool');
export const odooConfig = z.object({
  url: z.string().max(300),
  database: z.string().regex(/^[\w.-]{1,63}$/),
  login: z.string().min(1).max(100),
});
/** Full replace of the connector's settings. `secret` (webhook signing secret / Odoo API key): a string sets it, absent keeps it; never returned. */
export const connectorPut = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('webhook'), enabled: z.boolean(), config: webhookConfig, secret: z.string().min(16).max(400).optional() }),
  z.object({ kind: z.literal('odoo'), enabled: z.boolean(), config: odooConfig, secret: z.string().min(8).max(400).optional() }),
]);
export const connectorDto = z.object({
  id: connectorId,
  kind: z.enum(['webhook', 'odoo']),
  enabled: z.boolean(),
  hasSecret: z.boolean(),
  config: z.union([webhookConfig, odooConfig]),
  /** The names the model sees (`<id>__<tool>`). */
  tools: z.array(z.string()),
  updatedAt: z.number().int(),
  updatedBy: z.string().nullable(),
});
export const connectorTestResult = z.object({ ok: z.boolean(), error: z.string().optional(), detail: z.string().optional() });
export type ConnectorDto = z.infer<typeof connectorDto>;
export type ConnectorPut = z.infer<typeof connectorPut>;
export type WebhookConfig = z.infer<typeof webhookConfig>;
export type WebhookTool = z.infer<typeof webhookTool>;
export type WebhookParam = z.infer<typeof webhookParam>;
export type OdooConfig = z.infer<typeof odooConfig>;

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
/** PATCH /contacts/:waId: a name the merchant gives the contact (null = follow WhatsApp's name again). */
export const renameContactRequest = z.object({ name: z.string().trim().min(1).max(100).nullable() }).strict();
/** POST /contacts/merge: the same person on a new number. Both are WhatsApp ids (digits). */
export const mergeContactsRequest = z.object({ fromWaId: z.string().regex(/^[1-9]\d{7,14}$/), intoWaId: z.string().regex(/^[1-9]\d{7,14}$/) }).strict().refine((b) => b.fromWaId !== b.intoWaId);
/** GET /contacts/:waId/export (B5): a page of the person's messages. */
export const exportContactQuery = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) });
/** PUT /retention (B4): the owner's message window in days; null = the platform default. */
export const retentionRequest = z.object({ days: z.number().int().min(30).max(3650).nullable() }).strict();
export const retentionDto = z.object({ days: z.number().int().nullable(), effectiveDays: z.number().int(), defaultDays: z.number().int(), minDays: z.number().int(), maxDays: z.number().int() });
/**
 * GET /members (WA-SEATS-1): the team as the Store knows it, with each person's seat here. `seat` is 'owner' (always works, counts as one), 'seated',
 * 'over_limit' (holds a row beyond what the package now allows: refused until a seat is freed) or 'none'. `seats.limit` counts the owner.
 */
export const memberSeat = z.enum(['owner', 'seated', 'over_limit', 'none']);
export const memberDto = z.object({ userId: z.string(), displayName: z.string(), role: z.enum(['owner', 'staff']), addedAt: z.string(), seat: memberSeat });
export const listMembersResponse = z.object({ items: z.array(memberDto), seats: z.object({ limit: z.number().int().min(1), used: z.number().int().min(1), overLimit: z.boolean() }) });
export type MemberDto = z.infer<typeof memberDto>;
export type ListMembersResponse = z.infer<typeof listMembersResponse>;
export const seatResponse = z.object({ userId: z.string(), seat: z.enum(['seated']) });
export const contactSummaryDto = z.object({ waId: z.string(), name: z.string().nullable(), optedOut: z.boolean() });
export const importMapping = z.object({ phone: z.string().min(1).max(100).optional(), name: z.string().min(1).max(100).optional(), tags: z.string().min(1).max(100).optional() });
/** The multipart text fields next to the `file` part. `consented` must be the literal string "true" to grant marketing consent. */
export const createImportFields = z.object({ consented: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'), wording: z.string().trim().min(1).max(500).optional(), mapping: z.string().max(1000).optional() });
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

/** Phase 6.3: broadcast campaigns. A template send to an audience, paged, paced against the number's tier, pausable. */
export const campaignParam = z.discriminatedUnion('kind', [
  /** The same text for everyone. A media header takes its https link here. */
  z.object({ kind: z.literal('text'), value: z.string().min(1).max(1000) }),
  /** The contact's name; `fallback` when we have none. */
  z.object({ kind: z.literal('name'), fallback: z.string().min(1).max(60) }),
  /** The recipient's own tracked short link (the full https URL), for a text parameter. Needs the campaign's `linkUrl`. */
  z.object({ kind: z.literal('link') }),
  /** Only the recipient's link code, for a template URL button written `https://<this service>/t/{{1}}`. Needs `linkUrl`. */
  z.object({ kind: z.literal('link_code') }),
]);
export const campaignStatus = z.enum(['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled']);
export const campaignPauseReason = z.enum(['manual', 'wallet_empty', 'template_unavailable', 'internal_error', 'plan_blocked', 'funding_unknown', 'rate_unavailable', 'quality_flagged', 'operator_paused']);
/** W2-OPS: every kill-switch action carries a reason (kept in the append-only audit). */
export const operatorKillSwitch = z.object({ reason: z.string().trim().min(5).max(300) });
/** W2-OFFBOARD: an owner asks to delete the workspace (explicit confirmation; a wallet balance has to be given up explicitly). Strict: an owner cannot skip the cooling-off. */
export const offboardingRequest = z.object({ confirm: z.literal(true), acceptWriteOff: z.boolean().optional(), reason: z.string().trim().min(5).max(300).optional() }).strict();
/** GET /stores/:id/offboarding. `none` = nothing asked yet; the other fields exist from `pending` on. */
export const offboardingDto = z.object({
  state: z.enum(['none', 'pending', 'running', 'done', 'cancelled']), requestedRole: z.enum(['owner', 'operator']).optional(),
  requestedAt: z.number().int().optional(), executeAfter: z.number().int().optional(), writeOffMinor: z.number().int().optional(),
});
/** GET /operator/workspaces/:id/offboarding and the list: the status plus the audit trail of the request (previous values are in `detail`). */
export const operatorOffboardingDto = z.object({
  workspaceId: z.string(), state: z.enum(['pending', 'running', 'done', 'cancelled']), requestedBy: z.string(), requestedRole: z.enum(['owner', 'operator']), reason: z.string().nullable(),
  requestedAt: z.number().int(), executeAfter: z.number().int(), writeOffMinor: z.number().int(), stepsDone: z.array(z.string()), attempts: z.number().int(), lastError: z.string().nullable(), finishedAt: z.number().int().nullable(), needsSecondApproval: z.boolean().optional(),
  log: z.array(z.object({ at: z.number().int(), actor: z.string(), action: z.string(), reason: z.string().nullable() })).optional(),
});
/** An operator asks (a reason is required and audited); `immediate` skips the cooling-off. */
export const operatorOffboardingRequest = z.object({ reason: z.string().trim().min(5).max(300), immediate: z.boolean().optional(), acceptWriteOff: z.boolean().optional() }).strict();
/** GET /operator/audit-log (T8): filters and a cursor (`before` = the smallest id already seen). */
export const auditLogQuery = z.object({
  workspaceId: z.string().min(1).max(100).optional(), actor: z.string().min(1).max(100).optional(), action: z.string().min(1).max(200).optional(),
  before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const auditLogItemDto = z.object({
  id: z.number().int(), at: z.number().int(), workspaceId: z.string().nullable(), actor: z.string(), actorRole: z.enum(['owner', 'staff', 'operator', 'integration', 'system']),
  action: z.string(), targetType: z.string().nullable(), targetId: z.string().nullable(), status: z.number().int(),
});
export const healthState = z.enum(['green', 'yellow', 'red', 'restricted']);
const opsNumberHealth = z.object({ phoneNumberId: z.string(), health: healthState, healthReason: z.string().nullable(), healthAt: z.number().int().nullable() });
/** GET /operator/workspaces/:id/ops: what the kill-switch card shows for one workspace and for the platform number. */
export const opsStatusDto = z.object({
  suspended: z.boolean(), suspendedReason: z.string().nullable(), integrationsRevokedAt: z.number().int().nullable(), evicted: z.boolean(),
  numbers: z.array(opsNumberHealth), sharedNumber: opsNumberHealth.nullable(),
  recentActions: z.array(z.object({ at: z.number().int(), actor: z.string(), action: z.string(), reason: z.string() })),
});
export type OpsStatusDto = z.infer<typeof opsStatusDto>;
export const campaignCreate = z.object({
  name: z.string().trim().min(1).max(80),
  template: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(10) }),
  params: z.array(campaignParam).max(20).default([]),
  audience: z.union([z.strictObject({ segmentId: z.number().int().positive() }), z.strictObject({ criteria: segmentCriteria })]),
  /** At most this many recipients are queued per rolling 24 h; the rest wait for the next day. */
  dailySendLimit: z.number().int().min(1).max(1_000_000).optional(),
  /** Where the tracked links lead: https, a real host. Required with a `link` / `link_code` parameter, refused without one. */
  linkUrl: z.string().trim().min(1).max(2000).optional(),
});
export type CampaignCreate = z.input<typeof campaignCreate>;
/** `scheduledAt` (epoch ms, at most a year ahead) = start then; absent = start now. */
export const sendCampaignRequest = z.object({ scheduledAt: z.number().int().positive().optional() });
export const campaignCounts = z.object({
  queued: z.number().int(), claimed: z.number().int(), retry: z.number().int(), accepted: z.number().int(), sent: z.number().int(),
  delivered: z.number().int(), read: z.number().int(), failed: z.number().int(), skipped: z.number().int(),
});
export const campaignDto = z.object({
  id: z.string(),
  name: z.string(),
  status: campaignStatus,
  pauseReason: campaignPauseReason.nullable(),
  template: z.object({ name: z.string(), language: z.string() }),
  category: z.string(),
  params: z.array(campaignParam),
  audience: z.object({ segmentId: z.number().int().nullable(), criteria: segmentCriteria }),
  scheduledAt: z.number().int().nullable(),
  dailySendLimit: z.number().int().nullable(),
  linkUrl: z.string().nullable(),
  /** Recipients who opened their link at least once, and all opens. Link-preview fetches are not counted. */
  clicks: z.object({ unique: z.number().int(), total: z.number().int() }),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  /** Messages by their own status, plus `skipped` (a recipient who could not be messaged, never sent). */
  counts: campaignCounts,
  /** Roll-up: sent = accepted by Meta or further; delivered/read are cumulative; pending = not yet with Meta. */
  totals: z.object({ recipients: z.number().int(), pending: z.number().int(), sent: z.number().int(), delivered: z.number().int(), read: z.number().int(), failed: z.number().int(), skipped: z.number().int() }),
  /** Before sending: how many people it would reach and what the wallet expects it to cost (piasters; 0 until a wallet is configured). */
  estimate: z.object({ audience: z.number().int(), perMessageMinor: z.number().int(), totalMinor: z.number().int() }).optional(),
});
export const listCampaignsQuery = z.object({
  status: campaignStatus.optional(),
  cursor: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const listCampaignsResponse = z.object({ items: z.array(campaignDto), nextCursor: z.string().nullable() });
export type CampaignDto = z.infer<typeof campaignDto>;
export type CampaignParam = z.infer<typeof campaignParam>;

export const customerOrdersResponse = z.object({ items: z.array(orderSummaryDto), source: z.enum(['store', 'sample']) });

export type ContactDto = z.infer<typeof contactDto>;
export type MessageDto = z.infer<typeof messageDto>;
export type ConversationDto = z.infer<typeof conversationDto>;
export type TemplateDto = z.infer<typeof templateDto>;
export type NoteDto = z.infer<typeof noteDto>;
export type OrderSummaryDto = z.infer<typeof orderSummaryDto>;
export type ApiError = z.infer<typeof apiError>;

/** Route table (paths relative to /api/v1/stores/:storeId). */
// ---- Billing (Phase 7). Additive. Amounts are integer piasters (EGP x 100); the currency is always EGP. ----
export const fundingKind = z.enum(['merchant_card', 'platform_line']);
/** The payer shown per number: `unknown` = no funding row yet (the server refuses sends for it as funding_unknown), never a guess. */
export const walletFundingKind = z.enum(['merchant_card', 'platform_line', 'unknown']);
export const billingCategory = z.enum(['marketing', 'utility', 'authentication', 'service']);
export const walletDto = z.object({
  /** Additive: the owner's newest InstaPay rejection not yet opened (shown as an inbox notice with the reason). */
  instapayNotice: z.object({ id: z.string(), reason: z.string() }).nullable().optional(),
  balanceMinor: z.number().int(),
  heldMinor: z.number().int(),
  /** balance - held; can be negative inside the overdraft. */
  availableMinor: z.number().int(),
  debtMinor: z.number().int().nonnegative(),
  creditLimitMinor: z.number().int().nonnegative(),
  currency: z.literal('EGP'),
  /** Who pays Meta, per connected number: merchant_card = Meta bills the merchant's card (the UI shows the notice), platform_line = this wallet, unknown = not set up yet. */
  funding: z.array(z.object({ phoneNumberId: z.string(), displayPhone: z.string().nullable(), funding: walletFundingKind })),
  topupsEnabled: z.boolean(),
  /** Additive: false while no card provider can confirm its webhooks (Kashier not configured). The screen then offers InstaPay only, never a card button that would answer 503 (Ruling WA-INSTAPAY-LAUNCH-1). Absent = an older server. */
  cardCheckout: z.boolean().optional(),
  lowBalance: z.boolean(),
  /** The wallet is low under this many minor units: max(20 EGP, 3 days of the last week's average Meta spend). */
  lowBalanceThresholdMinor: z.number().int().nonnegative(),
  /** One credit = one AI turn. `low` = available under a tenth of the monthly `allowance` (never under 5 credits, `lowThreshold`). */
  aiCredits: z.object({ balance: z.number().int(), available: z.number().int(), low: z.boolean(), lowThreshold: z.number().int().nonnegative(), allowance: z.number().int().nonnegative() }),
  plan: z.object({ packageId: z.string(), status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired']), periodEnd: z.number().int(), cancelledAt: z.number().int().nullable() }).nullable(),
});
export type WalletDto = z.infer<typeof walletDto>;

/** T13: the weekly usage digest. Counts and amounts only. `{ enabled: false }` when the owner switched it off. */
export const digestDto = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true), from: z.number().int(), to: z.number().int(),
    customersWrote: z.number().int(), messagesIn: z.number().int(), messagesOut: z.number().int(), delivered: z.number().int(), failed: z.number().int(),
    aiReplies: z.number().int(), aiCreditsUsed: z.number().int(), handoffs: z.number().int(), campaignRecipients: z.number().int(), optOuts: z.number().int(),
    spendMinor: z.number().int(), topupsMinor: z.number().int(), balanceMinor: z.number().int(), availableMinor: z.number().int(), lowBalance: z.boolean(),
    aiCredits: z.object({ available: z.number().int(), low: z.boolean(), lowThreshold: z.number().int(), allowance: z.number().int() }),
  }),
]);
export type DigestDto = z.infer<typeof digestDto>;
export const digestSettings = z.object({ enabled: z.boolean() });

export const walletMoney = z.object({ count: z.number().int(), netMinor: z.number().int(), vatMinor: z.number().int(), amountMinor: z.number().int() });
export const statementRowDto = z.object({
  at: z.number().int(), kind: z.string(), netMinor: z.number().int(), vatMinor: z.number().int(), amountMinor: z.number().int(), balanceAfterMinor: z.number().int(),
  ref: z.string(), wamid: z.string().nullable(), category: z.string().nullable(), note: z.string().nullable(),
});
export const statementDto = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/), from: z.number().int(), to: z.number().int(), openingMinor: z.number().int(), closingMinor: z.number().int(),
  rows: z.array(statementRowDto), truncated: z.boolean(),
  totalsByKind: z.record(z.string(), walletMoney), totalsByCategory: z.record(z.string(), walletMoney),
  cardCosts: z.array(z.object({ category: z.string(), count: z.number().int(), usdMicros: z.number().int() })),
});
export type StatementDto = z.infer<typeof statementDto>;
export const statementQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), format: z.enum(['json', 'csv']).default('json') });

/** What a send would cost before it is made. perMessageMinor is what THIS WALLET pays (0 when Meta bills the merchant's card). */
export const costEstimateQuery = z.object({ category: billingCategory, count: z.coerce.number().int().min(1).max(1_000_000).default(1), country: z.string().regex(/^[A-Z]{2,3}$/).optional() });
export const costEstimateDto = z.object({
  funding: fundingKind, paidBy: z.enum(['wallet', 'merchant_card']), perMessageMinor: z.number().int().nonnegative(), totalMinor: z.number().int().nonnegative(), priced: z.boolean(), currency: z.literal('EGP'),
});

export const topupRequest = z.object({ amountMinor: z.number().int().min(1000).max(5_000_000) });
export const topupDto = z.object({
  orderId: z.string(), state: z.enum(['pending', 'paid', 'failed', 'expired']), amountMinor: z.number().int(), feeMinor: z.number().int(), totalMinor: z.number().int(),
  checkoutUrl: z.string().url().optional(),
});
/** Packages a merchant can buy (PACKAGE_CHECKOUT_ENABLED). The amount is the server's price; the client never sends one. */
/** Feature keys in display order (shared with marketing and the Store plan comparison). */
export const PACKAGE_FEATURE_KEYS = ['members', 'shared_inbox', 'order_confirmations', 'templates', 'campaigns', 'order_in_chat', 'api', 'priority_support', 'ai_credits'] as const;
export const packageDto = z.object({
  id: z.string(), name: z.string(), priceMinor: z.number().int().positive(), aiCredits: z.number().int().nonnegative(),
  maxMembers: z.number().int().min(1), features: z.array(z.enum(PACKAGE_FEATURE_KEYS)), periodMonths: z.number().int().positive(),
});
export const packageOrderDto = z.object({ orderId: z.string(), state: z.enum(['pending', 'paid', 'failed', 'expired', 'refunded']), packageId: z.string(), amountMinor: z.number().int(), checkoutUrl: z.string().url().optional() });
// ---- InstaPay billing (INSTAPAY_BILLING_ENABLED). Additive. The amount is the server's: a package's price, or a top-up within the card top-up bounds. ----
export const instapayState = z.enum(['awaiting_proof', 'under_review', 'confirmed', 'rejected', 'expired']);
export const instapayCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('package'), packageId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('topup'), amountMinor: z.number().int().min(1000).max(5_000_000) }).strict(),
]);
export const instapayPayeeDto = z.object({ handle: z.string(), name: z.string(), qrUrl: z.string().url().nullable() });
export const instapayRequestDto = z.object({
  id: z.string(), reference: z.string(), kind: z.enum(['package', 'topup']), packageId: z.string().nullable(), amountMinor: z.number().int(), currency: z.string(), state: instapayState,
  createdAt: z.number().int(), expiresAt: z.number().int(), hasProof: z.boolean(), rejectReason: z.string().nullable(), decidedAt: z.number().int().nullable(),
  /** InstaPay auto-confirm: confirmed by the system, being checked right now, or reverted ("not received") with the end of its 48 h grace. All optional: older servers send none. */
  autoConfirmed: z.boolean().optional(), checking: z.boolean().optional(), revertedAt: z.number().int().nullable().optional(), graceUntil: z.number().int().nullable().optional(),
});
/** GET /wallet/instapay: `payee` is null when the brand has no InstaPay account configured (the card is then shown as unavailable). */
export const instapayViewDto = z.object({ enabled: z.boolean(), payee: instapayPayeeDto.nullable(), items: z.array(instapayRequestDto), revert: z.object({ requestId: z.string(), kind: z.enum(['package', 'topup']), graceUntil: z.number().int() }).nullable().optional() });
export const instapayCreatedDto = instapayRequestDto.extend({ payee: instapayPayeeDto });
export const operatorInstapayDto = instapayRequestDto.extend({
  workspaceId: z.string(), createdBy: z.string(), proofAt: z.number().int().nullable(), firstApprover: z.string().nullable(), decidedBy: z.string().nullable(), proofMime: z.string().nullable(),
  /** C2: set while the request cannot be confirmed because its image or bank reference was seen on another request (`heldOf`). */
  heldReason: z.enum(['duplicate_image', 'duplicate_reference']).nullable().optional(), heldOf: z.string().nullable().optional(), bankRef: z.string().nullable().optional(),
});
/** Confirming may carry the bank's own transaction reference, read from the proof (optional; a re-used one is refused). */
/** DUP-REF-REQUIRED-1: the bank reference is required for every amount; a proof that shows none is confirmed with `noReference: true` and a reason (audited). */
export const instapayConfirm = z.object({ bankRef: z.string().trim().min(1).max(60).optional(), noReference: z.literal(true).optional(), reason: z.string().trim().min(5).max(300).optional() }).strict()
  .refine((b) => !b.noReference || (!b.bankRef && !!b.reason), { message: 'no_reference_needs_reason' })
  .refine((b) => b.noReference || !b.reason, { message: 'reason_only_with_no_reference' });
export const instapayRelease = z.object({ reason: z.string().trim().min(5).max(300) });
export const instapayReject = z.object({ reason: z.string().trim().min(3).max(300) });
export const refundRequestCreate = z.object({ amountMinor: z.number().int().min(5000), note: z.string().trim().max(500).optional() });
/** An operator refunded the card in the provider's dashboard to pay a manual payout and links that refund to the request. `orderId` (the top-up) is optional. */
export const refundDashboardLink = z.object({ kashierRefundId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), amountMinor: z.number().int().positive(), orderId: z.string().min(1).max(64).optional() });
export const refundRequestDto = z.object({
  id: z.string(), workspaceId: z.string(), amountMinor: z.number().int(), note: z.string().nullable(), state: z.enum(['pending', 'rejected', 'processing', 'paid', 'manual_payout', 'failed', 'abandoning', 'abandoned']),
  requestedBy: z.string(), createdAt: z.number().int(), decidedBy: z.string().nullable(), decidedAt: z.number().int().nullable(), decisionNote: z.string().nullable(),
  cardRefundedMinor: z.number().int(), manualMinor: z.number().int(),
});

// Operator (super admin) — /api/v1/operator/*
export const pricingSettingsDto = z.object({
  ver: z.number().int(), effectiveFrom: z.number().int(), marginBps: z.number().int(), creditLimitMinor: z.number().int(), fxBufferBps: z.number().int(), vatBps: z.number().int(), actor: z.string(), reason: z.string(),
});
/** `effectiveFrom` must be at least 1 h ahead (absent = in 1 h). A reason is mandatory and is audited with old -> new. */
export const pricingSettingsPublish = z.object({
  effectiveFrom: z.number().int().positive().optional(), marginBps: z.number().int().min(0).max(100_000), creditLimitMinor: z.number().int().min(0).max(10_000_000),
  fxBufferBps: z.number().int().min(0).max(10_000), vatBps: z.number().int().min(0).max(10_000), reason: z.string().trim().min(5).max(500),
});
export const pricingOverridePublish = z.object({ effectiveFrom: z.number().int().positive().optional(), marginBps: z.number().int().min(0).max(100_000), reason: z.string().trim().min(5).max(500) });
export const rateCardPublish = z.object({
  /** At least 24 h ahead. */
  effectiveFrom: z.number().int().positive(),
  rates: z.array(z.object({ country: z.string().regex(/^[A-Z]{2,3}$/), category: z.string().regex(/^[a-z_]{3,32}$/), usdMicros: z.number().int().min(0).max(1_000_000_000) })).min(1).max(2000),
  reason: z.string().trim().min(5).max(500),
});
export const fxBufferPin = z.object({ bufferBps: z.number().int().min(0).max(10_000).nullable(), reason: z.string().trim().min(5).max(500) });
export const fxBackfill = z.object({ days: z.number().int().min(1).max(400).default(365), reason: z.string().trim().min(5).max(500) });
export const fxPublish = z.object({ effectiveFrom: z.number().int().positive(), egpPerUsdMicros: z.number().int().min(1).max(1_000_000_000_000), bufferBps: z.number().int().min(0).max(10_000), reason: z.string().trim().min(5).max(500) });
export const operatorFundingSet = z.object({ funding: z.enum(['merchant_card', 'platform_line']), reason: z.string().trim().min(5).max(500) });
export const operatorSubscriptionSet = z.object({ packageId: z.string().min(1).max(64), status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired']), periodEnd: z.number().int().positive(), reason: z.string().trim().min(5).max(500) });
export const operatorAdjustmentCreate = z.object({ amountMinor: z.number().int().refine((n) => n !== 0), reason: z.string().trim().min(5).max(500) });
export const operatorDecision = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() });
export const trueupPublish = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), phoneNumberId: z.string().min(1), actualMinor: z.number().int().min(0) });
export const changeLogItemDto = z.object({ id: z.number().int(), at: z.number().int(), actor: z.string(), action: z.string(), workspaceId: z.string().nullable(), before: z.unknown(), after: z.unknown(), reason: z.string().nullable() });

/** Bot results (funnel): steps in the order of the flow, then the side steps. */
export const FUNNEL_STEPS = ['conversation', 'browse', 'cart', 'checkout', 'order', 'menu', 'handoff'] as const;
export const funnelStep = z.enum(FUNNEL_STEPS);
export const FUNNEL_MAX_DAYS = 92;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => { const t = Date.parse(`${s}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(s); }, 'not a calendar date');
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const botFunnelQuery = z.object({ from: ymd, to: ymd }).strict().refine((q) => q.from <= q.to && daysBetween(q.from, q.to) < FUNNEL_MAX_DAYS, 'range must be 1 to 92 days');
/** Counts only: `series[i]` belongs to `days[i]` (Cairo calendar days). `total` is customer-days: a customer who comes on two days counts on both. */
export const botFunnelDto = z.object({ from: ymd, to: ymd, days: z.array(z.string()), steps: z.array(z.object({ step: funnelStep, total: z.number().int(), series: z.array(z.number().int()) })) });
export type BotFunnelDto = z.infer<typeof botFunnelDto>;

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
  templatesCheck: 'POST /templates/check',
  template: 'GET|PUT|DELETE /templates/:name/:language',
  templatesInstallDefaults: 'POST /templates/install-defaults',
  media: 'GET /media/:messageId',
  upload: 'POST /media',
  events: 'GET /events',
  ws: 'GET /ws',
  orders: 'GET /contacts/:waId/orders',
  codOutcome: 'POST /contacts/:waId/orders/:orderNumber/cod-outcome',
  me: 'GET /me',
  storeLinkSettings: 'GET|PATCH /store-link/settings',
  storeLinkCatalog: 'GET /store-link/catalog',
  provisionCatalog: 'POST /store-link/catalog/provision',
  botFunnel: 'GET /bot/funnel',
  agent: 'GET|PUT /agent',
  connectors: 'GET /connectors',
  connector: 'PUT|DELETE /connectors/:connectorId',
  connectorTest: 'POST /connectors/:connectorId/test',
  contacts: 'GET /contacts',
  contactTags: 'PUT /contacts/:waId/tags',
  imports: 'GET|POST /imports',
  import: 'GET /imports/:importId',
  importRejects: 'GET /imports/:importId/rejects',
  segments: 'GET|POST /segments',
  segment: 'GET|PUT|DELETE /segments/:segmentId',
  segmentPreview: 'POST /segments/preview',
  segmentCount: 'GET /segments/:segmentId/preview',
  campaigns: 'GET|POST /campaigns',
  campaign: 'GET|DELETE /campaigns/:campaignId',
  campaignSend: 'POST /campaigns/:campaignId/send',
  campaignPause: 'POST /campaigns/:campaignId/pause',
  campaignResume: 'POST /campaigns/:campaignId/resume',
  campaignCancel: 'POST /campaigns/:campaignId/cancel',
  numbers: 'GET /numbers',
  signupConfig: 'GET /numbers/signup-config',
  numberConnect: 'POST /numbers/connect',
  numberRefresh: 'POST /numbers/:phoneNumberId/refresh',
  numberRegister: 'POST /numbers/:phoneNumberId/register',
  numberDisconnect: 'POST /numbers/:phoneNumberId/disconnect',
  wallet: 'GET /wallet',
  walletStatement: 'GET /wallet/statement?month=YYYY-MM[&format=csv]',
  walletEstimate: 'GET /wallet/estimate?category=&count=&country=',
  walletTopups: 'POST /wallet/topups',
  walletTopup: 'GET /wallet/topups/:orderId',
  walletRefundRequests: 'GET|POST /wallet/refund-requests',
  packages: 'GET /packages',
  packageCheckout: 'POST /packages/:packageId/checkout',
  packageOrder: 'GET /packages/orders/:orderId',
  operator: 'GET|POST /api/v1/operator/{pricing-settings,pricing-overrides/:workspaceId,rate-cards,fx-rates,numbers/:phoneNumberId/funding,workspaces/:workspaceId/subscription,refund-requests,adjustments,trueups,change-log}',
} as const;

// ---- Phase 8.1: connecting a merchant's own number (Embedded Signup) -------------------------------------------------
const metaId = z.string().regex(/^[0-9]{1,30}$/);
/** FINISH = a new Cloud API number; FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING = an existing WhatsApp Business app number (coexistence). */
export const signupEvent = z.enum(['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING']);
export const connectNumberRequest = z.object({
  /** The one-time code from the Embedded Signup popup; it expires 30 seconds after it is issued. */
  code: z.string().min(1).max(2048),
  event: signupEvent,
  wabaId: metaId,
  phoneNumberId: metaId,
  businessId: metaId.optional(),
});
export type ConnectNumberRequest = z.infer<typeof connectNumberRequest>;

export const numberDto = z.object({
  phoneNumberId: z.string(),
  wabaId: z.string(),
  displayPhone: z.string().nullable(),
  verifiedName: z.string().nullable(),
  kind: z.enum(['own', 'platform']),
  onboarding: z.enum(['cloud_api', 'business_app']).nullable(),
  /** active = can send and receive; disconnected = removed, or not finished (see registration). */
  status: z.enum(['active', 'disconnected']),
  registration: z.enum(['pending', 'registered', 'failed', 'locked', 'not_needed']).nullable(),
  qualityRating: z.string().nullable(),
  messagingLimitTier: z.string().nullable(),
  throughputLevel: z.string().nullable(),
  nameStatus: z.string().nullable(),
  platformType: z.string().nullable(),
  isOnBizApp: z.boolean().nullable(),
  /** Outcome of the one-time syncs for a number kept on the WhatsApp Business app. */
  historySync: z.enum(['requested', 'refused', 'declined', 'received']).nullable(),
  contactsSync: z.enum(['requested', 'refused', 'received']).nullable(),
  connectedAt: z.number().int().nullable(),
  /** The last moment the one-time syncs can still be requested (24 h after onboarding); null when they do not apply. */
  syncDeadlineAt: z.number().int().nullable(),
  lastStatusSyncAt: z.number().int().nullable(),
  /** W2-META: green = fine; yellow = flagged (campaigns paused); red / restricted = no new template sends. Meta's own rating is `qualityRating`. */
  health: z.enum(['green', 'yellow', 'red', 'restricted']).optional(),
});
/** Owner-visible notices about a connection (final review I5): a person who connected the number removed the app from Meta. Nothing was disconnected. */
export const numberNoticeDto = z.object({ id: z.number().int(), kind: z.string(), wabaId: z.string(), at: z.number().int() });
export const listNumbersResponse = z.object({ items: z.array(numberDto), notices: z.array(numberNoticeDto).default([]) });
export type NumberNoticeDto = z.infer<typeof numberNoticeDto>;
/** GET /numbers/signup-config: public Meta ids for launching Embedded Signup in the page. */
export const signupConfigDto = z.object({ appId: z.string(), configId: z.string(), graphVersion: z.string() });
export type NumberDto = z.infer<typeof numberDto>;

// ---- Phase 8.2: the shared platform number. ----
/**
 * A display name as customers will see it: invisible marks (bidi, joiners, variation selectors, Hangul fillers and every other
 * default-ignorable code point, plus the braille blank) removed, space runs collapsed, outer space trimmed.
 */
export const canonicalDisplayName = (s: string): string => s.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, '').replace(/\s+/g, ' ').trim();
const sharedDisplayName = z.string().transform(canonicalDisplayName).pipe(z.string().min(2).max(60));
/** POST /shared-number/join. The display name is what customers read in the "which store?" list; absent = the workspace name. */
export const sharedNumberJoin = z.object({ displayName: sharedDisplayName.optional() });
/** GET /shared-number. `available` = the operator has registered a platform number; `member` = this store sends and receives through it. */
export const sharedNumberDto = z.object({
  available: z.boolean(),
  member: z.boolean(),
  displayName: z.string().nullable(),
  displayPhone: z.string().nullable(),
  /** Additive: true when the store is not a member and its plan does not include the shared number (joining answers 402 package_required). */
  packageRequired: z.boolean().optional(),
});
export type SharedNumberDto = z.infer<typeof sharedNumberDto>;
/** POST /operator/shared-numbers (super admin). Registers the platform number and records its funding (platform_line) in the same write. */
export const sharedNumberRegister = z.object({
  phoneNumberId: z.string().regex(/^[0-9]{1,30}$/),
  wabaId: z.string().regex(/^[0-9]{1,30}$/),
  displayPhone: z.string().trim().min(5).max(30).optional(),
  reason: z.string().trim().min(5).max(500),
});

/** InstaPay auto-confirm (operator): one decision per request, with every reason code (the console shows a label for each). */
export const AUTO_REASON_CODES = REASON_ORDER;
export const operatorAutoDto = z.object({
  requestId: z.string(), workspaceId: z.string(), workspaceName: z.string().nullable(), kind: z.enum(['package', 'topup']).nullable(),
  state: z.enum(['pending_decision', 'auto_confirmed', 'needs_human', 'reverted', 'failed']), verdict: z.string().nullable(), reasons: z.array(z.string()),
  amountMinor: z.number().int().nullable(), expectedAmountMinor: z.number().int().nullable(), isFirstPayment: z.boolean().nullable(), confirmedAt: z.number().int().nullable(),
  digestSentAt: z.number().int().nullable(), revertedAt: z.number().int().nullable(), graceUntil: z.number().int().nullable(), creditsRemovedMinor: z.number().int().nullable(),
  creditsUsedMinor: z.number().int().nullable(), aiCreditsRemoved: z.number().int().nullable(), aiCreditsUsed: z.number().int().nullable(), createdAt: z.number().int(),
});
export const operatorAutoListDto = z.object({ mode: z.enum(['off', 'shadow', 'live']), ready: z.object({ ready: z.boolean(), missing: z.array(z.string()) }), items: z.array(operatorAutoDto) });
