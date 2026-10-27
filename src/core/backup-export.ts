import { BACKUP_ORDER, type BackupTable } from './backup';

/**
 * Chunked, streaming export of one table (T17). The old export read every table of the workspace inside ONE `transactionSync` and held the whole thing in
 * memory: on a big workspace that blocks the Durable Object for the whole read and can exceed its memory. Now:
 *  - rows are read in keyset chunks (`WHERE key > last ORDER BY key LIMIT n`), each its own short synchronous read; the awaits between chunks let other requests in;
 *  - the NDJSON is streamed to R2 (a single put while the file is small, a multipart upload past `PART_BYTES`) and hashed incrementally (DigestStream), so memory
 *    is one chunk plus one part, not the table;
 *  - tables with an integer `id` key stop at the high-water mark taken at the start of the whole export, so a child row written during the export never refers to a parent
 *    row the snapshot lacks (messages -> conversations -> contacts). Keyed tables (tags, recipients, state) are read as of their chunk.
 * The files and hashes are byte-identical to the one-shot export. Consistency model: per row, not per workspace (Ruling WA-BACKUP-CHUNK-1 in docs/runbooks/backup-restore.md).
 */
export const DEFAULT_CHUNK_ROWS = 2_000;
/** R2 multipart parts must be at least 5 MiB (except the last). */
export const PART_BYTES = 5 * 1024 * 1024;

type Sql = Pick<DurableObjectStorage, 'sql'>['sql'];
const columnsOf = (t: BackupTable): string[] => BACKUP_ORDER[t].split(',').map((c) => c.trim());
const isIdKeyed = (t: BackupTable): boolean => BACKUP_ORDER[t] === 'id';

/** The largest `id` of each id-keyed table, read in one tiny transaction at the start. */
export function highWaterMarks(sql: Sql, storage: DurableObjectStorage, tables: readonly BackupTable[]): Partial<Record<BackupTable, number>> {
  return storage.transactionSync(() => {
    const out: Partial<Record<BackupTable, number>> = {};
    for (const t of tables) if (isIdKeyed(t)) out[t] = sql.exec<{ m: number | null }>(`SELECT max(id) AS m FROM ${t}`).one().m ?? 0;
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
  const cols = columnsOf(d.table);
  const colList = cols.join(', ');
  const tuple = `(${colList})`;
  const marks = `(${cols.map(() => '?').join(', ')})`;
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
      const where = [last ? `${tuple} > ${marks}` : null, d.highWater !== undefined ? 'id <= ?' : null].filter(Boolean).join(' AND ');
      const params: SqlStorageValue[] = [...(last ?? []), ...(d.highWater !== undefined ? [d.highWater] : [])];
      const batch = d.sql.exec(`SELECT * FROM ${d.table} ${where ? `WHERE ${where}` : ''} ORDER BY ${colList} LIMIT ?`, ...params, d.chunkRows).toArray() as Record<string, SqlStorageValue>[];
      if (!batch.length) break;
      const text = batch.map((r) => `${JSON.stringify(r)}\n`).join('');
      const bytes = encoder.encode(text);
      await hasher.write(bytes);
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      rows += batch.length;
      last = cols.map((c) => batch[batch.length - 1]![c]!);
      chunk++;
      while (pendingBytes >= PART_BYTES) await flushPart();
      await d.afterChunk?.(d.table, chunk);
      if (batch.length < d.chunkRows) break;
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
