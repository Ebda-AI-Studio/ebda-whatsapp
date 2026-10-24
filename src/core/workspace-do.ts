import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { migrate } from './do-migrations';
import type { InboundMessage, StatusEvent } from './meta/webhook-schema';
import type { SendJob } from './send-queue';

export const PREVIEW_CHARS = 280;
export const INLINE_BODY_BYTES = 1024;

export type IngestBatch = { phoneNumberId: string; inbound: InboundMessage[]; statuses: StatusEvent[]; receivedAt: number };
export type IngestResult = { stored: number; duplicates: number; replies: SendJob[] };
export type WorkspaceConfig = { autoReplyText?: string };

/** One tenant's data: a SQLite-backed Durable Object per workspace. */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => migrate(this.sql));
  }

  private get workspaceId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  async ingest(batch: IngestBatch, config: WorkspaceConfig = {}): Promise<IngestResult> {
    // Large bodies go to R2 first (outside the transaction); the key is content-addressed by wamid so a retry rewrites the same object.
    const bodies = new Map<string, string>();
    for (const m of batch.inbound) {
      if (m.text && new TextEncoder().encode(m.text).byteLength > INLINE_BODY_BYTES) {
        const key = `bodies/${this.workspaceId}/${m.wamid}`;
        await this.env.MEDIA.put(key, m.text);
        bodies.set(m.wamid, key);
      }
    }
    const result: IngestResult = { stored: 0, duplicates: 0, replies: [] };
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      for (const m of batch.inbound) {
        const contactId = this.sql.exec<{ id: number }>(
          `INSERT INTO contacts (wa_id, profile_name, last_inbound_at) VALUES (?, ?, ?)
           ON CONFLICT(wa_id) DO UPDATE SET profile_name = coalesce(excluded.profile_name, profile_name), last_inbound_at = max(coalesce(last_inbound_at, 0), excluded.last_inbound_at)
           RETURNING id`,
          m.from, m.profileName ?? null, m.ts,
        ).one().id;
        const conversationId = this.sql.exec<{ id: number }>(
          `INSERT INTO conversations (contact_id, last_message_at) VALUES (?, ?)
           ON CONFLICT(contact_id) DO UPDATE SET last_message_at = max(coalesce(last_message_at, 0), excluded.last_message_at)
           RETURNING id`,
          contactId, m.ts,
        ).one().id;
        const inserted = this.sql.exec(
          `INSERT INTO messages (wamid, conversation_id, direction, type, preview, body_r2_key, created_at, updated_at)
           VALUES (?, ?, 'in', ?, ?, ?, ?, ?) ON CONFLICT(wamid) DO NOTHING`,
          m.wamid, conversationId, m.type, m.text ? [...m.text].slice(0, PREVIEW_CHARS).join('') : null, bodies.get(m.wamid) ?? null, m.ts * 1000, now,
        ).rowsWritten;
        if (inserted === 0) {
          result.duplicates++;
          continue;
        }
        result.stored++;
        this.sql.exec('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
        if (m.type === 'text' && config.autoReplyText) {
          result.replies.push({
            workspaceId: this.workspaceId,
            phoneNumberId: batch.phoneNumberId,
            to: m.from,
            text: config.autoReplyText,
            idempotencyKey: `reply:${m.wamid}`,
            inboundAt: m.ts * 1000,
          });
        }
      }
    });
    return result;
  }
}
