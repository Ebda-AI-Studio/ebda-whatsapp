import type { LinkHost } from '../store-link/host';
import type { ColumnMap, ImportRejectReason } from './csv';
import { MAX_TAGS_PER_CONTACT } from './csv';

/** Hard limits of one import: file size is checked at the edge, rows here. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;
/** Rejected rows kept for the report; the rest are only counted. */
export const MAX_STORED_REJECTS = 1000;
/** A contact's tag set is bounded so a long-lived contact cannot grow without limit. */
export const MAX_CONTACT_TAGS = 20;

export type ImportStatus = 'pending' | 'running' | 'done' | 'failed';
export type ImportRow = { line: number } & ({ waId: string; name: string | null; tags: string[] } | { reject: ImportRejectReason });
export type ImportState = {
  id: string; status: ImportStatus; r2Key: string; size: number; consented: boolean; mapping: { phone?: string; name?: string; tags?: string } | null;
  nextOffset: number; nextLine: number; delimiter: number | null; cols: ColumnMap | null;
};
export type ImportSummary = {
  id: string; filename: string; status: ImportStatus; consented: boolean; total: number; created: number; updated: number; rejected: number;
  error: string | null; createdAt: number; finishedAt: number | null;
};

/** `import:<file>` is the consent source stored on a contact; the file name is the merchant's own, cleaned of anything odd. */
export function importConsentSource(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `import:${clean || 'file'}`;
}

export function createImport(host: LinkHost, a: { id: string; filename: string; r2Key: string; size: number; consented: boolean; mapping: ImportState['mapping']; actor: string; now: number }): { ok: true } | { ok: false; reason: 'import_in_progress' } {
  return host.storage.transactionSync(() => {
    if (host.sql.exec("SELECT 1 FROM imports WHERE status IN ('pending', 'running')").toArray().length) return { ok: false, reason: 'import_in_progress' } as const;
    host.sql.exec(
      "INSERT INTO imports (id, filename, r2_key, size, consented, mapping, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      a.id, a.filename.slice(0, 120), a.r2Key, a.size, a.consented ? 1 : 0, a.mapping ? JSON.stringify(a.mapping) : null, a.actor, a.now,
    );
    return { ok: true } as const;
  });
}

export function importState(host: LinkHost, id: string): ImportState | null {
  const r = host.sql.exec<{ id: string; status: ImportStatus; r2_key: string; size: number; consented: number; mapping: string | null; next_offset: number; next_line: number; delimiter: number | null; cols: string | null }>(
    'SELECT id, status, r2_key, size, consented, mapping, next_offset, next_line, delimiter, cols FROM imports WHERE id = ?', id,
  ).toArray()[0];
  if (!r) return null;
  return {
    id: r.id, status: r.status, r2Key: r.r2_key, size: r.size, consented: r.consented === 1, mapping: r.mapping ? JSON.parse(r.mapping) : null,
    nextOffset: r.next_offset, nextLine: r.next_line, delimiter: r.delimiter, cols: r.cols ? JSON.parse(r.cols) : null,
  };
}

export function importSummary(host: LinkHost, id: string): ImportSummary | null {
  const r = host.sql.exec<{ id: string; filename: string; status: ImportStatus; consented: number; total: number; created_count: number; updated_count: number; rejected_count: number; error: string | null; created_at: number; finished_at: number | null }>(
    'SELECT id, filename, status, consented, total, created_count, updated_count, rejected_count, error, created_at, finished_at FROM imports WHERE id = ?', id,
  ).toArray()[0];
  return r ? { id: r.id, filename: r.filename, status: r.status, consented: r.consented === 1, total: r.total, created: r.created_count, updated: r.updated_count, rejected: r.rejected_count, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at } : null;
}

export function listImports(host: LinkHost, limit: number): ImportSummary[] {
  return host.sql.exec<{ id: string }>('SELECT id FROM imports ORDER BY created_at DESC, id DESC LIMIT ?', limit).toArray().map((r) => importSummary(host, r.id)!);
}

export function listRejects(host: LinkHost, id: string): { line: number; reason: string }[] | null {
  if (!host.sql.exec('SELECT 1 FROM imports WHERE id = ?', id).toArray().length) return null;
  return host.sql.exec<{ line: number; reason: string }>('SELECT line, reason FROM import_rejects WHERE import_id = ? ORDER BY line', id).toArray();
}

export type ApplyArgs = { maxRows?: number; importId: string; fromOffset: number; toOffset: number; nextLine: number; delimiter: number; cols: ColumnMap; rows: ImportRow[]; now: number };
export type ApplyResult = { ok: true; done: boolean; keys: string[] } | { ok: false; reason: 'unknown_import' | 'not_running' | 'offset_mismatch' };

