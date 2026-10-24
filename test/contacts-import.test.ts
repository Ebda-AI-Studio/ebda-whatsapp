import { env, introspectWorkflow, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { importDto, listContactsResponse } from '../src/core/api/contract';
import { IMPORT_TUNING, runImportChunk } from '../src/core/campaigns/import-run';
import { MAX_IMPORT_BYTES } from '../src/core/campaigns/contacts';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { exec, openChat, rows, workspace } from './helpers/workspace';

useApiKey();

const form = (csv: string | Uint8Array, fields: Record<string, string> = {}, name = 'contacts.csv', type = 'text/csv') => {
  const f = new FormData();
  f.set('file', new File([csv as never], name, { type }));
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
type Api = Awaited<ReturnType<typeof apiFor>>;

/** Posts a CSV and waits for the import workflow to finish. */
async function importCsv(api: Api, csv: string, fields: Record<string, string> = {}, name = 'contacts.csv') {
  const wf = await introspectWorkflow(env.IMPORT_WORKFLOW);
  try {
    await wf.modifyAll(async (m) => { await m.disableRetryDelays(); });
    const res = await api.call('POST', '/imports', form(csv, fields, name));
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    for (const inst of await wf.get()) await inst.waitForStatus('complete');
    const summary = importDto.parse(await (await api.call('GET', `/imports/${id}`)).json());
    return { id, summary };
  } finally {
    await wf.dispose();
  }
}

const CSV = [
  'Phone,Full Name,Tags',
  '0100 123 4567,Ali Hassan,"VIP; eid"',
  '+965 5000 1234,null,kuwait',
  '01001234567,Dup Ali,vip',
  '12345,Bad,',
  ',NoPhone,',
  '٠١١١١١١١١١١,سارة,',
  '"0122 222 2222","Multi',
  'Line",',
].join('\r\n');

it('imports a CSV: creates and tags contacts, rejects bad rows by line without keeping their phone, and deletes the uploaded file', async () => {
  const api = await apiFor(W(600));
  const { id, summary } = await importCsv(api, CSV, { consented: 'true' });
  expect(summary).toMatchObject({ status: 'done', consented: true, total: 7, created: 4, updated: 0, rejected: 3, error: null, filename: 'contacts.csv' });
  const rejects = (await (await api.call('GET', `/imports/${id}/rejects`)).json()) as { items: { line: number; reason: string }[] };
  expect(rejects.items).toEqual([{ line: 4, reason: 'duplicate_in_file' }, { line: 5, reason: 'invalid_phone' }, { line: 6, reason: 'empty_phone' }]);
  expect(JSON.stringify(rejects)).not.toMatch(/\d{5}/);
  const contacts = await rows<{ wa_id: string; profile_name: string | null; consent_source: string | null; consent_at: number | null }>(W(600), 'SELECT wa_id, profile_name, consent_source, consent_at FROM contacts ORDER BY wa_id');
  expect(contacts.map((c) => [c.wa_id, c.profile_name, c.consent_source])).toEqual([
    ['201001234567', 'Ali Hassan', 'import:contacts.csv'],
    ['201111111111', 'سارة', 'import:contacts.csv'],
    ['201222222222', 'Multi Line', 'import:contacts.csv'],
    ['96550001234', null, 'import:contacts.csv'],
  ]);
  expect(contacts.every((c) => c.consent_at !== null)).toBe(true);
  expect((await rows<{ tag: string }>(W(600), 'SELECT t.tag FROM contact_tags t JOIN contacts c ON c.id = t.contact_id WHERE c.wa_id = ? ORDER BY t.tag', '201001234567')).map((r) => r.tag)).toEqual(['eid', 'vip']);
  expect(await env.MEDIA.get(`imports/${W(600)}/${id}.csv`)).toBeNull(); // the file held phone numbers: gone once read
  expect(await rows(W(600), 'SELECT key FROM r2_pending_deletes')).toEqual([]);
});

it('without the "these contacts agreed" box, contacts are saved with NO consent, so marketing to them stays blocked', async () => {
  const api = await apiFor(W(601));
  const { summary } = await importCsv(api, 'phone,name\n01001234567,Ali\n');
  expect(summary).toMatchObject({ status: 'done', consented: false, created: 1 });
  expect(await rows(W(601), 'SELECT consent_source, consent_at FROM contacts')).toEqual([{ consent_source: null, consent_at: null }]);
  const list = listContactsResponse.parse(await (await api.call('GET', '/contacts')).json());
  expect(list.items[0]).toMatchObject({ waId: '201001234567', consent: null, optedOut: false });
});

it('an import never undoes a STOP and never overwrites consent already on record', async () => {
  const api = await apiFor(W(602));
  await openChat(W(602), '201001111111');
  await openChat(W(602), '201002222222');
  await openChat(W(602), '201003333333');
  await exec(W(602), "UPDATE contacts SET opted_out_at = 5000, consent_source = 'keyword_stop', consent_at = 5000 WHERE wa_id = '201001111111'");
  await exec(W(602), "UPDATE contacts SET consent_source = 'keyword_start', consent_at = 7000 WHERE wa_id = '201002222222'");
  const { summary } = await importCsv(api, 'phone,name,tags\n201001111111,Stopped,a\n201002222222,Started,b\n201003333333,Fresh,c\n', { consented: 'true' }, 'list.csv');
  expect(summary).toMatchObject({ status: 'done', created: 0, updated: 3 });
  expect(await rows(W(602), 'SELECT wa_id, opted_out_at, consent_source, consent_at, profile_name FROM contacts ORDER BY wa_id')).toEqual([
    { wa_id: '201001111111', opted_out_at: 5000, consent_source: 'keyword_stop', consent_at: 5000, profile_name: 'Stopped' },
    { wa_id: '201002222222', opted_out_at: null, consent_source: 'keyword_start', consent_at: 7000, profile_name: 'Started' },
    { wa_id: '201003333333', opted_out_at: null, consent_source: 'import:list.csv', consent_at: expect.any(Number), profile_name: 'Fresh' },
  ]);
});

it('a name in the file only fills a gap; the WhatsApp profile name already stored stays', async () => {
  const api = await apiFor(W(603));
  await workspace(W(603)).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: 'w.603', from: '201001234567', ts: 100, type: 'text', text: 'hi', profileName: 'From WhatsApp' }], statuses: [], receivedAt: 1 });
  await importCsv(api, 'phone,name\n01001234567,From File\n');
  expect((await rows<{ profile_name: string }>(W(603), 'SELECT profile_name FROM contacts'))[0]!.profile_name).toBe('From WhatsApp');
});

