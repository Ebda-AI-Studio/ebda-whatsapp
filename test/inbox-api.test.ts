import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { conversationDto, getMessagesResponse, listConversationsResponse, noteDto, searchResponse, type ConversationDto } from '../src/core/api/contract';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { seedConversations } from './helpers/seed';
import { openChat, rows, workspace } from './helpers/workspace';

useApiKey();
const USER = '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f'; // the default token subject
const nowS = () => Math.floor(Date.now() / 1000);

async function inbound(ws: string, from: string, ts: number, text: string, wamid = `w.${from}.${ts}.${text.length}`) {
  await workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid, from, ts, type: 'text', text, profileName: `P ${from.slice(-3)}` }], statuses: [], receivedAt: 1 });
}
const list = async (api: Awaited<ReturnType<typeof apiFor>>, qs = '') => {
  const r = await api.call('GET', `/conversations${qs}`);
  expect(r.status).toBe(200);
  return listConversationsResponse.parse(await r.json());
};

it('lists conversations newest first as ConversationDtos, with the 24 h window and last message', async () => {
  const api = await apiFor(W(200));
  await inbound(W(200), '201000000001', nowS() - 100, 'قديم');
  await inbound(W(200), '201000000002', nowS() - 10, 'جديد');
  await inbound(W(200), '201000000003', nowS() - 3 * 86400, 'من تلات ايام');
  const { items, nextCursor } = await list(api);
  expect(items.map((c) => c.contact.waId)).toEqual(['201000000002', '201000000001', '201000000003']);
  expect(nextCursor).toBeNull();
  expect(items[0]).toMatchObject({ unread: 1, assigneeUserId: null, tags: [], contact: { name: 'P 002', optedOut: false }, lastMessage: { preview: 'جديد', direction: 'in', type: 'text', status: null } });
  expect(items[0]!.windowOpenUntil).toBeGreaterThan(Date.now());
  expect(items[2]!.windowOpenUntil).toBeNull();
});

