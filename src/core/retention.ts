import { ERASURE_TARGETS } from './erasure-targets';

/**
 * Message retention (B4 / T7, PDPL data minimisation). A workspace keeps its messages for `retention_days` (platform default 2 years, owner-set between 30 days and
 * 10 years; never "forever"), then a daily purge deletes older MESSAGES with everything hanging off them: R2 bodies and media, uploads, status events, search
 * rows, agent turns. The contact, the conversation shell, staff notes and tags, orders and every money record stay (they are the merchant's own records and
 * the law's); erasing a person is a separate right (`eraseContact`).
 *
 * Ruling RETENTION-DEFAULT-1 - the default is 730 days, the window is 30 to 3650 days and `null` means the default. Two years covers the longest
 * return/dispute window a merchant realistically has; the bound stops a workspace from keeping customer chats for ever by omission. Cost if wrong: a merchant who
 * needs older chats for a dispute has to set a longer window BEFORE they age out (a purge cannot be undone; backups hold deleted history for 30 days only).
 */
export const DEFAULT_RETENTION_DAYS = 730;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;
export const RETENTION_KEY = 'retention_days';
export const RETENTION_BATCH = 500;
export const RETENTION_MAX_BATCHES = 20;
const DAY = 86_400_000;

export type RetentionView = { days: number | null; effectiveDays: number; defaultDays: number; minDays: number; maxDays: number };

export function readRetentionDays(sql: SqlStorage): number | null {
  const v = sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', RETENTION_KEY).toArray()[0]?.value;
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= MIN_RETENTION_DAYS && n <= MAX_RETENTION_DAYS ? n : null;
}

export function retentionView(sql: SqlStorage): RetentionView {
  const days = readRetentionDays(sql);
  return { days, effectiveDays: days ?? DEFAULT_RETENTION_DAYS, defaultDays: DEFAULT_RETENTION_DAYS, minDays: MIN_RETENTION_DAYS, maxDays: MAX_RETENTION_DAYS };
}

export function writeRetentionDays(sql: SqlStorage, days: number | null): void {
  if (days === null) sql.exec('DELETE FROM store_state WHERE key = ?', RETENTION_KEY);
  else sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', RETENTION_KEY, String(days));
}

export const cutoffFor = (sql: SqlStorage, now: number): number => now - retentionView(sql).effectiveDays * DAY;

/**
 * Deletes up to `batch` messages older than `cutoff`, inside the caller's transaction, with everything the shared list (erasure-targets.ts) marks `purge`
 * (status events, AI turns, realtime events, the message row itself), their search rows, and the conversation-updated events that show them as the last message.
 * An R2 key (and its uploads row) is queued for deletion only when NO remaining message still points at it: a campaign image is shared by many messages.
 * Returns how many messages went.
 */
export function purgeBatch(sql: SqlStorage, cutoff: number, batch: number): number {
  const msgs = sql.exec<{ id: number; wamid: string | null; conversation_id: number; body_r2_key: string | null; media_r2_key: string | null }>(
    'SELECT id, wamid, conversation_id, body_r2_key, media_r2_key FROM messages WHERE created_at < ? ORDER BY created_at LIMIT ?', cutoff, batch,
  ).toArray();
  const keys = new Set<string>();
  const conversations = new Set<number>();
  for (const m of msgs) {
    for (const k of [m.body_r2_key, m.media_r2_key]) if (k) keys.add(k);
    conversations.add(m.conversation_id);
    sql.exec('DELETE FROM messages_fts WHERE rowid = ?', m.id);
    for (const t of ERASURE_TARGETS) {
      if (!t.purge) continue;
      switch (t.by) {
        case 'wamid': if (m.wamid) sql.exec(`DELETE FROM ${t.table} WHERE wamid = ?`, m.wamid); break;
        case 'message_id': sql.exec(`DELETE FROM ${t.table} WHERE message_id = ?`, m.id); break;
        case 'event_payload': sql.exec(`DELETE FROM ${t.table} WHERE json_extract(payload, '$.messageId') = ? OR json_extract(payload, '$.message.id') = ?`, m.id, m.id); break;
        case 'conversation_id': sql.exec(`DELETE FROM ${t.table} WHERE id = ?`, m.id); break; // the message row itself
        default: break;
      }
    }
  }
  // A conversation-updated event carries the last message's preview: drop them, a client re-reads the list.
  for (const c of conversations) sql.exec("DELETE FROM events WHERE json_extract(payload, '$.type') = 'conversation.updated' AND json_extract(payload, '$.conversation.id') = ?", c);
  for (const k of keys) {
    if (stillReferenced(sql, k)) continue; // still referenced
    sql.exec('INSERT OR IGNORE INTO r2_pending_deletes (key) VALUES (?)', k);
    sql.exec('DELETE FROM uploads WHERE r2_key = ?', k);
  }
  return msgs.length;
}

/** The realtime log keeps no event older than the window (rows from before `at` existed have no age and go too: they are only resync history). */
export function purgeOldEvents(sql: SqlStorage, cutoff: number): void {
  sql.exec('DELETE FROM events WHERE at IS NULL OR at < ?', cutoff);
}

export const hasExpired = (sql: SqlStorage, cutoff: number): boolean => sql.exec('SELECT 1 FROM messages WHERE created_at < ? LIMIT 1', cutoff).toArray().length > 0;

/**
 * The one "is this R2 key still referenced by a message?" query (retention, erasure of one contact). Two lookups, one per column, each on its partial index
 * (messages_body_r2 / messages_media_r2, DO migration v37), so the check costs two index probes instead of a scan of every message per key. With
 * `exceptConversation` the messages of that conversation are ignored (the contact being erased: its rows are deleted after the keys are decided).
 * Bind: key, then (when `exceptConversation`) the conversation id.
 */
export const referencedElsewhereSql = (exceptConversation: boolean): string =>
  `SELECT 1 FROM messages WHERE body_r2_key = ?1${exceptConversation ? ' AND conversation_id <> ?2' : ''} UNION ALL SELECT 1 FROM messages WHERE media_r2_key = ?1${exceptConversation ? ' AND conversation_id <> ?2' : ''} LIMIT 1`;
export function stillReferenced(sql: SqlStorage, key: string, exceptConversation?: number): boolean {
  return exceptConversation === undefined
    ? sql.exec(referencedElsewhereSql(false), key).toArray().length > 0
    : sql.exec(referencedElsewhereSql(true), key, exceptConversation).toArray().length > 0;
}