it('semicolon files, an explicit column mapping and a BOM all work', async () => {
  const api = await apiFor(W(604));
  const { summary } = await importCsv(api, '﻿رقم الموبايل;الاسم;col3\n01001234567;علي;x\n', {});
  expect(summary).toMatchObject({ status: 'done', created: 1 });
  const mapped = await importCsv(api, 'a,b,c\nnope,01009999999,Mapped\n', { mapping: JSON.stringify({ phone: 'B', name: 'c' }) });
  expect(mapped.summary).toMatchObject({ status: 'done', created: 1 });
  expect(await rows(W(604), "SELECT profile_name FROM contacts WHERE wa_id = '201009999999'")).toEqual([{ profile_name: 'Mapped' }]);
});

it('no phone column fails the import with a reason and still deletes the file', async () => {
  const api = await apiFor(W(605));
  const { id, summary } = await importCsv(api, 'email,city\nx@y.z,Cairo\n');
  expect(summary).toMatchObject({ status: 'failed', error: 'no_phone_column', created: 0 });
  expect(await env.MEDIA.get(`imports/${W(605)}/${id}.csv`)).toBeNull();
  const bad = await importCsv(api, 'a,b\n1,2\n', { mapping: JSON.stringify({ phone: 'zzz' }) });
  expect(bad.summary).toMatchObject({ status: 'failed', error: 'mapped_column_not_found' });
});

