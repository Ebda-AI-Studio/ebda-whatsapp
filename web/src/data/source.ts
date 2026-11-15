import type {
  AgentSettingsDto, AgentSettingsUpdate, BotFunnelDto, BotSettingsDto, BotSwitchesDto, ThrottleReportDto, CatalogStatusDto, CampaignCreate, ConnectNumberRequest, NumberDto, NumberNoticeDto, CampaignDto, ContactDto, ConversationDto, ImportDto, MessageDto, OrderSummaryDto,
  ListMembersResponse, RealtimeEvent, RetentionDto, SegmentCriteria, SegmentDto, SegmentPreviewDto, SendMessageRequest, SharedNumberDto, SharedRequestDto, SharedTemplateDto, TemplateDto,
} from '../../../src/core/api/contract';

import type { RuleIssue } from '../../../src/core/meta/template-rules';
import type { TemplateDraft } from '../../../src/core/template-draft';
import type { OperatorApi, WalletApi } from './billing';
import type { SharedTemplatesApi } from './shared-templates';
import type { AssistantApi } from './assistant';

export type ConversationFilter = 'all' | 'unread' | 'mine' | 'unassigned';
export type Role = 'owner' | 'staff' | 'super_admin';

/** Broadcasts (Phase 6). The server checks every role; the UI only hides what the role cannot do. */
export interface CampaignsApi {
  list(): Promise<CampaignDto[]>;
  get(id: string): Promise<CampaignDto>;
  /** Creates a draft; the returned draft carries the audience size and cost estimate. */
  create(req: CampaignCreate): Promise<CampaignDto>;
  send(id: string, scheduledAt?: number): Promise<CampaignDto>;
  pause(id: string): Promise<CampaignDto>;
  resume(id: string): Promise<CampaignDto>;
  cancel(id: string): Promise<CampaignDto>;
  remove(id: string): Promise<void>;
  segments(): Promise<SegmentDto[]>;
  preview(criteria: SegmentCriteria): Promise<SegmentPreviewDto>;
}

/**
 * Merchant template self-service on the merchant's OWN WhatsApp account. The server checks every role; the UI only hides what the role cannot do.
 * Rejections are ApiErrors: `detail` = exists | in_use | edit_limit (with `extra.retryAt`) | payload_changed | not_editable | not_deletable | token_unavailable | invalid_template (with `extra.issues`) | no_active_number (404).
 */
export interface TemplatesApi {
  list(): Promise<{ items: TemplateDto[]; starterInstalled: boolean }>;
  detail(name: string, language: string): Promise<TemplateDto>;
  /** Free: Meta's rules against a draft, and the hash that `create` / `edit` must carry to prove the sent draft is the checked one. */
  check(d: TemplateDraft): Promise<{ issues: RuleIssue[]; payloadHash: string }>;
  create(d: TemplateDraft, expectedHash: string): Promise<{ name: string; language: string; status: string; category: TemplateDto['category']; categoryChanged: boolean }>;
  edit(name: string, language: string, d: TemplateDraft, expectedHash: string): Promise<{ status: string }>;
  remove(name: string, language: string): Promise<void>;
  sync(): Promise<{ upserted: number; removed: number }>;
  installDefaults(): Promise<{ submitted: string[]; skipped: string[]; failed: string[] }>;
  /** A store on the SHARED number (no own number): the platform's sendable templates and its asks for new utility ones. `list` rejects with 404 for a store that is not on the shared number. */
  shared?: {
    list(): Promise<SharedTemplateDto[]>;
    requests(): Promise<SharedRequestDto[]>;
    /** Rejects with an ApiError `rate_limited` (429, `too_many_open_requests`) at 5 open requests, and 400 `marketing_not_on_shared_number`. */
    request(r: { name: string; language: string; category: 'UTILITY' | 'AUTHENTICATION'; body: string }): Promise<SharedRequestDto>;
  };
}

/** Team seats (owner only; WA-SEATS-1). `assign` rejects with an ApiError `seat_limit` (status 403) when the package has no seat left, and 503 when the team cannot be read. */
export interface TeamApi {
  list(): Promise<ListMembersResponse>;
  assign(userId: string): Promise<void>;
  unassign(userId: string): Promise<void>;
}

