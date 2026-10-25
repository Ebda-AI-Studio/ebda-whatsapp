import { z } from 'zod';

/** Phase 1 tables first; the rest were added in Phase 2 and are optional in a manifest so older backups still restore. */
export const BACKUP_TABLES = ['contacts', 'conversations', 'messages', 'message_status_events', 'notes', 'conversation_tags', 'templates', 'uploads', 'store_orders', 'store_state', 'agent_state', 'credit_ledger', 'contact_tags', 'imports', 'import_rejects', 'segments', 'campaigns', 'campaign_pages', 'campaign_recipients', 'campaign_links', 'connectors'] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];
/** Stable row order per table for the NDJSON files (two tables have no integer id). */
export const BACKUP_ORDER: Record<BackupTable, string> = {
  contacts: 'id', conversations: 'id', messages: 'id', message_status_events: 'id', notes: 'id', templates: 'id',
  conversation_tags: 'conversation_id, tag', uploads: 'id', store_orders: 'order_id', store_state: 'key', agent_state: 'key', credit_ledger: 'id',
  contact_tags: 'contact_id, tag', imports: 'id', import_rejects: 'import_id, line', segments: 'id',
  campaigns: 'id', campaign_pages: 'campaign_id, page', campaign_recipients: 'campaign_id, contact_id', campaign_links: 'code', connectors: 'id',
};
// Not backed up, by design: derived or transient state (messages_fts is rebuilt on restore; scheduled_tasks/events/tier_slots/number_limits/erased_keys/r2_pending_deletes are operational) and R2 objects (bodies, media, uploads).
const tableEntry = z.object({ rows: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
export const backupManifestSchema = z.object({
  workspaceId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  schemaVersion: z.number().int().positive(),
  tables: z.object({
    contacts: tableEntry, conversations: tableEntry, messages: tableEntry, message_status_events: tableEntry,
    notes: tableEntry.optional(), conversation_tags: tableEntry.optional(), templates: tableEntry.optional(), uploads: tableEntry.optional(),
    store_orders: tableEntry.optional(), store_state: tableEntry.optional(), agent_state: tableEntry.optional(), credit_ledger: tableEntry.optional(),
    contact_tags: tableEntry.optional(), imports: tableEntry.optional(), import_rejects: tableEntry.optional(), segments: tableEntry.optional(),
    campaigns: tableEntry.optional(), campaign_pages: tableEntry.optional(), campaign_recipients: tableEntry.optional(), campaign_links: tableEntry.optional(), connectors: tableEntry.optional(),
  }),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const BACKUP_HOUR_LOCAL = 2;
export const BACKUP_TIME_ZONE = 'Africa/Cairo';

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toNdjson(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

/** Epoch ms of the next whole hour `hour` in `timeZone` strictly after `now` (DST-safe: walks hour by hour). */
export function nextLocalHour(now: number, hour: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
  let t = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
  for (let i = 0; i < 48; i++, t += 3_600_000) {
    if (Number(fmt.format(t)) === hour) return t;
  }
  throw new Error('no matching hour within 48 h');
}

export function backupPrefix(workspaceId: string, date: string): string {
  return `backups/${workspaceId}/${date}/`;
}