/**
 * Applies one parsed chunk, once. The chunk is identified by the byte offset it starts at: a replay (the workflow step ran twice) finds
 * next_offset already past it and changes nothing. Existing contacts are merged, never replaced: a name only fills a gap, tags are added,
 * and consent is recorded only where none exists and the contact has not opted out, so an import can never undo a STOP.
 */
export function applyImportChunk(host: LinkHost, a: ApplyArgs): ApplyResult {
  return host.storage.transactionSync((): ApplyResult => {
    const imp = host.sql.exec<{ status: ImportStatus; next_offset: number; consented: number; filename: string; r2_key: string; size: number; total: number; rejected_count: number }>(
      'SELECT status, next_offset, consented, filename, r2_key, size, total, rejected_count FROM imports WHERE id = ?', a.importId,
    ).toArray()[0];
    if (!imp) return { ok: false, reason: 'unknown_import' };
    if (imp.next_offset > a.fromOffset) return { ok: true, done: imp.status === 'done' || imp.status === 'failed', keys: [] };
    if (imp.status !== 'pending' && imp.status !== 'running') return { ok: false, reason: 'not_running' };
    if (imp.next_offset < a.fromOffset) return { ok: false, reason: 'offset_mismatch' };
    const source = importConsentSource(imp.filename);
    let created = 0, updated = 0, rejected = 0, seen = imp.total;
    let storedRejects = host.sql.exec<{ n: number }>('SELECT count(*) AS n FROM import_rejects WHERE import_id = ?', a.importId).one().n;
    const reject = (line: number, reason: string) => {
      rejected++;
      if (storedRejects < MAX_STORED_REJECTS) {
        host.sql.exec('INSERT OR IGNORE INTO import_rejects (import_id, line, reason) VALUES (?, ?, ?)', a.importId, line, reason);
        storedRejects++;
      }
    };
    let overLimit = false;
    for (const row of a.rows) {
      if (seen >= (a.maxRows ?? MAX_IMPORT_ROWS)) { overLimit = true; break; }
      seen++;
      if ('reject' in row) { reject(row.line, row.reject); continue; }
      const have = host.sql.exec<{ id: number; last_import_id: string | null; consent_at: number | null; opted_out_at: number | null }>(
        'SELECT id, last_import_id, consent_at, opted_out_at FROM contacts WHERE wa_id = ?', row.waId,
      ).toArray()[0];
      if (have?.last_import_id === a.importId) { reject(row.line, 'duplicate_in_file'); continue; }
      let contactId: number;
      const grant = imp.consented === 1;
      if (!have) {
        contactId = host.sql.exec<{ id: number }>(
          'INSERT INTO contacts (wa_id, profile_name, last_import_id, consent_source, consent_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
          row.waId, row.name, a.importId, grant ? source : null, grant ? a.now : null,
        ).one().id;
        created++;
      } else {
        contactId = have.id;
        host.sql.exec('UPDATE contacts SET profile_name = coalesce(profile_name, ?), last_import_id = ? WHERE id = ?', row.name, a.importId, contactId);
        if (grant && have.consent_at === null && have.opted_out_at === null) host.sql.exec('UPDATE contacts SET consent_source = ?, consent_at = ? WHERE id = ?', source, a.now, contactId);
        updated++;
      }
      addContactTags(host, contactId, row.tags);
    }
    const done = overLimit || a.toOffset >= imp.size;
    const status: ImportStatus = overLimit ? 'failed' : done ? 'done' : 'running';
    host.sql.exec(
      `UPDATE imports SET status = ?, next_offset = ?, next_line = ?, delimiter = ?, cols = ?, total = ?, created_count = created_count + ?, updated_count = updated_count + ?,
         rejected_count = rejected_count + ?, error = ?, finished_at = ? WHERE id = ?`,
      status, a.toOffset, a.nextLine, a.delimiter, JSON.stringify(a.cols), seen, created, updated, rejected, overLimit ? 'row_limit' : null, done ? a.now : null, a.importId,
    );
    const keys: string[] = [];
    if (done) {
      host.sql.exec('INSERT OR IGNORE INTO r2_pending_deletes (key) VALUES (?)', imp.r2_key);
      keys.push(imp.r2_key);
    }
    return { ok: true, done, keys };
  });
}

/** Ends an import that cannot continue. The uploaded file holds customers' phone numbers, so it is queued for deletion at once. */
export function failImport(host: LinkHost, id: string, reason: string, now: number): { keys: string[] } {
  return host.storage.transactionSync(() => {
    const imp = host.sql.exec<{ r2_key: string; status: ImportStatus }>('SELECT r2_key, status FROM imports WHERE id = ?', id).toArray()[0];
    if (!imp || imp.status === 'done' || imp.status === 'failed') return { keys: [] };
    host.sql.exec("UPDATE imports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", reason.slice(0, 60), now, id);
    host.sql.exec('INSERT OR IGNORE INTO r2_pending_deletes (key) VALUES (?)', imp.r2_key);
    return { keys: [imp.r2_key] };
  });
}

