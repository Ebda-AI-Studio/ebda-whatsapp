import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { listConversationsResponse } from '../src/core/api/contract';
import { phoneDigits } from '../src/core/text-normalise';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { exec, rows, workspace } from './helpers/workspace';

useApiKey();
const nowS = () => Math.floor(Date.now() / 1000);

async function chat(ws: string, from: string, name: string | undefined, text: string, ts = nowS() - 100) {
  await workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: `${ws}.${from}.${ts}`, from, ts, type: 'text', text, ...(name ? { profileName: name } : {}) }], statuses: [], receivedAt: 1 });
}
async function find(api: Awaited<ReturnType<typeof apiFor>>, q: string, extra = '') {
  const r = await api.call('GET', `/conversations?q=${encodeURIComponent(q)}${extra}`);
  expect(r.status).toBe(200);
  const body = listConversationsResponse.parse(await r.json());
  expect(body.nextCursor).toBeNull();
  return body.items.map((c) => c.contact.waId);
}

it('phoneDigits keeps digits only and folds Arabic-Indic and Persian digits', () => {
  expect(phoneDigits('+20 (101) ٢٣٤-۵۶۷')).toBe('201012345' + '67');
  expect(phoneDigits('abc')).toBe('');
});

it('Review Focus 1: a one-letter query with hamza / taa-marbuta / yaa variants matches names stored in the other form', async () => {
  const ws = W(300);
  const api = await apiFor(ws);
  await chat(ws, '201000000001', 'أحمد', 'x1');
  await chat(ws, '201000000002', 'فاطمة', 'x2');
  await chat(ws, '201000000003', 'مصطفى', 'x3');
  await chat(ws, '201000000004', 'منى', 'x4');
  expect(await find(api, 'ا')).toEqual(['201000000001']); // one letter, bare alef finds hamza alef
  expect(await find(api, 'أ')).toEqual(['201000000001']);
  expect(await find(api, 'احمد')).toEqual(['201000000001']);
  expect(await find(api, 'فاطمه')).toEqual(['201000000002']); // ه finds ة
  expect(await find(api, 'مصطفي')).toEqual(['201000000003']); // ي finds ى
  expect(await find(api, 'م')).toEqual(['201000000004', '201000000003']); // newest first among two matches (ts desc ties by id)
});

it('Review Focus 2: a phone typed with Arabic-Indic or Persian digits, spaces or a plus matches wa_id; under 3 digits never does a phone scan', async () => {
  const ws = W(301);
  const api = await apiFor(ws);
  await chat(ws, '201012345678', 'Sara', 'hello');
  await chat(ws, '201199999999', 'Omar', 'hi');
  expect(await find(api, '٠١٠١٢٣')).toEqual(['201012345678']);
  expect(await find(api, '۰۱۰۱۲۳')).toEqual(['201012345678']);
  expect(await find(api, '+20 101 2345')).toEqual(['201012345678']);
  expect(await find(api, '0101 2345 678')).toEqual(['201012345678']);
  expect(await find(api, '20')).toEqual([]); // two digits: no phone scan, even though both wa_ids contain them
  expect(await find(api, '٢٠')).toEqual([]);
});

it('matches every token as a prefix, and also matches message text', async () => {
  const ws = W(302);
  const api = await apiFor(ws);
  await chat(ws, '201000000011', 'Mona Ali', 'order please');
  await chat(ws, '201000000012', 'Mona Hassan', 'refund');
  expect(await find(api, 'mon al')).toEqual(['201000000011']);
  expect(await find(api, 'mon')).toHaveLength(2);
  expect(await find(api, 'refu')).toEqual(['201000000012']); // by message text
});

it('respects the filter', async () => {
  const ws = W(303);
  const api = await apiFor(ws);
  await chat(ws, '201000000021', 'Nour A', 'a');
  await chat(ws, '201000000022', 'Nour B', 'b');
  const id = (await rows<{ id: number }>(ws, "SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = '201000000021'"))[0]!.id;
  expect((await api.call('POST', `/conversations/${id}/read`)).status).toBe(200);
  expect(await find(api, 'nour', '&filter=unread')).toEqual(['201000000022']);
  expect(await find(api, 'nour', '&filter=unassigned')).toHaveLength(2);
  expect(await find(api, 'nour', '&filter=mine')).toEqual([]);
  expect(await find(api, 'nour')).toHaveLength(2);
});

it('never returns another store\'s contacts', async () => {
  const a = W(304);
  const b = W(305);
  const apiA = await apiFor(a);
  const apiB = await apiFor(b);
  await chat(b, '201000000031', 'Zeinab', 'secret');
  expect(await find(apiA, 'zeinab')).toEqual([]);
  expect(await find(apiA, '201000000031')).toEqual([]);
  expect(await find(apiA, 'secret')).toEqual([]);
  expect(await find(apiB, 'zeinab')).toEqual(['201000000031']);
});

it('a name change drops the old name from the index', async () => {
  const ws = W(306);
  const api = await apiFor(ws);
  await chat(ws, '201000000041', 'Old Name', 'a');
  await chat(ws, '201000000041', 'Fresh Name', 'b', nowS() - 50);
  expect(await find(api, 'old')).toEqual([]);
  expect(await find(api, 'fresh')).toEqual(['201000000041']);
});

it('Review Focus 5: erasing a contact removes it from the name index in the same transaction (no ghost hits)', async () => {
  const ws = W(307);
  const api = await apiFor(ws);
  await chat(ws, '201000000051', 'Ghost Person', 'boo');
  await chat(ws, '201000000052', 'Ghost Keeper', 'boo2');
  expect(await find(api, 'ghost')).toHaveLength(2);
  await workspace(ws).eraseContact('201000000051');
  expect(await find(api, 'ghost')).toEqual(['201000000052']);
  expect(await rows(ws, 'SELECT rowid FROM contacts_fts WHERE rowid NOT IN (SELECT id FROM contacts)')).toEqual([]);
  expect((await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM contacts_fts'))[0]!.n).toBe(1);
});

it('rebuilds the name index for contacts that predate it', async () => {
  const ws = W(308);
  const api = await apiFor(ws);
  await chat(ws, '201000000061', 'Layla', 'a');
  await exec(ws, 'DELETE FROM contacts_fts');
  expect(await find(api, 'layla')).toEqual([]);
  await runInDurableObject(workspace(ws), (inst) => (inst as unknown as { rebuildFts(): void }).rebuildFts());
  expect(await find(api, 'layla')).toEqual(['201000000061']);
});

it('q over 100 characters or blank is a 400', async () => {
  const api = await apiFor(W(309));
  expect((await api.call('GET', `/conversations?q=${'a'.repeat(101)}`)).status).toBe(400);
  expect((await api.call('GET', `/conversations?q=${'a'.repeat(100)}`)).status).toBe(200);
  expect((await api.call('GET', '/conversations?q=%20%20')).status).toBe(400);
});
