import type {
  AgentSettingsDto, AgentSettingsUpdate, CampaignCreate, CampaignDto, ContactDto, ConversationDto, ImportDto, MessageDto, OrderSummaryDto,
  RealtimeEvent, SegmentCriteria, SegmentDto, SegmentPreviewDto, SendMessageRequest, TemplateDto,
} from '../../../src/core/api/contract';

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

export type ContactsQuery = { q?: string; tag?: string; optedOut?: boolean; cursor?: string | null };

export interface ContactsApi {
  list(query: ContactsQuery): Promise<{ items: ContactDto[]; nextCursor: string | null }>;
  /** Uploads a CSV for import. `consented` must reflect the owner's explicit tick: it is the marketing consent on record. */
  importCsv(file: File, consented: boolean): Promise<string>;
  imports(): Promise<ImportDto[]>;
  rejects(importId: string): Promise<{ line: number; reason: string }[]>;
}

/** Where the inbox reads from: the live API (contract.ts) or labelled sample data. */
export interface InboxSource {
  kind: 'live' | 'sample';
  currentUserId: string;
  /** The signed-in user's role in this store (GET /me); `staff` hides spending actions. */
  role: Role;
  /** Display names of staff for assignee labels. */
  userNames: Record<string, string>;
  listConversations(filter: ConversationFilter, q: string): Promise<ConversationDto[]>;
  getMessages(conversationId: number): Promise<MessageDto[]>;
  send(conversationId: number, req: SendMessageRequest): Promise<MessageDto>;
  markRead(conversationId: number): Promise<void>;
  orders(waId: string): Promise<{ items: OrderSummaryDto[]; source: 'store' | 'sample' }>;
  templates(): Promise<TemplateDto[]>;
  /** Confirm or refuse a pending COD order (the store stays the writer of order state). */
  recordCodOutcome(waId: string, orderNumber: string, outcome: 'confirmed' | 'refused'): Promise<void>;
  /** What this source can do today (e.g. COD outcomes need the store route, Phase 4). */
  capabilities: { codOutcome: boolean };
  /** A displayable URL for a protected media path (fetch with the token → blob URL). */
  mediaUrl?(path: string): Promise<string>;
  /** Full text of a message longer than 1 KB. */
  longBody?(messageId: number): Promise<string>;
  /** Stages a file for sending; returns the uploadId for a media send. */
  upload?(file: File): Promise<string>;
  /** AI agent settings (owner only); undefined when the source has no agent. */
  agentSettings?(): Promise<AgentSettingsDto | null>;
  saveAgentSettings?(update: AgentSettingsUpdate): Promise<AgentSettingsDto>;
  /** Assign a conversation (null = unassign). */
  assign?(conversationId: number, userId: string | null): Promise<void>;
  campaigns?: CampaignsApi;
  contacts?: ContactsApi;
  /** Called when events were missed beyond repair; the app reloads its list and open chat. */
  onReload?(cb: () => void): () => void;
  /** Realtime events; returns an unsubscribe function. */
  subscribe(onEvent: (e: RealtimeEvent) => void): () => void;
}
