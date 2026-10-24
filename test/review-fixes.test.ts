import { SELF, createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { extractEvents } from '../src/core/meta/webhook-schema';
import type { SendJob } from '../src/core/send-queue';
import { STALE_CLAIM_MS } from '../src/core/workspace-do';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { inboundPayload } from './helpers/payload';
import { rows, seedNumber, workspace } from './helpers/workspace';

let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());

const job = (ws: string, key: string, pn = 'pn-1'): SendJob => ({ workspaceId: ws, phoneNumberId: pn, to: '201001234567', text: 'x'.repeat(600), idempotencyKey: key });

async function runBatch(jobs: SendJob[], attempts = 1) {
  const batch = createMessageBatch<SendJob>('ebda-wa-send', jobs.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

// C1
it('keeps the full text of a body between 281 characters and 1 KB', async () => {
  await seedNumber('pn-c1', 'ws-c1');
  const text = 'a'.repeat(500);
  await postWebhook(SELF, inboundPayload('pn-c1', [{ id: 'wamid.c1', text }]));
  expect(await rows('ws-c1', 'SELECT body, body_r2_key FROM messages')).toEqual([{ body: text, body_r2_key: null }]);
});

it('keeps the full text of an outbound reply', async () => {
  await seedNumber('pn-c1o', 'ws-c1o');
  graph = stubGraph();
  await runBatch([job('ws-c1o', 'k-c1o', 'pn-c1o')]);
  expect(await rows('ws-c1o', "SELECT body FROM messages WHERE direction = 'out'")).toEqual([{ body: 'x'.repeat(600) }]);
});

// C2
it('retries (does not ack) a job whose send is still in flight, and re-sends after the stale window', async () => {
  await seedNumber('pn-c2', 'ws-c2');
  const j = job('ws-c2', 'k-c2', 'pn-c2');
  expect(await workspace('ws-c2').claimSend(j)).toBe('claimed'); // simulates a consumer that died after claiming
  graph = stubGraph();
  const batch = createMessageBatch<SendJob>('ebda-wa-send', [{ id: 'm0', timestamp: new Date(), attempts: 2, body: j }]);
  const retry = vi.spyOn(batch.messages[0]!, 'retry');
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  const res = await getQueueResult(batch, ctx);
  expect(res.explicitAcks).toEqual([]);
  expect(retry.mock.calls[0]?.[0]?.delaySeconds).toBeGreaterThanOrEqual(STALE_CLAIM_MS / 1000);
  expect(graph.calls).toHaveLength(0);
  vi.useFakeTimers({ now: Date.now() + STALE_CLAIM_MS + 1000, toFake: ['Date'] });
  await runBatch([j], 3);
  vi.useRealTimers();
  expect(graph.calls).toHaveLength(1);
});

// I3
it('keeps failed when sent arrives after it', async () => {
  const ws = workspace('ws-i3');
  await seedNumber('pn-i3', 'ws-i3');
  graph = stubGraph();
  await runBatch([job('ws-i3', 'k-i3', 'pn-i3')]);
  await ws.ingest({ phoneNumberId: 'pn-i3', inbound: [], statuses: [{ wamid: 'wamid.out1', status: 'failed', ts: 2, errorCode: 131026 }], receivedAt: 2 });
  await ws.ingest({ phoneNumberId: 'pn-i3', inbound: [], statuses: [{ wamid: 'wamid.out1', status: 'sent', ts: 1 }], receivedAt: 3 });
  expect(await rows('ws-i3', "SELECT status, error_code FROM messages WHERE wamid = 'wamid.out1'")).toEqual([{ status: 'failed', error_code: 131026 }]);
});

// I4
it('applies a status that arrived before the wamid was recorded', async () => {
  await seedNumber('pn-i4', 'ws-i4');
  const ws = workspace('ws-i4');
  await ws.ingest({ phoneNumberId: 'pn-i4', inbound: [], statuses: [{ wamid: 'wamid.out1', status: 'delivered', ts: 5 }], receivedAt: 5 });
  graph = stubGraph();
  await runBatch([job('ws-i4', 'k-i4', 'pn-i4')]);
  expect(await rows('ws-i4', "SELECT status FROM messages WHERE wamid = 'wamid.out1'")).toEqual([{ status: 'delivered' }]);
});

// I5
it('keeps the valid items when one item in a change is malformed', () => {
  const body = JSON.parse(inboundPayload('pn-i5', [{ id: 'wamid.ok' }, { id: 'wamid.bad' }]));
  delete body.entry[0].changes[0].value.messages[1].timestamp;
  body.entry[0].changes[0].value.statuses = [{ id: 'w1', status: 'deleted', timestamp: '1', recipient_id: 'x' }, { id: 'w2', status: 'read', timestamp: '1', recipient_id: 'x' }];
  const ev = extractEvents(body)!;
  expect(ev[0]!.inbound.map((m) => m.wamid)).toEqual(['wamid.ok']);
  expect(ev[0]!.statuses.map((s) => s.wamid)).toEqual(['w2']);
});

// M14
it('drops an item whose timestamp is not numeric', () => {
  const body = JSON.parse(inboundPayload('pn-m14', [{ id: 'wamid.nan' }]));
  body.entry[0].changes[0].value.messages[0].timestamp = 'soon';
  expect(extractEvents(body)![0]!.inbound).toEqual([]);
});

// M7
it('marks a reply failed on the last retry instead of leaving it in retry', async () => {
  await seedNumber('pn-m7', 'ws-m7');
  graph = stubGraph(() => ({ status: 500, json: { error: { code: 131000, message: 'x' } } }));
  const res = await runBatch([job('ws-m7', 'k-m7', 'pn-m7')], 5);
  expect(res.explicitAcks).toEqual(['m0']);
  expect(await rows('ws-m7', "SELECT status FROM messages WHERE direction = 'out'")).toEqual([{ status: 'failed' }]);
});

// M9
it('records a redelivered status event once', async () => {
  const ws = workspace('ws-m9');
  const st = { phoneNumberId: 'pn-m9', inbound: [], statuses: [{ wamid: 'wamid.m9', status: 'read' as const, ts: 9 }], receivedAt: 9 };
  await ws.ingest(st);
  await ws.ingest(st);
  expect(await rows('ws-m9', 'SELECT id FROM message_status_events')).toHaveLength(1);
});

// M10
it('does not rewrite R2 for a redelivered large body', async () => {
  await seedNumber('pn-m10', 'ws-m10');
  const body = inboundPayload('pn-m10', [{ id: 'wamid.m10', text: 'b'.repeat(1200) }]);
  await postWebhook(SELF, body);
  const put = vi.spyOn(env.MEDIA, 'put');
  await postWebhook(SELF, body);
  expect(put).not.toHaveBeenCalled();
});

// M11
it('does not send from a number the workspace no longer owns', async () => {
  await seedNumber('pn-m11', 'ws-m11', 'disconnected');
  graph = stubGraph();
  const res = await runBatch([job('ws-m11', 'k-m11', 'pn-m11')]);
  expect(res.explicitAcks).toEqual(['m0']);
  expect(graph.calls).toHaveLength(0);
});

// M12
it('never splits an emoji in the preview', async () => {
  const ws = workspace('ws-m12');
  const family = '👨‍👩‍👧‍👦';
  const text = 'a'.repeat(279) + family + 'tail';
  await ws.ingest({ phoneNumberId: 'pn', inbound: [{ wamid: 'wamid.m12', from: '1', ts: 1, type: 'text', text }], statuses: [], receivedAt: 1 });
  const [m] = await rows<{ preview: string }>('ws-m12', 'SELECT preview FROM messages');
  expect(m!.preview).toBe('a'.repeat(279) + family);
});
