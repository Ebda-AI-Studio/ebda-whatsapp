import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { BACKUP_HOUR_LOCAL, BACKUP_TABLES, BACKUP_TIME_ZONE, backupManifestSchema, backupPrefix, nextLocalHour, sha256Hex, toNdjson, type BackupManifest } from './backup';
import { DO_MIGRATIONS, migrate } from './do-migrations';
import type { SendResult } from './meta/client';
import type { InboundMessage, StatusEvent } from './meta/webhook-schema';
import type { SendJob } from './send-queue';
import { jobKind } from './send-queue';
import type { MessageDto, SendMessageRequest } from './api/contract';
import { MESSAGE_COLUMNS, WINDOW_MS, messageDto, type MessageRow } from './dto';
import { outboundMediaFor } from './media';
import { detectOptIn, detectOptOut } from './consent';
import { DAILY_KINDS, addTask, backoffMs, dueTasks, earliestDue, type TaskKind } from './scheduler';
import { sendJobSchema } from './send-queue';
import { normaliseText } from './text-normalise';
import { conversationDto, type ConversationRow } from './dto';
import type { ConversationDto, NoteDto } from './api/contract';
import { DEFAULT_MPS, DEFAULT_TIER, TIER_WINDOW_MS, bucketDecision } from './throttle';
import { bodyTextOf, componentsSchema, paramCount, renderTemplate } from './templates';
import type { TemplateDto } from './api/contract';

export const PREVIEW_CHARS = 280;
export const INLINE_BODY_BYTES = 1024;
/** A claim older than this is presumed crashed and may be re-claimed once (duplicate risk vs drop risk: we accept one possible duplicate). */
export const STALE_CLAIM_MS = 2 * 60 * 1000;
/** failed sits between sent and delivered: it beats a late 'sent', but never undoes a delivery. */
const STATUS_RANK = { sent: 1, failed: 2, delivered: 3, read: 4 } as const;

export type IngestBatch = { phoneNumberId: string; inbound: InboundMessage[]; statuses: StatusEvent[]; receivedAt: number };
export type IngestResult = { stored: number; duplicates: number; replies: SendJob[] };
export type WorkspaceConfig = { autoReplyText?: string; optInKeywords?: string[] };
export type OutboundRefusal = 'window_closed' | 'opted_out' | 'template_not_approved' | 'unsupported_media' | 'invalid_request' | 'not_found';
export type QueueOutboundResult = { ok: true; message: MessageDto; job: SendJob | null } | { ok: false; reason: OutboundRefusal; message?: string };
/** What a scheduled task may carry. Stored as JSON and re-validated when it runs. */
export type TaskPayload = { job?: SendJob; reason?: 'tier' | 'throughput' | 'frequency_cap'; n?: number };
export type ClaimResult = 'claimed' | 'already_sent' | 'in_flight' | 'dropped' | 'deferred';
export type ThrottleReport = { tier: number; mps: number; usedInWindow: number; waiting: number; nextSlotAt: number | null };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** First PREVIEW_CHARS user-perceived characters; never splits an emoji or a combining mark. */
export function previewOf(text: string): string {
  let out = '';
  let n = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (n++ === PREVIEW_CHARS) break;
    out += segment;
  }
  return out;
}

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;
/** R2 accepts at most 1000 keys per delete call. */
export const R2_DELETE_BATCH = 1000;

export type EraseResult = { found: boolean; messages: number; statusEvents: number; r2Objects: number; r2Pending: number };

