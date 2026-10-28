import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BACKUP_TABLES, sha256Hex } from '../src/core/backup';
import { exec, rows, workspace } from './helpers/workspace';

// T17: the export reads each table in short keyset chunks (never one transaction over the whole workspace) and streams the file to R2, so memory and the time a
// single read blocks the Durable Object stay bounded however big the workspace is. The file and manifest are byte-identical to the one-shot export.
type Knobs = { backupChunkRows: number; backupHooks: { afterChunk?: (table: string, chunk: number) => Promise<void> } };
const knobs = (ws: string, f: (k: Knobs) => void) => runInDurableObject(workspace(ws), (inst) => { f(inst as unknown as Knobs); });
const seed = (ws: string, n: number) => workspace(ws).ingest({ phoneNumberId: 'pn', inbound: Array.from({ length: n }, (_, i) => ({ wamid: `wamid.${i}`, from: `2010000000${i % 10}`, ts: 1000 + i, type: 'text' as const, text: `رسالة ${i} 👋` })), statuses: [], receivedAt: 1 });
const body = async (ws: string, t: string) => (await (await env.BACKUPS.get(`backups/${ws}/2026-10-27/${t}.ndjson`))!.text());

it('a chunked export is byte-identical to the one-shot export of the SAME workspace: same files, same hashes, same manifest', async () => {
  await seed('ws-ck1', 25);
  await knobs('ws-ck1', (k) => { k.backupChunkRows = 1_000_000; });
  const whole = await workspace('ws-ck1').exportSnapshot('2026-10-27');
  await knobs('ws-ck1', (k) => { k.backupChunkRows = 2; });
  const chunked = await workspace('ws-ck1').exportSnapshot('2026-10-28');
  expect({ ...chunked, date: '' }).toEqual({ ...whole, date: '' });
  for (const t of BACKUP_TABLES) {
    const one = await (await env.BACKUPS.get(`backups/ws-ck1/2026-10-27/${t}.ndjson`))!.text();
    const many = await (await env.BACKUPS.get(`backups/ws-ck1/2026-10-28/${t}.ndjson`))!.text();
    expect(many, t).toBe(one);
    expect(chunked.tables[t]!.sha256, t).toBe(await sha256Hex(many));
  }
  expect(whole.tables.messages!.rows).toBe(25);
});

it('reads a table in ceil(rows / chunk) short reads and lets other work in between (no single transaction over the workspace)', async () => {
  await seed('ws-ck2', 5);
  const seen: string[] = [];
  await knobs('ws-ck2', (k) => { k.backupChunkRows = 2; k.backupHooks = { afterChunk: async (t, i) => { if (t === 'messages') seen.push(`${t}#${i}`); } }; });
  await workspace('ws-ck2').exportSnapshot('2026-10-27');
  expect(seen).toEqual(['messages#1', 'messages#2', 'messages#3']); // 5 rows, 2 per chunk
});

it('a message that arrives BETWEEN chunks does not enter the snapshot, and no row in it refers to a conversation the snapshot lacks', async () => {
  await seed('ws-ck3', 4);
  await knobs('ws-ck3', (k) => {
    k.backupChunkRows = 1;
    let done = false;
    const self = k as unknown as { ingest(b: unknown): Promise<unknown> };
    k.backupHooks = { afterChunk: async (t) => { if (t === 'messages' && !done) { done = true; await self.ingest({ phoneNumberId: 'pn', inbound: [{ wamid: 'wamid.late', from: '201999999999', ts: 5000, type: 'text', text: 'late' }], statuses: [], receivedAt: 2 }); } } };
  });
  const m = await workspace('ws-ck3').exportSnapshot('2026-10-27');
  expect(m.tables.messages!.rows).toBe(4); // the late one is after the high-water mark taken at the start
  expect(m.tables.conversations!.rows).toBe(m.tables.contacts!.rows);
  expect((await body('ws-ck3', 'messages')).includes('wamid.late')).toBe(false);
  expect((await workspace('ws-ck3-restore').importSnapshot('backups/ws-ck3/2026-10-27/')).ok).toBe(true);
  expect(await rows('ws-ck3-restore', 'SELECT count(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id)')).toEqual([{ n: 0 }]);
  expect(await rows('ws-ck3', 'SELECT count(*) AS n FROM messages')).toEqual([{ n: 5 }]); // and it IS in the live workspace
});

