import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { completeErasure, recordErasure, subjectHash } from '../src/core/erasure';
import { ERASURE_EXEMPT, ERASURE_TARGETS } from '../src/core/erasure-targets';
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
    await exec(ws, "INSERT INTO store_state (key, value) VALUES (?, '1')", `away:${wa}`);
    await exec(ws, "INSERT INTO bot_sessions (wa_id, state, locale, data, updated_at) VALUES (?, 's', 'ar', '{}', 1)", wa);
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
    const recs = await d1<{ workspace_id: string; subject_hash: string; erased_at: number; completed_at: number | null; erased_by: string }>('SELECT * FROM erasure_records WHERE workspace_id = ?', ws);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.completed_at).toBeGreaterThanOrEqual(recs[0]!.erased_at); // stamped before, completed AFTER the Durable Object finished
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
    expect(await rows(t, "SELECT key FROM store_state WHERE key LIKE 'away:%'")).toEqual([{ key: `away:${B}` }]); // eraseContact removes away:<wa_id>; so does the restore
  });

  it('a backup taken BETWEEN the stamp and the end of the erase still cannot bring the person back (the erase is stamped when it COMPLETES)', async () => {
    const ws = W(3006);
    await seed(ws);
    expect(await recordErasure(env, { workspaceId: ws, waId: A, actor: 'u1' })).not.toBeNull(); // 1. the stamp
    await sleep(5);
    await workspace(ws).exportSnapshot('2026-10-27'); // 2. the nightly backup runs now and still holds A
    await sleep(5);
    const done = await workspace(ws).eraseContact(A); // 3. the Durable Object finishes
    await completeErasure(env, { workspaceId: ws, waId: A, completedAt: done.completedAt });
    const t = `${ws}-restored`;
    const res = await workspace(t).importSnapshot(`backups/${ws}/2026-10-27/`);
    expect(res.ok && res.erasedSkipped).toBe(1);
    expect(await rows(t, 'SELECT wa_id FROM contacts')).toEqual([{ wa_id: B }]);
  });

  it('an erase whose Durable Object step never finished (no completion) is dropped from every restore', async () => {
    const ws = W(3007);
    await seed(ws);
    await recordErasure(env, { workspaceId: ws, waId: A, actor: 'u1' }); // stamped, never completed
    await workspace(ws).exportSnapshot('2026-10-27');
    const res = await workspace(`${ws}-restored`).importSnapshot(`backups/${ws}/2026-10-27/`);
    expect(res.ok && res.erasedSkipped).toBe(1);
  });

  it('every table that holds a customer is in the ONE erasure list (eraseContact and the restore both walk it)', async () => {
    const probe = await runInDurableObject(workspace(W(3008)), (_i, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'contacts_fts%'").toArray() as { name: string }[];
      const out: string[] = [];
      for (const { name } of tables) {
        const cols = (state.storage.sql.exec(`SELECT name FROM pragma_table_info('${name}')`).toArray() as { name: string }[]).map((c) => c.name);
        if (cols.some((c) => ['wa_id', 'contact_id', 'conversation_id', 'wamid', 'message_id'].includes(c))) out.push(name);
      }
      return out;
    });
    const decided = new Set([...ERASURE_TARGETS.map((t) => t.table), ...Object.keys(ERASURE_EXEMPT)]);
    expect(probe.filter((t) => !decided.has(t)).sort()).toEqual([]);
    expect(ERASURE_TARGETS.some((t) => t.table === 'store_state')).toBe(true); // keys like away:<wa_id> are customer data too
  });

  it('a person who wrote again AFTER the erasure completed (a genuine new relationship) and is in a LATER backup is restored', async () => {
    const ws = W(3004);
    await seed(ws);
    expect((await (await apiFor(ws)).call('DELETE', `/contacts/${A}`)).status).toBe(200);
    await sleep(5);
    await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [{ wamid: `wamid.again.${ws}`, from: A, ts: Math.floor(Date.now() / 1000) + 3, type: 'text', text: 'مرحبا مرة تانية' }], statuses: [], receivedAt: 1 });
    await workspace(ws).exportSnapshot('2026-10-28');
    const res = await workspace(`${ws}-restored`).importSnapshot(`backups/${ws}/2026-10-28/`);
    expect(res.ok).toBe(true);
    expect(res.ok && res.erasedSkipped).toBeUndefined();
    expect(await rows(`${ws}-restored`, 'SELECT wa_id FROM contacts ORDER BY wa_id')).toEqual([{ wa_id: A }, { wa_id: B }]);
  });

});
