import { SELF, createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { SendJob } from '../src/core/send-queue';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { inboundPayload } from './helpers/payload';
import { rows, seedNumber, workspace } from './helpers/workspace';

let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());

function job(ws: string, key: string): SendJob {
  return { workspaceId: ws, phoneNumberId: `pn-${ws}`, to: '201001234567', text: 'أهلاً 👋', idempotencyKey: key };
}

async function runBatch(jobs: SendJob[], attempts = 1) {
  for (const j of jobs) if (j.workspaceId) await seedNumber(j.phoneNumberId, j.workspaceId).catch(() => {}); // already seeded on redelivery
  const batch = createMessageBatch<SendJob>('ebda-wa-send', jobs.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

type Out = { wamid: string | null; status: string; direction: string; error_code: number | null };

it('sends a reply job once and stores the outbound wamid', async () => {
  graph = stubGraph();
  const res = await runBatch([job('ws-s1', 'reply:a')]);
  expect(res.explicitAcks).toEqual(['m0']);
  expect(graph.calls).toHaveLength(1);
  expect(graph.calls[0]!.url).toBe('https://graph.facebook.com/v23.0/pn-ws-s1/messages');
  expect(graph.calls[0]!.body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '201001234567', type: 'text', text: { body: 'أهلاً 👋' } });
  expect(await rows<Out>('ws-s1', "SELECT wamid, status, direction FROM messages WHERE direction = 'out'")).toEqual([{ wamid: 'wamid.out1', status: 'accepted', direction: 'out' }]);
});

it('sends to Meta once when the queue redelivers the same job', async () => {
  graph = stubGraph();
  await runBatch([job('ws-s2', 'reply:b')]);
  const again = await runBatch([job('ws-s2', 'reply:b')], 2);
  expect(graph.calls).toHaveLength(1);
  expect(again.explicitAcks).toEqual(['m0']);
});

it('retries the queue message on a retryable Meta error', async () => {
  graph = stubGraph(() => ({ status: 400, json: { error: { code: 131056, message: 'pair rate limit' } } }));
  const res = await runBatch([job('ws-s3', 'reply:c')]);
  expect(res.explicitAcks).toEqual([]);
  expect(res.retryMessages?.map((m: { msgId: string }) => m.msgId)).toEqual(['m0']);
  // the claim is released so the retry can send
  graph.restore();
  graph = stubGraph();
  await runBatch([job('ws-s3', 'reply:c')], 2);
  expect(graph.calls).toHaveLength(1);
});

it('acks and marks failed on a permanent Meta error', async () => {
  graph = stubGraph(() => ({ status: 400, json: { error: { code: 131026, message: 'undeliverable' } } }));
  const res = await runBatch([job('ws-s4', 'reply:d')]);
  expect(res.explicitAcks).toEqual(['m0']);
  expect(await rows<Out>('ws-s4', "SELECT status, error_code FROM messages WHERE direction = 'out'")).toEqual([{ status: 'failed', error_code: 131026 }]);
});

it('acks and drops an invalid job body', async () => {
  graph = stubGraph();
  const res = await runBatch([{ nope: true } as unknown as SendJob]);
  expect(res.explicitAcks).toEqual(['m0']);
  expect(graph.calls).toHaveLength(0);
});

it('keeps the highest state when statuses arrive out of order', async () => {
  graph = stubGraph();
  await runBatch([job('ws-s5', 'reply:e')]);
  const ws = workspace('ws-s5');
  await ws.ingest({ phoneNumberId: 'pn-1', inbound: [], statuses: [{ wamid: 'wamid.out1', status: 'read', ts: 3 }], receivedAt: 3 });
  await ws.ingest({ phoneNumberId: 'pn-1', inbound: [], statuses: [{ wamid: 'wamid.out1', status: 'delivered', ts: 2 }], receivedAt: 4 });
  expect(await rows('ws-s5', "SELECT status FROM messages WHERE wamid = 'wamid.out1'")).toEqual([{ status: 'read' }]);
  expect(await rows('ws-s5', 'SELECT status, applied FROM message_status_events ORDER BY id')).toEqual([
    { status: 'read', applied: 1 },
    { status: 'delivered', applied: 0 },
  ]);
});

it('records but does not apply failed after delivered', async () => {
  graph = stubGraph();
  await runBatch([job('ws-s6', 'reply:f')]);
  const ws = workspace('ws-s6');
  await ws.ingest({ phoneNumberId: 'pn-1', inbound: [], statuses: [{ wamid: 'wamid.out1', status: 'delivered', ts: 2 }], receivedAt: 2 });
  await ws.ingest({ phoneNumberId: 'pn-1', inbound: [], statuses: [{ wamid: 'wamid.out1', status: 'failed', ts: 3, errorCode: 131047 }], receivedAt: 3 });
  expect(await rows('ws-s6', "SELECT status FROM messages WHERE wamid = 'wamid.out1'")).toEqual([{ status: 'delivered' }]);
  expect(await rows('ws-s6', "SELECT applied FROM message_status_events WHERE status = 'failed'")).toEqual([{ applied: 0 }]);
});

it('re-offers a reply on inbound redelivery until the reply is claimed', async () => {
  const ws = workspace('ws-s7');
  const batch = { phoneNumberId: 'pn-1', inbound: [{ wamid: 'wamid.in7', from: '201001234567', ts: 1, type: 'text' as const, text: 'x' }], statuses: [], receivedAt: 1 };
  const cfg = { autoReplyText: 'r' };
  await ws.ingest(batch, cfg);
  expect((await ws.ingest(batch, cfg)).replies).toHaveLength(1);
  graph = stubGraph();
  await runBatch([{ ...job('ws-s7', 'reply:wamid.in7') }]);
  expect((await ws.ingest(batch, cfg)).replies).toHaveLength(0);
});

it('enqueues one reply job when a webhook brings a new text', async () => {
  await seedNumber('pn-q', 'ws-q');
  const spy = vi.mocked(env.SEND_QUEUE.sendBatch);
  await postWebhook(SELF, inboundPayload('pn-q', [{ id: 'wamid.q1', text: 'hi' }]));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0]).toEqual([{ body: expect.objectContaining({ workspaceId: 'ws-q', idempotencyKey: 'reply:wamid.q1' }) }]);
});
