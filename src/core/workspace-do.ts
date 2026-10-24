import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { BACKUP_HOUR_LOCAL, BACKUP_TABLES, BACKUP_TIME_ZONE, backupPrefix, nextLocalHour, sha256Hex, toNdjson, type BackupManifest } from './backup';
import { DO_MIGRATIONS, migrate } from './do-migrations';
import type { SendResult } from './meta/client';
import type { InboundMessage, StatusEvent } from './meta/webhook-schema';
import type { SendJob } from './send-queue';

export const PREVIEW_CHARS = 280;
export const INLINE_BODY_BYTES = 1024;
/** A claim older than this is presumed crashed and may be re-claimed once (duplicate risk vs drop risk: we accept one possible duplicate). */
export const STALE_CLAIM_MS = 2 * 60 * 1000;
/** failed sits between sent and delivered: it beats a late 'sent', but never undoes a delivery. */
const STATUS_RANK = { sent: 1, failed: 2, delivered: 3, read: 4 } as const;

export type IngestBatch = { phoneNumberId: string; inbound: InboundMessage[]; statuses: StatusEvent[]; receivedAt: number };
export type IngestResult = { stored: number; duplicates: number; replies: SendJob[] };
export type WorkspaceConfig = { autoReplyText?: string };

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

/** One tenant's data: a SQLite-backed Durable Object per workspace. */
export class WorkspaceDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
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
        const cols = this.bodyColumns(m.text, bodies.get(m.wamid));
        const inserted = this.sql.exec(
          `INSERT INTO messages (wamid, conversation_id, direction, type, preview, body, body_r2_key, created_at, updated_at)
           VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?) ON CONFLICT(wamid) DO NOTHING`,
          m.wamid, conversationId, m.type, cols.preview, cols.body, cols.key, m.ts * 1000, now,
        ).rowsWritten;
        if (inserted === 0) {
          result.duplicates++;
          // Redelivery heals a lost enqueue: offer the reply again until its send is claimed (claimSend dedupes).
          const claimed = this.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', `reply:${m.wamid}`).toArray().length > 0;
          if (!claimed && m.type === 'text' && config.autoReplyText) result.replies.push(this.replyJob(workspaceId, batch, m, config.autoReplyText));
          continue;
        }
        result.stored++;
        this.sql.exec('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
        if (m.type === 'text' && config.autoReplyText) result.replies.push(this.replyJob(workspaceId, batch, m, config.autoReplyText));
      }
      for (const st of batch.statuses) this.applyStatusSync(st);
    });
    return result;
  }

  private replyJob(workspaceId: string, batch: IngestBatch, m: InboundMessage, text: string): SendJob {
    return { workspaceId, phoneNumberId: batch.phoneNumberId, to: m.from, text, idempotencyKey: `reply:${m.wamid}`, inboundAt: m.ts * 1000, receivedAt: batch.receivedAt };
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
          `INSERT INTO messages (conversation_id, direction, type, preview, body, status, idempotency_key, claim_attempts, created_at, updated_at)
           VALUES (?, 'out', 'text', ?, ?, 'claimed', ?, 1, ?, ?)`,
          conversationId, previewOf(job.text), job.text, job.idempotencyKey, now, now,
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

  /** Arms the nightly backup alarm once; alarm() re-arms it. */
  private async ensureBackupAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(nextLocalHour(Date.now(), BACKUP_HOUR_LOCAL, BACKUP_TIME_ZONE));
    }
  }

  async alarm(): Promise<void> {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: BACKUP_TIME_ZONE }).format(Date.now());
    await this.exportSnapshot(date);
    await this.ctx.storage.setAlarm(nextLocalHour(Date.now() + 3_600_000, BACKUP_HOUR_LOCAL, BACKUP_TIME_ZONE));
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
      return { ok: true, manifest: await this.importSnapshotOrThrow(prefix) };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  private async importSnapshotOrThrow(prefix: string): Promise<BackupManifest> {
    const manifestObj = await this.env.BACKUPS.get(`${prefix}manifest.json`);
    if (!manifestObj) throw new Error('backup manifest not found');
    const manifest = (await manifestObj.json()) as BackupManifest;
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
    return manifest;
  }
}
