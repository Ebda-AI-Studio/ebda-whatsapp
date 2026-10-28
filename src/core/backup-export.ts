import type { BackupTable } from './backup';
import { alert } from './observability';

/**
 * Chunked, streaming export of one table (T17). The old export read every table of the workspace inside ONE `transactionSync` and held the whole thing in
 * memory: on a big workspace that blocks the Durable Object for the whole read and can exceed its memory. Now:
 *  - rows are read in keyset chunks (`WHERE key > last ORDER BY key LIMIT n`), each its own short synchronous read; the awaits between chunks let other requests in.
 *    THE KEY IS ALWAYS UNIQUE AND NEVER NULL: `rowid` for a rowid table, the primary key for a WITHOUT ROWID table (SQLite makes those columns NOT NULL), and a table with
 *    neither is refused. (A keyset over a nullable column, `(a, b) > (?, ?)`, is never true for a NULL row, so every row after the first NULL was silently dropped.)
 *  - the NDJSON is streamed to R2 (a single put while the file is small, a multipart upload past `PART_BYTES`) and hashed incrementally (DigestStream), so memory
 *    is one chunk plus one part, not the table;
 *  - every rowid table stops at the high-water mark (`max(rowid)`) taken at the start of the whole export, so a child row written during the export never refers to a parent
 *    row the snapshot lacks (messages -> conversations -> contacts). WITHOUT ROWID tables (tags, recipients) are read as of their chunk.
 *  - SUCCESS IS A POSITIVE COUNT MATCH: after a table is read, the rows written are compared with `count(*)` under the same condition. A mismatch (a row ADDED or skipped
 *    while the table was read; for a rowid table a row DELETED below the high-water mark is tolerated) raises `backup_export_mismatch`, throws, and writes neither the table file nor the manifest: a partial backup never reads as complete.
 * The files and hashes are byte-identical to the one-shot export. Consistency model: per row, not per workspace (Ruling WA-BACKUP-CHUNK-1 in docs/runbooks/backup-restore.md).
 */
export const DEFAULT_CHUNK_ROWS = 500;
/** R2 multipart parts must be at least 5 MiB (except the last). */
export const PART_BYTES = 5 * 1024 * 1024;

