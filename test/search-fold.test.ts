import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { listConversationsResponse } from '../src/core/api/contract';
import { syncSearchFold } from '../src/core/search-fold';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { rows, workspace } from './helpers/workspace';

useApiKey();
const nowS = () => Math.floor(Date.now() / 1000);

async function chat(ws: string, from: string, name: string, text: string) {
  const ts = nowS() - 100;
  await workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: `${ws}.${from}.${ts}`, from, ts, type: 'text', text, profileName: name }], statuses: [], receivedAt: 1 });
}
async function find(api: Awaited<ReturnType<typeof apiFor>>, q: string) {
  const r = await api.call('GET', `/conversations?q=${encodeURIComponent(q)}`);
  expect(r.status).toBe(200);
  return listConversationsResponse.parse(await r.json()).items.map((c) => c.contact.waId);
}
/** What the DO constructor does when env.SEARCH_FOLD changes: marker + full rebuild in one transaction. */
const flip = (ws: string, on: boolean) =>
  runInDurableObject(workspace(ws), (i, state) => state.storage.transactionSync(() => syncSearchFold(state.storage.sql, on, () => (i as unknown as { rebuildFts(): void }).rebuildFts())));

it('FDN-SEARCH-1: flag off = legacy fold; flipping on re-indexes names AND messages; flipping off restores legacy', async () => {
  const ws = W(310);
  const api = await apiFor(ws);
  await chat(ws, '201000000011', 'سؤال', 'مرحبا');
  await chat(ws, '201000000012', 'کوتشی', 'عايز كوتشي ابيض');
  await chat(ws, '201000000013', 'ﻻ', 'hello');
  // legacy: ؤ and Persian ک/ی are NOT folded; NFKC IS applied (the lam-alef presentation form U+FEFB becomes لا)
  expect(await find(api, 'سوال')).toEqual([]);
  expect(await find(api, 'كوتشي')).toEqual(['201000000012']); // via the MESSAGE text "كوتشي"
  expect(await find(api, 'لا')).toEqual(['201000000013']);

  expect(await flip(ws, true)).toBe(true);
  expect(await flip(ws, true)).toBe(false); // already there: no second rebuild
  expect(await rows(ws, "SELECT value FROM store_state WHERE key = 'search_fold'")).toEqual([{ value: 'v2' }]);
  expect(await find(api, 'سوال')).toEqual(['201000000011']); // ؤ -> و
  expect(await find(api, 'كوتشي')).toContain('201000000012'); // Persian name and the message both match now
  expect(await find(api, 'كوت')).toContain('201000000012'); // name prefix
  // DOCUMENTED REGRESSION (PR body): the shared fold has no NFKC (the SQL twin cannot), so a name pasted with a presentation form no longer meets the typed letters
  expect(await find(api, 'لا')).toEqual([]);

  expect(await flip(ws, false)).toBe(true);
  expect(await rows(ws, "SELECT value FROM store_state WHERE key = 'search_fold'")).toEqual([]);
  expect(await find(api, 'سوال')).toEqual([]);
  expect(await find(api, 'لا')).toEqual(['201000000013']);
});

it('a name written while the flag is on is indexed with the shared fold (index and query always agree)', async () => {
  const ws = W(311);
  const api = await apiFor(ws);
  await flip(ws, true);
  await chat(ws, '201000000021', 'سؤال جديد', 'x');
  expect(await find(api, 'سوال')).toEqual(['201000000021']);
});
