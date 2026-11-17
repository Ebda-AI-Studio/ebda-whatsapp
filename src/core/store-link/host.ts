import type { Env } from '../../env';
import type { Billing } from '../billing/engine';
import type { SendJob } from '../send-queue';

/** What the Store-link code needs from the workspace Durable Object. Implemented by WorkspaceDO; never exposed over RPC. */
export interface LinkHost {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly env: Env;
  readonly workspaceId: string;
  /** The workspace's wallet (holds, charges). Synchronous: call it inside the same transaction as the message it settles. */
  readonly billing: Billing;
  /** Brings the copy of the price inputs up to date (cheap when it is fresh). Await it before a wallet decision that is not part of a send. */
  ensurePricing(): Promise<void>;
  /** Contact and conversation for a WhatsApp id (digits, no +), created if missing. Call inside a transaction. */
  ensureConversation(waId: string, now: number, profileName?: string | null): { contactId: number; conversationId: number };
  /** Inserts an outbound 'queued' message row (search index, realtime events included). Call inside a transaction. */
  insertOutbound(conversationId: number, row: OutboundRow, now: number): number;
  emitConversationUpdated(conversationId: number): void;
  /** Voice note result, first write wins: a transcript becomes the message's text (voice_state 'ok'), null marks it never transcribed ('failed'). False = the message is gone. Inbox clients are told. */
  recordVoice(messageId: number, transcript: string | null): boolean;
  /** Re-points the single alarm at the earliest task. */
  arm(): Promise<void>;
  /** Sends an already-stored message now (claim, throttle, Meta call, record); falls back to the send queue on a retryable failure. */
  deliver(job: SendJob): Promise<void>;
  /** Pause between two sends of one bot turn, so WhatsApp keeps their order. */
  readonly sendGapMs: number;
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
  /** Who wrote it, for the inbox to mark: the AI agent, the ordering bot or a person. Absent = a system message. */
  author?: 'agent' | 'bot' | 'staff';
};

export type JobSink = { jobs: SendJob[] };
