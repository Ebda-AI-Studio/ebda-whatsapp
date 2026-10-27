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
 * Deletes up to `batch` messages older than `cutoff`, inside the caller's transaction, with their dependants. R2 keys are queued in `r2_pending_deletes`
 * (the same table `eraseContact` uses, drained after the transaction). Returns how many messages went.
 */
export function purgeBatch(sql: SqlStorage, cutoff: number, batch: number): number {
  const msgs = sql.exec<{ id: number; wamid: string | null; body_r2_key: string | null; media_r2_key: string | null }>(
    'SELECT id, wamid, body_r2_key, media_r2_key FROM messages WHERE created_at < ? ORDER BY created_at LIMIT ?', cutoff, batch,
  ).toArray();
  for (const m of msgs) {
    for (const k of [m.body_r2_key, m.media_r2_key]) {
      if (!k) continue;
      sql.exec('INSERT OR IGNORE INTO r2_pending_deletes (key) VALUES (?)', k);
      sql.exec('DELETE FROM uploads WHERE r2_key = ?', k);
    }
    if (m.wamid) sql.exec('DELETE FROM message_status_events WHERE wamid = ?', m.wamid);
    sql.exec('DELETE FROM agent_turns WHERE message_id = ?', m.id);
    sql.exec('DELETE FROM messages_fts WHERE rowid = ?', m.id);
    sql.exec('DELETE FROM messages WHERE id = ?', m.id);
  }
  return msgs.length;
}

export const hasExpired = (sql: SqlStorage, cutoff: number): boolean => sql.exec('SELECT 1 FROM messages WHERE created_at < ? LIMIT 1', cutoff).toArray().length > 0;
