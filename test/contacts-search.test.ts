import { expect, it } from 'vitest';
import { listContactsResponse } from '../src/core/api/contract';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { workspace } from './helpers/workspace';

useApiKey();
const nowS = () => Math.floor(Date.now() / 1000);

async function contact(ws: string, from: string, name: string | undefined) {
  await workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: `${ws}.${from}`, from, ts: nowS() - 100, type: 'text', text: 'x', ...(name ? { profileName: name } : {}) }], statuses: [], receivedAt: 1 });
}
async function find(api: Awaited<ReturnType<typeof apiFor>>, q: string, extra = '') {
  const r = await api.call('GET', `/contacts?q=${encodeURIComponent(q)}${extra}`);
  expect(r.status).toBe(200);
  return listContactsResponse.parse(await r.json()).items.map((c) => c.waId);
}

it('Review Focus 1 on /contacts: hamza / taa-marbuta / yaa variants match names stored in the other form, from one letter', async () => {
  const ws = W(950);
  const api = await apiFor(ws);
  await contact(ws, '201000000001', 'أحمد');
  await contact(ws, '201000000002', 'فاطمة');
  await contact(ws, '201000000003', 'مصطفى');
  await contact(ws, '201000000004', 'منى');
  expect(await find(api, 'ا')).toEqual(['201000000001']);
  expect(await find(api, 'أ')).toEqual(['201000000001']);
  expect(await find(api, 'احمد')).toEqual(['201000000001']);
  expect(await find(api, 'فاطمه')).toEqual(['201000000002']);
  expect(await find(api, 'مصطفي')).toEqual(['201000000003']);
  expect(await find(api, 'م')).toEqual(['201000000004', '201000000003']); // newest contact first
});

it('names match by word prefix (every typed word), not by a fragment in the middle of a word', async () => {
  const ws = W(951);
  const api = await apiFor(ws);
  await contact(ws, '201000000011', 'محمد علي حسن');
  await contact(ws, '201000000012', 'Sara Ahmed');
  expect(await find(api, 'علي حس')).toEqual(['201000000011']);
  expect(await find(api, 'sar ahm')).toEqual(['201000000012']);
  expect(await find(api, 'SARA')).toEqual(['201000000012']);
  expect(await find(api, 'لي')).toEqual([]); // inside "علي": not a word start
  expect(await find(api, '%')).toEqual([]); // wildcards are just punctuation
});

it('Review Focus 2 on /contacts: a phone typed with Arabic-Indic digits, spaces or a plus matches wa_id; under 3 digits never scans phones', async () => {
  const ws = W(952);
  const api = await apiFor(ws);
  await contact(ws, '201001234567', undefined);
  await contact(ws, '201119876543', 'Omar');
  expect(await find(api, '٢٠١٠٠١٢٣')).toEqual(['201001234567']);
  expect(await find(api, '+20 100 123')).toEqual(['201001234567']);
  expect(await find(api, '234567')).toEqual(['201001234567']); // anywhere in the number
  expect(await find(api, '20')).toEqual([]); // 2 digits: no phone scan
  expect(await find(api, '٢٠')).toEqual([]);
  expect(await find(api, '987')).toEqual(['201119876543']);
});

it('the query combines with the opted-out filter and pagination keeps working', async () => {
  const ws = W(953);
  const api = await apiFor(ws);
  for (let i = 0; i < 4; i++) await contact(ws, `20100000002${i}`, `Nour ${i}`);
  expect((await find(api, 'nour')).length).toBe(4);
  expect(await find(api, 'nour', '&optedOut=true')).toEqual([]);
  const page = listContactsResponse.parse(await (await api.call('GET', `/contacts?q=nour&limit=3`)).json());
  expect(page.items).toHaveLength(3);
  expect(page.nextCursor).not.toBeNull();
  const next = listContactsResponse.parse(await (await api.call('GET', `/contacts?q=nour&limit=3&cursor=${page.nextCursor}`)).json());
  expect(next.items).toHaveLength(1);
});
