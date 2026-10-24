import type { Env } from '../../env';
import type { SendJob } from '../send-queue';

/** What the Store-link code needs from the workspace Durable Object. Implemented by WorkspaceDO; never exposed over RPC. */
export interface LinkHost {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly env: Env;
  readonly workspaceId: string;
  /** Contact and conversation for a WhatsApp id (digits, no +), created if missing. Call inside a transaction. */
  ensureConversation(waId: string, now: number, profileName?: string | null): { contactId: number; conversationId: number };
  /** Inserts an outbound 'queued' message row (search index, realtime events included). Call inside a transaction. */
  insertOutbound(conversationId: number, row: OutboundRow, now: number): number;
  emitConversationUpdated(conversationId: number): void;
  /** Re-points the single alarm at the earliest task. */
  arm(): Promise<void>;
  /** Erases one contact and everything about it (data-protection request). */
  eraseContact(waId: string): Promise<{ found: boolean }>;
}

export type OutboundRow = {
  type: string;
  preview: string;
  body: string | null;
  key: string;
  templateName?: string;
  templateLang?: string;
};

export type JobSink = { jobs: SendJob[] };