it('a table over the multipart threshold is streamed in parts and still hashes and counts correctly', async () => {
  const ws = 'ws-ck4';
  await seed(ws, 1);
  const conv = (await rows<{ id: number }>(ws, 'SELECT id FROM conversations'))[0]!.id;
  const text = 'ب'.repeat(10_000); // 20 KB of UTF-8 per note
  for (let i = 0; i < 600; i++) await exec(ws, 'INSERT INTO notes (conversation_id, author_user_id, text, created_at) VALUES (?, ?, ?, ?)', conv, 'u', `${i}:${text}`, i); // ~12 MB
  await knobs(ws, (k) => { k.backupChunkRows = 100; });
  const m = await workspace(ws).exportSnapshot('2026-10-27');
  const stored = await body(ws, 'notes');
  expect(new TextEncoder().encode(stored).length).toBeGreaterThan(11_000_000); // over two 5 MiB parts
  expect(m.tables.notes!.rows).toBe(600);
  expect(m.tables.notes!.sha256).toBe(await sha256Hex(stored));
  expect(stored.split('\n').filter(Boolean)).toHaveLength(600);
  expect((await workspace('ws-ck4-restore').importSnapshot(`backups/${ws}/2026-10-27/`)).ok).toBe(true);
  expect(await rows('ws-ck4-restore', 'SELECT count(*) AS n FROM notes')).toEqual([{ n: 600 }]);
}, 60_000);

it('composite-key tables page correctly (tags: contact_id, tag)', async () => {
  const ws = 'ws-ck5';
  await seed(ws, 3);
  const ids = (await rows<{ id: number }>(ws, 'SELECT id FROM contacts ORDER BY id')).map((r) => r.id);
  for (const id of ids) for (const tag of ['a', 'b', 'c']) await exec(ws, 'INSERT INTO contact_tags (contact_id, tag) VALUES (?, ?)', id, tag);
  await knobs(ws, (k) => { k.backupChunkRows = 4; });
  const m = await workspace(ws).exportSnapshot('2026-10-27');
  const lines = (await body(ws, 'contact_tags')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { contact_id: number; tag: string });
  expect(lines).toHaveLength(m.tables.contact_tags!.rows);
  expect(lines.length).toBe(ids.length * 3);
  expect(new Set(lines.map((l) => `${l.contact_id}/${l.tag}`)).size).toBe(lines.length); // no row twice, none missed across chunk edges
});