/** A merchant's own WhatsApp numbers (Phase 8.1); absent when Embedded Signup is switched off. */
export interface NumbersApi {
  list(): Promise<NumberDto[]>;
  /** Owner-visible notices about connections (a person who connected a number removed the app); absent in sample data. */
  notices?(): Promise<NumberNoticeDto[]>;
  /** The owner keeps the numbers connected and closes the notice. */
  dismissNotice?(id: number): Promise<void>;
  /** Public Meta ids for the signup popup; null when signup is not configured on the server. */
  signupConfig(): Promise<{ appId: string; configId: string; graphVersion: string } | null>;
  connect(req: ConnectNumberRequest): Promise<NumberDto>;
  refresh(phoneNumberId: string): Promise<NumberDto>;
  register(phoneNumberId: string): Promise<NumberDto>;
  disconnect(phoneNumberId: string): Promise<NumberDto>;
  /** The shared platform number (absent, or `status` rejecting with 404, = the feature is off). Joining needs a plan that includes it: a 402 `package_required`. */
  shared?: { status(): Promise<SharedNumberDto>; join(displayName?: string): Promise<SharedNumberDto>; leave(): Promise<SharedNumberDto> };
  /** Loads what the popup needs ahead of the click (sample data and tests replace it); absent = Meta's SDK. */
  prepare?: (cfg: { appId: string; configId: string; graphVersion: string }) => Promise<void>;
  /** Replaces Meta's popup (sample data and tests only); absent = the real Embedded Signup. */
  launch?: (cfg: { appId: string; configId: string; graphVersion: string }) => Promise<{ code: string; event: ConnectNumberRequest['event']; wabaId: string; phoneNumberId: string; businessId?: string }>;
}

export type ContactsQuery = { q?: string; tag?: string; optedOut?: boolean; cursor?: string | null };

export interface ContactsApi {
  list(query: ContactsQuery, signal?: AbortSignal): Promise<{ items: ContactDto[]; nextCursor: string | null }>;
  /** Uploads a CSV for import. `consented` must reflect the owner's explicit tick: it is the marketing consent on record. */
  importCsv(file: File, consented: boolean, wording?: string): Promise<string>;
  imports(): Promise<ImportDto[]>;
  rejects(importId: string): Promise<{ line: number; reason: string }[]>;
  /** A name the merchant gives a contact (null = follow WhatsApp's name again). */
  renameContact(waId: string, name: string | null): Promise<{ waId: string; name: string | null; optedOut: boolean }>;
  /** B5: all of one contact's data (every page of messages joined). Owner only. */
  exportContact(waId: string): Promise<unknown>;
  /** M-175: the same person on a new number. Owner only; cannot be undone. */
  mergeContacts(fromWaId: string, intoWaId: string): Promise<void>;
  /** B4: how long messages are kept (owner only). `days: null` = the platform default. */
  retention(): Promise<RetentionDto>;
  setRetention(days: number | null): Promise<RetentionDto>;
}

