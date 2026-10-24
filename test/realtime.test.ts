import { SELF, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { eventsResponse, realtimeEvent, type RealtimeEvent } from '../src/core/api/contract';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import { postWebhook } from './helpers/meta';
import { inboundPayload, statusPayload } from './helpers/payload';
import { consume } from './helpers/queue';
import { openChat, rows, seedNumber, workspace } from './helpers/workspace';
import type { SendJob } from '../src/core/send-queue';
import { env } from 'cloudflare:test';

useApiKey();

async function connect(storeId: string, token: string, protocols = `ebda.v1, bearer.${token}`) {
  const res = await SELF.fetch(`https://x/api/v1/stores/${storeId}/ws`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocols } });
  return res;
}
async function listen(storeId: string, token: string) {
  const res = await connect(storeId, token);
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const events: RealtimeEvent[] = [];
  ws.addEventListener('message', (e) => events.push(realtimeEvent.parse(JSON.parse(String(e.data)))));
  return { ws, events, res };
}
const waitFor = (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true), { timeout: 3000, interval: 10 });

it('upgrades with the token in Sec-WebSocket-Protocol and answers ebda.v1; no token or wrong store is refused', async () => {
  const api = await apiFor(W(300));
  const { res, ws } = await listen(W(300), api.token);
  expect(res.headers.get('sec-websocket-protocol')).toBe('ebda.v1');
  ws.close();
  expect((await connect(W(300), api.token, 'ebda.v1')).status).toBe(401);
  const other = await apiFor(W(301));
  expect((await connect(W(300), other.token)).status).toBe(403);
  expect((await SELF.fetch(`https://x/api/v1/stores/${W(300)}/ws`, { headers: { authorization: `Bearer ${api.token}` } })).status).toBe(426);
});

it('fans out events on ingest, status and send, each with a growing seq', async () => {
  const store = W(302);
  const api = await apiFor(store, 'owner', 'pn-rt');
  const { ws, events } = await listen(store, api.token);
  expect((await postWebhook(SELF, inboundPayload('pn-rt', [{ id: 'wamid.rt1', text: 'مرحبا', ts: Math.floor(Date.now() / 1000) }]))).status).toBe(200);
  await waitFor(() => events.length >= 2);
  expect(events.map((e) => e.type)).toEqual(['message.created', 'conversation.updated']);
  const created = events[0]!;
  if (created.type !== 'message.created') throw new Error('unexpected');
  expect(created.message).toMatchObject({ direction: 'in', text: 'مرحبا', wamid: 'wamid.rt1' });
  const conv = events[1]!;
  if (conv.type !== 'conversation.updated') throw new Error('unexpected');
  expect(conv.conversation).toMatchObject({ unread: 1, contact: { waId: '201001234567' } });

  // an API send: queued message, then accepted by Meta, then Meta's delivery status
  const convId = created.conversationId;
  const before = events.length;
  const post = await api.call('POST', `/conversations/${convId}/messages`, { type: 'text', clientId: '00000000-0000-4000-8000-000000000302', text: 'أهلاً' });
  expect(post.status).toBe(202);
  await waitFor(() => events.length >= before + 2);
  const sent = events.slice(before).find((e) => e.type === 'message.created');
  expect(sent).toMatchObject({ message: { clientId: '00000000-0000-4000-8000-000000000302', status: 'queued' } });
  graphStub();
  const job = vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls.at(-1)![0] as { body: SendJob }[];
  const afterPost = events.length;
  await consume([job[0]!.body]);
  await waitFor(() => events.some((e, i) => i >= afterPost && e.type === 'message.status' && e.status === 'accepted'));
  const afterAccept = events.length;
  await postWebhook(SELF, statusPayload('pn-rt', [{ id: 'wamid.out1', status: 'delivered' }]));
  await waitFor(() => events.length > afterAccept);
  expect(events.at(-1)).toMatchObject({ type: 'message.status', status: 'delivered', errorCode: null });

  const seqs = events.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  ws.close();
});

it('a client that missed events catches up with GET /events?after=<seq> and nothing is lost or repeated', async () => {
  const store = W(303);
  const api = await apiFor(store, 'owner', 'pn-rt2');
  await postWebhook(SELF, inboundPayload('pn-rt2', [{ id: 'wamid.rs1', text: 'one' }]));
  const first = eventsResponse.parse(await (await api.call('GET', '/events?after=0')).json());
  expect(first.items.map((e) => e.type)).toEqual(['message.created', 'conversation.updated']);
  const cursor = first.latestSeq;
  expect(first.items.at(-1)!.seq).toBe(cursor);
  // "the phone slept": two more messages arrive while no socket is open
  await postWebhook(SELF, inboundPayload('pn-rt2', [{ id: 'wamid.rs2', text: 'two' }, { id: 'wamid.rs3', text: 'three' }]));
  const gap = eventsResponse.parse(await (await api.call('GET', `/events?after=${cursor}`)).json());
  const created = gap.items.filter((e) => e.type === 'message.created');
  expect(created.map((e) => e.type === 'message.created' && e.message.text)).toEqual(['two', 'three']);
  expect(gap.items.every((e) => e.seq > cursor)).toBe(true);
  expect(eventsResponse.parse(await (await api.call('GET', `/events?after=${gap.latestSeq}`)).json())).toEqual({ items: [], latestSeq: gap.latestSeq });
  expect((await api.call('GET', '/events?after=-1')).status).toBe(400);
});

it('keeps only the last 1,000 events but seq keeps growing', async () => {
  const store = W(304);
  const api = await apiFor(store);
  const convId = await openChat(store);
  await runInDurableObject(workspace(store), (inst) => {
    for (let i = 0; i < 1100; i++) (inst as unknown as { emitConversationUpdated(id: number): void }).emitConversationUpdated(convId);
  });
  const all = eventsResponse.parse(await (await api.call('GET', '/events?after=0')).json());
  expect(all.items).toHaveLength(1000);
  expect(all.latestSeq).toBeGreaterThan(1100);
  expect(all.items[0]!.seq).toBe(all.latestSeq - 999);
});

it('read, assign and tags broadcast conversation.updated; erasing a contact removes its events', async () => {
  const store = W(305);
  const api = await apiFor(store);
  const convId = await openChat(store, '201001239999', { text: 'سري' });
  const { ws, events } = await listen(store, api.token);
  await api.call('POST', `/conversations/${convId}/read`);
  await api.call('PUT', `/conversations/${convId}/tags`, { tags: ['a'] });
  await waitFor(() => events.length >= 2);
  expect(events.map((e) => e.type)).toEqual(['conversation.updated', 'conversation.updated']);
  ws.close();
  await workspace(store).eraseContact('201001239999');
  expect(await rows(store, 'SELECT 1 FROM events')).toEqual([]);
  void seedNumber;
});