/** One tenant's data: a SQLite-backed Durable Object per workspace. */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage);
      this.reindexIfEmpty();
    });
  }

  /** The workspace id is the DO name. Never fall back to the hex id: idFromName(hex) is a different, empty DO. */
  private get workspaceId(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error('WorkspaceDO must be addressed with idFromName(workspaceId)');
    return name;
  }

  private bodyColumns(text: string | undefined, r2Key: string | undefined): { preview: string | null; body: string | null; key: string | null } {
    if (text === undefined) return { preview: null, body: null, key: null };
    return { preview: previewOf(text), body: r2Key ? null : text, key: r2Key ?? null };
  }

  async ingest(batch: IngestBatch, config: WorkspaceConfig = {}): Promise<IngestResult> {
    const workspaceId = this.workspaceId;
    // Large bodies go to R2 first (outside the transaction); skipped for a wamid we already stored, so redelivery writes nothing.
    const bodies = new Map<string, string>();
    for (const m of batch.inbound) {
      if (!m.text || byteLength(m.text) <= INLINE_BODY_BYTES) continue;
      if (this.sql.exec('SELECT 1 FROM messages WHERE wamid = ?', m.wamid).toArray().length) continue;
      const key = `bodies/${workspaceId}/${m.wamid}`;
      await this.env.MEDIA.put(key, m.text);
      bodies.set(m.wamid, key);
    }
    await this.ensureBackupAlarm();
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
        const optOut = m.type === 'text' && !!m.text && detectOptOut(m.text);
        const cols = this.bodyColumns(m.text, bodies.get(m.wamid));
        const inserted = this.sql.exec<{ id: number }>(
          `INSERT INTO messages (wamid, conversation_id, direction, type, preview, body, body_r2_key, created_at, updated_at)
           VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?) ON CONFLICT(wamid) DO NOTHING RETURNING id`,
          m.wamid, conversationId, m.type, cols.preview, cols.body, cols.key, m.ts * 1000, now,
        ).toArray()[0];
        if (!inserted) {
          result.duplicates++;
          // Redelivery heals a lost enqueue: offer the reply again until its send is claimed (claimSend dedupes).
          const claimed = this.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', `reply:${m.wamid}`).toArray().length > 0;
          if (!claimed && !optOut && m.type === 'text' && config.autoReplyText) result.replies.push(this.replyJob(workspaceId, batch, m, config.autoReplyText));
          continue;
        }
        result.stored++;
        this.indexMessage(inserted.id, cols.preview);
        this.sql.exec('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
        if (optOut) {
          // A reply to STOP is optional under Meta's rules and we send none: the opt-out is silent and immediate.
          this.sql.exec("UPDATE contacts SET opted_out_at = coalesce(opted_out_at, ?), consent_source = 'keyword_stop', consent_at = ? WHERE id = ?", m.ts * 1000, now, contactId);
        } else if (m.type === 'text' && m.text && detectOptIn(m.text, config.optInKeywords)) {
          this.sql.exec("UPDATE contacts SET opted_out_at = NULL, consent_source = 'keyword_start', consent_at = ? WHERE id = ? AND opted_out_at IS NOT NULL", now, contactId);
        }
        if (!optOut && m.type === 'text' && config.autoReplyText) result.replies.push(this.replyJob(workspaceId, batch, m, config.autoReplyText));
      }
      for (const st of batch.statuses) this.applyStatusSync(st);
    });
    return result;
  }

  private replyJob(workspaceId: string, batch: IngestBatch, m: InboundMessage, text: string): SendJob {
    return { workspaceId, phoneNumberId: batch.phoneNumberId, to: m.from, text, idempotencyKey: `reply:${m.wamid}`, inboundAt: m.ts * 1000, receivedAt: batch.receivedAt };
  }

  /**
   * Claims the right to send `job` once. Only 'claimed' may call Meta. 'dropped' = nothing left to send (the row was
   * erased with its contact, or an API job lost its row): the consumer acks it without calling Meta.
   */
  async claimSend(job: SendJob, now = Date.now()): Promise<ClaimResult> {
    let deferred = false;
    const result = this.ctx.storage.transactionSync((): ClaimResult => {
      const claim = this.claimRow(job, now);
      if (claim !== 'claimed') return claim;
      const wait = this.throttle(job, now);
      if (!wait) return 'claimed';
      // Over a Meta limit: give the claim back, keep the message 'queued', and let the scheduler release it later.
      this.sql.exec("UPDATE messages SET status = 'queued', claim_attempts = max(0, claim_attempts - 1), updated_at = ? WHERE idempotency_key = ?", now, job.idempotencyKey);
      addTask(this.sql, 'send_release', wait.dueAt, { job, reason: wait.reason });
      deferred = true;
      return 'deferred';
    });
    if (deferred) await this.arm();
    return result;
  }

  private claimRow(job: SendJob, now: number): ClaimResult {
    {
      const existing = this.sql
        .exec<{ id: number; status: string; updated_at: number; claim_attempts: number }>('SELECT id, status, updated_at, claim_attempts FROM messages WHERE idempotency_key = ?', job.idempotencyKey)
        .toArray()[0];
      if (!existing) {
        // Only auto-reply jobs (no row yet) may create their row; a job created by the API always has one, so a missing row means it was erased.
        if (jobKind(job) !== 'text' || job.idempotencyKey.startsWith('ui:') || !job.text) return 'dropped';
        const contactId = this.sql.exec<{ id: number }>(
          'INSERT INTO contacts (wa_id) VALUES (?) ON CONFLICT(wa_id) DO UPDATE SET wa_id = wa_id RETURNING id', job.to,
        ).one().id;
        const conversationId = this.sql.exec<{ id: number }>(
          'INSERT INTO conversations (contact_id, last_message_at) VALUES (?, ?) ON CONFLICT(contact_id) DO UPDATE SET last_message_at = excluded.last_message_at RETURNING id',
          contactId, Math.floor(now / 1000),
        ).one().id;
        const replyId = this.sql.exec<{ id: number }>(
          `INSERT INTO messages (conversation_id, direction, type, preview, body, status, idempotency_key, claim_attempts, created_at, updated_at)
           VALUES (?, 'out', 'text', ?, ?, 'claimed', ?, 1, ?, ?) RETURNING id`,
          conversationId, previewOf(job.text), job.text, job.idempotencyKey, now, now,
        ).one().id;
        this.indexMessage(replyId, previewOf(job.text));
        return 'claimed';
      }
      if (existing.status === 'queued' || existing.status === 'retry' || (existing.status === 'claimed' && now - existing.updated_at > STALE_CLAIM_MS && existing.claim_attempts < 2)) {
        this.sql.exec("UPDATE messages SET status = 'claimed', claim_attempts = claim_attempts + 1, updated_at = ? WHERE id = ?", now, existing.id);
        return 'claimed';
      }
      return existing.status === 'claimed' ? 'in_flight' : 'already_sent';
    }
  }

  private limitsFor(phoneNumberId: string): { tier: number; mps: number; tokens: number; tokens_at: number; alerted_at: number } {
    return (
      this.sql.exec<{ tier: number; mps: number; tokens: number; tokens_at: number; alerted_at: number }>('SELECT tier, mps, tokens, tokens_at, alerted_at FROM number_limits WHERE phone_number_id = ?', phoneNumberId).toArray()[0]
      ?? { tier: DEFAULT_TIER, mps: DEFAULT_MPS, tokens: DEFAULT_MPS, tokens_at: 0, alerted_at: 0 }
    );
  }

  /**
   * The two Meta limits, checked in one transaction with the claim. Returns null to go ahead (and records the slot and
   * the token), or when and why to retry. (1) tier: a recipient whose 24 h window is closed is business-initiated and
   * takes a slot among the number's unique recipients of the rolling 24 h; replies inside an open window never do.
   * (2) throughput: one token per message from a bucket refilled at the number's MPS.
   */
  private throttle(job: SendJob, now: number): { dueAt: number; reason: 'tier' | 'throughput' } | null {
    const pn = job.phoneNumberId;
    const lim = this.limitsFor(pn);
    const contact = this.sql.exec<{ id: number; last_inbound_at: number | null }>('SELECT id, last_inbound_at FROM contacts WHERE wa_id = ?', job.to).toArray()[0];
    const initiated = !(contact?.last_inbound_at && contact.last_inbound_at * 1000 + WINDOW_MS > now);
    const since = now - TIER_WINDOW_MS;
    let needsSlot = false;
    if (initiated && contact) {
      const slot = this.sql.exec<{ started_at: number }>('SELECT started_at FROM tier_slots WHERE phone_number_id = ? AND contact_id = ?', pn, contact.id).toArray()[0];
      needsSlot = !slot || slot.started_at <= since;
      if (needsSlot) {
        const used = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM tier_slots WHERE phone_number_id = ? AND started_at > ?', pn, since).one().n;
        if (used >= lim.tier) {
          const waiting = this.waitingFor(pn);
          // Spread the waiters over the slots as they expire (k-th waiter takes the k-th expiry; beyond one lap, the next day).
          const idx = waiting % used;
          const lap = Math.floor(waiting / used) + 1;
          const nth = this.sql.exec<{ started_at: number }>('SELECT started_at FROM tier_slots WHERE phone_number_id = ? AND started_at > ? ORDER BY started_at LIMIT 1 OFFSET ?', pn, since, idx).one().started_at;
          if (now - lim.alerted_at > 600_000) {
            this.sql.exec(
              `INSERT INTO number_limits (phone_number_id, tier, mps, tokens, tokens_at, alerted_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(phone_number_id) DO UPDATE SET alerted_at = excluded.alerted_at`, pn, lim.tier, lim.mps, lim.tokens, lim.tokens_at, now,
            );
            console.warn(JSON.stringify({ alert: 'send_tier_exhausted', workspace: this.workspaceId, phoneNumberId: pn, tier: lim.tier, waiting: waiting + 1 }));
          }
          return { dueAt: nth + lap * TIER_WINDOW_MS + 1000, reason: 'tier' };
        }
      }
    }
    const bucket = bucketDecision(lim.tokens_at === 0 ? lim.mps : lim.tokens, lim.mps, now, lim.tokens_at === 0 ? now : lim.tokens_at);
    if (!bucket.ok) return { dueAt: now + bucket.delayMs, reason: 'throughput' };
    this.sql.exec(
      `INSERT INTO number_limits (phone_number_id, tier, mps, tokens, tokens_at, alerted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(phone_number_id) DO UPDATE SET tokens = excluded.tokens, tokens_at = excluded.tokens_at`, pn, lim.tier, lim.mps, bucket.tokens, now, lim.alerted_at,
    );
    if (needsSlot && contact) {
      this.sql.exec(
        `INSERT INTO tier_slots (phone_number_id, contact_id, started_at) VALUES (?, ?, ?)
         ON CONFLICT(phone_number_id, contact_id) DO UPDATE SET started_at = excluded.started_at`, pn, contact.id, now,
      );
    }
    return null;
  }

  private waitingFor(phoneNumberId: string): number {
    return this.sql.exec<{ n: number }>(
      "SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'send_release' AND json_extract(payload, '$.reason') = 'tier' AND json_extract(payload, '$.job.phoneNumberId') = ?", phoneNumberId,
    ).one().n;
  }

  /** Meta's tier (from quality/tier webhooks) and throughput for one number. */
  async setNumberLimits(phoneNumberId: string, limits: { tier?: number; mps?: number }): Promise<void> {
    const cur = this.limitsFor(phoneNumberId);
    const mps = limits.mps ?? cur.mps;
    this.sql.exec(
      `INSERT INTO number_limits (phone_number_id, tier, mps, tokens, tokens_at, alerted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(phone_number_id) DO UPDATE SET tier = excluded.tier, mps = excluded.mps, tokens = min(tokens, excluded.mps)`,
      phoneNumberId, limits.tier ?? cur.tier, mps, Math.min(cur.tokens, mps), cur.tokens_at, cur.alerted_at,
    );
  }

  async throttleReport(phoneNumberId: string, now = Date.now()): Promise<ThrottleReport> {
    const lim = this.limitsFor(phoneNumberId);
    const since = now - TIER_WINDOW_MS;
    const used = this.sql.exec<{ n: number; first: number | null }>('SELECT count(*) AS n, min(started_at) AS first FROM tier_slots WHERE phone_number_id = ? AND started_at > ?', phoneNumberId, since).one();
    return { tier: lim.tier, mps: lim.mps, usedInWindow: used.n, waiting: this.waitingFor(phoneNumberId), nextSlotAt: used.n >= lim.tier && used.first !== null ? used.first + TIER_WINDOW_MS : null };
  }

  /**
   * Error 131049 (Meta's marketing frequency cap) is not a ban and not the contact's fault: put the message back to
   * 'queued' and try again in 24 h; after two deferrals give up and fail it. The contact is never touched.
   */
  async rescheduleFrequencyCap(job: SendJob, now = Date.now()): Promise<'rescheduled' | 'failed'> {
    const deferrals = job.deferrals ?? 0;
    if (deferrals >= 2) {
      this.sql.exec("UPDATE messages SET status = 'failed', error_code = 131049, updated_at = ? WHERE idempotency_key = ?", now, job.idempotencyKey);
      return 'failed';
    }
    this.sql.exec("UPDATE messages SET status = 'queued', error_code = 131049, updated_at = ? WHERE idempotency_key = ?", now, job.idempotencyKey);
    addTask(this.sql, 'send_release', now + TIER_WINDOW_MS, { job: { ...job, deferrals: deferrals + 1 }, reason: 'frequency_cap' });
    await this.arm();
    return 'rescheduled';
  }

  /**
   * The API send path: validates against the 24 h window, consent and the template set, stores a 'queued' message and
   * returns the job to enqueue. Expected refusals come back as a result object (a throw would cross the RPC boundary).
   * A repeated clientId returns the stored message and no job, so a retried POST sends once.
   */
  async queueOutbound(conversationId: number, phoneNumberId: string, req: SendMessageRequest, now = Date.now()): Promise<QueueOutboundResult> {
    const workspaceId = this.workspaceId;
    return this.ctx.storage.transactionSync((): QueueOutboundResult => {
      const conv = this.sql
        .exec<{ id: number; wa_id: string; last_inbound_at: number | null; opted_out_at: number | null }>(
          'SELECT c.id, ct.wa_id, ct.last_inbound_at, ct.opted_out_at FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?', conversationId,
        ).toArray()[0];
      if (!conv) return { ok: false, reason: 'not_found' };
      const key = `ui:${req.clientId}`;
      const dup = this.sql.exec<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.idempotency_key = ?`, key).toArray()[0];
      if (dup) return { ok: true, message: messageDto(dup, workspaceId), job: null };
      const windowOpen = conv.last_inbound_at !== null && conv.last_inbound_at * 1000 + WINDOW_MS > now;
      const base = { workspaceId, phoneNumberId, to: conv.wa_id, idempotencyKey: key };
      let type: string;
      let preview: string;
      let col: { template_name?: string; template_lang?: string; media_mime?: string; media_size?: number; media_r2_key?: string } = {};
      let job: SendJob;
      switch (req.type) {
        case 'text':
          if (!windowOpen) return { ok: false, reason: 'window_closed' };
          type = 'text'; preview = req.text;
          job = { ...base, kind: 'text', text: req.text };
          break;
        case 'interactive':
          if (!windowOpen) return { ok: false, reason: 'window_closed' };
          type = 'interactive'; preview = req.body;
          job = { ...base, kind: 'interactive', interactive: { body: req.body, buttons: req.buttons } };
          break;
        case 'media': {
          if (!windowOpen) return { ok: false, reason: 'window_closed' };
          const up = this.sql.exec<{ meta_media_id: string; mime: string; size: number; filename: string | null; r2_key: string }>('SELECT meta_media_id, mime, size, filename, r2_key FROM uploads WHERE id = ?', req.uploadId).toArray()[0];
          if (!up) return { ok: false, reason: 'invalid_request', message: 'unknown uploadId' };
          const allowed = outboundMediaFor(up.mime);
          if (!allowed) return { ok: false, reason: 'unsupported_media' };
          if (req.caption && allowed.kind === 'audio') return { ok: false, reason: 'invalid_request', message: 'audio cannot have a caption' };
          type = allowed.kind; preview = req.caption ?? '';
          col = { media_mime: up.mime, media_size: up.size, media_r2_key: up.r2_key };
          job = { ...base, kind: 'media', media: { kind: allowed.kind, mediaId: up.meta_media_id, ...(req.caption ? { caption: req.caption } : {}), ...(up.filename ? { filename: up.filename } : {}) } };
          break;
        }
        case 'template': {
          const t = this.sql.exec<{ category: string; status: string; components: string }>('SELECT category, status, components FROM templates WHERE name = ? AND language = ?', req.name, req.language).toArray()[0];
          if (!t || t.status !== 'APPROVED') return { ok: false, reason: 'template_not_approved' };
          if (t.category === 'MARKETING' && conv.opted_out_at !== null) return { ok: false, reason: 'opted_out' };
          const stored = componentsSchema.safeParse(JSON.parse(t.components));
          if (!stored.success) return { ok: false, reason: 'invalid_request', message: 'stored template is malformed' };
          const rendered = renderTemplate(stored.data, req.params);
          if (!rendered.ok) return { ok: false, reason: 'invalid_request', message: rendered.message };
          type = 'template'; preview = rendered.text;
          col = { template_name: req.name, template_lang: req.language };
          job = { ...base, kind: 'template', template: { name: req.name, language: req.language, components: rendered.components } };
          break;
        }
      }
      const id = this.sql.exec<{ id: number }>(
        `INSERT INTO messages (conversation_id, direction, type, preview, body, status, idempotency_key, template_name, template_lang, media_mime, media_size, media_r2_key, created_at, updated_at)
         VALUES (?, 'out', ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        conversationId, type, previewOf(preview), preview.length ? preview : null, key,
        col.template_name ?? null, col.template_lang ?? null, col.media_mime ?? null, col.media_size ?? null, col.media_r2_key ?? null, now, now,
      ).one().id;
      this.indexMessage(id, preview.length ? previewOf(preview) : null);
      this.sql.exec('UPDATE conversations SET last_message_at = max(coalesce(last_message_at, 0), ?) WHERE id = ?', Math.floor(now / 1000), conversationId);
      const row = this.sql.exec<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = ?`, id).one();
      return { ok: true, message: messageDto(row, workspaceId), job };
    });
  }

  async listTemplates(): Promise<TemplateDto[]> {
    return this.sql
      .exec<{ name: string; language: string; category: string; status: string; components: string; rejected_reason: string | null }>(
        'SELECT name, language, category, status, components, rejected_reason FROM templates ORDER BY name, language',
      )
      .toArray()
      .map((t) => {
        const comps = componentsSchema.safeParse(JSON.parse(t.components));
        const parts = comps.success ? comps.data : [];
        return {
          name: t.name, language: t.language, category: t.category as TemplateDto['category'], status: t.status as TemplateDto['status'],
          bodyText: bodyTextOf(parts), paramCount: paramCount(parts), rejectedReason: t.rejected_reason,
        };
      });
  }

  /** Replaces the template set with what Meta returned (the caller fetched every page, so absence means deleted at Meta). */
  async syncTemplates(items: { name: string; language: string; category: string; status: string; components: unknown[]; rejectedReason: string | null }[]): Promise<{ upserted: number; removed: number }> {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const keep = new Set<string>();
      for (const t of items) {
        keep.add(`${t.name}\u0000${t.language}`);
        this.upsertTemplate(t.name, t.language, t.category, t.status, JSON.stringify(t.components), t.rejectedReason, now);
      }
      let removed = 0;
      for (const t of this.sql.exec<{ id: number; name: string; language: string }>('SELECT id, name, language FROM templates').toArray()) {
        if (keep.has(`${t.name}\u0000${t.language}`)) continue;
        this.sql.exec('DELETE FROM templates WHERE id = ?', t.id);
        removed++;
      }
      return { upserted: items.length, removed };
    });
  }

  /** A template we just submitted to Meta. */
  async saveSubmittedTemplate(t: { name: string; language: string; category: string; status: string; components: unknown[] }): Promise<void> {
    this.upsertTemplate(t.name, t.language, t.category, t.status, JSON.stringify(t.components), null, Date.now());
  }

  async hasTemplate(name: string, language: string): Promise<boolean> {
    return this.sql.exec('SELECT 1 FROM templates WHERE name = ? AND language = ?', name, language).toArray().length > 0;
  }

  /** Meta's template-status webhook. Unknown templates are ignored (they will arrive with the next sync). */
  async applyTemplateStatus(name: string, language: string, status: string, reason: string | null): Promise<{ applied: boolean }> {
    const r = this.sql.exec('UPDATE templates SET status = ?, rejected_reason = ?, updated_at = ? WHERE name = ? AND language = ?', status, reason, Date.now(), name, language);
    return { applied: r.rowsWritten > 0 };
  }

  private upsertTemplate(name: string, language: string, category: string, status: string, components: string, rejectedReason: string | null, now: number): void {
    this.sql.exec(
      `INSERT INTO templates (name, language, category, status, components, rejected_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, language) DO UPDATE SET category = excluded.category, status = excluded.status, components = excluded.components, rejected_reason = excluded.rejected_reason, updated_at = excluded.updated_at`,
      name, language, category, status, components, rejectedReason, now,
    );
  }

  /** The enqueue after queueOutbound threw: the message will never be sent, so say so instead of leaving it 'queued'. */
  async markEnqueueFailed(idempotencyKey: string): Promise<void> {
    this.sql.exec("UPDATE messages SET status = 'failed', updated_at = ? WHERE idempotency_key = ? AND status = 'queued'", Date.now(), idempotencyKey);
  }

  async recordOutbound(idempotencyKey: string, result: SendResult): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      if (result.ok) {
        this.sql.exec("UPDATE messages SET wamid = ?, status = 'accepted', updated_at = ? WHERE idempotency_key = ?", result.wamid, now, idempotencyKey);
        // Meta often sends 'sent'/'failed' before we store the wamid: replay what arrived early, oldest first.
        const early = this.sql
          .exec<{ id: number; status: StatusEvent['status']; ts: number; error_code: number | null }>(
            'SELECT id, status, ts, error_code FROM message_status_events WHERE wamid = ? AND applied = 0 ORDER BY ts, id', result.wamid,
          )
          .toArray();
        for (const e of early) {
          if (this.applyToMessage({ wamid: result.wamid, status: e.status, ts: e.ts, ...(e.error_code !== null ? { errorCode: e.error_code } : {}) })) {
            this.sql.exec('UPDATE message_status_events SET applied = 1 WHERE id = ?', e.id);
          }
        }
      } else {
        this.sql.exec('UPDATE messages SET status = ?, error_code = ?, updated_at = ? WHERE idempotency_key = ?', result.retryable ? 'retry' : 'failed', result.code, now, idempotencyKey);
      }
    });
  }

  async applyStatus(e: StatusEvent): Promise<{ applied: boolean }> {
    return this.ctx.storage.transactionSync(() => ({ applied: this.applyStatusSync(e) }));
  }

  /** Records each distinct status event once; the message keeps its highest state. */
  private applyStatusSync(e: StatusEvent): boolean {
    const isNew = this.sql.exec(
      'INSERT INTO message_status_events (wamid, status, ts, applied, error_code) VALUES (?, ?, ?, 0, ?) ON CONFLICT(wamid, status, ts) DO NOTHING',
      e.wamid, e.status, e.ts, e.errorCode ?? null,
    ).rowsWritten > 0;
    if (!isNew) return false;
    const applied = this.applyToMessage(e);
    if (applied) this.sql.exec('UPDATE message_status_events SET applied = 1 WHERE wamid = ? AND status = ? AND ts = ?', e.wamid, e.status, e.ts);
    return applied;
  }

  private applyToMessage(e: StatusEvent): boolean {
    const msg = this.sql.exec<{ id: number; status_rank: number }>('SELECT id, status_rank FROM messages WHERE wamid = ?', e.wamid).toArray()[0];
    if (!msg) return false;
    const rank = STATUS_RANK[e.status];
    if (rank <= msg.status_rank || (e.status === 'failed' && msg.status_rank >= STATUS_RANK.delivered)) return false;
    this.sql.exec('UPDATE messages SET status = ?, status_rank = ?, error_code = coalesce(?, error_code), updated_at = ? WHERE id = ?', e.status, rank, e.errorCode ?? null, Date.now(), msg.id);
    return true;
  }

  // ---- search index ----------------------------------------------------------------------------------------------

  /** Adds one message to the full-text index. Text is normalised here and at query time with the same function. */
  private indexMessage(messageId: number, preview: string | null): void {
    const t = preview ? normaliseText(preview) : '';
    if (t) this.sql.exec('INSERT INTO messages_fts (rowid, text) VALUES (?, ?)', messageId, t);
  }

  /** Rebuilds the index from message previews (after a restore, or for rows older than the index). */
  private rebuildFts(): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM messages_fts');
      for (const m of this.sql.exec<{ id: number; preview: string }>('SELECT id, preview FROM messages WHERE preview IS NOT NULL').toArray()) this.indexMessage(m.id, m.preview);
    });
  }

  private reindexIfEmpty(): void {
    if (this.sql.exec('SELECT 1 FROM messages_fts LIMIT 1').toArray().length) return;
    if (this.sql.exec('SELECT 1 FROM messages WHERE preview IS NOT NULL LIMIT 1').toArray().length) this.rebuildFts();
  }

  // ---- inbox reads and edits --------------------------------------------------------------------------------------

  private static readonly CONVERSATION_SELECT = `SELECT c.id, ct.wa_id, ct.profile_name, ct.opted_out_at, ct.last_inbound_at, c.unread, c.assignee_user_id, c.last_message_at,
      lm.preview AS lm_preview, lm.direction AS lm_direction, lm.type AS lm_type, lm.status AS lm_status, lm.created_at AS lm_at
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN messages lm ON lm.id = (SELECT id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1)`;

  private tagsFor(ids: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (!ids.length) return out;
    for (const t of this.sql.exec<{ conversation_id: number; tag: string }>(`SELECT conversation_id, tag FROM conversation_tags WHERE conversation_id IN (${ids.map(() => '?').join(',')}) ORDER BY tag`, ...ids)) {
      (out.get(t.conversation_id) ?? out.set(t.conversation_id, []).get(t.conversation_id)!).push(t.tag);
    }
    return out;
  }

  private conversationById(id: number, now: number): ConversationDto | null {
    const row = this.sql.exec<ConversationRow>(`${WorkspaceDO.CONVERSATION_SELECT} WHERE c.id = ?`, id).toArray()[0];
    return row ? conversationDto(row, this.tagsFor([id]).get(id) ?? [], now) : null;
  }

  /** Newest first by (last_message_at, id); `cursor` is the opaque "<at>.<id>" of the last row of the previous page. */
  async listConversations(opts: { filter: 'all' | 'unread' | 'mine' | 'unassigned'; userId: string; cursor?: string; limit: number }, now = Date.now()): Promise<{ items: ConversationDto[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    if (opts.filter === 'unread') where.push('c.unread > 0');
    else if (opts.filter === 'mine') { where.push('c.assignee_user_id = ?'); params.push(opts.userId); }
    else if (opts.filter === 'unassigned') where.push('c.assignee_user_id IS NULL');
    const m = opts.cursor ? /^(\d+)\.(\d+)$/.exec(opts.cursor) : null;
    if (m) { where.push('(c.last_message_at, c.id) < (?, ?)'); params.push(Number(m[1]), Number(m[2])); }
    const rows = this.sql
      .exec<ConversationRow>(`${WorkspaceDO.CONVERSATION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`, ...params, opts.limit + 1)
      .toArray();
    const page = rows.slice(0, opts.limit);
    const tags = this.tagsFor(page.map((r) => r.id));
    const last = page.at(-1);
    return { items: page.map((r) => conversationDto(r, tags.get(r.id) ?? [], now)), nextCursor: rows.length > opts.limit && last ? `${last.last_message_at ?? 0}.${last.id}` : null };
  }

  /** The newest `limit` messages before message id `before`, oldest first. Null when the conversation does not exist. */
  async getMessages(conversationId: number, before: number | undefined, limit: number): Promise<{ items: MessageDto[]; nextBefore: number | null } | null> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return null;
    const workspaceId = this.workspaceId;
    const rows = this.sql
      .exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.conversation_id = ? ${before !== undefined ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`,
        ...(before !== undefined ? [conversationId, before, limit + 1] : [conversationId, limit + 1]),
      )
      .toArray();
    const page = rows.slice(0, limit).reverse();
    return { items: page.map((r) => messageDto(r, workspaceId)), nextBefore: rows.length > limit && page[0] ? page[0].id : null };
  }

  /** The whole text of a message whose body lives in R2 (or inline). Null when there is no such message. */
  async getBody(messageId: number): Promise<{ text: string } | null> {
    const m = this.sql.exec<{ body: string | null; body_r2_key: string | null; preview: string | null }>('SELECT body, body_r2_key, preview FROM messages WHERE id = ?', messageId).toArray()[0];
    if (!m) return null;
    if (m.body !== null) return { text: m.body };
    if (m.body_r2_key) {
      const obj = await this.env.MEDIA.get(m.body_r2_key);
      if (obj) return { text: await obj.text() };
    }
    return { text: m.preview ?? '' };
  }

  async markRead(conversationId: number, now = Date.now()): Promise<ConversationDto | null> {
    this.sql.exec('UPDATE conversations SET unread = 0 WHERE id = ?', conversationId);
    return this.conversationById(conversationId, now);
  }

  async assign(conversationId: number, userId: string | null, now = Date.now()): Promise<ConversationDto | null> {
    this.sql.exec('UPDATE conversations SET assignee_user_id = ? WHERE id = ?', userId, conversationId);
    return this.conversationById(conversationId, now);
  }

  async setTags(conversationId: number, tags: string[], now = Date.now()): Promise<ConversationDto | null> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return null;
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM conversation_tags WHERE conversation_id = ?', conversationId);
      for (const t of clean) this.sql.exec('INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, ?)', conversationId, t);
    });
    return this.conversationById(conversationId, now);
  }

  async addNote(conversationId: number, authorUserId: string, text: string, now = Date.now()): Promise<NoteDto | null> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return null;
    const id = this.sql.exec<{ id: number }>('INSERT INTO notes (conversation_id, author_user_id, text, created_at) VALUES (?, ?, ?, ?) RETURNING id', conversationId, authorUserId, text, now).one().id;
    return { id, authorUserId, text, at: now };
  }

  async listNotes(conversationId: number): Promise<NoteDto[] | null> {
    if (!this.sql.exec('SELECT 1 FROM conversations WHERE id = ?', conversationId).toArray().length) return null;
    return this.sql
      .exec<{ id: number; author_user_id: string; text: string; created_at: number }>('SELECT id, author_user_id, text, created_at FROM notes WHERE conversation_id = ? ORDER BY id', conversationId)
      .toArray()
      .map((n) => ({ id: n.id, authorUserId: n.author_user_id, text: n.text, at: n.created_at }));
  }

  /** Full-text search over message previews: every word is a prefix match, both sides normalised the same way. */
  async search(q: string, limit: number): Promise<{ conversationId: number; messageId: number; snippet: string; at: number }[]> {
    const tokens = normaliseText(q).split(' ').filter(Boolean).slice(0, 8);
    if (!tokens.length) return [];
    // Tokens are letters/digits only after normalisation, so quoting them cannot be broken out of.
    const match = tokens.map((t) => `"${t}"*`).join(' ');
    return this.sql
      .exec<{ id: number; conversation_id: number; preview: string | null; created_at: number }>(
        'SELECT m.id, m.conversation_id, m.preview, m.created_at FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?',
        match, limit,
      )
      .toArray()
      .map((r) => ({ conversationId: r.conversation_id, messageId: r.id, snippet: Array.from(r.preview ?? '').slice(0, 160).join(''), at: r.created_at }));
  }

  /** Schedules the nightly backup and R2 drain if they are not pending yet (idempotent; cheap enough for every ingest). */
  private ensureDaily(now: number): boolean {
    const have = new Set(this.sql.exec<{ kind: string }>("SELECT kind FROM scheduled_tasks WHERE kind IN ('backup', 'r2_drain')").toArray().map((r) => r.kind));
    let added = false;
    for (const kind of DAILY_KINDS) {
      if (have.has(kind)) continue;
      addTask(this.sql, kind, nextLocalHour(now, BACKUP_HOUR_LOCAL, BACKUP_TIME_ZONE));
      added = true;
    }
    return added;
  }

  private async ensureBackupAlarm(): Promise<void> {
    if (this.ensureDaily(Date.now())) await this.arm();
  }

  /** The one DO alarm always points at the earliest pending task. */
  private async arm(): Promise<void> {
    const next = earliestDue(this.sql);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /** Schedules a task and re-arms the alarm. Backup and r2_drain keep only their earliest due time. */
  async schedule(kind: TaskKind, dueAt: number, payload?: TaskPayload): Promise<void> {
    addTask(this.sql, kind, dueAt, payload);
    await this.arm();
  }

  async alarm(): Promise<void> {
    await this.runDueTasks(Date.now());
  }

  /**
   * Runs every due task, each in isolation: a failure is recorded with exponential backoff and never stops the others.
   * A handler may return the next due time (daily tasks reschedule themselves) or nothing (the task is done).
   */
  async runDueTasks(now = Date.now()): Promise<{ ran: number; failed: number }> {
    let ran = 0;
    let failed = 0;
    for (;;) {
      const due = dueTasks(this.sql, now, 50);
      if (!due.length) break;
      for (const t of due) {
        ran++;
        try {
          const nextDue = await this.runTask(t.kind, t.payload, now);
          if (nextDue === undefined) this.sql.exec('DELETE FROM scheduled_tasks WHERE id = ?', t.id);
          else this.sql.exec('UPDATE scheduled_tasks SET due_at = ?, attempts = 0, last_error = NULL WHERE id = ?', nextDue, t.id);
        } catch (err) {
          failed++;
          const attempts = t.attempts + 1;
          this.sql.exec('UPDATE scheduled_tasks SET attempts = ?, due_at = ?, last_error = ? WHERE id = ?', attempts, now + backoffMs(attempts), String((err as Error).message).slice(0, 200), t.id);
          console.error(JSON.stringify({ alert: `${t.kind}_failed`, workspace: this.workspaceId, attempts, error: (err as Error).message }));
        }
      }
    }
    this.ensureDaily(now);
    await this.arm();
    return { ran, failed };
  }

  /** One task. Returns the next due time for self-rescheduling tasks. Throws to be retried with backoff. */
  private async runTask(kind: TaskKind, payload: string | null, now: number): Promise<number | undefined> {
    switch (kind) {
      case 'backup': {
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: BACKUP_TIME_ZONE }).format(now);
        await this.exportSnapshot(date);
        return nextLocalHour(now + 3_600_000, BACKUP_HOUR_LOCAL, BACKUP_TIME_ZONE);
      }
      case 'r2_drain': {
        const stillOwed = await this.drainR2Deletes();
        if (stillOwed > 0) {
          console.error(JSON.stringify({ alert: 'r2_deletes_still_owed', workspace: this.workspaceId, keys: stillOwed }));
          return now + 3_600_000;
        }
        return nextLocalHour(now + 3_600_000, BACKUP_HOUR_LOCAL, BACKUP_TIME_ZONE);
      }
      case 'send_release': {
        const job = sendJobSchema.safeParse((JSON.parse(payload ?? 'null') as { job?: unknown } | null)?.job);
        if (!job.success) {
          console.error(JSON.stringify({ alert: 'scheduled_task_invalid', kind, workspace: this.workspaceId }));
          return undefined; // a payload that can never parse must not retry forever
        }
        await this.env.SEND_QUEUE.sendBatch([{ body: job.data }]);
        return undefined;
      }
      default:
        return undefined; // campaign_step: Phase 6 placeholder
    }
  }

  /**
   * Writes every table as NDJSON plus a manifest (row count + sha256 per table) to R2.
   * All tables are read inside ONE transaction, so the snapshot is consistent; the whole workspace is held in memory
   * (fine for the spike's metadata-only rows; streaming export is a Phase 3 follow-up).
   */
  async exportSnapshot(date: string): Promise<BackupManifest> {
    const workspaceId = this.workspaceId;
    const dumps = this.ctx.storage.transactionSync(() =>
      BACKUP_TABLES.map((t) => ({ t, rows: this.sql.exec(`SELECT * FROM ${t} ORDER BY id`).toArray() as Record<string, unknown>[] })),
    );
    const manifest: BackupManifest = { workspaceId, date, schemaVersion: DO_MIGRATIONS.length, tables: {} as BackupManifest['tables'] };
    const prefix = backupPrefix(workspaceId, date);
    for (const { t, rows } of dumps) {
      const body = toNdjson(rows);
      manifest.tables[t] = { rows: rows.length, sha256: await sha256Hex(body) };
      await this.env.BACKUPS.put(`${prefix}${t}.ndjson`, body);
    }
    await this.env.BACKUPS.put(`${prefix}manifest.json`, JSON.stringify(manifest));
    return manifest;
  }

  /** Restores a snapshot into THIS workspace, which must be empty. Verifies counts and hashes before writing anything. */
  async importSnapshot(prefix: string): Promise<{ ok: true; manifest: BackupManifest } | { ok: false; reason: string }> {
    try {
      const manifest = await this.importSnapshotOrThrow(prefix);
      await this.ensureBackupAlarm();
      return { ok: true, manifest };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  private async importSnapshotOrThrow(prefix: string): Promise<BackupManifest> {
    const manifestObj = await this.env.BACKUPS.get(`${prefix}manifest.json`);
    if (!manifestObj) throw new Error('backup manifest not found');
    const parsed = backupManifestSchema.safeParse(await manifestObj.json().catch(() => null));
    if (!parsed.success) throw new Error('backup manifest is invalid');
    const manifest = parsed.data;
    if (manifest.schemaVersion > DO_MIGRATIONS.length) throw new Error('backup is newer than this schema');
    const files: { t: (typeof BACKUP_TABLES)[number]; rows: Record<string, unknown>[] }[] = [];
    for (const t of BACKUP_TABLES) {
      const body = (await (await this.env.BACKUPS.get(`${prefix}${t}.ndjson`))?.text()) ?? '';
      if ((await sha256Hex(body)) !== manifest.tables[t].sha256) throw new Error(`backup checksum mismatch: ${t}`);
      const rows = body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      if (rows.length !== manifest.tables[t].rows) throw new Error(`backup row count mismatch: ${t}`);
      files.push({ t, rows });
    }
    this.ctx.storage.transactionSync(() => {
      for (const t of BACKUP_TABLES) {
        if (this.sql.exec(`SELECT 1 FROM ${t} LIMIT 1`).toArray().length) throw new Error('restore target workspace is not empty');
      }
      for (const { t, rows } of files) {
        const allowed = new Set(this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`).toArray().map((c) => c.name));
        for (const row of rows) {
          const cols = Object.keys(row);
          if (cols.some((c) => !allowed.has(c))) throw new Error(`backup has an unknown column in ${t}`);
          this.sql.exec(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c] as SqlStorageValue));
        }
      }
    });
    this.rebuildFts();
    return manifest;
  }

  /**
   * Erases one contact (data-protection request): the contact, its conversation, every message in and out and their
   * status events. R2 body keys are recorded in r2_pending_deletes in the SAME transaction as the row deletes, and a
   * key leaves that table only after R2 confirms; any leftover is retried on the next erase and by the nightly alarm.
   */
  async eraseContact(waId: string): Promise<EraseResult> {
    const found = this.ctx.storage.transactionSync(() => {
      const contact = this.sql.exec<{ id: number }>('SELECT id FROM contacts WHERE wa_id = ?', waId).toArray()[0];
      if (!contact) return { found: false, keys: 0, messages: 0, statusEvents: 0 };
      const conv = this.sql.exec<{ id: number }>('SELECT id FROM conversations WHERE contact_id = ?', contact.id).toArray()[0];
      const msgs = conv
        ? this.sql.exec<{ wamid: string | null; body_r2_key: string | null }>('SELECT wamid, body_r2_key FROM messages WHERE conversation_id = ?', conv.id).toArray()
        : [];
      let statusEvents = 0;
      let keys = 0;
      for (const m of msgs) {
        if (m.body_r2_key) {
          this.sql.exec('INSERT OR IGNORE INTO r2_pending_deletes (key) VALUES (?)', m.body_r2_key);
          keys++;
        }
        if (!m.wamid) continue;
        // Count first: rowsWritten also counts index entries, so it is not a row count.
        statusEvents += this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM message_status_events WHERE wamid = ?', m.wamid).one().n;
        this.sql.exec('DELETE FROM message_status_events WHERE wamid = ?', m.wamid);
      }
      this.sql.exec('DELETE FROM tier_slots WHERE contact_id = ?', contact.id);
      if (conv) {
        this.sql.exec('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE conversation_id = ?)', conv.id);
        this.sql.exec('DELETE FROM notes WHERE conversation_id = ?', conv.id);
        this.sql.exec('DELETE FROM conversation_tags WHERE conversation_id = ?', conv.id);
        this.sql.exec('DELETE FROM messages WHERE conversation_id = ?', conv.id);
        this.sql.exec('DELETE FROM conversations WHERE id = ?', conv.id);
      }
      this.sql.exec('DELETE FROM contacts WHERE id = ?', contact.id);
      return { found: true, keys, messages: msgs.length, statusEvents };
    });
    const r2Pending = await this.drainR2Deletes();
    if (r2Pending > 0) await this.schedule('r2_drain', Date.now() + 3_600_000); // R2 refused some deletes: try again within the hour
    return { found: found.found, messages: found.messages, statusEvents: found.statusEvents, r2Objects: found.keys, r2Pending };
  }

  /** Deletes owed R2 objects in batches; returns how many are still owed (0 when R2 confirmed them all). */
  private async drainR2Deletes(): Promise<number> {
    for (;;) {
      const batch = this.sql.exec<{ key: string }>('SELECT key FROM r2_pending_deletes ORDER BY key LIMIT ?', R2_DELETE_BATCH).toArray().map((r) => r.key);
      if (!batch.length) return 0;
      try {
        await this.env.MEDIA.delete(batch);
      } catch (err) {
        console.error(JSON.stringify({ alert: 'r2_delete_failed', workspace: this.workspaceId, keys: batch.length, error: (err as Error).message }));
        return this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM r2_pending_deletes').one().n;
      }
      this.ctx.storage.transactionSync(() => {
        for (const k of batch) this.sql.exec('DELETE FROM r2_pending_deletes WHERE key = ?', k);
      });
    }
  }
}