/** Where the inbox reads from: the live API (contract.ts) or labelled sample data. */
export interface InboxSource {
  kind: 'live' | 'sample';
  /** T35: an operator looking at a merchant's workspace, read-only (every request carries the view-as headers; the server refuses writes). */
  viewAs?: boolean;
  currentUserId: string;
  /** The store this session is for (the upgrade card builds the Store billing link from it). */
  storeId?: string;
  /** The signed-in user's role in this store (GET /me); `staff` hides spending actions. */
  role: Role;
  /** Display names of staff for assignee labels. */
  userNames: Record<string, string>;
  /** `signal` aborts a search the user has already typed past (the caller also drops its answer if it still arrives). */
  listConversations(filter: ConversationFilter, q: string, signal?: AbortSignal): Promise<ConversationDto[]>;
  getMessages(conversationId: number): Promise<MessageDto[]>;
  send(conversationId: number, req: SendMessageRequest): Promise<MessageDto>;
  markRead(conversationId: number): Promise<void>;
  orders(waId: string): Promise<{ items: OrderSummaryDto[]; source: 'store' | 'sample' }>;
  templates(): Promise<TemplateDto[]>;
  /** Confirm or refuse a pending COD order (the store stays the writer of order state). */
  recordCodOutcome(waId: string, orderNumber: string, outcome: 'confirmed' | 'refused'): Promise<void>;
  /** What this source can do today (e.g. COD outcomes need the store route, Phase 4). */
  capabilities: { codOutcome: boolean; numbers?: boolean; assistant?: boolean };
  /** A displayable URL for a protected media path (fetch with the token → blob URL). */
  mediaUrl?(path: string): Promise<string>;
  /** Full text of a message longer than 1 KB. */
  longBody?(messageId: number): Promise<string>;
  /** Stages a file for sending; returns the uploadId for a media send. */
  upload?(file: File): Promise<string>;
  /** AI agent settings (owner only); undefined when the source has no agent. */
  agentSettings?(): Promise<AgentSettingsDto | null>;
  saveAgentSettings?(update: AgentSettingsUpdate): Promise<AgentSettingsDto>;
  /** Service menu, business hours and store location. Everyone may read; only the owner may save (the server decides). */
  botSettings?(): Promise<BotSettingsDto>;
  saveBotSettings?(update: BotSettingsDto): Promise<BotSettingsDto>;
  /** The merchant's Meta catalog. `provision` rejects with an error carrying `detail` = missing_permission | no_business | business_mismatch | catalog_already_set | meta_error. */
  catalog?: {
    status(): Promise<CatalogStatusDto>;
    provision(name?: string): Promise<{ catalogId: string }>;
    /** Starts a fresh full pass of the sync (owner). Rejects with `detail` = catalog_not_set. */
    resync(): Promise<{ started: boolean }>;
    /** Turns the shop button and the cart on the number on or off (owner). Rejects with `detail` = missing_permission | catalog_not_set | meta_error. */
    setCommerce(v: { catalogVisible: boolean; cartEnabled: boolean }): Promise<{ catalogVisible: boolean; cartEnabled: boolean }>;
  };
  /**
   * The owner switches (ordering bot, order confirmations, store-login codes over WhatsApp) and the sending-speed report. Turning confirmations or codes ON takes
   * `preview` first, then `save` with its single-use token (`save` rejects with `detail` = confirm_required | confirm_invalid | confirm_expired). `throttle` is null when no number is connected.
   */
  switches?: {
    get(): Promise<BotSwitchesDto>;
    preview(change: Partial<BotSwitchesDto>): Promise<{ confirmToken: string }>;
    save(change: Partial<BotSwitchesDto>, confirmToken?: string): Promise<BotSwitchesDto>;
    throttle(): Promise<ThrottleReportDto | null>;
  };
  /** Bot results: customers per step over the last 7, 30 or 90 days (Cairo calendar days, today included). Counts only; owner and staff read. */
  botFunnel?(days: 7 | 30 | 90): Promise<BotFunnelDto>;
  /** Assign a conversation (null = unassign). */
  assign?(conversationId: number, userId: string | null): Promise<void>;
  campaigns?: CampaignsApi;
  /** Create, submit, edit and delete templates; absent in builds that cannot manage them. */
  templatesApi?: TemplatesApi;
  numbers?: NumbersApi;
  /** The assistant side panel (answer-only for now); offered only while `capabilities.assistant` is true (the server's own switch for this store). */
  assistant?: AssistantApi;
  /** The team and its seats; offered to the owner only. */
  team?: TeamApi;
  contacts?: ContactsApi;
  /** Wallet, statement, top-ups and refunds (Phase 7). */
  wallet?: WalletApi;
  /** Super-admin console; only offered when `role` is super_admin. */
  operator?: OperatorApi;
  /** Signs the person out (clears tokens, ends the provider session where possible). Offered only by a build that has its own sign-in. */
  signOut?(): void;
  /** The platform WABA's templates (super admin only, with `operator`). */
  sharedTemplates?: SharedTemplatesApi;
  /** Called when events were missed beyond repair; the app reloads its list and open chat. */
  onReload?(cb: () => void): () => void;
  /** Realtime events; returns an unsubscribe function. */
  subscribe(onEvent: (e: RealtimeEvent) => void): () => void;
}
