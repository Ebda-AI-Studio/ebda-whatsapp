import type { ConversationDto, MessageDto, OrderSummaryDto, RealtimeEvent, SendMessageRequest, TemplateDto } from '../../../src/core/api/contract';

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
  /** Realtime events; returns an unsubscribe function. */
  subscribe(onEvent: (e: RealtimeEvent) => void): () => void;
}