it('keyset pagination: no duplicates or gaps across pages, even when many conversations share a timestamp', async () => {
  const ws = W(201);
  const api = await apiFor(ws);
  const ts = nowS() - 500;
  for (let i = 0; i < 7; i++) await inbound(ws, `20100000010${i}`, ts, `m${i}`); // all tied
  await inbound(ws, '201000000200', ts + 50, 'newest');
  const seen: number[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const r = await list(api, `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...r.items.map((c) => c.id));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  expect(seen).toHaveLength(8);
  expect(new Set(seen).size).toBe(8);
  expect(seen[0]).toBe((await rows<{ id: number }>(ws, "SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = '201000000200'"))[0]!.id);
});

it('filters unread / mine / unassigned', async () => {
  const ws = W(202);
  const api = await apiFor(ws);
  const a = await openChat(ws, '201000000011');
  const b = await openChat(ws, '201000000012');
  await openChat(ws, '201000000013');
  expect((await api.call('POST', `/conversations/${a}/read`)).status).toBe(200);
  expect((await api.call('POST', `/conversations/${b}/assign`, { userId: USER })).status).toBe(200);
  const ids = async (f: string) => (await list(api, `?filter=${f}`)).items.map((c) => c.contact.waId).sort();
  expect(await ids('all')).toHaveLength(3);
  expect(await ids('unread')).toEqual(['201000000012', '201000000013']);
  expect(await ids('mine')).toEqual(['201000000012']);
  expect(await ids('unassigned')).toEqual(['201000000011', '201000000013']);
  await api.call('POST', `/conversations/${b}/assign`, { userId: null });
  expect(await ids('mine')).toEqual([]);
});

it('rejects a limit over 50, an unknown filter and a bad cursor', async () => {
  const api = await apiFor(W(203));
  for (const qs of ['?limit=51', '?filter=nope', '?cursor=garbage']) expect((await api.call('GET', `/conversations${qs}`)).status, qs).toBe(400);
});

it('pages a conversation oldest-to-newest with before/limit and nextBefore', async () => {
  const ws = W(204);
  const api = await apiFor(ws);
  const conv = await openChat(ws, '201000000021', { text: 'm0', wamid: 'p0' });
  for (let i = 1; i < 120; i++) await inbound(ws, '201000000021', nowS() + i, `m${i}`, `p${i}`);
  const first = getMessagesResponse.parse(await (await api.call('GET', `/conversations/${conv}/messages`)).json());
  expect(first.items).toHaveLength(50);
  expect(first.items.at(-1)!.text).toBe('m119'); // the newest page, oldest first
  expect(first.items.map((m) => m.id)).toEqual([...first.items.map((m) => m.id)].sort((x, y) => x - y));
  const second = getMessagesResponse.parse(await (await api.call('GET', `/conversations/${conv}/messages?before=${first.nextBefore}&limit=50`)).json());
  expect(second.items.at(-1)!.id).toBeLessThan(first.items[0]!.id);
  const third = getMessagesResponse.parse(await (await api.call('GET', `/conversations/${conv}/messages?before=${second.nextBefore}`)).json());
  expect(third.items).toHaveLength(20);
  expect(third.nextBefore).toBeNull();
  expect((await api.call('GET', '/conversations/99999/messages')).status).toBe(404);
});

it('read clears unread; assign, notes and tags round-trip and show on the conversation', async () => {
  const ws = W(205);
  const api = await apiFor(ws);
  const conv = await openChat(ws);
  const read = conversationDto.parse(await (await api.call('POST', `/conversations/${conv}/read`)).json());
  expect(read.unread).toBe(0);
  const note = noteDto.parse(await (await api.call('POST', `/conversations/${conv}/notes`, { text: 'العميل عايز يغير العنوان' })).json());
  expect(note).toMatchObject({ authorUserId: USER, text: 'العميل عايز يغير العنوان' });
  const notes = (await (await api.call('GET', `/conversations/${conv}/notes`)).json()) as { items: unknown[] };
  expect(notes.items).toEqual([note]);
  const tagged = conversationDto.parse(await (await api.call('PUT', `/conversations/${conv}/tags`, { tags: ['vip', ' vip ', 'شحن'] })).json());
  expect(tagged.tags).toEqual(['vip', 'شحن']);
  const retag = conversationDto.parse(await (await api.call('PUT', `/conversations/${conv}/tags`, { tags: ['شحن'] })).json());
  expect(retag.tags).toEqual(['شحن']);
  expect((await list(api)).items[0]!.tags).toEqual(['شحن']);
  expect((await api.call('POST', `/conversations/${conv}/notes`, { text: '' })).status).toBe(400);
  expect((await api.call('POST', '/conversations/99999/read')).status).toBe(404);
});

it('searches message text with Arabic normalisation at index and query time, and finds prefixes', async () => {
  const ws = W(206);
  const api = await apiFor(ws);
  await inbound(ws, '201000000031', nowS(), 'عايز الغاء الطلب رقم ١٢٣٤');
  await inbound(ws, '201000000032', nowS(), 'مرحبا بكم');
  await inbound(ws, '201000000033', nowS(), 'order 1234 arrived');
  const find = async (q: string) => searchResponse.parse(await (await api.call('GET', `/search?q=${encodeURIComponent(q)}`)).json()).items;
  expect(await find('إلغاء')).toHaveLength(1);
  expect(await find('1234')).toHaveLength(2); // Arabic digits fold to ASCII on both sides
  const hit = (await find('الط'))[0]!;
  expect(hit.snippet).toBe('عايز الغاء الطلب رقم ١٢٣٤');
  expect(await find('nothing here')).toEqual([]);
  expect((await api.call('GET', '/search?q=')).status).toBe(400);
  expect((await api.call('GET', `/search?q=${encodeURIComponent('"* OR *')}`)).status).toBe(200); // FTS syntax characters are just text
});

it('outbound messages are searchable too', async () => {
  const ws = W(207);
  const api = await apiFor(ws);
  const conv = await openChat(ws);
  await api.call('POST', `/conversations/${conv}/messages`, { type: 'text', clientId: '00000000-0000-4000-8000-000000000207', text: 'تم شحن طلبك' });
  expect(searchResponse.parse(await (await api.call('GET', `/search?q=${encodeURIComponent('شحن')}`)).json()).items).toHaveLength(1);
});

it('erasing a contact also removes its notes, tags and search entries', async () => {
  const ws = W(208);
  const api = await apiFor(ws);
  const conv = await openChat(ws, '201000000041', { text: 'سري جدا' });
  await api.call('POST', `/conversations/${conv}/notes`, { text: 'ملاحظة' });
  await api.call('PUT', `/conversations/${conv}/tags`, { tags: ['x'] });
  await workspace(ws).eraseContact('201000000041');
  expect(await rows(ws, 'SELECT 1 FROM notes')).toEqual([]);
  expect(await rows(ws, 'SELECT 1 FROM conversation_tags')).toEqual([]);
  expect(await rows(ws, 'SELECT 1 FROM messages_fts')).toEqual([]);
  expect(searchResponse.parse(await (await api.call('GET', `/search?q=${encodeURIComponent('سري')}`)).json()).items).toEqual([]);
});

it('long bodies are served from /messages/:id/body', async () => {
  const ws = W(209);
  const api = await apiFor(ws);
  const long = 'ك'.repeat(1500);
  await inbound(ws, '201000000051', nowS(), long, 'long1');
  const [m] = await rows<{ id: number }>(ws, "SELECT id FROM messages WHERE wamid = 'long1'");
  const res = await api.call('GET', `/messages/${m!.id}/body`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: long });
  const dto = (await (await api.call('GET', `/conversations/${(await rows<{ conversation_id: number }>(ws, 'SELECT conversation_id FROM messages WHERE id = ?', m!.id))[0]!.conversation_id}/messages`)).json()) as { items: { hasLongBody: boolean; text: string }[] };
  expect(dto.items[0]).toMatchObject({ hasLongBody: true });
  expect(dto.items[0]!.text.length).toBeLessThan(300);
  expect((await api.call('GET', '/messages/99999/body')).status).toBe(404);
});

// Opt-in like test/perf.test.ts (BENCH=1, scripts/bench-local.mjs): a wall-clock budget only means something on a quiet, known machine;
// on the shared CI runner (7-12x slower) it measures the runner, not the code.
it.runIf(env.BENCH === '1')('speed: listing 50 of 5,000 conversations and opening a chat stay under the 150 ms p95 budget', async () => {
  const ws = W(210);
  const api = await apiFor(ws);
  await seedConversations(ws);
  const time = async (qs: string, path = '/conversations') => {
    const t = performance.now();
    const r = await api.call('GET', `${path}${qs}`);
    await r.text();
    expect(r.status).toBe(200);
    return performance.now() - t;
  };
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95) - 1]!;
  await time('?limit=50');
  const first = (await list(api, '?limit=50')).items;
  expect(first).toHaveLength(50);
  const lists: number[] = [];
  const filtered: number[] = [];
  for (let i = 0; i < 20; i++) lists.push(await time('?limit=50'));
  for (const f of ['unread', 'mine', 'unassigned']) for (let i = 0; i < 6; i++) filtered.push(await time(`?limit=50&filter=${f}`));
  const bigConv = first[0]! satisfies ConversationDto;
  const chats: number[] = [];
  for (let i = 0; i < 20; i++) chats.push(await time('?limit=50', `/conversations/${bigConv.id}/messages`));
  console.log('PERF inbox', JSON.stringify({ listP95: p95(lists), filteredP95: p95(filtered), chatP95: p95(chats) }));
  expect(p95(lists)).toBeLessThan(150);
  expect(p95(filtered)).toBeLessThan(150);
  expect(p95(chats)).toBeLessThan(150);
});
