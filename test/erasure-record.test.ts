import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { subjectHash } from '../src/core/erasure';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { exec, own, rows, workspace } from './helpers/workspace';

useApiKey();
const d1 = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);
const A = '201001234567';
const B = '201007654321';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two customers with a chat each, a status event, a note, a tag and an order: everything an erasure has to reach. */
async function seed(ws: string) {
  await own(ws);
  await workspace(ws).ingest({
    phoneNumberId: 'pn-x',
    inbound: [A, B].map((from, i) => ({ wamid: `wamid.er.${ws}.${i}`, from, ts: 1000 + i, type: 'text' as const, text: `رسالة ${i}` })),
    statuses: [{ wamid: `wamid.er.${ws}.0`, status: 'read', ts: 2000 }, { wamid: `wamid.er.${ws}.1`, status: 'read', ts: 2000 }],
    receivedAt: 1,
  });
  for (const wa of [A, B]) {
    const [c] = await rows<{ id: number; cid: number }>(ws, 'SELECT c.id AS id, ct.id AS cid FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?', wa);
    await exec(ws, "INSERT INTO notes (conversation_id, author_user_id, text, created_at) VALUES (?, 'u', 'ملاحظة', 1)", c!.id);
    await exec(ws, "INSERT INTO conversation_tags (conversation_id, tag) VALUES (?, 'vip')", c!.id);
    await exec(ws, "INSERT INTO contact_tags (contact_id, tag) VALUES (?, 'vip')", c!.cid);
    await exec(ws, "INSERT INTO store_orders (order_id, wa_id, updated_at) VALUES (?, ?, 1)", `o-${ws}-${wa}`, wa);
  }
}
const counts = (ws: string, wa: string) => rows<{ n: number }>(ws,
  `SELECT (SELECT count(*) FROM contacts WHERE wa_id = ?1) + (SELECT count(*) FROM store_orders WHERE wa_id = ?1) AS n`, wa).then((r) => r[0]!.n);

describe('the erasure record', () => {
  it('is written in D1 before the erase, holds a keyed hash and no phone number, and is idempotent', async () => {
    const ws = W(3001);
    await seed(ws);
    const api = await apiFor(ws);
    expect((await api.call('DELETE', `/contacts/${A}`)).status).toBe(200);
    const recs = await d1<{ workspace_id: string; subject_hash: string; erased_at: number; erased_by: string }>('SELECT * FROM erasure_records WHERE workspace_id = ?', ws);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.subject_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(recs[0]!.subject_hash).toBe(await subjectHash(env, ws, A));
    expect(await subjectHash(env, W(3002), A)).not.toBe(recs[0]!.subject_hash); // bound to the workspace
    expect(JSON.stringify(recs)).not.toContain(A);
    await api.call('DELETE', `/contacts/${A}`); // a second request for the same person
    expect(await d1('SELECT 1 FROM erasure_records WHERE workspace_id = ?', ws)).toHaveLength(1);
  });

  it('a restore never brings an erased contact back (contact, chat, messages, status events, notes, tags, orders), and leaves everyone else', async () => {
    const ws = W(3003);
    await seed(ws);
    await workspace(ws).exportSnapshot('2026-10-27'); // the backup still holds A
    await sleep(5);
    expect((await (await apiFor(ws)).call('DELETE', `/contacts/${A}`)).status).toBe(200);
    expect(await counts(ws, A)).toBe(0);

    const res = await workspace(`${ws}-restored`).importSnapshot(`backups/${ws}/2026-10-27/`);
    expect(res.ok).toBe(true);
    expect(res.ok && res.erasedSkipped).toBe(1);
    const t = `${ws}-restored`;
    expect(await rows(t, 'SELECT wa_id FROM contacts')).toEqual([{ wa_id: B }]);
    expect(await rows(t, 'SELECT count(*) AS n FROM conversations')).toEqual([{ n: 1 }]);
    expect(await rows(t, 'SELECT wamid FROM messages')).toEqual([{ wamid: `wamid.er.${ws}.1` }]);
    expect(await rows(t, 'SELECT wamid FROM message_status_events')).toEqual([{ wamid: `wamid.er.${ws}.1` }]);
    expect(await rows(t, 'SELECT count(*) AS n FROM notes')).toEqual([{ n: 1 }]);
    expect(await rows(t, 'SELECT count(*) AS n FROM conversation_tags')).toEqual([{ n: 1 }]);
    expect(await rows(t, 'SELECT count(*) AS n FROM contact_tags')).toEqual([{ n: 1 }]);
    expect(await rows(t, 'SELECT wa_id FROM store_orders')).toEqual([{ wa_id: B }]);
  });

  it('a person who wrote again AFTER the erasure and is in a LATER backup is a new relationship and is restored', async () => {
    const ws = W(3004);
    await seed(ws);
    expect((await (await apiFor(ws)).call('DELETE', `/contacts/${A}`)).status).toBe(200);
    await sleep(5);
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [{ wamid: `wamid.again.${ws}`, from: A, ts: 5000, type: 'text', text: 'مرحبا مرة تانية' }], statuses: [], receivedAt: 1 });
    await workspace(ws).exportSnapshot('2026-10-28');
    const res = await workspace(`${ws}-restored`).importSnapshot(`backups/${ws}/2026-10-28/`);
    expect(res.ok).toBe(true);
    expect(res.ok && res.erasedSkipped).toBeUndefined();
    expect(await rows(`${ws}-restored`, 'SELECT wa_id FROM contacts ORDER BY wa_id')).toEqual([{ wa_id: A }, { wa_id: B }]);
  });

  it('a backup is stamped with the time it was taken (the restore compares it with the erasure time)', async () => {
    const ws = W(3005);
    await seed(ws);
    const before = Date.now();
    const m = await workspace(ws).exportSnapshot('2026-10-27');
    expect(m.takenAt).toBeGreaterThanOrEqual(before);
  });
});