type Sql = Pick<DurableObjectStorage, 'sql'>['sql'];
type Key = { kind: 'rowid' } | { kind: 'pk'; cols: string[] };
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The unique, non-null cursor of a table. Throws for a table that has none (a view, a table the engine cannot order). */
export function keyOf(sql: Sql, table: string): Key {
  if (!SAFE_NAME.test(table)) throw new Error(`export refused: ${table} is not a plain table name`);
  try {
    sql.exec(`SELECT rowid FROM ${table} LIMIT 0`).toArray();
    return { kind: 'rowid' };
  } catch {
    // no rowid: WITHOUT ROWID table (its primary key is NOT NULL by definition), or not a table at all
  }
  const cols = sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`).toArray().map((r) => r.name);
  if (!cols.length) throw new Error(`export refused: ${table} has no usable key`);
  return { kind: 'pk', cols };
}

/** `max(rowid)` of every rowid table, read in one tiny transaction at the start. */
export function highWaterMarks(sql: Sql, storage: DurableObjectStorage, tables: readonly BackupTable[]): Partial<Record<BackupTable, number>> {
  return storage.transactionSync(() => {
    const out: Partial<Record<BackupTable, number>> = {};
    for (const t of tables) if (keyOf(sql, t).kind === 'rowid') out[t] = sql.exec<{ m: number | null }>(`SELECT max(rowid) AS m FROM ${t}`).one().m ?? 0;
    return out;
  });
}

export type ExportDeps = {
  sql: Sql;
  bucket: R2Bucket;
  key: string;
  table: BackupTable;
  highWater: number | undefined;
  chunkRows: number;
  afterChunk?: (table: string, chunk: number) => Promise<void>;
};

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function exportTable(d: ExportDeps): Promise<{ rows: number; sha256: string }> {
  const key = keyOf(d.sql, d.table);
  const cols = key.kind === 'rowid' ? ['__rid'] : key.cols;
  const order = key.kind === 'rowid' ? 'rowid' : key.cols.join(', ');
  const tuple = `(${order})`;
  const marks = `(${cols.map(() => '?').join(', ')})`;
  const select = key.kind === 'rowid' ? 'rowid AS __rid, *' : '*';
  const capped = key.kind === 'rowid' && d.highWater !== undefined;
  const digest = new crypto.DigestStream('SHA-256');
  const hasher = digest.getWriter();
  const encoder = new TextEncoder();
  const parts: R2UploadedPart[] = [];
  let upload: R2MultipartUpload | null = null;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let rows = 0;
  let chunk = 0;
  let last: SqlStorageValue[] | null = null;

  const concat = (): Uint8Array => {
    const out = new Uint8Array(pendingBytes);
    let at = 0;
    for (const p of pending) { out.set(p, at); at += p.byteLength; }
    pending = [];
    pendingBytes = 0;
    return out;
  };
  // R2 wants every part but the last to be the SAME size: cut exactly PART_BYTES, keep the rest buffered.
  const flushPart = async (all = false): Promise<void> => {
    upload ??= await d.bucket.createMultipartUpload(d.key);
    const buf = concat();
    const cut = all ? buf.byteLength : PART_BYTES;
    parts.push(await upload.uploadPart(parts.length + 1, buf.subarray(0, cut)));
    if (cut < buf.byteLength) { pending = [buf.subarray(cut)]; pendingBytes = buf.byteLength - cut; }
  };

  try {
    for (;;) {
      const where = [last ? `${tuple} > ${marks}` : null, capped ? 'rowid <= ?' : null].filter(Boolean).join(' AND ');
      const params: SqlStorageValue[] = [...(last ?? []), ...(capped ? [d.highWater!] : [])];
      const batch = d.sql.exec(`SELECT ${select} FROM ${d.table} ${where ? `WHERE ${where}` : ''} ORDER BY ${order} LIMIT ?`, ...params, d.chunkRows).toArray() as Record<string, SqlStorageValue>[];
      if (!batch.length) break;
      const text = batch.map(({ __rid: _rid, ...row }) => `${JSON.stringify(row)}\n`).join('');
      const bytes = encoder.encode(text);
      await hasher.write(bytes);
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      rows += batch.length;
      last = cols.map((c) => batch[batch.length - 1]![c]!);
      chunk++;
      while (pendingBytes >= PART_BYTES) await flushPart();
      await d.afterChunk?.(d.table, chunk);
      // A real yield: reading SQL is synchronous, and an await on an already-settled promise lets no other request in. A zero-delay timer does.
      await new Promise<void>((r) => setTimeout(r, 0));
      if (batch.length < d.chunkRows) break;
    }
    // Positive count match BEFORE anything is finalised: the table file does not exist, and no manifest follows, unless the rows written equal the rows the table holds.
    const counted = d.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${d.table} ${capped ? 'WHERE rowid <= ?' : ''}`, ...(capped ? [d.highWater!] : [])).one().n;
    // A rowid table stops at the high-water mark, so a row can only have been DELETED since it was read (the retention purge, an erasure): fewer rows now than were written is fine.
    // MORE rows than were written is a row the keyset skipped: a real mismatch. A table with no mark (WITHOUT ROWID) can also grow, so it stays an exact match.
    if (capped ? counted > rows : counted !== rows) {
      alert('backup_export_mismatch', { table: d.table, exported: rows, counted });
      throw new Error(`backup export mismatch: ${d.table} exported ${rows} rows, the table holds ${counted}`);
    }
    if (upload) {
      if (pendingBytes > 0) await flushPart(true);
      await (upload as R2MultipartUpload).complete(parts);
    } else {
      await d.bucket.put(d.key, concat()); // small table (or empty): one put, an empty file included
    }
    await hasher.close();
    return { rows, sha256: hex(await digest.digest) };
  } catch (e) {
    await (upload as R2MultipartUpload | null)?.abort().catch(() => undefined);
    throw e;
  }
}
