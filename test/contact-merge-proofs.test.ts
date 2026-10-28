/** Final-review fix I7: a merge re-points the consent proofs, the data-subject export carries them, and a schema walk fails when a table keyed by a person is not decided for the merge. */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MERGE_TABLES } from '../src/core/contact-data';
import { apiFor, storeId as W0, useApiKey } from './helpers/api';
import { exec, own, rows, workspace } from './helpers/workspace';

useApiKey();
const W = (n: number) => W0(9700 + n);
const A = '201001234567';
const B = '201007654321';
const nowS = () => Math.floor(Date.now() / 1000);
async function chat(ws: string, wa: string) {
  await workspace(ws).ingest({ phoneNumberId: 'pn-x', inbound: [{ wamid: `wamid.mp.${ws}.${wa}`, from: wa, ts: nowS() - 50, type: 'text' as const, text: 'hi' }], statuses: [], receivedAt: Date.now() });
}
const cid = (ws: string, wa: string) => rows<{ id: number }>(ws, 'SELECT id FROM contacts WHERE wa_id = ?', wa).then((r) => r[0]!.id);

describe('merge and consent proofs', () => {
  it('the source\'s proofs move to the surviving contact; none is left under the deleted id, so a new contact can never inherit them', async () => {
    const ws = W(1);
    await own(ws);
    await chat(ws, A);
    await chat(ws, B);
    const [from, into] = [await cid(ws, A), await cid(ws, B)];
    await exec(ws, "INSERT INTO consent_proofs (contact_id, source, attested_by, wording, at, ref) VALUES (?, 'import', 'u1', 'I agree', 5, NULL)", from);
    await exec(ws, "INSERT INTO consent_proofs (contact_id, source, attested_by, wording, at, ref) VALUES (?, 'opt_in', 'customer', 'start', 6, NULL)", into);
    expect((await (await apiFor(ws)).call('POST', '/contacts/merge', { fromWaId: A, intoWaId: B })).status).toBe(200);
    expect(await rows(ws, 'SELECT contact_id, source FROM consent_proofs ORDER BY id')).toEqual([{ contact_id: into, source: 'import' }, { contact_id: into, source: 'opt_in' }]);
    // contacts.id has no AUTOINCREMENT: the deleted row's id is reused by the next contact
    await chat(ws, '201005555555');
    expect(await rows(ws, 'SELECT count(*) AS n FROM consent_proofs WHERE contact_id = (SELECT id FROM contacts WHERE wa_id = ?)', '201005555555')).toEqual([{ n: 0 }]);
  });

  it('the data-subject export carries the proofs (source, who attested, the wording, when)', async () => {
    const ws = W(2);
    await own(ws);
    await chat(ws, A);
    await exec(ws, "INSERT INTO consent_proofs (contact_id, source, attested_by, wording, at, ref) VALUES (?, 'link', 'store', 'أوافق على الرسائل', 9, 'locale:ar')", await cid(ws, A));
    const j = (await (await (await apiFor(ws)).call('GET', `/contacts/${A}/export`)).json()) as { consentProofs: unknown[] };
    expect(j.consentProofs).toEqual([{ source: 'link', attestedBy: 'store', wording: 'أوافق على الرسائل', at: 9, ref: 'locale:ar' }]);
  });

  it('WALK: every table with a contact_id or wa_id column is decided for the merge (re-pointed, dropped or exempt with a reason)', async () => {
    const tables = await runInDurableObject(workspace(W(3)), (_i, state) => {
      const all = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'contacts_fts%'").toArray() as { name: string }[];
      return all.filter(({ name }) => (state.storage.sql.exec(`SELECT name FROM pragma_table_info('${name}')`).toArray() as { name: string }[]).some((c) => c.name === 'contact_id' || c.name === 'wa_id')).map((t) => t.name);
    });
    expect(tables.length).toBeGreaterThan(8);
    expect(tables.filter((t) => !(t in MERGE_TABLES)).sort()).toEqual([]);
    expect(Object.keys(MERGE_TABLES).filter((t) => !tables.includes(t) && t !== 'conversations').sort()).toEqual([]); // no stale entries
    for (const v of Object.values(MERGE_TABLES)) expect(v.length).toBeGreaterThan(10);
  });
});
