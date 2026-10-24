import type { Env } from '../../env';
import type { ImportRow } from './contacts';
import { detectDelimiter, normaliseImportRow, parseCsvChunk, resolveColumns } from './csv';

/** How much of the file one workflow step reads and applies. A field so tests can use many small chunks. */
export const IMPORT_TUNING = { chunkBytes: 256 * 1024, maxRecords: 2000 };

export type ChunkOutcome = { done: boolean; status: 'running' | 'done' | 'failed' };

const stubFor = (env: Env, workspaceId: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));

/**
 * One step of the import workflow: read the next slice of the uploaded file from R2, parse it, normalise the rows and hand them to the
 * workspace. Safe to run twice: the workspace applies a chunk only if it starts at the stored offset, and a replay changes nothing.
 * Rows are normalised here (the Worker), not in the Durable Object, so the DO only does the writes.
 */
export async function runImportChunk(env: Env, workspaceId: string, importId: string): Promise<ChunkOutcome> {
  const ws = stubFor(env, workspaceId);
  const st = await ws.importState(importId);
  if (!st) return { done: true, status: 'failed' };
  if (st.status === 'done' || st.status === 'failed') return { done: true, status: st.status };
  if (st.nextOffset >= st.size) {
    await ws.failImport(importId, 'file_ended_early'); // the file ended without the last chunk being applied: cannot happen unless the file changed
    return { done: true, status: 'failed' };
  }
  const length = Math.min(IMPORT_TUNING.chunkBytes, st.size - st.nextOffset);
  const obj = await env.MEDIA.get(st.r2Key, { range: { offset: st.nextOffset, length } });
  if (!obj) {
    await ws.failImport(importId, 'file_missing');
    return { done: true, status: 'failed' };
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const final = st.nextOffset + bytes.length >= st.size;
  const first = st.nextOffset === 0;
  const delimiter = st.delimiter ?? detectDelimiter(bytes);
  const parsed = parseCsvChunk(bytes, { delimiter, startLine: st.nextLine, maxRecords: IMPORT_TUNING.maxRecords, final, stripBom: first });
  if (parsed.consumed === 0 && !final) {
    await ws.failImport(importId, 'row_too_long');
    return { done: true, status: 'failed' };
  }
  let cols = st.cols;
  let records = parsed.records;
  if (first) {
    const header = records[0];
    if (!header || header.bad) {
      await ws.failImport(importId, 'no_header');
      return { done: true, status: 'failed' };
    }
    const resolved = resolveColumns(header.cells, st.mapping ?? {});
    if (!resolved.ok) {
      await ws.failImport(importId, resolved.reason);
      return { done: true, status: 'failed' };
    }
    cols = resolved.cols;
    records = records.slice(1);
  }
  if (!cols) {
    await ws.failImport(importId, 'no_header');
    return { done: true, status: 'failed' };
  }
  const rows: ImportRow[] = records.map((r) => {
    if (r.bad) return { line: r.line, reject: 'unreadable_row' as const };
    const n = normaliseImportRow(r.cells, cols!);
    return n.ok ? { line: r.line, waId: n.waId, name: n.name, tags: n.tags } : { line: r.line, reject: n.reason };
  });
  const applied = await ws.applyImportChunk({
    importId, fromOffset: st.nextOffset, toOffset: st.nextOffset + parsed.consumed, nextLine: st.nextLine + parsed.lines, delimiter, cols, rows,
  });
  if (!applied.ok) throw new Error(`import chunk refused: ${applied.reason}`); // the step retries; a persistent refusal fails the workflow loudly
  if (!applied.done) return { done: false, status: 'running' };
  const ended = await ws.getImport(importId);
  return { done: true, status: ended?.status === 'failed' ? 'failed' : 'done' };
}
