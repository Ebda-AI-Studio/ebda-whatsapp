import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { migrate } from './do-migrations';
import type { InboundMessage, StatusEvent } from './meta/webhook-schema';
import type { SendResult } from './meta/client';
import type { SendJob } from './send-queue';

export const PREVIEW_CHARS = 280;
export const INLINE_BODY_BYTES = 1024;
/** A claim older than this is presumed crashed and may be re-claimed once (duplicate risk vs drop risk: we accept one possible duplicate). */
export const STALE_CLAIM_MS = 2 * 60 * 1000;
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 } as const;

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
          // Redelivery heals a lost enqueue: offer the reply again until its send is claimed (claimSend dedupes).
          const claimed = this.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', `reply:${m.wamid}`).toArray().length > 0;
          if (!claimed && m.type === 'text' && config.autoReplyText) result.replies.push(this.replyJob(batch, m, config.autoReplyText));
          continue;
        }
        result.stored++;
        this.sql.exec('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
        if (m.type === 'text' && config.autoReplyText) {
          result.replies.push(this.replyJob(batch, m, config.autoReplyText));
        }
      }
      for (const st of batch.statuses) this.applyStatusSync(st);
    });
    return result;
  }

  private replyJob(batch: IngestBatch, m: InboundMessage, text: string): SendJob {
    return { workspaceId: this.workspaceId, phoneNumberId: batch.phoneNumberId, to: m.from, text, idempotencyKey: `reply:${m.wamid}`, inboundAt: m.ts * 1000, receivedAt: batch.receivedAt };
  }

  /** Claims the right to send `job` once. Only 'claimed' may call Meta. */
  async claimSend(job: SendJob): Promise<'claimed' | 'already_sent' | 'in_flight'> {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const existing = this.sql
        .exec<{ id: number; status: string; updated_at: number; claim_attempts: number }>('SELECT id, status, updated_at, claim_attempts FROM messages WHERE idempotency_key = ?', job.idempotencyKey)
        .toArray()[0];
      if (!existing) {
        const contactId = this.sql.exec<{ id: number }>(
          'INSERT INTO contacts (wa_id) VALUES (?) ON CONFLICT(wa_id) DO UPDATE SET wa_id = wa_id RETURNING id', job.to,
        ).one().id;
        const conversationId = this.sql.exec<{ id: number }>(
          'INSERT INTO conversations (contact_id, last_message_at) VALUES (?, ?) ON CONFLICT(contact_id) DO UPDATE SET last_message_at = excluded.last_message_at RETURNING id',
          contactId, Math.floor(now / 1000),
        ).one().id;
        this.sql.exec(
          `INSERT INTO messages (conversation_id, direction, type, preview, status, idempotency_key, claim_attempts, created_at, updated_at)
           VALUES (?, 'out', 'text', ?, 'claimed', ?, 1, ?, ?)`,
          conversationId, [...job.text].slice(0, PREVIEW_CHARS).join(''), job.idempotencyKey, now, now,
        );
        return 'claimed';
      }
      if (existing.status === 'retry' || (existing.status === 'claimed' && now - existing.updated_at > STALE_CLAIM_MS && existing.claim_attempts < 2)) {
        this.sql.exec("UPDATE messages SET status = 'claimed', claim_attempts = claim_attempts + 1, updated_at = ? WHERE id = ?", now, existing.id);
        return 'claimed';
      }
      return existing.status === 'claimed' ? 'in_flight' : 'already_sent';
    });
  }

  async recordOutbound(idempotencyKey: string, result: SendResult): Promise<void> {
    const now = Date.now();
    if (result.ok) {
      this.sql.exec("UPDATE messages SET wamid = ?, status = 'accepted', updated_at = ? WHERE idempotency_key = ?", result.wamid, now, idempotencyKey);
    } else if (result.retryable) {
      this.sql.exec("UPDATE messages SET status = 'retry', error_code = ?, updated_at = ? WHERE idempotency_key = ?", result.code, now, idempotencyKey);
    } else {
      this.sql.exec("UPDATE messages SET status = 'failed', error_code = ?, updated_at = ? WHERE idempotency_key = ?", result.code, now, idempotencyKey);
    }
  }

  async applyStatus(e: StatusEvent): Promise<{ applied: boolean }> {
    return this.ctx.storage.transactionSync(() => ({ applied: this.applyStatusSync(e) }));
  }

  /** Records every status event; the message keeps its highest state. 'failed' applies only before delivery. */
  private applyStatusSync(e: StatusEvent): boolean {
    const msg = this.sql.exec<{ id: number; status_rank: number }>('SELECT id, status_rank FROM messages WHERE wamid = ?', e.wamid).toArray()[0];
    let applied = false;
    if (msg) {
      if (e.status === 'failed') applied = msg.status_rank < STATUS_RANK.delivered;
      else applied = STATUS_RANK[e.status] > msg.status_rank;
      if (applied) {
        const rank = e.status === 'failed' ? msg.status_rank : STATUS_RANK[e.status];
        this.sql.exec('UPDATE messages SET status = ?, status_rank = ?, error_code = coalesce(?, error_code), updated_at = ? WHERE id = ?', e.status, rank, e.errorCode ?? null, Date.now(), msg.id);
      }
    }
    this.sql.exec('INSERT INTO message_status_events (wamid, status, ts, applied, error_code) VALUES (?, ?, ?, ?, ?)', e.wamid, e.status, e.ts, applied ? 1 : 0, e.errorCode ?? null);
    return applied;
  }
}