/** Adds tags to a contact, never past MAX_CONTACT_TAGS. Call inside a transaction. */
export function addContactTags(host: LinkHost, contactId: number, tags: string[]): void {
  if (!tags.length) return;
  let have = host.sql.exec<{ n: number }>('SELECT count(*) AS n FROM contact_tags WHERE contact_id = ?', contactId).one().n;
  for (const t of tags) {
    if (have >= MAX_CONTACT_TAGS) return;
    if (host.sql.exec('INSERT OR IGNORE INTO contact_tags (contact_id, tag) VALUES (?, ?)', contactId, t).rowsWritten > 0) have++;
  }
}

export type ContactItem = {
  waId: string; name: string | null; optedOut: boolean; tags: string[]; consent: { source: string; at: number } | null; lastInboundAt: number | null;
};

/** Every tag a contact carries: its own and those the inbox put on its conversation. */
export function tagsFor(host: LinkHost, contactIds: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!contactIds.length) return out;
  const marks = contactIds.map(() => '?').join(',');
  const rows = host.sql.exec<{ contact_id: number; tag: string }>(
    `SELECT contact_id, tag FROM contact_tags WHERE contact_id IN (${marks})
     UNION SELECT cv.contact_id, t.tag FROM conversation_tags t JOIN conversations cv ON cv.id = t.conversation_id WHERE cv.contact_id IN (${marks}) ORDER BY 1, 2`,
    ...contactIds, ...contactIds,
  ).toArray();
  for (const r of rows) (out.get(r.contact_id) ?? out.set(r.contact_id, []).get(r.contact_id)!).push(r.tag);
  return out;
}

export type ContactQuery = { tag?: string; optedOut?: boolean; q?: string; cursor?: number; limit: number };

/** Newest first by contact id (stable under inserts), keyset-paginated. `tag` matches either tag source. */
export function listContacts(host: LinkHost, q: ContactQuery): { items: ContactItem[]; nextCursor: string | null } {
  const where: string[] = [];
  const params: SqlStorageValue[] = [];
  if (q.cursor !== undefined) { where.push('c.id < ?'); params.push(q.cursor); }
  if (q.optedOut !== undefined) where.push(q.optedOut ? 'c.opted_out_at IS NOT NULL' : 'c.opted_out_at IS NULL');
  if (q.tag) {
    where.push('(EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = c.id AND t.tag = ?) OR EXISTS (SELECT 1 FROM conversation_tags t JOIN conversations cv ON cv.id = t.conversation_id WHERE cv.contact_id = c.id AND t.tag = ?))');
    params.push(q.tag, q.tag);
  }
  if (q.q) {
    const digits = q.q.replace(/\D/g, '');
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(digits.length >= 3 ? "(c.wa_id LIKE ? OR c.profile_name LIKE ? ESCAPE '\\')" : "c.profile_name LIKE ? ESCAPE '\\'");
    if (digits.length >= 3) params.push(`${digits}%`);
    params.push(like);
  }
  const rows = host.sql.exec<{ id: number; wa_id: string; profile_name: string | null; opted_out_at: number | null; consent_source: string | null; consent_at: number | null; last_inbound_at: number | null }>(
    `SELECT c.id, c.wa_id, c.profile_name, c.opted_out_at, c.consent_source, c.consent_at, c.last_inbound_at FROM contacts c ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT ?`,
    ...params, q.limit + 1,
  ).toArray();
  const page = rows.slice(0, q.limit);
  const tags = tagsFor(host, page.map((r) => r.id));
  return {
    items: page.map((r) => ({
      waId: r.wa_id, name: r.profile_name, optedOut: r.opted_out_at !== null, tags: tags.get(r.id) ?? [],
      consent: r.consent_at !== null && r.consent_source ? { source: r.consent_source, at: r.consent_at } : null,
      lastInboundAt: r.last_inbound_at === null ? null : r.last_inbound_at * 1000,
    })),
    nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.id) : null,
  };
}

/** Replaces a contact's own tags. null = no such contact. */
export function setContactTags(host: LinkHost, waId: string, tags: string[]): { tags: string[] } | null {
  return host.storage.transactionSync(() => {
    const c = host.sql.exec<{ id: number }>('SELECT id FROM contacts WHERE wa_id = ?', waId).toArray()[0];
    if (!c) return null;
    host.sql.exec('DELETE FROM contact_tags WHERE contact_id = ?', c.id);
    addContactTags(host, c.id, tags.slice(0, MAX_TAGS_PER_CONTACT));
    return { tags: tagsFor(host, [c.id]).get(c.id) ?? [] };
  });
}