// ---- the cursor must be unique and never NULL; success is a positive count match -------------------------------------------------------------
it('rows whose old cursor column is NULL are exported across chunk boundaries (a nullable keyset silently dropped everything after the first NULL)', async () => {
  const ws = 'ws-ck6';
  await seed(ws, 2);
  for (let i = 0; i < 5; i++) await exec(ws, "INSERT INTO agent_state (key, value) VALUES (NULL, ?)", `null-${i}`);
  for (let i = 0; i < 5; i++) await exec(ws, "INSERT INTO agent_state (key, value) VALUES (?, ?)", `k${i}`, `v${i}`);
  await knobs(ws, (k) => { k.backupChunkRows = 2; });
  const m = await workspace(ws).exportSnapshot('2026-10-27');
  const total = (await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM agent_state'))[0]!.n;
  expect(m.tables.agent_state!.rows).toBe(total);
  expect((await body(ws, 'agent_state')).split('\n').filter(Boolean)).toHaveLength(total);
  expect((await body(ws, 'agent_state')).match(/null-/g)).toHaveLength(5);
  expect((await workspace('ws-ck6-restore').importSnapshot(`backups/${ws}/2026-10-27/`)).ok).toBe(true);
  expect(await rows('ws-ck6-restore', 'SELECT count(*) AS n FROM agent_state')).toEqual([{ n: total }]);
});

it('a row removed while a table WITHOUT a high-water mark was being exported makes the export FAIL (positive count match required), alerts, and writes no manifest (a rowid table tolerates a deleted row: see review-minors-2.test.ts)', async () => {
  const ws = 'ws-ck7';
  await seed(ws, 6);
  for (let i = 0; i < 6; i++) await exec(ws, 'INSERT INTO contact_tags (contact_id, tag) VALUES (1, ?)', `t${i}`);
  const lines: string[] = [];
  await knobs(ws, (k) => {
    k.backupChunkRows = 2;
    const sql = (k as unknown as { sql: SqlStorage }).sql;
    let done = false;
    k.backupHooks = { afterChunk: async (t) => { if (t === 'contact_tags' && !done) { done = true; sql.exec("DELETE FROM contact_tags WHERE tag = 't0'"); } } };
  });
  const { vi } = await import('vitest');
  const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { lines.push(String(m)); });
  const failure = await workspace(ws).exportSnapshot('2026-10-27').then(() => null, (e: Error) => e);
  spy.mockRestore();
  expect(String(failure?.message)).toMatch(/export mismatch/);
  expect(await env.BACKUPS.get(`backups/${ws}/2026-10-27/manifest.json`)).toBeNull();
  expect(lines.join('\n')).toContain('backup_export_mismatch');
  expect(lines.join('\n')).not.toMatch(/\d{9,}/); // table name and counts only
});

it('the key is discovered per table: rowid tables page on rowid, WITHOUT ROWID tables on their primary key, and anything with neither (a view) is refused', async () => {
  const { exportTable } = await import('../src/core/backup-export');
  const ws = 'ws-ck8';
  await seed(ws, 1);
  const r = await runInDurableObject(workspace(ws), async (_i, state) => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE t_rowid (a TEXT)');
    sql.exec('CREATE TABLE t_wr (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID');
    sql.exec("CREATE VIEW v_none AS SELECT 1 AS x");
    for (let i = 0; i < 7; i++) { sql.exec('INSERT INTO t_rowid (a) VALUES (?)', i % 2 ? null : `r${i}`); sql.exec('INSERT INTO t_wr (a, b) VALUES (?, ?)', `a${i % 3}`, `b${i}`); }
    const run = (table: string) => exportTable({ sql, bucket: env.BACKUPS, key: `scratch/${table}`, table: table as never, highWater: undefined, chunkRows: 2 }).then((x) => x.rows, (e: Error) => e.message);
    const out = { rowid: await run('t_rowid'), wr: await run('t_wr'), view: await run('v_none') };
    sql.exec('DROP VIEW v_none'); sql.exec('DROP TABLE t_rowid'); sql.exec('DROP TABLE t_wr');
    return out;
  });
  expect(r.rowid).toBe(7);
  expect(r.wr).toBe(7);
  expect(String(r.view)).toMatch(/no usable key/);
});

it('the export YIELDS between chunks: another request to the same workspace is answered before a many-chunk export finishes', async () => {
  const ws = 'ws-ck9';
  await seed(ws, 60);
  await knobs(ws, (k) => { k.backupChunkRows = 1; });
  const order: string[] = [];
  const exporting = workspace(ws).exportSnapshot('2026-10-27').then(() => order.push('export'));
  const other = workspace(ws).walletView().then(() => order.push('other'));
  await Promise.all([exporting, other]);
  expect(order).toEqual(['other', 'export']); // the export is hundreds of chunks long; the quick call did not wait for all of them
});
