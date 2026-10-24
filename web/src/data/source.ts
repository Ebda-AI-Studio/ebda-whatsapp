import type { AgentSettingsDto, AgentSettingsUpdate, ConversationDto, MessageDto, OrderSummaryDto, RealtimeEvent, SendMessageRequest, TemplateDto } from '../../../src/core/api/contract';

export type ConversationFilter = 'all' | 'unread' | 'mine' | 'unassigned';

/** Where the inbox reads from: the live API (contract.ts) or labelled sample data. */
export interface InboxSource {
  kind: 'live' | 'sample';
  currentUserId: string;
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
  /** Called when events were missed beyond repair; the app reloads its list and open chat. */
  onReload?(cb: () => void): () => void;
  /** Realtime events; returns an unsubscribe function. */
  subscribe(onEvent: (e: RealtimeEvent) => void): () => void;
}