it('refuses staff, other file types, oversize files, a bad mapping, and a second import while one is running', async () => {
  const api = await apiFor(W(606));
  const staff = await apiFor(W(606), 'staff');
  expect((await staff.call('POST', '/imports', form('phone\n1\n'))).status).toBe(403);
  expect((await api.call('POST', '/imports', form('x', {}, 'photo.png', 'image/png'))).status).toBe(415);
  expect((await api.call('POST', '/imports', form('x', {}, 'sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))).status).toBe(415);
  expect((await api.call('POST', '/imports', form(new Uint8Array(MAX_IMPORT_BYTES + 1), {}, 'big.csv'))).status).toBe(413);
  expect((await api.call('POST', '/imports', form('phone\n1\n', { mapping: 'not json' }))).status).toBe(400);
  expect((await api.call('POST', '/imports', form('phone\n1\n', { consented: 'yes' }))).status).toBe(400);
  expect((await api.call('POST', '/imports', form('phone\n1\n', {}, 'excel.csv', 'application/vnd.ms-excel'))).status).toBe(202); // Excel's own label for CSV
});

it('a second import while one is running is refused and writes no file', async () => {
  const api = await apiFor(W(613));
  await workspace(W(613)).createImport({ id: 'busy', filename: 'busy.csv', r2Key: 'imports/busy.csv', size: 5, consented: false, mapping: null, actor: 'u' });
  const again = await api.call('POST', '/imports', form('phone\n1\n'));
  expect(again.status).toBe(409);
  expect((await env.MEDIA.list({ prefix: `imports/${W(613)}/` })).objects).toEqual([]);
});

it('big files run in many chunks: a quoted line break across a chunk edge is one row, and a replayed chunk changes nothing', async () => {
  const api = await apiFor(W(607));
  const lines = ['phone,name'];
  for (let i = 0; i < 60; i++) lines.push(`2010${String(10000000 + i)},"Name ${i}${i % 7 === 0 ? '\nsecond line' : ''}"`);
  const csv = lines.join('\n') + '\n';
  const ws = workspace(W(607));
  const key = `imports/${W(607)}/chunky.csv`;
  await env.MEDIA.put(key, csv);
  const size = new TextEncoder().encode(csv).byteLength;
  expect((await ws.createImport({ id: 'chunky', filename: 'chunky.csv', r2Key: key, size, consented: true, mapping: null, actor: 'u' })).ok).toBe(true);
  const saved = { ...IMPORT_TUNING };
  Object.assign(IMPORT_TUNING, { chunkBytes: 150, maxRecords: 5 });
  try {
    let steps = 0;
    for (;;) {
      steps++;
      const r = await runImportChunk(env, W(607), 'chunky');
      if (r.done) break;
      expect(steps).toBeLessThan(100);
    }
    expect(steps).toBeGreaterThan(10);
  } finally {
    Object.assign(IMPORT_TUNING, saved);
  }
  const s = await ws.getImport('chunky');
  expect(s).toMatchObject({ status: 'done', total: 60, created: 60, rejected: 0 });
  const names = await rows<{ profile_name: string }>(W(607), "SELECT profile_name FROM contacts WHERE profile_name LIKE '%second line%' ORDER BY id");
  expect(names).toHaveLength(9);
  // replay: the same chunk again (a step that ran twice) is a no-op
  const st = await ws.importState('chunky');
  const replay = await ws.applyImportChunk({ importId: 'chunky', fromOffset: 0, toOffset: 10, nextLine: 2, delimiter: 0x2c, cols: { phone: 0, name: 1, tags: -1 }, rows: [{ line: 2, waId: '201099999999', name: 'Replay', tags: [] }] });
  expect(replay).toEqual({ ok: true, done: true });
  expect(st?.status).toBe('done');
  expect(await rows(W(607), "SELECT 1 FROM contacts WHERE wa_id = '201099999999'")).toEqual([]);
  expect(api).toBeTruthy();
});

it('a step that applied its chunk but died before answering re-runs safely', async () => {
  const ws = workspace(W(608));
  const key = `imports/${W(608)}/twice.csv`;
  const csv = 'phone,name\n01001234567,Ali\n01001234568,Sara\n';
  await env.MEDIA.put(key, csv);
  await ws.createImport({ id: 'twice', filename: 'twice.csv', r2Key: key, size: csv.length, consented: false, mapping: null, actor: 'u' });
  const first = await runImportChunk(env, W(608), 'twice');
  const second = await runImportChunk(env, W(608), 'twice');
  expect(first).toEqual({ done: true, status: 'done' });
  expect(second).toEqual({ done: true, status: 'done' });
  expect(await ws.getImport('twice')).toMatchObject({ created: 2, total: 2 });
});

it('the row limit stops an import at the cap and fails it with row_limit (rows already applied stay)', async () => {
  const ws = workspace(W(609));
  await runInDurableObject(ws, (inst) => { (inst as unknown as { importMaxRows: number }).importMaxRows = 3; });
  const key = `imports/${W(609)}/limit.csv`;
  const csv = 'phone\n01001234561\n01001234562\n01001234563\n01001234564\n01001234565\n';
  await env.MEDIA.put(key, csv);
  await ws.createImport({ id: 'limit', filename: 'limit.csv', r2Key: key, size: csv.length, consented: false, mapping: null, actor: 'u' });
  expect(await runImportChunk(env, W(609), 'limit')).toEqual({ done: true, status: 'failed' });
  expect(await ws.getImport('limit')).toMatchObject({ status: 'failed', error: 'row_limit', created: 3 });
  expect(await env.MEDIA.get(key)).toBeNull();
});

it('GET /contacts filters by tag (contact or conversation tag), opted-out state and search, and pages by cursor', async () => {
  const api = await apiFor(W(610));
  await importCsv(api, ['phone,name,tags', ...Array.from({ length: 5 }, (_, i) => `0100123450${i},Cust ${i},${i % 2 ? 'odd' : 'even'}`)].join('\n'), { consented: 'true' });
  const cid = await openChat(W(610), '201999999999');
  await exec(W(610), `INSERT INTO conversation_tags (conversation_id, tag) VALUES (${cid}, 'odd')`);
  await exec(W(610), "UPDATE contacts SET opted_out_at = 1 WHERE wa_id = '201001234501'");
  const get = async (qs: string) => listContactsResponse.parse(await (await api.call('GET', `/contacts${qs}`)).json());
  expect((await get('?tag=odd')).items.map((i) => i.waId).sort()).toEqual(['201001234501', '201001234503', '201999999999']);
  expect((await get('?optedOut=true')).items.map((i) => i.waId)).toEqual(['201001234501']);
  expect((await get('?optedOut=false&tag=odd')).items.map((i) => i.waId).sort()).toEqual(['201001234503', '201999999999']);
  expect((await get('?q=Cust 3')).items.map((i) => i.waId)).toEqual(['201001234503']);
  expect((await get('?q=2010012345')).items).toHaveLength(5);
  const p1 = await get('?limit=4');
  expect(p1.items).toHaveLength(4);
  expect(p1.nextCursor).not.toBeNull();
  const p2 = await get(`?limit=4&cursor=${p1.nextCursor}`);
  expect(p2.items).toHaveLength(2);
  expect(p2.nextCursor).toBeNull();
  expect(new Set([...p1.items, ...p2.items].map((i) => i.waId)).size).toBe(6);
  const first = p1.items.find((i) => i.waId === '201001234503')!;
  expect(first.tags).toEqual(['odd']);
  expect(first.consent?.source).toBe('import:contacts.csv');
  expect((await api.call('GET', '/contacts?limit=1000')).status).toBe(400);
  expect((await api.call('GET', '/contacts?cursor=abc')).status).toBe(400);
});

it('PUT /contacts/:waId/tags replaces the contact tags (lower-cased, deduped, at most 10); unknown contact 404', async () => {
  const api = await apiFor(W(611));
  await openChat(W(611), '96550001234');
  const ok = await api.call('PUT', '/contacts/96550001234/tags', { tags: ['VIP', 'vip', 'Eid'] });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ tags: ['eid', 'vip'] });
  expect((await api.call('PUT', '/contacts/96550001234/tags', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).status).toBe(400);
  expect((await api.call('PUT', '/contacts/96550009999/tags', { tags: ['x'] })).status).toBe(404);
  expect((await api.call('PUT', '/contacts/abc/tags', { tags: ['x'] })).status).toBe(400);
});

it('erasing a contact deletes its tags too', async () => {
  const api = await apiFor(W(612));
  await openChat(W(612), '201001234567');
  await api.call('PUT', '/contacts/201001234567/tags', { tags: ['vip'] });
  expect(await rows(W(612), 'SELECT 1 FROM contact_tags')).toHaveLength(1);
  expect((await api.call('DELETE', '/contacts/201001234567')).status).toBe(200);
  expect(await rows(W(612), 'SELECT 1 FROM contact_tags')).toEqual([]);
});

it('contact tags and import history survive a backup and restore', async () => {
  const api = await apiFor(W(614));
  await importCsv(api, 'phone,name,tags\n01001234567,Ali,vip\n12,bad,\n', { consented: 'true' });
  const m = await workspace(W(614)).exportSnapshot('2026-10-25');
  expect(m.tables.contact_tags?.rows).toBe(1);
  expect(m.tables.imports?.rows).toBe(1);
  expect(m.tables.import_rejects?.rows).toBe(1);
  expect(await workspace(W(615)).importSnapshot(`backups/${W(614)}/2026-10-25/`)).toMatchObject({ ok: true });
  expect(await rows(W(615), 'SELECT tag FROM contact_tags')).toEqual([{ tag: 'vip' }]);
  expect(await rows(W(615), 'SELECT status, created_count FROM imports')).toEqual([{ status: 'done', created_count: 1 }]);
});
