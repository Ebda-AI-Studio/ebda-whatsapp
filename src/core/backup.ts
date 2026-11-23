import { z } from 'zod';

/** Phase 1 tables first; the rest were added in Phase 2 and are optional in a manifest so older backups still restore. */
export const BACKUP_TABLES = ['contacts', 'conversations', 'messages', 'message_status_events', 'notes', 'conversation_tags', 'templates', 'uploads', 'store_orders', 'store_state', 'agent_state', 'credit_ledger', 'contact_tags', 'imports', 'import_rejects', 'segments', 'campaigns', 'campaign_pages', 'campaign_recipients', 'campaign_links', 'connectors', 'wallet_ledger', 'wallet_holds', 'billable_sends', 'ledger_outbox', 'consent_proofs', 'quick_replies'] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];
/** Stable row order per table for the NDJSON files (two tables have no integer id). */
export const BACKUP_ORDER: Record<BackupTable, string> = {
  contacts: 'id', conversations: 'id', messages: 'id', message_status_events: 'id', notes: 'id', templates: 'id',
  conversation_tags: 'conversation_id, tag', uploads: 'id', store_orders: 'order_id', store_state: 'key', agent_state: 'key', credit_ledger: 'id',
  contact_tags: 'contact_id, tag', imports: 'id', import_rejects: 'import_id, line', segments: 'id',
  campaigns: 'id', campaign_pages: 'campaign_id, page', campaign_recipients: 'campaign_id, contact_id', campaign_links: 'code', connectors: 'id',
  wallet_ledger: 'id', wallet_holds: 'ref', billable_sends: 'wamid', ledger_outbox: 'ledger, ref', consent_proofs: 'id', quick_replies: 'id',
};
// Not backed up, by design: derived or transient state (messages_fts is rebuilt on restore; scheduled_tasks/events/tier_slots/number_limits/erased_keys/r2_pending_deletes are operational) and R2 objects (bodies, media, uploads).
const tableEntry = z.object({ rows: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
export const backupManifestSchema = z.object({
  workspaceId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  schemaVersion: z.number().int().positive(),
  /** `hmac-sha256:<hex>` over the canonical manifest (M-174). Optional so backups made before it still read; a restore with a key configured requires it. */
  signature: z.string().regex(/^hmac-sha256:[0-9a-f]{64}$/).optional(),
  tables: z.object({
    contacts: tableEntry, conversations: tableEntry, messages: tableEntry, message_status_events: tableEntry,
    notes: tableEntry.optional(), conversation_tags: tableEntry.optional(), templates: tableEntry.optional(), uploads: tableEntry.optional(),
    store_orders: tableEntry.optional(), store_state: tableEntry.optional(), agent_state: tableEntry.optional(), credit_ledger: tableEntry.optional(),
    contact_tags: tableEntry.optional(), imports: tableEntry.optional(), import_rejects: tableEntry.optional(), segments: tableEntry.optional(),
    campaigns: tableEntry.optional(), campaign_pages: tableEntry.optional(), campaign_recipients: tableEntry.optional(), campaign_links: tableEntry.optional(), connectors: tableEntry.optional(),
    wallet_ledger: tableEntry.optional(), wallet_holds: tableEntry.optional(), billable_sends: tableEntry.optional(), ledger_outbox: tableEntry.optional(), consent_proofs: tableEntry.optional(), quick_replies: tableEntry.optional(),
  }),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

// ---- M-174: the manifest is signed (HMAC-SHA256, key from env), not only hashed ------------------------------------------------------------
// The per-table sha256 proves integrity (corruption, truncation); anyone who can write to the bucket can rewrite a table file and its hash together.
// The signature covers the canonical manifest, so a forged manifest needs the key, which never lives in the bucket.
const SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/;
/** Stable JSON of the manifest WITHOUT its signature: keys sorted at every level, so the signature does not depend on key order. */
export function canonicalManifest(m: Omit<BackupManifest, 'signature'> & { signature?: string }): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v);
  const { signature: _signature, ...rest } = m;
  return JSON.stringify(sort(rest));
}
async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function signManifest(m: Omit<BackupManifest, 'signature'> & { signature?: string }, key: string): Promise<string> {
  return `hmac-sha256:${await hmacHex(key, canonicalManifest(m))}`;
}
/** True when the manifest's signature matches under ANY of `keys` (the current key, and the previous one during a key change). */
export async function verifyManifestSignature(m: BackupManifest & { signature?: string }, keys: string[]): Promise<boolean> {
  if (!m.signature || !SIGNATURE.test(m.signature)) return false;
  const want = new TextEncoder().encode(m.signature);
  for (const key of keys) {
    const got = new TextEncoder().encode(await signManifest(m, key));
    if (got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want)) return true;
  }
  return false;
}

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
